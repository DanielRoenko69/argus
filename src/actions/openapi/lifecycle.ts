import type pg from 'pg';
import {
  buildOpenApiCapabilityManifest,
  isOpenApiSafeAuth,
  type OpenApiCapabilityManifest,
  type OpenApiSafeAuth,
} from './manifest.js';
import { prepareOpenApiStudioPreview } from './studio.js';

type LifecycleStatus = 'unchecked' | 'current' | 'drifted' | 'error';

interface SourceRow {
  id: number;
  backend_id: number;
  backend_name: string;
  backend_enabled: boolean;
  name_prefix: string;
  source_kind: 'url' | 'text';
  source_url: string | null;
  title: string;
  openapi_version: string;
  base_url: string;
  base_url_override: string | null;
  auth_scheme: OpenApiSafeAuth | null;
  auth_signature: string | null;
  spec_digest: string | null;
  manifest_digest: string | null;
  operation_count: number;
  revision: string;
  lifecycle_status: LifecycleStatus;
  last_checked_at: string | Date | null;
  last_observed_spec_digest: string | null;
  last_observed_manifest_digest: string | null;
  last_check_summary: DriftSummary | null;
  last_check_error_code: string | null;
  imported_at: string | Date;
}

interface StoredOperationRow {
  operation_key: string;
  tool_name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  is_write: boolean;
  supported: boolean;
  signature: string;
  workflow_count: number;
}

export interface DriftOperationRef {
  key: string;
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  isWrite: boolean;
  supported: boolean;
  signature: string;
  workflowCount: number;
}

export interface DriftSummary {
  added: number;
  changed: number;
  removed: number;
  authChanged: boolean;
  baseUrlChanged: boolean;
}

export interface CapabilitySourceListItem {
  id: number;
  name: string;
  prefix: string;
  backendId: number;
  backendEnabled: boolean;
  source: { kind: 'url' | 'text'; url: string | null; canCheck: boolean; baseUrlOverride: string | null };
  status: LifecycleStatus;
  importedAt: string;
  checkedAt: string | null;
  baseline: { specDigest: string | null; manifestDigest: string | null; operationCount: number };
  lastCheck: {
    status: LifecycleStatus;
    checkedAt: string;
    observedSpecDigest: string | null;
    observedManifestDigest: string | null;
    summary: DriftSummary | null;
    errorCode: string | null;
  } | null;
}

export interface CapabilitySourceCheckResult {
  source: { id: number; name: string; prefix: string; sourceKind: 'url' | 'text' };
  checkedAt: string;
  status: 'current' | 'drifted';
  baseline: { specDigest: string; manifestDigest: string };
  observed: {
    specDigest: string;
    manifestDigest: string;
    title: string;
    openapiVersion: string;
    baseUrl: string;
    auth: OpenApiSafeAuth;
  };
  diff: {
    added: DriftOperationRef[];
    changed: Array<{ before: DriftOperationRef; after: DriftOperationRef; changes: string[] }>;
    removed: DriftOperationRef[];
    baseUrl: { changed: boolean; before: string; after: string };
    auth: { changed: boolean; before: OpenApiSafeAuth; after: OpenApiSafeAuth };
    summary: DriftSummary;
  };
}

export class CapabilitySourceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 413 | 502 = 400,
    readonly code = 'invalid_request',
  ) {
    super(message);
    this.name = 'CapabilitySourceError';
  }
}

const SOURCE_SELECT = `
  SELECT source.id, source.backend_id, backend.name AS backend_name,
         backend.enabled AS backend_enabled, source.name_prefix,
         source.source_kind, source.source_url, source.title,
         source.openapi_version, source.base_url, source.base_url_override,
         source.auth_scheme, source.auth_signature, source.spec_digest,
         source.manifest_digest, source.operation_count,
         source.revision::text AS revision,
         source.lifecycle_status, source.last_checked_at,
         source.last_observed_spec_digest, source.last_observed_manifest_digest,
         source.last_check_summary, source.last_check_error_code, source.imported_at
    FROM mcp_capability_sources source
    JOIN mcp_backends backend ON backend.id = source.backend_id`;

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function sourceListItem(row: SourceRow): CapabilitySourceListItem {
  assertPersistedSource(row);
  const checkedAt = iso(row.last_checked_at);
  return {
    id: Number(row.id),
    name: row.title || row.backend_name,
    prefix: row.name_prefix,
    backendId: row.backend_id,
    backendEnabled: row.backend_enabled,
    source: {
      kind: row.source_kind,
      url: row.source_kind === 'url' ? row.source_url : null,
      canCheck: row.manifest_digest != null && (row.source_kind === 'text' || row.source_url != null),
      baseUrlOverride: row.base_url_override,
    },
    status: row.lifecycle_status,
    importedAt: iso(row.imported_at)!,
    checkedAt,
    baseline: {
      specDigest: row.spec_digest,
      manifestDigest: row.manifest_digest,
      operationCount: row.operation_count,
    },
    lastCheck: checkedAt ? {
      status: row.lifecycle_status,
      checkedAt,
      observedSpecDigest: row.last_observed_spec_digest,
      observedManifestDigest: row.last_observed_manifest_digest,
      summary: row.last_check_summary,
      errorCode: row.last_check_error_code,
    } : null,
  };
}

