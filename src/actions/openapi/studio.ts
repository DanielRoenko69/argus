import { createHash } from 'node:crypto';
import type pg from 'pg';
import { assertEgressAllowed, assertSsrfSafeResolved } from '../../backends/customBackends.js';
import { mapOperations, mapSecurity, type MappedOp, type MappedSecurity } from './map.js';
import { MAX_OPENAPI_SPEC_BYTES, parseSpec } from './parse.js';
import { resolveLocalRefs } from './refs.js';
import { isOpenApiSafeAuth } from './manifest.js';
import { storedOpenApiCredentialReadable, storedOpenApiHeaderMatches } from './credential.js';

export const MAX_OPENAPI_OPERATIONS = 500;

export interface OpenApiStudioSourceInput {
  specText?: unknown;
  specUrl?: unknown;
  namePrefix?: unknown;
  baseUrl?: unknown;
}

export interface OpenApiPreviewOperation {
  key: string;
  name: string;
  method: MappedOp['method'];
  path: string;
  description: string;
  parameterCount: number;
  parameters: MappedOp['parameters'];
  tags: string[];
  isWrite: boolean;
  riskLevel: 'low' | 'high';
  supported: boolean;
  warnings: string[];
  change: 'create' | 'update' | 'collision' | 'unsupported';
  collisionReason: string | null;
}

export interface OpenApiStudioPreview {
  previewDigest: string;
  specDigest: string;
  title: string;
  openapiVersion: string;
  sourceKind: 'text' | 'url';
  prefix: string;
  baseUrl: string;
  security: MappedSecurity;
  existing: {
    backendId: number | null;
    backendOwned: boolean;
    authType: string | null;
    hasCredential: boolean;
    credentialReusable: boolean;
    importedToolCount: number;
    assignedBundleIds: number[];
    sourceRevision: string | null;
    sourceManifestDigest: string | null;
    defaultBundleId: number | null;
    defaultBundleOwned: boolean;
  };
  operations: OpenApiPreviewOperation[];
  removals: Array<{ name: string; workflowCount: number }>;
  counts: {
    total: number;
    supported: number;
    read: number;
    write: number;
    create: number;
    update: number;
    collisions: number;
    unsupported: number;
    removals: number;
  };
  warnings: string[];
}

export interface PreparedOpenApiStudioPreview {
  preview: OpenApiStudioPreview;
  operations: MappedOp[];
}

export type OpenApiStudioQueryable = pg.Pool | pg.PoolClient;

