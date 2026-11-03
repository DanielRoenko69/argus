/**
 * upstreamTokens — per-User OAuth-Token-Storage für Token-Exchange-Pattern.
 *
 * Argus's Upstream-Calls (Bitbucket/Jira/Confluence/Gitea/GitHub) können
 * im Namen des End-Users statt mit Service-Account erfolgen, sobald der
 * User einmalig OAuth-consented hat. Tokens encrypted-at-rest via
 * AES-256-GCM (SECRET_KEY).
 *
 * Refresh-Logik: Bei jedem Use prüft `getValidToken()` ob expires_at <
 * now() + 60s und refresht dann transparent. Refresh-Failure setzt
 * refresh_failed_at → UI zeigt "re-consent required".
 *
 * Feature ist OFF by default. Aktivierung durch Platform-Config
 * Master-Switch upstream_token_exchange.enabled.
 */

import type pg from 'pg';
import { encrypt, decrypt, isCurrentlyEncrypted } from './encryption.js';
import { logger } from './logger.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { postOAuthForm, readOAuthTokenResponse } from './upstreamOAuthTransport.js';

export interface UpstreamTokenRow {
  user_id: number;
  backend_id: number;
  access_token: string;
  refresh_token?: string;
  expires_at: Date;
  scopes_granted: string[];
  upstream_username?: string;
  refresh_failed_at?: Date | null;
}

export function encryptToken(plain: string): string {
  const encrypted = encrypt(plain);
  if (!encrypted || !isCurrentlyEncrypted(encrypted)) throw new Error('OAuth tokens require DB_ENCRYPTION_KEY, including local environments');
  return encrypted;
}

export function decryptToken(enc: string | null | undefined): string | undefined {
  if (!enc) return undefined;
  const dec = decrypt(enc);
  if (dec === null) throw new Error('Token decryption failed (tampered or wrong key)');
  // encryption.decrypt() returns the raw encrypted value when both keys fail to authenticate;
  // for tokens we treat that as tampered/corrupted instead of silently leaking ciphertext.
  if (dec.startsWith('enc:v1:')) throw new Error('Token decryption failed (tampered or wrong key)');
  return dec;
}

const REFRESH_THRESHOLD_MS = 60_000;
export function needsRefresh(expiresAt: Date): boolean {
  return !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() - Date.now() < REFRESH_THRESHOLD_MS;
}

export interface BackendOAuthConfig {
  id: number;
  oauth_token_url: string;
  oauth_client_id: string;
  oauth_client_secret_enc: string;
}

export async function fetchTokenForUser(
  pool: Pick<pg.Pool, 'query'>,
  userId: number,
  backendId: number,
): Promise<UpstreamTokenRow | null> {
  const { rows } = await pool.query<{
    user_id: number; backend_id: number; access_token_enc: string;
    refresh_token_enc: string | null; expires_at: Date;
    scopes_granted: string[]; upstream_username: string | null; refresh_failed_at: Date | null;
  }>(
    `SELECT user_id, backend_id, access_token_enc, refresh_token_enc, expires_at, scopes_granted, upstream_username, refresh_failed_at
     FROM mcp_user_upstream_tokens
     WHERE user_id = $1 AND backend_id = $2`,
    [userId, backendId],
  );
  if (rows.length === 0) return null;
  const r = rows[0]!;
  return {
    user_id: r.user_id,
    backend_id: r.backend_id,
    access_token: decryptToken(r.access_token_enc) ?? '',
    refresh_token: decryptToken(r.refresh_token_enc),
    expires_at: r.expires_at,
    scopes_granted: r.scopes_granted,
    upstream_username: r.upstream_username ?? undefined,
    refresh_failed_at: r.refresh_failed_at,
  };
}