function assertPersistedSource(row: SourceRow): void {
  if (!/^[1-9]\d*$/.test(row.revision)
    || (row.auth_scheme !== null && !isOpenApiSafeAuth(row.auth_scheme))) {
    throw new Error('Capability Source contains invalid persisted state');
  }
  if (row.source_kind === 'url') {
    try {
      const url = new URL(row.source_url ?? '');
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || url.toString() !== row.source_url) {
        throw new Error('unsafe source URL');
      }
    } catch {
      throw new Error('Capability Source contains an unsafe persisted URL');
    }
  } else if (row.source_url !== null) {
    throw new Error('Capability Source contains invalid source metadata');
  }
  for (const value of [row.base_url, row.base_url_override].filter((item): item is string => item != null)) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('unsafe base URL');
      }
    } catch {
      throw new Error('Capability Source contains an unsafe base URL');
    }
  }
}

export async function listCapabilitySources(pool: pg.Pool): Promise<{
  generatedAt: string;
  sources: CapabilitySourceListItem[];
}> {
  const rows = await pool.query<SourceRow>(`${SOURCE_SELECT} ORDER BY source.updated_at DESC, source.id DESC`);
  return { generatedAt: new Date().toISOString(), sources: rows.rows.map(sourceListItem) };
}

function validateCheckBody(source: SourceRow, raw: unknown): { specText?: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CapabilitySourceError('Check-Daten fehlen');
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find(key => key !== 'specText');
  if (unknown) throw new CapabilitySourceError(`Unbekanntes Check-Feld: ${unknown}`);
  if (source.source_kind === 'url') {
    if (body.specText != null) throw new CapabilitySourceError('URL-Quellen werden serverseitig neu geladen');
    return {};
  }
  if (typeof body.specText !== 'string' || !body.specText.trim()) {
    throw new CapabilitySourceError('Für manuelle Quellen ist eine neue OpenAPI-Spezifikation erforderlich');
  }
  return { specText: body.specText };
}

function operationRef(operation: StoredOperationRow): DriftOperationRef {
  return {
    key: operation.operation_key,
    name: operation.tool_name,
    method: operation.method,
    path: operation.path,
    isWrite: operation.is_write,
    supported: operation.supported,
    signature: operation.signature,
    workflowCount: Number(operation.workflow_count ?? 0),
  };
}

function observedOperationRef(
  operation: OpenApiCapabilityManifest['operations'][number],
  workflowCount = 0,
): DriftOperationRef {
  return {
    key: operation.key,
    name: operation.name,
    method: operation.method,
    path: operation.path,
    isWrite: operation.isWrite,
    supported: operation.supported,
    signature: operation.signature,
    workflowCount,
  };
}

function operationChanges(before: DriftOperationRef, after: DriftOperationRef): string[] {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push('name');
  if (before.isWrite !== after.isWrite) changes.push('writeClassification');
  if (before.supported !== after.supported) changes.push('support');
  if (before.signature !== after.signature) changes.push('implementation');
  return [...new Set(changes)];
}

