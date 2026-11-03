import pg from 'pg';

const { Pool } = pg;
let statusPool: pg.Pool | null = null;

function getStatusPool(connectionUrl: string): pg.Pool {
  if (!statusPool) statusPool = new Pool({ connectionString: connectionUrl });
  return statusPool;
}

import type { Config } from '../config/env.js';
import type { DynamicToolRow } from '../tools/dynamic/index.js';
import type { CustomBackendRow } from '../backends/customBackends.js';
import { checkCustomBackend } from '../backends/customBackends.js';
import { checkRemoteMcp, getRemoteConnection } from '../backends/remoteMcpClients.js';

export interface BackendStatus {
  name: string;
  type: 'custom' | 'mcp';
  enabled: boolean;
  reachable: boolean | null;
  latencyMs: number | null;
  error: string | null;
  config: Record<string, string>;
  customId?: number;
  toolCount?: number;
  bundleIds?: number[];
}

async function checkPostgres(config: Config): Promise<Pick<BackendStatus, 'reachable' | 'latencyMs' | 'error'>> {
  try {
    const client = new pg.Client({ connectionString: config.postgresConnectionUrl });
    const start = Date.now();
    await client.connect();
    await client.query('SELECT 1');
    const latencyMs = Date.now() - start;
    await client.end();
    return { reachable: true, latencyMs, error: null };
  } catch (err) {
    return { reachable: false, latencyMs: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function maskConnectionUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '****';
    return parsed.toString();
  } catch {
    return '****';
  }
}

export async function getStatus(
  config: Config,
  dynamicTools: DynamicToolRow[],
  customBackends: CustomBackendRow[] = [],
): Promise<{
  backends: BackendStatus[];
  server: Record<string, unknown>;
  dynamicTools: DynamicToolRow[];
  customBackends: CustomBackendRow[];
  remoteTools: Array<{ id: number; backend_id: number; backend_name: string; tool_name: string; prefixed_name: string; description: string; bundle_ids: number[] }>;
  bundles: Array<{ id: number; label: string; icon: string; backend_count: number; tool_count: number }>;
}> {
  const backends: BackendStatus[] = [];
  const checks: Promise<unknown>[] = [];

  if (config.postgresEnabled) {
    const pgStatus: BackendStatus = {
      name: 'PostgreSQL', type: 'custom', enabled: true,
      reachable: null, latencyMs: null, error: null,
      config: { connectionUrl: maskConnectionUrl(config.postgresConnectionUrl) },
    };
    backends.push(pgStatus);
    checks.push(checkPostgres(config).then(result => Object.assign(pgStatus, result)));
  }

  for (const backend of customBackends) {
    if (backend.backend_type === 'mcp') {
      const connection = getRemoteConnection(backend.id);
      const mcpStatus: BackendStatus = {
        name: backend.name, type: 'mcp', enabled: backend.enabled,
        reachable: null, latencyMs: null, error: null,
        config: { url: backend.base_url, endpoint: backend.mcp_endpoint || '/mcp' },
        customId: backend.id, toolCount: connection?.tools.length ?? 0, bundleIds: backend.bundle_ids,
      };
      backends.push(mcpStatus);
      if (backend.enabled) {
        checks.push(checkRemoteMcp(backend.id).then(result => Object.assign(mcpStatus, {
          reachable: result.reachable, latencyMs: result.latencyMs, error: result.error, toolCount: result.toolCount,
        })));
      }
    } else {
      const backendStatus: BackendStatus = {
        name: backend.name, type: 'custom', enabled: backend.enabled,
        reachable: null, latencyMs: null, error: null,
        config: { url: backend.base_url, auth: backend.auth_type },
        customId: backend.id, bundleIds: backend.bundle_ids,
      };
      backends.push(backendStatus);
      if (backend.enabled) checks.push(checkCustomBackend(backend).then(result => Object.assign(backendStatus, result)));
    }
  }

  await Promise.allSettled(checks);

  let bundles: Array<{ id: number; label: string; icon: string; backend_count: number; tool_count: number }> = [];
  let remoteTools: Array<{ id: number; backend_id: number; backend_name: string; tool_name: string; prefixed_name: string; description: string; bundle_ids: number[] }> = [];
  if (config.postgresEnabled) {
    try {
      const pool = getStatusPool(config.postgresConnectionUrl);
      const { rows } = await pool.query(`
        SELECT b.id, b.label, b.icon,
          (SELECT count(*) FROM mcp_backend_bundles WHERE bundle_id = b.id)::int AS backend_count,
          (
            (SELECT count(*) FROM mcp_tool_bundles WHERE bundle_id = b.id)
            + (SELECT count(*) FROM mcp_remote_tools rt
               JOIN mcp_backend_bundles bb ON bb.backend_id = rt.backend_id
               LEFT JOIN mcp_bundle_backend_tool_policies policy
                 ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
               WHERE bb.bundle_id = b.id
                 AND (policy.mode IS NULL OR policy.mode = 'all' OR rt.prefixed_name = ANY(policy.allowed_tool_names)))
          )::int AS tool_count
        FROM mcp_service_bundles b ORDER BY b.label
      `);
      bundles = rows;

      const toolResult = await pool.query(`
        SELECT rt.id, rt.backend_id, b.name AS backend_name, rt.tool_name, rt.prefixed_name, rt.description,
          COALESCE((
            SELECT array_agg(bb.bundle_id)
              FROM mcp_backend_bundles bb
              LEFT JOIN mcp_bundle_backend_tool_policies policy
                ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
             WHERE bb.backend_id = rt.backend_id
               AND (policy.mode IS NULL OR policy.mode = 'all' OR rt.prefixed_name = ANY(policy.allowed_tool_names))
          ), '{}') AS bundle_ids
        FROM mcp_remote_tools rt
        JOIN mcp_backends b ON b.id = rt.backend_id
        ORDER BY rt.prefixed_name
      `);
      remoteTools = toolResult.rows;
    } catch { /* status data remains available without optional bundle metadata */ }
  }

  return {
    server: {
      name: 'argus-core', version: '1.0.0', port: config.port,
      uptime: `${Math.floor(process.uptime())}s`, nodeVersion: process.version,
      mcpEndpoint: '/mcp', dynamicToolsLoaded: dynamicTools.length,
      rateLimitPerMinute: config.rateLimitPerMinute, maxResultRows: config.maxResultRows,
    },
    backends, dynamicTools, customBackends, remoteTools, bundles,
  };
}