export async function storeToken(
  pool: pg.Pool,
  userId: number,
  backendId: number,
  tok: {
    access_token: string;
    refresh_token?: string;
    expires_in_sec: number;
    scopes_granted: string[];
    upstream_username?: string;
  },
): Promise<void> {
  if (!tok.access_token || !Number.isFinite(tok.expires_in_sec) || tok.expires_in_sec <= 0) throw new Error('Invalid upstream token lease');
  const expiresAt = new Date(Date.now() + tok.expires_in_sec * 1000);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [userId, backendId]);
    await client.query(
    `INSERT INTO mcp_user_upstream_tokens
       (user_id, backend_id, access_token_enc, refresh_token_enc, expires_at, scopes_granted, upstream_username)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, backend_id) DO UPDATE SET
       access_token_enc  = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       expires_at        = EXCLUDED.expires_at,
       scopes_granted    = EXCLUDED.scopes_granted,
       upstream_username = COALESCE(EXCLUDED.upstream_username, mcp_user_upstream_tokens.upstream_username),
       refresh_failed_at = NULL`,
    [
      userId, backendId,
      encryptToken(tok.access_token),
      tok.refresh_token ? encryptToken(tok.refresh_token) : null,
      expiresAt,
      tok.scopes_granted,
      tok.upstream_username ?? null,
    ],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  writeImmutableAudit(pool, {
    eventType: 'upstream_token_acquired',
    apiKeyPrefix: `user__${userId}`,
    userId,
    model: '',
    errorType: `backend:${backendId}`,
    riskLevel: 'medium',
  });
}

export async function revokeToken(pool: pg.Pool, userId: number, backendId: number): Promise<UpstreamTokenRow | null> {
  const client = await pool.connect();
  let removed: UpstreamTokenRow | null = null;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [userId, backendId]);
    // Capture the latest rotated token under the refresh lock, then prevent new use.
    // Corrupt ciphertext must not prevent a local disconnect.
    removed = await fetchTokenForUser(client, userId, backendId).catch(() => null);
    await client.query('DELETE FROM mcp_user_upstream_tokens WHERE user_id = $1 AND backend_id = $2', [userId, backendId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }
  writeImmutableAudit(pool, {
    eventType: 'upstream_token_revoked',
    apiKeyPrefix: `user__${userId}`,
    userId,
    model: '',
    errorType: `backend:${backendId}`,
    riskLevel: 'medium',
  });
  return removed;
}

/**
 * Lock-Key für `pg_advisory_xact_lock`: zwei int4 (user_id, backend_id).
 * Wir nutzen den 2-Param-Form damit die Lock-Scope auf (user_id, backend_id)
 * eindeutig ist. Verhindert Refresh-Race bei rotating Refresh Tokens (Bitbucket,
 * GitHub-Apps, Auth0, Okta) — sonst killt der Token-Rotate des einen Callers
 * den Refresh-Token des anderen → refresh_failed_at gesetzt obwohl alles fresh.
 */