export function compareCapabilitySourceManifest(
  source: SourceRow,
  baselineRows: StoredOperationRow[],
  observed: OpenApiCapabilityManifest,
): CapabilitySourceCheckResult['diff'] {
  if (!source.auth_scheme) throw new CapabilitySourceError('Quelle benötigt einen bestätigten Reimport als Baseline', 409, 'baseline_required');
  const baselineByKey = new Map(baselineRows.map(operation => [operation.operation_key, operation]));
  const observedByKey = new Map(observed.operations.map(operation => [operation.key, operation]));
  const added = observed.operations
    .filter(operation => !baselineByKey.has(operation.key))
    .map(operation => observedOperationRef(operation));
  const removed = baselineRows
    .filter(operation => !observedByKey.has(operation.operation_key))
    .map(operationRef);
  const changed = baselineRows.flatMap((stored) => {
    const next = observedByKey.get(stored.operation_key);
    if (!next || next.signature === stored.signature) return [];
    const before = operationRef(stored);
    const after = observedOperationRef(next, before.name === next.name ? before.workflowCount : 0);
    return [{ before, after, changes: operationChanges(before, after) }];
  });
  const authChanged = source.auth_signature !== observed.authSignature;
  const baseUrlChanged = source.base_url !== observed.baseUrl;
  const summary: DriftSummary = {
    added: added.length,
    changed: changed.length,
    removed: removed.length,
    authChanged,
    baseUrlChanged,
  };
  return {
    added,
    changed,
    removed,
    baseUrl: { changed: baseUrlChanged, before: source.base_url, after: observed.baseUrl },
    auth: { changed: authChanged, before: source.auth_scheme, after: observed.auth },
    summary,
  };
}

function checkFailure(error: unknown): CapabilitySourceError | null {
  if (error instanceof CapabilitySourceError) return error;
  const errorName = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (errorName === 'TimeoutError' || /aborted.*timeout|timed out|timeout/i.test(message)) {
    return new CapabilitySourceError('OpenAPI-Quelle konnte nicht sicher geladen werden', 502, 'source_fetch_failed');
  }
  const databaseCode = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (databaseCode === 'openapi_parse_failed') {
    return new CapabilitySourceError('OpenAPI-Spezifikation ist ungültig', 400, 'invalid_spec');
  }
  if (typeof databaseCode === 'string' && databaseCode.length > 0) return null;
  if (message.includes('MB limit')) return new CapabilitySourceError('OpenAPI-Spezifikation überschreitet das Größenlimit', 413, 'spec_too_large');
  if (message.includes('not allowed') || message.includes('nicht erlaubt') || message.includes('resolve safely')) {
    return new CapabilitySourceError('OpenAPI-Quelle ist durch Netzwerkregeln blockiert', 400, 'source_blocked');
  }
  if (message.includes('fetch failed') || message.includes('HTTP ') || message.includes('redirect')) {
    return new CapabilitySourceError('OpenAPI-Quelle konnte nicht sicher geladen werden', 502, 'source_fetch_failed');
  }
  if (/OpenAPI spec is empty|Failed to parse OpenAPI specification|Spec is not an object|Only OpenAPI 3\.x|Spec has no valid paths|Refusing external\/remote \$ref|Unresolvable \$ref|Circular \$ref|OpenAPI document exceeds|Base URL|server URL|no supported HTTP operations|exceeds the limit of \d+ operations/i.test(message)) {
    return new CapabilitySourceError('OpenAPI-Spezifikation ist ungültig', 400, 'invalid_spec');
  }
  return null;
}

async function loadSource(client: pg.PoolClient, sourceId: number): Promise<SourceRow | null> {
  const source = (await client.query<SourceRow>(`${SOURCE_SELECT} WHERE source.id = $1`, [sourceId])).rows[0] ?? null;
  if (source) assertPersistedSource(source);
  return source;
}

async function storeCheckError(
  client: pg.PoolClient,
  source: SourceRow,
  checkedAt: string,
  error: CapabilitySourceError,
): Promise<void> {
  if (!source.manifest_digest) return;
  await client.query(
    `UPDATE mcp_capability_sources
        SET lifecycle_status = 'error', last_checked_at = $2,
            last_observed_spec_digest = NULL, last_observed_manifest_digest = NULL,
            last_check_summary = NULL, last_check_error_code = $3, updated_at = now()
      WHERE id = $1 AND manifest_digest = $4 AND revision = $5::bigint`,
    [source.id, checkedAt, error.code, source.manifest_digest, source.revision],
  );
}

