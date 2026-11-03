/**
 * upstreamOauth — OAuth 2.0 Authorization-Code-Flow für Upstream-Backends.
 *
 * Argus startet einen Consent-Flow zu Bitbucket/Jira/Confluence/Gitea/GitHub
 * (per-Backend konfiguriert via oauth_authorize_url / oauth_token_url /
 * oauth_client_id / oauth_client_secret / oauth_scopes), tauscht den
 * Authorization-Code gegen Tokens und persistiert sie pro (User, Backend) in
 * mcp_user_upstream_tokens.
 *
 * CSRF-Schutz via signed-state-Param (HMAC). State enthält {userId, backendId,
 * nonce, expiresAt}. /connect leitet weiter, /callback validiert state und
 * tauscht den code.
 */

import type pg from 'pg';
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { storeToken, decryptToken } from './upstreamTokens.js';
import { postOAuthForm, readOAuthTokenResponse } from './upstreamOAuthTransport.js';
import { logger } from './logger.js';

const STATE_TTL_MS = 10 * 60 * 1000;  // 10 Minuten — User muss in dieser Zeit consenten

function stateSecret(): Buffer {
  const raw = process.env['SESSION_SECRET'] ?? process.env['DB_ENCRYPTION_KEY'] ?? '';
  if (!raw) {
    // Prod: fail-closed. Multi-Pod-Deployments brauchen denselben Secret
    // damit ein Flow, der auf Pod-A startet, auf Pod-B callbacked werden kann.
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('SESSION_SECRET (or DB_ENCRYPTION_KEY) must be set in production for OAuth state HMAC');
    }
    // Dev: per-process random — kein Multi-Pod-Use-Case in Dev
    logger.warn('upstreamOauth: no SESSION_SECRET/DB_ENCRYPTION_KEY set — using per-process random key (dev-only)');
    return randomBytes(32);
  }
  // Full SHA-256 hash → 256 Bit Entropie, unabhängig vom Eingabeformat
  return createHash('sha256').update(raw).digest();
}

const SECRET = stateSecret();

export interface StatePayload {
  uid: number;       // userId
  bid: number;       // backendId
  exp: number;       // unix ms
  nonce: string;     // 16-byte random, also seeds PKCE verifier-derivation
  /** SHA-256(sessionId) — bindet den Flow an die Session, die ihn gestartet hat.
   *  Verhindert OAuth-Login-CSRF: ein geleakter State funktioniert nur in derselben
   *  Browser-Session des initiierenden Users. */
  shash: string;
  /** SHA-256(verifier) — PKCE S256-Challenge. Verifier wird stateless aus
   *  HMAC(nonce, SECRET) abgeleitet (siehe derivePkce). */
  pkce: string;
  /** Signed, allow-listed native UI return target after the provider callback. */
  returnTo?: '/mcp-fabric';
}

/** Hash a session-id (or any opaque secret) into a stable short identifier
 *  suitable for inclusion in a signed state payload. Never put raw session
 *  cookies into URLs. */
export function hashSession(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

export function signState(payload: Omit<StatePayload, 'nonce'> & { nonce?: string }): string {
  const full: StatePayload = { ...payload, nonce: payload.nonce ?? randomBytes(16).toString('hex') };
  const body = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyState(state: string): StatePayload | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;

  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as StatePayload;
    if (!Number.isSafeInteger(payload.uid) || payload.uid <= 0 || !Number.isSafeInteger(payload.bid) || payload.bid <= 0) return null;
    if (!Number.isFinite(payload.exp) || payload.exp <= Date.now()) return null;
    if (typeof payload.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(payload.nonce)) return null;
    if (typeof payload.shash !== 'string' || payload.shash.length === 0) return null;
    if (typeof payload.pkce !== 'string' || payload.pkce.length === 0) return null;
    if (payload.returnTo !== undefined && payload.returnTo !== '/mcp-fabric') return null;
    return payload;
  } catch {
    return null;
  }
}

/** Constant-time compare of two strings of equal length. */
export function safeStringEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface BackendOAuthRow {
  id: number;
  name: string;
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string[] | null;
  oauth_revoke_url: string | null;
}

export async function fetchBackendOAuthConfig(
  pool: pg.Pool,
  backendId: number,
): Promise<BackendOAuthRow | null> {
  const { rows } = await pool.query<BackendOAuthRow>(
    `SELECT id, name, oauth_authorize_url, oauth_token_url, oauth_client_id,
            oauth_client_secret, oauth_scopes, oauth_revoke_url
     FROM mcp_backends WHERE id = $1`,
    [backendId],
  );
  return rows[0] ?? null;
}

/**
 * Best-effort upstream token revocation (RFC 7009). Never throws — caller
 * proceeds with local DELETE regardless. Some backends ignore unknown tokens,
 * some return 200, some return 400 for invalid tokens. All acceptable.
 */
export async function bestEffortUpstreamRevoke(
  cfg: BackendOAuthRow,
  accessToken: string,
  refreshToken?: string,
): Promise<void> {
  if (!cfg.oauth_revoke_url) return;
  let clientSecret: string | undefined;
  try { clientSecret = decryptToken(cfg.oauth_client_secret); }
  catch { return; }
  const auth = (cfg.oauth_client_id && clientSecret)
    ? 'Basic ' + Buffer.from(`${cfg.oauth_client_id}:${clientSecret}`).toString('base64')
    : undefined;

  const revoke = async (token: string, hint: 'access_token' | 'refresh_token') => {
    try {
      const res = await postOAuthForm(cfg.oauth_revoke_url!, new URLSearchParams({ token, token_type_hint: hint }),
        auth ? { Authorization: auth } : {});
      await res.body?.cancel().catch(() => {});
      logger.info({ backendId: cfg.id, hint, status: res.status }, 'upstream token revoked');
    } catch {
      logger.warn({ backendId: cfg.id, hint }, 'upstream revoke failed (continuing)');
    }
  };

  // Refresh-token first — invalidating it nukes the whole grant on most providers
  if (refreshToken) await revoke(refreshToken, 'refresh_token');
  await revoke(accessToken, 'access_token');
}

