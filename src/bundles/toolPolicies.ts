import type pg from 'pg';

export type BundleToolPolicyMode = 'all' | 'selected';

export interface BundleBackendToolPolicy {
  backendId: number;
  bundleId: number;
  mode: BundleToolPolicyMode;
  allowedToolNames: string[];
}

interface PolicyRow {
  backend_id: number;
  bundle_id: number;
  mode: BundleToolPolicyMode;
  allowed_tool_names: string[];
}

export async function listBundleToolPolicies(
  pool: pg.Pool,
  bundleIds?: number[],
): Promise<BundleBackendToolPolicy[]> {
  const result = await pool.query<PolicyRow>(
    `SELECT backend_id, bundle_id, mode, allowed_tool_names
       FROM mcp_bundle_backend_tool_policies
      ${bundleIds ? 'WHERE bundle_id = ANY($1::int[])' : ''}
      ORDER BY bundle_id, backend_id`,
    bundleIds ? [bundleIds] : [],
  );
  return result.rows.map(row => ({
    backendId: row.backend_id,
    bundleId: row.bundle_id,
    mode: row.mode,
    allowedToolNames: row.allowed_tool_names ?? [],
  }));
}

/**
 * Resolve the effective tool names for one or more bundles.
 *
 * Backend-owned tools follow the Bundle × Connection policy. Direct tools
 * without a backend keep the established mcp_tool_bundles semantics.
 * A backend/tool with no bundle assignment remains globally unscoped for
 * backwards compatibility unless includeUnscoped=false is requested by a
 * strict authorization boundary such as an explicitly bundled Agent.
 */
export async function loadAllowedToolNames(
  pool: pg.Pool,
  bundleIds: number[],
  options: { includeUnscoped?: boolean } = {},
): Promise<Set<string>> {
  if (bundleIds.length === 0) return new Set();
  const includeUnscoped = options.includeUnscoped ?? true;
  const result = await pool.query<{ name: string }>(
    `WITH dynamic_candidates AS (
       SELECT t.name,
              b.id AS backend_id
         FROM mcp_tools t
         LEFT JOIN mcp_backends b
           ON t.backend = b.name OR t.backend = 'custom:' || b.name
     ),
     allowed_dynamic AS (
       SELECT candidate.name
         FROM dynamic_candidates candidate
        WHERE (
          candidate.backend_id IS NULL
          AND (
            ($2::boolean AND NOT EXISTS (
              SELECT 1 FROM mcp_tools direct_tool
              JOIN mcp_tool_bundles direct_tb ON direct_tb.tool_id = direct_tool.id
              WHERE direct_tool.name = candidate.name
            ))
            OR EXISTS (
              SELECT 1 FROM mcp_tools direct_tool
              JOIN mcp_tool_bundles direct_tb ON direct_tb.tool_id = direct_tool.id
              WHERE direct_tool.name = candidate.name
                AND direct_tb.bundle_id = ANY($1::int[])
            )
          )
        ) OR (
          candidate.backend_id IS NOT NULL
          AND (
            ($2::boolean AND NOT EXISTS (
              SELECT 1 FROM mcp_backend_bundles any_bb
              WHERE any_bb.backend_id = candidate.backend_id
            ))
            OR EXISTS (
              SELECT 1
                FROM mcp_backend_bundles bb
                LEFT JOIN mcp_bundle_backend_tool_policies policy
                  ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
               WHERE bb.backend_id = candidate.backend_id
                 AND bb.bundle_id = ANY($1::int[])
                 AND (
                   policy.mode IS NULL
                   OR policy.mode = 'all'
                   OR candidate.name = ANY(policy.allowed_tool_names)
                 )
            )
          )
        )
     ),
     allowed_remote AS (
       SELECT remote.prefixed_name AS name
         FROM mcp_remote_tools remote
        WHERE ($2::boolean AND NOT EXISTS (
          SELECT 1 FROM mcp_backend_bundles any_bb
          WHERE any_bb.backend_id = remote.backend_id
        ))
        OR EXISTS (
          SELECT 1
            FROM mcp_backend_bundles bb
            LEFT JOIN mcp_bundle_backend_tool_policies policy
              ON policy.backend_id = bb.backend_id AND policy.bundle_id = bb.bundle_id
           WHERE bb.backend_id = remote.backend_id
             AND bb.bundle_id = ANY($1::int[])
             AND (
               policy.mode IS NULL
               OR policy.mode = 'all'
               OR remote.prefixed_name = ANY(policy.allowed_tool_names)
             )
        )
     )
     SELECT name FROM allowed_dynamic
     UNION
     SELECT name FROM allowed_remote`,
    [bundleIds, includeUnscoped],
  );
  return new Set(result.rows.map(row => row.name));
}

export function toolAllowedByPolicy(
  toolName: string,
  policy: Pick<BundleBackendToolPolicy, 'mode' | 'allowedToolNames'> | undefined,
): boolean {
  return !policy || policy.mode === 'all' || policy.allowedToolNames.includes(toolName);
}
