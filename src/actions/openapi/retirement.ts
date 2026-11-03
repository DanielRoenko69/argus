import { createHash } from 'node:crypto';
import type pg from 'pg';

export type OpenApiSourceRetirementErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'ownership_mismatch'
  | 'baseline_changed'
  | 'impact_changed';

/** Expected retirement failures whose message is safe to return to an API client. */
export class OpenApiSourceRetirementError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code: OpenApiSourceRetirementErrorCode = 'invalid_request',
  ) {
    super(message);
    this.name = 'OpenApiSourceRetirementError';
  }
}

export interface OpenApiSourceRetirementCapabilityImpact {
  id: number;
  name: string;
  isWrite: boolean;
  enabled: boolean;
  bundleIds: number[];
  workflowCount: number;
}

export interface OpenApiSourceRetirementBundleImpact {
  id: number;
  name: string;
  label: string;
  connectionAssigned: boolean;
  capabilityIds: number[];
  capabilityNames: string[];
}

export interface OpenApiSourceRetirementWorkflowImpact {
  id: number;
  name: string;
  capabilityNames: string[];
}

export interface OpenApiSourceRetirementImpact {
  capabilities: OpenApiSourceRetirementCapabilityImpact[];
  bundles: OpenApiSourceRetirementBundleImpact[];
  workflows: OpenApiSourceRetirementWorkflowImpact[];
}

export interface OpenApiSourceRetirementConfirmation {
  expectedPrefix: string;
  expectedRevision: string;
  expectedManifestDigest: string | null;
  expectedImpactDigest: string;
}

export interface OpenApiSourceRetirementPreview {
  source: {
    id: number;
    name: string;
    prefix: string;
    revision: string;
    manifestDigest: string | null;
    operationCount: number;
  };
  backend: {
    id: number;
    name: string;
    enabled: boolean;
  };
  impact: OpenApiSourceRetirementImpact;
  confirmation: OpenApiSourceRetirementConfirmation;
}

export interface OpenApiSourceRetirementResult {
  sourceId: number;
  backendId: number;
  prefix: string;
  deletedCapabilities: Array<{ id: number; name: string }>;
  deletedCapabilityCount: number;
  preservedBundleIds: number[];
  preservedWorkflowIds: number[];
  retiredAt: string;
}

interface SourceHintRow {
  backend_id: number;
  name_prefix: string;
}

interface SourceRow extends SourceHintRow {
  id: number;
  title: string;
  revision: string;
  manifest_digest: string | null;
  operation_count: number;
}

interface BackendRow {
  id: number;
  name: string;
  enabled: boolean;
}

interface PreviewSourceRow extends SourceRow {
  backend_name: string;
  backend_enabled: boolean;
}

interface ToolRow {
  id: number;
  name: string;
  category: string | null;
  backend: string;
  is_write: boolean;
  enabled: boolean;
  mapped_name: string | null;
}

interface BackendBundleRow {
  id: number;
  name: string;
  label: string;
}

interface ToolBundleRow extends BackendBundleRow {
  tool_id: number;
}

interface WorkflowRow {
  id: number;
  name: string;
  capability_names: string[];
}

const PREFIX_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const REVISION_PATTERN = /^[1-9]\d*$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_DATABASE_ID = 2_147_483_647;

function parseSourceId(rawSourceId: number | string): number {
  if (typeof rawSourceId === 'string' && !/^[1-9]\d*$/.test(rawSourceId)) {
    throw new OpenApiSourceRetirementError('Source-ID ist ungültig');
  }
  const sourceId = typeof rawSourceId === 'number' ? rawSourceId : Number(rawSourceId);
  if (!Number.isSafeInteger(sourceId) || sourceId < 1 || sourceId > MAX_DATABASE_ID) {
    throw new OpenApiSourceRetirementError('Source-ID ist ungültig');
  }
  return sourceId;
}

