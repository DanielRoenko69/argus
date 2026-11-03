import pg from 'pg';
import { logger } from '../lib/logger.js';
import {
  isOpenApiCategory,
  isOpenApiManagedConfig,
  OpenApiOwnershipError,
} from '../lib/openApiOwnership.js';
import { listBundleToolPolicies, toolAllowedByPolicy } from './toolPolicies.js';

// ── Types ────────────────────────────────────────────────────

export interface ServiceBundle {
  id: number;
  name: string;
  label: string;
  description: string;
  icon: string;
  system_prompt: string | null;
  agent_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface BundleWithStats extends ServiceBundle {
  backend_count: number;
  tool_count: number;
  composite_count?: number;
}

export interface CreateBundleInput {
  name: string;
  label: string;
  description?: string;
  icon?: string;
  system_prompt?: string;
  agent_role?: string;
}

export interface UpdateBundleInput {
  label?: string;
  description?: string;
  icon?: string;
  system_prompt?: string;
  agent_role?: string;
}

// ── CRUD ─────────────────────────────────────────────────────

export async function listBundles(pool: pg.Pool): Promise<BundleWithStats[]> {
  const { rows } = await pool.query<BundleWithStats>(`
    SELECT b.*,
      (SELECT count(*) FROM mcp_backend_bundles WHERE bundle_id = b.id)::int AS backend_count,
      (
        (SELECT count(*) FROM mcp_tool_bundles WHERE bundle_id = b.id)
        + (SELECT count(*) FROM mcp_remote_tools rt
           JOIN mcp_backend_bundles bb ON bb.backend_id = rt.backend_id
           LEFT JOIN mcp_bundle_backend_tool_policies policy
             ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
           WHERE bb.bundle_id = b.id
             AND (
               policy.mode IS NULL
               OR policy.mode = 'all'
               OR rt.prefixed_name = ANY(policy.allowed_tool_names)
             ))
      )::int AS tool_count,
      (SELECT count(*) FROM mcp_composites c
         WHERE b.id = ANY(c.included_bundle_ids))::int AS composite_count
    FROM mcp_service_bundles b
    ORDER BY b.label
  `);
  return rows;
}

export async function getBundle(pool: pg.Pool, id: number): Promise<BundleWithStats | null> {
  const { rows } = await pool.query<BundleWithStats>(`
    SELECT b.*,
      (SELECT count(*) FROM mcp_backend_bundles WHERE bundle_id = b.id)::int AS backend_count,
      (
        (SELECT count(*) FROM mcp_tool_bundles WHERE bundle_id = b.id)
        + (SELECT count(*) FROM mcp_remote_tools rt
           JOIN mcp_backend_bundles bb ON bb.backend_id = rt.backend_id
           LEFT JOIN mcp_bundle_backend_tool_policies policy
             ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
           WHERE bb.bundle_id = b.id
             AND (
               policy.mode IS NULL
               OR policy.mode = 'all'
               OR rt.prefixed_name = ANY(policy.allowed_tool_names)
             ))
      )::int AS tool_count
    FROM mcp_service_bundles b
    WHERE b.id = $1
  `, [id]);
  return rows[0] ?? null;
}

export async function getBundleByName(pool: pg.Pool, name: string): Promise<ServiceBundle | null> {
  const { rows } = await pool.query<ServiceBundle>(
    'SELECT * FROM mcp_service_bundles WHERE name = $1',
    [name],
  );
  return rows[0] ?? null;
}

export async function createBundle(pool: pg.Pool, input: CreateBundleInput): Promise<ServiceBundle> {
  const { rows } = await pool.query<ServiceBundle>(
    `INSERT INTO mcp_service_bundles (name, label, description, icon, system_prompt, agent_role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.name, input.label, input.description ?? '', input.icon ?? '', input.system_prompt ?? null, input.agent_role ?? null],
  );
  logger.info({ bundle: input.name }, 'Service bundle created');
  return rows[0];
}

export async function updateBundle(pool: pg.Pool, id: number, input: UpdateBundleInput): Promise<ServiceBundle> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.label !== undefined) { sets.push(`label = $${idx++}`); values.push(input.label); }
  if (input.description !== undefined) { sets.push(`description = $${idx++}`); values.push(input.description); }
  if (input.icon !== undefined) { sets.push(`icon = $${idx++}`); values.push(input.icon); }
  if (input.system_prompt !== undefined) { sets.push(`system_prompt = $${idx++}`); values.push(input.system_prompt || null); }
  if (input.agent_role !== undefined) { sets.push(`agent_role = $${idx++}`); values.push(input.agent_role || null); }

  if (sets.length === 0) {
    const existing = await getBundle(pool, id);
    if (!existing) throw new Error(`Bundle ${id} not found`);
    return existing;
  }

  values.push(id);
  const { rows } = await pool.query<ServiceBundle>(
    `UPDATE mcp_service_bundles SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
    values,
  );
  if (rows.length === 0) throw new Error(`Bundle ${id} not found`);
  logger.info({ bundleId: id }, 'Service bundle updated');
  return rows[0];
}

export async function deleteBundle(
  pool: pg.Pool,
  id: number,
  deleteContents: boolean,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Import/re-import takes one advisory lock per OpenAPI prefix before
    // touching the backend, source manifest, tools or bundle assignments.
    // Acquire the same locks before the bundle row to avoid a lifecycle ↔
    // bundle-row lock inversion. Even a plain bundle delete cascades its
    // assignments, so every delete must protect source bundle boundaries.
    const lifecyclePrefixes = (await client.query<{ name_prefix: string }>(
        `SELECT DISTINCT candidate.name_prefix
           FROM (
             SELECT source.name_prefix
               FROM mcp_capability_sources source
               JOIN mcp_backend_bundles assignment ON assignment.backend_id = source.backend_id
              WHERE assignment.bundle_id = $1
             UNION
             SELECT lower(backend.name) AS name_prefix
               FROM mcp_backends backend
               JOIN mcp_backend_bundles assignment ON assignment.backend_id = backend.id
              WHERE assignment.bundle_id = $1
                AND backend.config->>'managed_by' = 'openapi'
             UNION
             SELECT source.name_prefix
               FROM mcp_capability_sources source
               JOIN mcp_capability_source_operations operation ON operation.source_id = source.id
               JOIN mcp_tool_bundles assignment ON assignment.tool_id = operation.tool_id
              WHERE assignment.bundle_id = $1
             UNION
             SELECT lower(substring(tool.category FROM 9)) AS name_prefix
               FROM mcp_tools tool
               JOIN mcp_tool_bundles assignment ON assignment.tool_id = tool.id
              WHERE assignment.bundle_id = $1
                AND lower(tool.category) LIKE 'openapi:%'
           ) candidate
          WHERE candidate.name_prefix IS NOT NULL
            AND candidate.name_prefix <> ''
          ORDER BY candidate.name_prefix`,
        [id],
    )).rows.map(row => row.name_prefix);
    for (const prefix of lifecyclePrefixes) {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`openapi:${prefix}`]);
    }

    const bundle = await client.query<{ id: number }>(
      'SELECT id FROM mcp_service_bundles WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (bundle.rows.length === 0) throw new Error(`Bundle ${id} not found`);

    const backends = await client.query<{
        id: number;
        name: string;
        config: unknown;
        source_controlled: boolean;
      }>(
        `SELECT backend.id,
                backend.name,
                backend.config,
                EXISTS (
                  SELECT 1
                    FROM mcp_capability_sources source
                   WHERE source.backend_id = backend.id
                ) AS source_controlled
           FROM mcp_backends backend
           JOIN mcp_backend_bundles assignment ON assignment.backend_id = backend.id
          WHERE assignment.bundle_id = $1
          ORDER BY backend.id
          FOR UPDATE OF backend`,
        [id],
      );
    const tools = await client.query<{
        id: number;
        name: string;
        category: string | null;
        source_controlled: boolean;
      }>(
        `SELECT tool.id,
                tool.name,
                tool.category,
                EXISTS (
                  SELECT 1
                    FROM mcp_capability_source_operations operation
                   WHERE operation.tool_id = tool.id
                ) AS source_controlled
           FROM mcp_tools tool
           JOIN mcp_tool_bundles assignment ON assignment.tool_id = tool.id
          WHERE assignment.bundle_id = $1
          ORDER BY tool.id
          FOR UPDATE OF tool`,
        [id],
      );
    const protectedBackend = backends.rows.find(row =>
      row.source_controlled || isOpenApiManagedConfig(row.config));
    const protectedTool = tools.rows.find(row =>
      row.source_controlled || isOpenApiCategory(row.category));
    if (protectedBackend || protectedTool) {
      throw new OpenApiOwnershipError(
        'Dieses Bundle ist eine Zugriffsgrenze für OpenAPI-verwaltete Capabilities oder Connections. '
        + 'Löse die Zuordnungen über einen kontrollierten Re-Import im Capability Studio.',
      );
    }

    if (deleteContents) {
      // Delete tools that belong exclusively to this bundle
      await client.query(
        `DELETE FROM mcp_tools WHERE id IN (SELECT tool_id FROM mcp_tool_bundles WHERE bundle_id = $1)`,
        [id],
      );
      // Delete backends that belong exclusively to this bundle
      await client.query(
        `DELETE FROM mcp_backends WHERE id IN (SELECT backend_id FROM mcp_backend_bundles WHERE bundle_id = $1)`,
        [id],
      );
    }
    // Junction table rows are removed via ON DELETE CASCADE on the bundle FK
    const { rowCount } = await client.query('DELETE FROM mcp_service_bundles WHERE id = $1', [id]);
    if (rowCount === 0) throw new Error(`Bundle ${id} not found`);

    await client.query('COMMIT');
    logger.info({ bundleId: id, deleteContents }, 'Service bundle deleted');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Bundle contents queries ──────────────────────────────────

export async function getBundleTools(pool: pg.Pool, bundleId: number): Promise<BundleToolRow[]> {
  const { rows } = await pool.query<BundleToolRow>(
    `SELECT t.id, t.name, t.description, t.backend, t.category, t.enabled
     FROM mcp_tools t
     JOIN mcp_tool_bundles tb ON tb.tool_id = t.id
     WHERE tb.bundle_id = $1
     ORDER BY t.name`,
    [bundleId],
  );
  return rows;
}

export interface BundleToolRow {
  id: number;
  name: string;
  description: string;
  backend: string;
  category: string | null;
  enabled: boolean;
}

export interface RemoteToolRow {
  id: number;
  tool_name: string;
  prefixed_name: string;
  description: string;
}

export interface DynToolRow {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
}

export interface BundleBackendRow {
  id: number;
  name: string;
  description: string;
  base_url: string;
  backend_type: string;
  enabled: boolean;
  mcp_endpoint: string | null;
  remote_tools: RemoteToolRow[];
  dynamic_tools: DynToolRow[];
  tool_policy: {
    mode: 'all' | 'selected';
    allowed_tool_names: string[];
  };
}

export async function getBundleBackends(pool: pg.Pool, bundleId: number): Promise<BundleBackendRow[]> {
  const { rows: backends } = await pool.query<Omit<BundleBackendRow, 'remote_tools'>>(
    `SELECT b.id, b.name, b.description, b.base_url, b.backend_type, b.enabled, b.mcp_endpoint
     FROM mcp_backends b
     JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
     WHERE bb.bundle_id = $1
     ORDER BY b.name`,
    [bundleId],
  );

  // Load remote tools for each MCP backend
  const backendIds = backends.filter(b => b.backend_type === 'mcp').map(b => b.id);
  const policies = await listBundleToolPolicies(pool, [bundleId]);
  const policyByBackend = new Map(policies.map(policy => [policy.backendId, policy]));
  let remoteToolMap = new Map<number, RemoteToolRow[]>();
  if (backendIds.length > 0) {
    const { rows: remoteTools } = await pool.query<RemoteToolRow & { backend_id: number }>(
      `SELECT id, backend_id, tool_name, prefixed_name, description
       FROM mcp_remote_tools
       WHERE backend_id = ANY($1)
       ORDER BY prefixed_name`,
      [backendIds],
    );
    for (const rt of remoteTools) {
      const list = remoteToolMap.get(rt.backend_id) ?? [];
      list.push({ id: rt.id, tool_name: rt.tool_name, prefixed_name: rt.prefixed_name, description: rt.description });
      remoteToolMap.set(rt.backend_id, list);
    }
  }

  // Load dynamic tools for each backend (by backend name reference)
  const backendNames = backends.map(b => b.name);
  let dynToolMap = new Map<string, DynToolRow[]>();
  if (backendNames.length > 0) {
    const { rows: dynTools } = await pool.query<DynToolRow & { backend: string }>(
      `SELECT id, name, description, enabled, backend
       FROM mcp_tools
       WHERE backend = ANY($1) OR backend = ANY(SELECT 'custom:' || n FROM unnest($1::text[]) n)
       ORDER BY name`,
      [backendNames],
    );
    for (const dt of dynTools) {
      // strip 'custom:' prefix to match back to backend name
      const backendKey = dt.backend.startsWith('custom:') ? dt.backend.slice(7) : dt.backend;
      const list = dynToolMap.get(backendKey) ?? [];
      list.push({ id: dt.id, name: dt.name, description: dt.description, enabled: dt.enabled });
      dynToolMap.set(backendKey, list);
    }
  }

  return backends.map(b => ({
    ...b,
    remote_tools: (remoteToolMap.get(b.id) ?? [])
      .filter(tool => toolAllowedByPolicy(tool.prefixed_name, policyByBackend.get(b.id))),
    dynamic_tools: (dynToolMap.get(b.name) ?? [])
      .filter(tool => toolAllowedByPolicy(tool.name, policyByBackend.get(b.id))),
    tool_policy: {
      mode: policyByBackend.get(b.id)?.mode ?? 'all',
      allowed_tool_names: policyByBackend.get(b.id)?.allowedToolNames ?? [],
    },
  }));
}