export async function refreshAccessToken(
  pool: pg.Pool,
  userId: number,
  backendId: number,
  cfg: BackendOAuthConfig,
): Promise<UpstreamTokenRow | null> {
  const clientSecret = decryptToken(cfg.oauth_client_secret_enc);
  if (!clientSecret) return null;

  // H3 — Per-(user,backend) Lock. Use a transactional client so xact-lock auto-releases.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [userId, backendId]);

    // Re-fetch INSIDE the lock — der konkurrierende Caller könnte gerade refresht haben
    const { rows } = await client.query<{
      user_id: number; backend_id: number; access_token_enc: string;
      refresh_token_enc: string | null; expires_at: Date;
      scopes_granted: string[]; upstream_username: string | null; refresh_failed_at: Date | null;
    }>(
      `SELECT user_id, backend_id, access_token_enc, refresh_token_enc, expires_at, scopes_granted, upstream_username, refresh_failed_at
       FROM mcp_user_upstream_tokens WHERE user_id = $1 AND backend_id = $2`,
      [userId, backendId],
    );
    if (rows.length === 0) { await client.query('COMMIT'); return null; }
    const r = rows[0]!;
    if (r.refresh_failed_at) { await client.query('COMMIT'); return null; }
    const current: UpstreamTokenRow = {
      user_id: r.user_id, backend_id: r.backend_id,
      access_token: decryptToken(r.access_token_enc) ?? '',
      refresh_token: decryptToken(r.refresh_token_enc),
      expires_at: r.expires_at, scopes_granted: r.scopes_granted,
      upstream_username: r.upstream_username ?? undefined,
    };
    if (!current.refresh_token) { await client.query('COMMIT'); return null; }
    // Wenn ein anderer Caller das Lock hatte und schon refresht hat, sind wir fertig
    if (!needsRefresh(current.expires_at)) {
      await client.query('COMMIT');
      return current;
    }

    const res = await postOAuthForm(cfg.oauth_token_url, new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refresh_token,
        client_id: cfg.oauth_client_id,
        client_secret: clientSecret,
      }));
    if (!res.ok) {
      // Innerhalb der Transaktion markieren — andere Caller sehen das nach COMMIT
      await client.query(
        `UPDATE mcp_user_upstream_tokens SET refresh_failed_at = now() WHERE user_id = $1 AND backend_id = $2`,
        [userId, backendId],
      );
      await client.query('COMMIT');
      logger.warn({ status: res.status, userId, backendId }, 'upstream token refresh failed');
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const data = await readOAuthTokenResponse(res);
    const newRefresh = data.refresh_token ?? current.refresh_token;
    const newScopes = data.scope !== undefined ? data.scope.split(/\s+/).filter(Boolean) : current.scopes_granted;
    const newExpiresAt = new Date(Date.now() + (data.expires_in ?? 3600) * 1000);

    // UPSERT INSIDE der Lock-Transaktion → atomar mit dem Refresh-Call
    await client.query(
      `UPDATE mcp_user_upstream_tokens SET
         access_token_enc  = $3,
         refresh_token_enc = $4,
         expires_at        = $5,
         scopes_granted    = $6,
         refresh_failed_at = NULL
       WHERE user_id = $1 AND backend_id = $2`,
      [
        userId, backendId,
        encryptToken(data.access_token),
        encryptToken(newRefresh),
        newExpiresAt,
        newScopes,
      ],
    );
    await client.query('COMMIT');

    // Audit nach COMMIT (fire-and-forget)
    writeImmutableAudit(pool, {
      eventType: 'upstream_token_acquired',
      apiKeyPrefix: `user__${userId}`,
      userId,
      model: '',
      errorType: `backend:${backendId}:refreshed`,
      riskLevel: 'low',
    });

    return {
      user_id: userId, backend_id: backendId,
      access_token: data.access_token,
      refresh_token: newRefresh,
      expires_at: newExpiresAt,
      scopes_granted: newScopes,
      upstream_username: current.upstream_username,
    };
  } catch {
    // A transport error may have consumed a rotating refresh token. Persist the
    // reconnect requirement while holding the same lock; never blindly retry it.
    try {
      await client.query('UPDATE mcp_user_upstream_tokens SET refresh_failed_at = now() WHERE user_id = $1 AND backend_id = $2', [userId, backendId]);
      await client.query('COMMIT');
    } catch { await client.query('ROLLBACK').catch(() => {}); }
    logger.warn({ userId, backendId }, 'upstream token refresh failed; reconnect required');
    return null;
  } finally {
    client.release();
  }
}

export async function getValidToken(
  pool: pg.Pool,
  userId: number,
  backendId: number,
  cfg: BackendOAuthConfig,
): Promise<UpstreamTokenRow | null> {
  let token = await fetchTokenForUser(pool, userId, backendId);
  if (!token || token.refresh_failed_at || !token.access_token) return null;
  if (needsRefresh(token.expires_at) && token.refresh_token) {
    token = await refreshAccessToken(pool, userId, backendId, cfg);
  }
  if (!token || token.refresh_failed_at || !token.access_token
    || !Number.isFinite(token.expires_at.getTime()) || token.expires_at.getTime() <= Date.now()) return null;
  // Touch last_used_at fire-and-forget
  pool.query(
    `UPDATE mcp_user_upstream_tokens SET last_used_at = now() WHERE user_id = $1 AND backend_id = $2`,
    [userId, backendId],
  ).catch(() => {});
  return token;
}
