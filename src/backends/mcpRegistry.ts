import { createHash } from 'node:crypto';
import type pg from 'pg';

export type McpTrustStatus = 'unverified' | 'trusted' | 'changed' | 'quarantined';

export interface RegistryToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCatalogChangeSummary {
  added: string[];
  removed: string[];
  changed: string[];
}

export interface McpRegistryEntry {
  backend_id: number;
  trust_status: McpTrustStatus;
  catalog_fingerprint: string;
  trusted_fingerprint: string | null;
  previous_fingerprint: string | null;
  tool_count: number;
  change_summary: McpCatalogChangeSummary;
  first_seen_at: string;
  last_seen_at: string;
  changed_at: string | null;
  verified_at: string | null;
  verified_by_user_id: number | null;
  verification_comment: string | null;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizedJson(child)]),
    );
  }
  return value;
}

function catalogRecord(tool: RegistryToolDescriptor): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: normalizedJson(tool.inputSchema),
  };
}

function catalogByName(tools: RegistryToolDescriptor[]): Map<string, string> {
  return new Map(
    tools.map(tool => [tool.name, JSON.stringify(catalogRecord(tool))]),
  );
}

export function fingerprintRemoteToolCatalog(tools: RegistryToolDescriptor[]): string {
  const catalog = tools
    .map(catalogRecord)
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
}

export function diffRemoteToolCatalogs(
  previous: RegistryToolDescriptor[],
  current: RegistryToolDescriptor[],
): McpCatalogChangeSummary {
  const oldCatalog = catalogByName(previous);
  const newCatalog = catalogByName(current);
  const added = [...newCatalog.keys()].filter(name => !oldCatalog.has(name)).sort();
  const removed = [...oldCatalog.keys()].filter(name => !newCatalog.has(name)).sort();
  const changed = [...newCatalog.keys()]
    .filter(name => oldCatalog.has(name) && oldCatalog.get(name) !== newCatalog.get(name))
    .sort();
  return { added, removed, changed };
}

export async function reconcileMcpRegistry(
  db: Queryable,
  backendId: number,
  previousTools: RegistryToolDescriptor[],
  currentTools: RegistryToolDescriptor[],
): Promise<McpRegistryEntry> {
  const fingerprint = fingerprintRemoteToolCatalog(currentTools);
  const summary = diffRemoteToolCatalogs(previousTools, currentTools);
  const existing = await db.query<McpRegistryEntry>(
    'SELECT * FROM mcp_registry_entries WHERE backend_id = $1 FOR UPDATE',
    [backendId],
  );

  if (existing.rows.length === 0) {
    const created = await db.query<McpRegistryEntry>(
      `INSERT INTO mcp_registry_entries (
         backend_id, trust_status, catalog_fingerprint, tool_count, change_summary, changed_at
       ) VALUES ($1, 'unverified', $2, $3, $4::jsonb, CASE WHEN $3 > 0 THEN now() ELSE NULL END)
       RETURNING *`,
      [backendId, fingerprint, currentTools.length, JSON.stringify(summary)],
    );
    return created.rows[0];
  }

  const entry = existing.rows[0];
  if (entry.catalog_fingerprint === fingerprint) {
    const unchanged = await db.query<McpRegistryEntry>(
      `UPDATE mcp_registry_entries
       SET tool_count = $2, last_seen_at = now()
       WHERE backend_id = $1
       RETURNING *`,
      [backendId, currentTools.length],
    );
    return unchanged.rows[0];
  }

  const trustStatus: McpTrustStatus = entry.trust_status === 'quarantined'
    ? 'quarantined'
    : entry.trusted_fingerprint === fingerprint
      ? 'trusted'
      : 'changed';
  const updated = await db.query<McpRegistryEntry>(
    `UPDATE mcp_registry_entries
     SET trust_status = $2,
         previous_fingerprint = catalog_fingerprint,
         catalog_fingerprint = $3,
         tool_count = $4,
         change_summary = $5::jsonb,
         last_seen_at = now(),
         changed_at = now()
     WHERE backend_id = $1
     RETURNING *`,
    [backendId, trustStatus, fingerprint, currentTools.length, JSON.stringify(summary)],
  );
  return updated.rows[0];
}

export async function setMcpRegistryTrust(
  pool: pg.Pool,
  backendId: number,
  status: 'trusted' | 'quarantined',
  userId: number,
  comment: string | null,
): Promise<McpRegistryEntry | null> {
  const result = await pool.query<McpRegistryEntry>(
    `UPDATE mcp_registry_entries registry
     SET trust_status = $2::varchar,
         trusted_fingerprint = CASE WHEN $2::varchar = 'trusted' THEN catalog_fingerprint ELSE trusted_fingerprint END,
         verified_at = now(),
         verified_by_user_id = $3,
         verification_comment = $4
     FROM mcp_backends backend
     WHERE registry.backend_id = $1
       AND backend.id = registry.backend_id
       AND backend.backend_type = 'mcp'
     RETURNING registry.*`,
    [backendId, status, userId, comment],
  );
  return result.rows[0] ?? null;
}