function parseConfirmation(raw: unknown): OpenApiSourceRetirementConfirmation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenApiSourceRetirementError('Retirement-Bestätigung fehlt');
  }
  const body = raw as Record<string, unknown>;
  const allowedKeys = new Set([
    'expectedPrefix',
    'expectedRevision',
    'expectedManifestDigest',
    'expectedImpactDigest',
  ]);
  const unknownKey = Object.keys(body).find(key => !allowedKeys.has(key));
  if (unknownKey
    || typeof body['expectedPrefix'] !== 'string'
    || !PREFIX_PATTERN.test(body['expectedPrefix'])
    || typeof body['expectedRevision'] !== 'string'
    || !REVISION_PATTERN.test(body['expectedRevision'])
    || (body['expectedManifestDigest'] !== null
      && (typeof body['expectedManifestDigest'] !== 'string'
        || !DIGEST_PATTERN.test(body['expectedManifestDigest'])))
    || typeof body['expectedImpactDigest'] !== 'string'
    || !DIGEST_PATTERN.test(body['expectedImpactDigest'])) {
    throw new OpenApiSourceRetirementError('Retirement-Bestätigung ist ungültig');
  }
  return {
    expectedPrefix: body['expectedPrefix'],
    expectedRevision: body['expectedRevision'],
    expectedManifestDigest: body['expectedManifestDigest'],
    expectedImpactDigest: body['expectedImpactDigest'],
  } as OpenApiSourceRetirementConfirmation;
}

function validatePersistedSource(source: SourceRow, backend: BackendRow): void {
  if (!PREFIX_PATTERN.test(source.name_prefix)
    || !REVISION_PATTERN.test(source.revision)
    || (source.manifest_digest !== null && !DIGEST_PATTERN.test(source.manifest_digest))
    || !Number.isSafeInteger(Number(source.operation_count))
    || Number(source.operation_count) < 0
    || Number(source.operation_count) > 500
    || source.backend_id !== backend.id
    || source.name_prefix !== backend.name) {
    throw new OpenApiSourceRetirementError(
      'Capability Source besitzt keine sicher auflösbare OpenAPI-Ownership',
      409,
      'ownership_mismatch',
    );
  }
}

function validateOwnedTools(source: SourceRow, backend: BackendRow, tools: ToolRow[]): void {
  const category = `openapi:${source.name_prefix}`;
  const backendRef = `custom:${backend.name}`;
  const invalid = tools.find(tool => tool.category !== category
    || tool.backend !== backendRef
    || !tool.name.startsWith(`${source.name_prefix}__`)
    || (tool.mapped_name !== null && tool.mapped_name !== tool.name));
  if (invalid) {
    throw new OpenApiSourceRetirementError(
      'Die materialisierten Capabilities stimmen nicht mehr eindeutig mit der OpenAPI-Quelle überein',
      409,
      'ownership_mismatch',
    );
  }
}

async function loadOwnedTools(
  client: pg.PoolClient,
  source: SourceRow,
  backend: BackendRow,
  lock: boolean,
): Promise<ToolRow[]> {
  const result = await client.query<ToolRow>(
    `SELECT tool.id, tool.name, tool.category, tool.backend,
            tool.is_write, tool.enabled,
            (SELECT operation.tool_name
               FROM mcp_capability_source_operations operation
              WHERE operation.source_id = $1
                AND operation.tool_id = tool.id
              LIMIT 1) AS mapped_name
       FROM mcp_tools tool
      WHERE (tool.category = $2 AND tool.backend = $3)
         OR EXISTS (
              SELECT 1
                FROM mcp_capability_source_operations operation
               WHERE operation.source_id = $1
                 AND operation.tool_id = tool.id
            )
      ORDER BY tool.id${lock ? '\n      FOR UPDATE OF tool' : ''}`,
    [source.id, `openapi:${source.name_prefix}`, `custom:${backend.name}`],
  );
  validateOwnedTools(source, backend, result.rows);
  return result.rows;
}

function normalizeId(value: number, entity: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1 || id > MAX_DATABASE_ID) {
    throw new OpenApiSourceRetirementError(
      `${entity} besitzt einen ungültigen Retirement-Impact`,
      409,
      'ownership_mismatch',
    );
  }
  return id;
}