function cleanOptionalString(value: unknown, label: string, maxLength: number): string {
  if (value == null) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} exceeds its maximum length`);
  return normalized;
}

export function normalizeOpenApiPrefix(value: unknown, fallback: unknown = 'api'): string {
  const source = cleanOptionalString(value, 'OpenAPI prefix', 256)
    || cleanOptionalString(fallback, 'OpenAPI title', 512)
    || 'api';
  let normalized = source.toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!/^[a-z]/.test(normalized)) normalized = `api_${normalized}`;
  normalized = normalized.slice(0, 32).replace(/[_-]+$/g, '');
  return normalized || 'api';
}

function normalizeBaseUrl(value: string, specUrl: string): string {
  if (!value) throw new Error('The spec has no usable server URL; provide an absolute base URL');
  if (/[{}]/.test(value)) throw new Error('The server URL contains unresolved variables; provide a concrete base URL');
  let url: URL;
  try { url = specUrl ? new URL(value, specUrl) : new URL(value); }
  catch { throw new Error('Base URL must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Base URL must be an absolute http(s) URL without embedded credentials');
  }
  if (url.search || url.hash) throw new Error('Base URL cannot contain a query or fragment');
  return url.toString().replace(/\/$/, '');
}

async function readResponseBodyLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OPENAPI_SPEC_BYTES) {
    throw new Error(`OpenAPI spec exceeds the ${MAX_OPENAPI_SPEC_BYTES / 1024 / 1024} MB limit`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > MAX_OPENAPI_SPEC_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`OpenAPI spec exceeds the ${MAX_OPENAPI_SPEC_BYTES / 1024 / 1024} MB limit`);
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text + decoder.decode();
}

export async function resolveOpenApiSpecText(
  input: OpenApiStudioSourceInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ text: string; sourceKind: 'text' | 'url'; specUrl: string }> {
  const specText = cleanOptionalString(input.specText, 'OpenAPI spec', MAX_OPENAPI_SPEC_BYTES);
  const specUrl = cleanOptionalString(input.specUrl, 'OpenAPI spec URL', 2_048);
  if (Boolean(specText) === Boolean(specUrl)) throw new Error('Provide exactly one OpenAPI source: pasted spec or URL');
  if (specText) return { text: specText, sourceKind: 'text', specUrl: '' };

  let url: URL;
  try { url = new URL(specUrl); }
  catch { throw new Error('OpenAPI spec URL is invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('OpenAPI spec URL must use http(s) and cannot contain embedded credentials');
  }
  await assertSsrfSafeResolved(url.toString(), undefined, { failClosedOnDnsError: true });
  assertEgressAllowed(url.toString());
  const response = await fetchImpl(url.toString(), {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.8' },
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error('OpenAPI spec URL returned a redirect; provide the final non-redirecting URL');
  }
  if (!response.ok) throw new Error(`OpenAPI spec fetch failed with HTTP ${response.status}`);
  return { text: await readResponseBodyLimited(response), sourceKind: 'url', specUrl: url.toString() };
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function prepareOpenApiStudioPreview(
  pool: OpenApiStudioQueryable,
  input: OpenApiStudioSourceInput,
): Promise<PreparedOpenApiStudioPreview> {
  const source = await resolveOpenApiSpecText(input);
  const doc = resolveLocalRefs(parseSpec(source.text));
  const prefix = normalizeOpenApiPrefix(input.namePrefix, doc.info?.title);
  const requestedBaseUrl = cleanOptionalString(input.baseUrl, 'OpenAPI base URL', 2_048);
  const baseUrl = normalizeBaseUrl(requestedBaseUrl || String(doc.servers?.[0]?.url ?? ''), source.specUrl);
  await assertSsrfSafeResolved(baseUrl, undefined, { failClosedOnDnsError: true });
  assertEgressAllowed(baseUrl);
  const operations = mapOperations(doc, prefix);
  if (operations.length === 0) throw new Error('The spec contains no supported HTTP operations');
  if (operations.length > MAX_OPENAPI_OPERATIONS) {
    throw new Error(`The spec exceeds the limit of ${MAX_OPENAPI_OPERATIONS} operations`);
  }

  const category = `openapi:${prefix}`;
  const [toolRows, backendRows, bundleRows] = await Promise.all([
    pool.query<{
      id: number;
      name: string;
      category: string | null;
      backend: string;
      workflow_count: number;
    }>(
      `SELECT tool.id, tool.name, tool.category, tool.backend,
              (SELECT count(*)::int FROM mcp_workflows workflow
                WHERE EXISTS (
                  SELECT 1 FROM jsonb_array_elements(workflow.steps) step
                   WHERE step->>'tool' = tool.name
                )) AS workflow_count
         FROM mcp_tools tool
        WHERE tool.name = ANY($1::text[]) OR (tool.category = $2 AND tool.backend = $3)`,
      [operations.map(operation => operation.name), category, `custom:${prefix}`],
    ),
    pool.query<{
      id: number;
      description: string;
      backend_type: string;
      managed_by: string | null;
      auth_type: string;
      auth_value: string | null;
      has_credential: boolean;
      bundle_ids: number[];
      source_revision: string | null;
      source_manifest_digest: string | null;
      source_auth_scheme: unknown;
    }>(
      `SELECT backend.id, backend.description, backend.backend_type, backend.auth_type,
              backend.auth_value,
              (NULLIF(backend.auth_value, '') IS NOT NULL) AS has_credential,
              backend.config->>'managed_by' AS managed_by,
              (SELECT source.revision::text
                 FROM mcp_capability_sources source
                WHERE source.backend_id = backend.id) AS source_revision,
              (SELECT source.manifest_digest
                 FROM mcp_capability_sources source
                WHERE source.backend_id = backend.id) AS source_manifest_digest,
              (SELECT source.auth_scheme
                 FROM mcp_capability_sources source
                WHERE source.backend_id = backend.id) AS source_auth_scheme,
              COALESCE(
                array_agg(assignment.bundle_id ORDER BY assignment.bundle_id)
                  FILTER (WHERE assignment.bundle_id IS NOT NULL),
                '{}'
              )::int[] AS bundle_ids
         FROM mcp_backends backend
         LEFT JOIN mcp_backend_bundles assignment ON assignment.backend_id = backend.id
        WHERE backend.name = $1
        GROUP BY backend.id`,
      [prefix],
    ),
    pool.query<{ id: number; description: string }>(
      'SELECT id, description FROM mcp_service_bundles WHERE name = $1',
      [prefix],
    ),
  ]);

  const existingByName = new Map(toolRows.rows.map(row => [row.name, row]));
  const importedRows = toolRows.rows.filter(row => row.category === category && row.backend === `custom:${prefix}`);
  const mappedNames = new Set(operations.filter(operation => operation.supported).map(operation => operation.name));
  const removals = importedRows
    .filter(row => !mappedNames.has(row.name))
    .map(row => ({ name: row.name, workflowCount: row.workflow_count }))
    .sort((left, right) => left.name.localeCompare(right.name));
  const previewOperations: OpenApiPreviewOperation[] = operations.map(operation => {
    const existing = existingByName.get(operation.name);
    const collision = existing != null && (existing.category !== category || existing.backend !== `custom:${prefix}`);
    const change = !operation.supported
      ? 'unsupported' as const
      : collision ? 'collision' as const
        : existing ? 'update' as const : 'create' as const;
    return {
      key: `${operation.method} ${operation.path}`,
      name: operation.name,
      method: operation.method,
      path: operation.path,
      description: operation.description,
      parameterCount: operation.parameters.length,
      parameters: operation.parameters,
      tags: operation.tags,
      isWrite: operation.isWrite,
      riskLevel: operation.isWrite ? 'high' : 'low',
      supported: operation.supported,
      warnings: operation.warnings,
      change,
      collisionReason: collision ? `Name is already owned by ${existing!.backend}` : null,
    };
  });
  const backend = backendRows.rows[0];
  const backendOwned = backend == null || (
    backend.backend_type === 'http'
    && (backend.managed_by === 'openapi' || backend.source_revision !== null)
  );
  const defaultBundle = bundleRows.rows[0];
  const defaultBundleOwned = defaultBundle == null || (
    backend != null
    && backendOwned
    && backend.bundle_ids.includes(defaultBundle.id)
  );
  const security = mapSecurity(doc);
  const sourceAuth = backend?.source_auth_scheme;
  const sourceHeaderName = isOpenApiSafeAuth(sourceAuth)
    && sourceAuth.type === 'header'
    && typeof sourceAuth.headerName === 'string'
    ? sourceAuth.headerName
    : null;
  const credentialReusable = Boolean(backend?.has_credential)
    && backend?.auth_type === security.auth_type
    && (security.auth_type === 'none' || storedOpenApiCredentialReadable(backend?.auth_value))
    && (security.auth_type !== 'header'
      || (sourceHeaderName !== null
        && typeof security.headerName === 'string'
        && sourceHeaderName.toLowerCase() === security.headerName.toLowerCase()
        && storedOpenApiHeaderMatches(backend.auth_value, security.headerName)));
  const warnings = [
    ...(!backendOwned ? [`Connection name '${prefix}' is already owned by another source`] : []),
    ...(!defaultBundleOwned ? [`Bundle name '${prefix}' is already owned by another source`] : []),
    ...(security.note ? [security.note] : []),
    ...(removals.length > 0 ? [`Re-import removes ${removals.length} operation${removals.length === 1 ? '' : 's'}`] : []),
  ];
  const specDigest = digest(source.text);
  const stateSignature = JSON.stringify({
    specDigest,
    prefix,
    baseUrl,
    operations: previewOperations.map(operation => [operation.key, operation.name, operation.change, operation.supported]),
    removals,
    backendId: backend?.id ?? null,
    backendOwned,
    backendAuthType: backend?.auth_type ?? null,
    backendHasCredential: backend?.has_credential ?? false,
    credentialReusable,
    assignedBundleIds: backend?.bundle_ids ?? [],
    sourceRevision: backend?.source_revision ?? null,
    sourceManifestDigest: backend?.source_manifest_digest ?? null,
    defaultBundleId: defaultBundle?.id ?? null,
    defaultBundleOwned,
  });
  const counts = {
    total: previewOperations.length,
    supported: previewOperations.filter(operation => operation.supported).length,
    read: previewOperations.filter(operation => !operation.isWrite).length,
    write: previewOperations.filter(operation => operation.isWrite).length,
    create: previewOperations.filter(operation => operation.change === 'create').length,
    update: previewOperations.filter(operation => operation.change === 'update').length,
    collisions: previewOperations.filter(operation => operation.change === 'collision').length,
    unsupported: previewOperations.filter(operation => operation.change === 'unsupported').length,
    removals: removals.length,
  };
  return {
    operations,
    preview: {
      previewDigest: digest(stateSignature),
      specDigest,
      title: String(doc.info?.title ?? 'Untitled API').slice(0, 200),
      openapiVersion: String(doc.openapi),
      sourceKind: source.sourceKind,
      prefix,
      baseUrl,
      security,
      existing: {
        backendId: backend?.id ?? null,
        backendOwned,
        authType: backend?.auth_type ?? null,
        hasCredential: backend?.has_credential ?? false,
        credentialReusable,
        importedToolCount: importedRows.length,
        assignedBundleIds: backend?.bundle_ids ?? [],
        sourceRevision: backend?.source_revision ?? null,
        sourceManifestDigest: backend?.source_manifest_digest ?? null,
        defaultBundleId: defaultBundle?.id ?? null,
        defaultBundleOwned,
      },
      operations: previewOperations,
      removals,
      counts,
      warnings,
    },
  };
}