export async function checkCapabilitySource(
  pool: pg.Pool,
  rawSourceId: string,
  rawBody: unknown,
): Promise<CapabilitySourceCheckResult> {
  if (!/^[1-9]\d*$/.test(rawSourceId)) throw new CapabilitySourceError('Source-ID ist ungültig');
  const sourceId = Number(rawSourceId);
  if (!Number.isSafeInteger(sourceId) || sourceId > 2_147_483_647) throw new CapabilitySourceError('Source-ID ist ungültig');
  const client = await pool.connect();
  let lockKey: string | null = null;
  let source: SourceRow | null = null;
  const checkedAt = new Date().toISOString();
  try {
    source = await loadSource(client, sourceId);
    if (!source) throw new CapabilitySourceError('Capability Source wurde nicht gefunden', 404, 'not_found');
    if (!source.manifest_digest || !source.spec_digest || !source.auth_scheme || !source.auth_signature) {
      throw new CapabilitySourceError('Quelle benötigt einen bestätigten Reimport als Baseline', 409, 'baseline_required');
    }
    let body = validateCheckBody(source, rawBody);
    lockKey = `openapi:${source.name_prefix}`;
    const locked = (await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [lockKey],
    )).rows[0]?.locked === true;
    if (!locked) throw new CapabilitySourceError('Für diese Quelle läuft bereits ein Check oder Import', 409, 'source_busy');

    // Refresh the baseline after acquiring the same lock used by the importer.
    source = await loadSource(client, sourceId);
    if (!source?.manifest_digest || !source.spec_digest || !source.auth_scheme || !source.auth_signature) {
      throw new CapabilitySourceError('Quelle benötigt einen bestätigten Reimport als Baseline', 409, 'baseline_required');
    }
    body = validateCheckBody(source, rawBody);
    const baselineRows = await client.query<StoredOperationRow>(
      `SELECT operation.operation_key, operation.tool_name, operation.method,
              operation.path, operation.is_write, operation.supported, operation.signature,
              (SELECT count(*)::int
                 FROM mcp_workflows workflow
                WHERE EXISTS (
                  SELECT 1 FROM jsonb_array_elements(workflow.steps) step
                   WHERE step->>'tool' = operation.tool_name
                )) AS workflow_count
         FROM mcp_capability_source_operations operation
        WHERE operation.source_id = $1
        ORDER BY operation.operation_key`,
      [source.id],
    );
    const previewInput = source.source_kind === 'url'
      ? { specUrl: source.source_url, namePrefix: source.name_prefix, baseUrl: source.base_url_override ?? undefined }
      : { specText: body.specText, namePrefix: source.name_prefix, baseUrl: source.base_url_override ?? undefined };
    // Reuse the lock-owning client. Acquiring a second pool client here lets
    // pool.max simultaneous checks exhaust the pool while all wait forever.
    const prepared = await prepareOpenApiStudioPreview(client, previewInput);
    const observed = buildOpenApiCapabilityManifest({
      prefix: prepared.preview.prefix,
      sourceKind: source.source_kind,
      specUrl: source.source_url,
      title: prepared.preview.title,
      openapiVersion: prepared.preview.openapiVersion,
      baseUrl: prepared.preview.baseUrl,
      baseUrlOverridden: source.base_url_override != null,
      security: prepared.preview.security,
      specDigest: prepared.preview.specDigest,
      operations: prepared.operations,
    });
    const diff = compareCapabilitySourceManifest(source, baselineRows.rows, observed);
    const drifted = diff.summary.added > 0 || diff.summary.changed > 0 || diff.summary.removed > 0
      || diff.summary.authChanged || diff.summary.baseUrlChanged;
    const status = drifted ? 'drifted' as const : 'current' as const;
    const updated = await client.query(
      `UPDATE mcp_capability_sources
          SET lifecycle_status = $2, last_checked_at = $3,
              last_observed_spec_digest = $4, last_observed_manifest_digest = $5,
              last_check_summary = $6::jsonb, last_check_error_code = NULL, updated_at = now()
        WHERE id = $1 AND manifest_digest = $7 AND revision = $8::bigint`,
      [
        source.id, status, checkedAt, observed.specDigest, observed.manifestDigest,
        JSON.stringify(diff.summary), source.manifest_digest, source.revision,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new CapabilitySourceError('Baseline wurde während des Checks aktualisiert', 409, 'baseline_changed');
    }
    return {
      source: {
        id: Number(source.id),
        name: source.title || source.backend_name,
        prefix: source.name_prefix,
        sourceKind: source.source_kind,
      },
      checkedAt,
      status,
      baseline: { specDigest: source.spec_digest, manifestDigest: source.manifest_digest },
      observed: {
        specDigest: observed.specDigest,
        manifestDigest: observed.manifestDigest,
        title: observed.title,
        openapiVersion: observed.openapiVersion,
        baseUrl: observed.baseUrl,
        auth: observed.auth,
      },
      diff,
    };
  } catch (error) {
    const failure = checkFailure(error);
    if (!failure) throw error;
    if (source?.source_kind === 'url'
      && !['invalid_request', 'not_found', 'baseline_required', 'source_busy', 'baseline_changed'].includes(failure.code)) {
      await storeCheckError(client, source, checkedAt, failure).catch(() => undefined);
    }
    throw failure;
  } finally {
    if (lockKey) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
    client.release();
  }
}