async function loadImpact(
  client: pg.PoolClient,
  backend: BackendRow,
  tools: ToolRow[],
): Promise<OpenApiSourceRetirementImpact> {
  const toolIds = tools.map(tool => normalizeId(tool.id, 'Capability'));
  const toolNames = tools.map(tool => tool.name);
  const [backendBundles, toolBundles, workflows] = await Promise.all([
    client.query<BackendBundleRow>(
      `SELECT bundle.id, bundle.name, bundle.label
         FROM mcp_backend_bundles assignment
         JOIN mcp_service_bundles bundle ON bundle.id = assignment.bundle_id
        WHERE assignment.backend_id = $1
        ORDER BY bundle.id`,
      [backend.id],
    ),
    client.query<ToolBundleRow>(
      `SELECT assignment.tool_id, bundle.id, bundle.name, bundle.label
         FROM mcp_tool_bundles assignment
         JOIN mcp_service_bundles bundle ON bundle.id = assignment.bundle_id
        WHERE assignment.tool_id = ANY($1::int[])
        ORDER BY bundle.id, assignment.tool_id`,
      [toolIds],
    ),
    client.query<WorkflowRow>(
      `SELECT workflow.id, workflow.name,
              ARRAY(
                SELECT DISTINCT step->>'tool'
                  FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(workflow.steps) = 'array'
                      THEN workflow.steps ELSE '[]'::jsonb END
                  ) step
                 WHERE step->>'tool' = ANY($1::text[])
                 ORDER BY step->>'tool'
              )::text[] AS capability_names
         FROM mcp_workflows workflow
        WHERE EXISTS (
          SELECT 1
            FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(workflow.steps) = 'array'
                THEN workflow.steps ELSE '[]'::jsonb END
              ) step
           WHERE step->>'tool' = ANY($1::text[])
        )
        ORDER BY workflow.id`,
      [toolNames],
    ),
  ]);

  const capabilityById = new Map<number, OpenApiSourceRetirementCapabilityImpact>();
  for (const tool of tools) {
    const id = normalizeId(tool.id, 'Capability');
    capabilityById.set(id, {
      id,
      name: tool.name,
      isWrite: tool.is_write,
      enabled: tool.enabled,
      bundleIds: [],
      workflowCount: 0,
    });
  }

  const bundlesById = new Map<number, OpenApiSourceRetirementBundleImpact>();
  for (const row of backendBundles.rows) {
    const id = normalizeId(row.id, 'Bundle');
    bundlesById.set(id, {
      id,
      name: row.name,
      label: row.label,
      connectionAssigned: true,
      capabilityIds: [],
      capabilityNames: [],
    });
  }
  for (const row of toolBundles.rows) {
    const bundleId = normalizeId(row.id, 'Bundle');
    const toolId = normalizeId(row.tool_id, 'Capability');
    const capability = capabilityById.get(toolId);
    if (!capability) {
      throw new OpenApiSourceRetirementError(
        'Bundle-Impact verweist nicht eindeutig auf eine Source-Capability',
        409,
        'ownership_mismatch',
      );
    }
    capability.bundleIds.push(bundleId);
    const bundle = bundlesById.get(bundleId) ?? {
      id: bundleId,
      name: row.name,
      label: row.label,
      connectionAssigned: false,
      capabilityIds: [],
      capabilityNames: [],
    };
    if (bundle.name !== row.name || bundle.label !== row.label) {
      throw new OpenApiSourceRetirementError(
        'Bundle-Impact ist nicht eindeutig',
        409,
        'ownership_mismatch',
      );
    }
    bundle.capabilityIds.push(toolId);
    bundle.capabilityNames.push(capability.name);
    bundlesById.set(bundleId, bundle);
  }

  const workflowsImpact = workflows.rows.map(row => {
    const names = [...new Set(row.capability_names ?? [])].sort();
    if (names.some(name => !toolNames.includes(name))) {
      throw new OpenApiSourceRetirementError(
        'Workflow-Impact verweist nicht eindeutig auf eine Source-Capability',
        409,
        'ownership_mismatch',
      );
    }
    for (const name of names) {
      const capability = [...capabilityById.values()].find(item => item.name === name);
      if (capability) capability.workflowCount += 1;
    }
    return {
      id: normalizeId(row.id, 'Workflow'),
      name: row.name,
      capabilityNames: names,
    };
  });

  const capabilities = [...capabilityById.values()]
    .map(capability => ({
      ...capability,
      bundleIds: [...new Set(capability.bundleIds)].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id);
  const bundles = [...bundlesById.values()]
    .map(bundle => ({
      ...bundle,
      capabilityIds: [...new Set(bundle.capabilityIds)].sort((left, right) => left - right),
      capabilityNames: [...new Set(bundle.capabilityNames)].sort(),
    }))
    .sort((left, right) => left.id - right.id);
  const normalizedWorkflows = workflowsImpact.sort((left, right) => left.id - right.id);
  return { capabilities, bundles, workflows: normalizedWorkflows };
}

function retirementImpactDigest(impact: OpenApiSourceRetirementImpact): string {
  return createHash('sha256').update(JSON.stringify(impact)).digest('hex');
}

function toPreview(
  source: SourceRow,
  backend: BackendRow,
  impact: OpenApiSourceRetirementImpact,
): OpenApiSourceRetirementPreview {
  const expectedImpactDigest = retirementImpactDigest(impact);
  return {
    source: {
      id: Number(source.id),
      name: source.title || backend.name,
      prefix: source.name_prefix,
      revision: source.revision,
      manifestDigest: source.manifest_digest,
      operationCount: Number(source.operation_count),
    },
    backend: {
      id: Number(backend.id),
      name: backend.name,
      enabled: backend.enabled,
    },
    impact,
    confirmation: {
      expectedPrefix: source.name_prefix,
      expectedRevision: source.revision,
      expectedManifestDigest: source.manifest_digest,
      expectedImpactDigest,
    },
  };
}

/** Build a transactionally consistent, credential-free retirement impact preview. */
export async function previewOpenApiSourceRetirement(
  pool: pg.Pool,
  rawSourceId: number | string,
): Promise<OpenApiSourceRetirementPreview> {
  const sourceId = parseSourceId(rawSourceId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row = (await client.query<PreviewSourceRow>(
      `SELECT source.id, source.backend_id, source.name_prefix, source.title,
              source.revision::text AS revision, source.manifest_digest,
              source.operation_count, backend.name AS backend_name,
              backend.enabled AS backend_enabled
         FROM mcp_capability_sources source
         JOIN mcp_backends backend ON backend.id = source.backend_id
        WHERE source.id = $1`,
      [sourceId],
    )).rows[0];
    if (!row) {
      throw new OpenApiSourceRetirementError(
        'Capability Source wurde nicht gefunden',
        404,
        'not_found',
      );
    }
    const backend: BackendRow = { id: row.backend_id, name: row.backend_name, enabled: row.backend_enabled };
    validatePersistedSource(row, backend);
    const tools = await loadOwnedTools(client, row, backend, false);
    const impact = await loadImpact(client, backend, tools);
    await client.query('COMMIT');
    return toPreview(row, backend, impact);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Retire one OpenAPI source after revalidating the exact preview baseline and
 * impact. Bundles and workflows are deliberately preserved; only importer-owned
 * capabilities and the source backend are removed in the transaction.
 */
export async function retireOpenApiSource(
  pool: pg.Pool,
  rawSourceId: number | string,
  rawConfirmation: unknown,
): Promise<OpenApiSourceRetirementResult> {
  const sourceId = parseSourceId(rawSourceId);
  const confirmation = parseConfirmation(rawConfirmation);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // This first read is only a lock-key/backend hint. All authoritative state
    // is fetched again after following the importer's lock order.
    const hint = (await client.query<SourceHintRow>(
      `SELECT source.backend_id, source.name_prefix
         FROM mcp_capability_sources source
        WHERE source.id = $1`,
      [sourceId],
    )).rows[0];
    if (!hint) {
      throw new OpenApiSourceRetirementError(
        'Capability Source wurde nicht gefunden',
        404,
        'not_found',
      );
    }

    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`openapi:${hint.name_prefix}`]);
    const backend = (await client.query<BackendRow>(
      `SELECT backend.id, backend.name, backend.enabled
         FROM mcp_backends backend
        WHERE backend.id = $1
        FOR UPDATE OF backend`,
      [hint.backend_id],
    )).rows[0];
    if (!backend) {
      throw new OpenApiSourceRetirementError(
        'Capability Source wurde nicht gefunden',
        404,
        'not_found',
      );
    }
    const source = (await client.query<SourceRow>(
      `SELECT source.id, source.backend_id, source.name_prefix, source.title,
              source.revision::text AS revision, source.manifest_digest,
              source.operation_count
         FROM mcp_capability_sources source
        WHERE source.id = $1
          AND source.backend_id = $2
        FOR UPDATE OF source`,
      [sourceId, backend.id],
    )).rows[0];
    if (!source) {
      throw new OpenApiSourceRetirementError(
        'Capability Source Baseline wurde während der Bestätigung verändert',
        409,
        'baseline_changed',
      );
    }
    validatePersistedSource(source, backend);
    if (source.name_prefix !== hint.name_prefix
      || source.backend_id !== hint.backend_id
      || source.name_prefix !== confirmation.expectedPrefix
      || source.revision !== confirmation.expectedRevision
      || source.manifest_digest !== confirmation.expectedManifestDigest) {
      throw new OpenApiSourceRetirementError(
        'Capability Source Baseline wurde seit der Vorschau verändert',
        409,
        'baseline_changed',
      );
    }

    const tools = await loadOwnedTools(client, source, backend, true);
    // Freeze assignment topology and workflow references after the required
    // advisory → backend → source → tools row-lock order. The retained rows can
    // then be compared with the preview without a post-check write race.
    await client.query('LOCK TABLE mcp_backend_bundles, mcp_tool_bundles, mcp_workflows IN SHARE MODE');
    const impact = await loadImpact(client, backend, tools);
    if (retirementImpactDigest(impact) !== confirmation.expectedImpactDigest) {
      throw new OpenApiSourceRetirementError(
        'Retirement-Impact wurde seit der Vorschau verändert',
        409,
        'impact_changed',
      );
    }

    const expectedDeleted = tools
      .map(tool => ({ id: Number(tool.id), name: tool.name }))
      .sort((left, right) => left.id - right.id);
    let deletedCapabilities: Array<{ id: number; name: string }> = [];
    if (expectedDeleted.length > 0) {
      deletedCapabilities = (await client.query<{ id: number; name: string }>(
        `DELETE FROM mcp_tools
          WHERE id = ANY($1::int[])
            AND category = $2
            AND backend = $3
        RETURNING id, name`,
        [
          expectedDeleted.map(capability => capability.id),
          `openapi:${source.name_prefix}`,
          `custom:${backend.name}`,
        ],
      )).rows
        .map(row => ({ id: Number(row.id), name: row.name }))
        .sort((left, right) => left.id - right.id);
      if (deletedCapabilities.length !== expectedDeleted.length
        || deletedCapabilities.some((capability, index) => capability.id !== expectedDeleted[index]!.id
          || capability.name !== expectedDeleted[index]!.name)) {
        throw new OpenApiSourceRetirementError(
          'Source-Capabilities wurden während des Retirements verändert',
          409,
          'impact_changed',
        );
      }
    }

    const deletedBackend = await client.query<{ id: number }>(
      `DELETE FROM mcp_backends
        WHERE id = $1
          AND name = $2
      RETURNING id`,
      [backend.id, backend.name],
    );
    if (deletedBackend.rows.length !== 1) {
      throw new OpenApiSourceRetirementError(
        'Capability Source Baseline wurde während des Retirements verändert',
        409,
        'baseline_changed',
      );
    }

    await client.query('COMMIT');
    return {
      sourceId: source.id,
      backendId: backend.id,
      prefix: source.name_prefix,
      deletedCapabilities,
      deletedCapabilityCount: deletedCapabilities.length,
      preservedBundleIds: impact.bundles.map(bundle => bundle.id),
      preservedWorkflowIds: impact.workflows.map(workflow => workflow.id),
      retiredAt: new Date().toISOString(),
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
