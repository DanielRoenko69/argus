import type pg from 'pg';

export interface ConnectionUser { id: number; role: string; allowed_bundles?: number[] | null }

/** Used on both connect and callback. A signed OAuth state is not an access grant. */
export async function canConnectToBackend(pool: pg.Pool, user: ConnectionUser, backendId: number): Promise<boolean> {
  if (!Number.isSafeInteger(backendId) || backendId < 1 || !Number.isSafeInteger(user.id) || user.id < 1) return false;
  const admin = ['admin', 'platform_admin', 'operations_admin'].includes(user.role);
  const bundles = !admin && Array.isArray(user.allowed_bundles) ? user.allowed_bundles : null;
  const result = await pool.query(
    `SELECT b.id FROM mcp_backends b
     WHERE b.id = $1 AND b.enabled = true AND b.auth_mode IN ('strict', 'permissive')
       AND COALESCE(b.oauth_authorize_url, '') <> '' AND COALESCE(b.oauth_token_url, '') <> ''
       AND COALESCE(b.oauth_client_id, '') <> '' AND COALESCE(b.oauth_client_secret, '') <> ''
       AND ($2::int[] IS NULL OR NOT EXISTS (SELECT 1 FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id)
         OR EXISTS (SELECT 1 FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id AND bb.bundle_id = ANY($2::int[])))`,
    [backendId, bundles],
  );
  return result.rows.length === 1;
}

export type ConnectionReadiness = 'disabled' | 'not_connected' | 'reconnect_required' | 'refresh_required' | 'ready';
export function connectionReadiness(connection: {
  connected: boolean; expires_at: Date | string | null; refresh_failed_at: Date | string | null;
  has_refresh_token: boolean; oauth_scopes: string[] | null; scopes_granted: string[] | null;
}, enabled: boolean, now = Date.now()): ConnectionReadiness {
  if (!enabled) return 'disabled';
  if (!connection.connected) return 'not_connected';
  if (connection.refresh_failed_at || (connection.oauth_scopes ?? []).some(scope => !(connection.scopes_granted ?? []).includes(scope))) return 'reconnect_required';
  const expiry = connection.expires_at ? new Date(connection.expires_at).getTime() : NaN;
  if (!Number.isFinite(expiry)) return 'reconnect_required';
  if (expiry <= now) return connection.has_refresh_token ? 'refresh_required' : 'reconnect_required';
  return 'ready';
}