export interface PkcePair {
  verifier: string;   // raw, used in exchange step
  challenge: string;  // base64url(sha256(verifier)) — sent to IdP in authorize step
}

/**
 * Derive a PKCE verifier deterministically from a nonce + the server's SECRET.
 *
 * Why deterministic+stateless: Argus runs in multi-pod K8s. If we stored the
 * verifier in process memory (a Map), a flow starting on pod-A and callbacking
 * on pod-B would fail — different pod, no verifier. Standard fix would be a
 * Redis cache, but we can avoid Redis dependency entirely:
 *
 *   verifier  = HMAC-SHA256(nonce, SECRET)
 *   challenge = SHA256(verifier)
 *
 * The nonce is part of the signed state, so any pod that can verify the state
 * (i.e., any pod with SECRET) can re-derive the verifier in the callback.
 *
 * Security:
 *  - Attacker with state can recompute the challenge (= sha256(verifier))
 *    but cannot derive verifier without SECRET (one-way HMAC).
 *  - SECRET is per-deployment, never leaves Argus → verifier is unforgeable.
 *  - Each state has a fresh random nonce → verifier is per-flow unique.
 *
 * This is the IETF-recommended stateless PKCE pattern (RFC 7636 §4.1 notes
 * verifier can be derived from any sufficient-entropy source).
 */
export function derivePkce(nonce: string): PkcePair {
  const verifier = createHmac('sha256', SECRET).update('pkce:' + nonce).digest('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** @deprecated Use derivePkce(nonce) — kept for test backwards-compat. */
export function generatePkce(): PkcePair {
  return derivePkce(randomBytes(16).toString('hex'));
}

export function buildAuthorizeUrl(
  cfg: BackendOAuthRow,
  redirectUri: string,
  state: string,
  codeChallenge?: string,
): string | null {
  if (!cfg.oauth_authorize_url || !cfg.oauth_client_id) return null;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.oauth_client_id,
    redirect_uri: redirectUri,
    state,
  });
  if (cfg.oauth_scopes?.length) params.set('scope', cfg.oauth_scopes.join(' '));
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }
  return `${cfg.oauth_authorize_url}?${params.toString()}`;
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  username?: string;
}

export async function exchangeCodeForToken(
  cfg: BackendOAuthRow,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<TokenExchangeResult> {
  if (!cfg.oauth_token_url || !cfg.oauth_client_id || !cfg.oauth_client_secret) {
    throw new Error('backend not OAuth-configured');
  }
  const clientSecret = decryptToken(cfg.oauth_client_secret);
  if (!clientSecret) throw new Error('client_secret decryption failed');

  const res = await postOAuthForm(cfg.oauth_token_url, new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: cfg.oauth_client_id,
      client_secret: clientSecret,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }));
  return readOAuthTokenResponse(res);
}

export interface CompleteFlowResult {
  scopesGranted: string[];
  scopesRequested: string[];
  scopesMissing: string[];
}

export async function completeAuthorizationCodeFlow(
  pool: pg.Pool,
  userId: number,
  backendId: number,
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<CompleteFlowResult> {
  const cfg = await fetchBackendOAuthConfig(pool, backendId);
  if (!cfg) throw new Error(`backend ${backendId} not found`);

  const tok = await exchangeCodeForToken(cfg, code, redirectUri, codeVerifier);

  const requested = cfg.oauth_scopes ?? [];
  const granted = tok.scope !== undefined ? tok.scope.split(/\s+/).filter(Boolean) : requested.slice();
  // Strict-subset check: every requested scope must be in granted
  const missing = requested.filter(s => !granted.includes(s));

  await storeToken(pool, userId, backendId, {
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_in_sec: tok.expires_in ?? 3600,
    scopes_granted: granted,
    upstream_username: tok.username,
  });

  logger.info(
    { userId, backendId, backend: cfg.name, scopes: granted, missing },
    missing.length > 0 ? 'upstream OAuth flow completed with scope down-grade' : 'upstream OAuth flow completed',
  );

  return { scopesGranted: granted, scopesRequested: requested, scopesMissing: missing };
}

export function buildRedirectUri(req: { protocol: string; get: (h: string) => string | undefined }): string {
  const explicit = process.env['ARGUS_PUBLIC_URL'];
  if (explicit) return `${explicit.replace(/\/+$/, '')}/connections/callback`;
  // In Prod fail-closed — Host-Header ist client-controlled und kann zu
  // Cache-Poisoning bzw. Token-Exfiltration via misconfigured IdP führen.
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('ARGUS_PUBLIC_URL must be set in production (refusing to fall back to Host header)');
  }
  const host = req.get('host') ?? `localhost:${process.env['PORT'] ?? '3000'}`;
  return `${req.protocol}://${host}/connections/callback`;
}

export const STATE_EXPIRY_MS = STATE_TTL_MS;

/**
 * Re-derive the PKCE verifier from a verified state payload. Stateless:
 * works on any Argus pod given the same SECRET. Returns undefined when state
 * has no nonce (malformed) — caller should treat as flow-failure.
 */
export function recoverPkceVerifier(payload: StatePayload): string | undefined {
  if (!payload.nonce) return undefined;
  return derivePkce(payload.nonce).verifier;
}
