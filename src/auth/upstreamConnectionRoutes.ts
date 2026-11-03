import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import type { SessionUser } from './userAuth.js';
import { parseArgusSessionCookie } from './sessionMiddleware.js';
import { logger } from '../lib/logger.js';
import { getUpstreamTokenExchangeConfig } from '../lib/platformConfig.js';
import { revokeToken } from '../lib/upstreamTokens.js';
import { canConnectToBackend, connectionReadiness } from '../lib/upstreamConnectionAccess.js';
import {
  fetchBackendOAuthConfig, signState, verifyState, buildAuthorizeUrl,
  completeAuthorizationCodeFlow, buildRedirectUri, STATE_EXPIRY_MS,
  hashSession, safeStringEqual, derivePkce, recoverPkceVerifier,
} from '../lib/upstreamOauth.js';

/** Session-authenticated personal delegation; connection state does not grant tool access. */
export function registerUpstreamConnectionRoutes(
  app: Express, sharedPool: pg.Pool | null, requireAuth: RequestHandler, requireSameOrigin: RequestHandler,
): void {
  // ── /connections — Per-User Upstream OAuth ────────────────────────

  // List backends + connection state for the calling user
  app.get('/api/connections', requireAuth, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    const user = (req as unknown as { user?: SessionUser }).user;
    if (!user) { res.status(401).json({ error: 'auth required' }); return; }
    try {
      // L4 — non-admin users sehen nur Backends, die zu Bundles gehören in
      // denen sie überhaupt Zugriff haben. Admins / users mit allowed_bundles=null
      // sehen alle OAuth-fähigen Backends.
      const isAdmin = user.role === 'admin' || user.role === 'platform_admin' || user.role === 'operations_admin';
      const restrictBundles = !isAdmin && Array.isArray(user.allowed_bundles);
      const params: unknown[] = [user.id];
      let bundleFilter = '';
      if (restrictBundles) {
        params.push(user.allowed_bundles);
        bundleFilter = `AND (
          NOT EXISTS (SELECT 1 FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id)
          OR EXISTS (
            SELECT 1 FROM mcp_backend_bundles bb
            WHERE bb.backend_id = b.id AND bb.bundle_id = ANY($2::int[])
          )
        )`;
      }
      const { rows } = await sharedPool.query<{
        backend_id: number; name: string; auth_mode: string;
        oauth_scopes: string[] | null;
        connected: boolean; expires_at: Date | null; scopes_granted: string[] | null;
        upstream_username: string | null; last_used_at: Date | null;
        refresh_failed_at: Date | null;
        has_refresh_token: boolean;
      }>(
        `SELECT b.id AS backend_id, b.name, b.auth_mode, b.oauth_scopes,
                (t.user_id IS NOT NULL) AS connected,
                t.expires_at, t.scopes_granted, t.upstream_username,
                t.last_used_at, t.refresh_failed_at, (t.refresh_token_enc IS NOT NULL) AS has_refresh_token
         FROM mcp_backends b
         LEFT JOIN mcp_user_upstream_tokens t
           ON t.backend_id = b.id AND t.user_id = $1
         WHERE b.auth_mode IN ('permissive','strict')
           AND b.oauth_authorize_url IS NOT NULL
           AND b.oauth_token_url     IS NOT NULL
           AND b.oauth_client_id     IS NOT NULL
           AND b.enabled = true
           ${bundleFilter}
         ORDER BY b.name`,
        params,
      );
      const delegationEnabled = getUpstreamTokenExchangeConfig().enabled;
      res.json({ delegationEnabled, connections: rows.map(row => ({ ...row, readiness: connectionReadiness(row, delegationEnabled) })) });
    } catch (err) {
      logger.error({ err }, '/api/connections failed');
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Initiate OAuth Authorization-Code-Flow
  app.get('/connections/connect/:id', requireAuth, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    const user = (req as unknown as { user?: SessionUser }).user;
    if (!user) { res.redirect('/login'); return; }
    const sessionId = parseArgusSessionCookie(req.headers.cookie);
    if (!sessionId) { res.redirect('/login'); return; }
    const backendId = Number(req.params['id']);
    if (!Number.isSafeInteger(backendId) || backendId < 1) { res.redirect('/connections?error=invalid+backend'); return; }
    res.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!getUpstreamTokenExchangeConfig().enabled || !await canConnectToBackend(sharedPool, user, backendId)) {
        res.redirect('/connections?error=delegation+unavailable+or+backend+not+authorized'); return;
      }
      const cfg = await fetchBackendOAuthConfig(sharedPool, backendId);
      if (!cfg) { res.redirect('/connections?error=backend+not+found'); return; }
      const redirectUri = buildRedirectUri(req);

      // K1 — Bind state to session-id hash. Verhindert Account-Confusion via geleakter Authorize-URL.
      // M1 — PKCE: stateless via HMAC(nonce, SECRET). Multi-Pod-safe — kein in-memory-Store mehr.
      //              Nonce wird randomisiert pro Flow, in den signierten state aufgenommen,
      //              und Callback re-derived den Verifier aus (nonce, SECRET).
      const nonce = randomBytes(16).toString('hex');
      const pkce = derivePkce(nonce);
      const returnTo = req.query['returnTo'] === '/mcp-fabric' ? '/mcp-fabric' as const : undefined;
      const state = signState({
        uid: user.id,
        bid: backendId,
        exp: Date.now() + STATE_EXPIRY_MS,
        shash: hashSession(sessionId),
        pkce: pkce.challenge,
        nonce,
        ...(returnTo ? { returnTo } : {}),
      });

      const url = buildAuthorizeUrl(cfg, redirectUri, state, pkce.challenge);
      if (!url) { res.redirect('/connections?error=backend+not+oauth-configured'); return; }
      res.redirect(url);
    } catch (err) {
      logger.error({ err, backendId, userId: user.id }, '/connections/connect failed');
      res.redirect('/connections?error=' + encodeURIComponent('start failed'));
    }
  });

  // OAuth callback (state-validated)
  app.get('/connections/callback', async (req, res) => {
    if (!sharedPool) { res.status(503).send('PostgreSQL not enabled'); return; }
    res.setHeader('Referrer-Policy', 'no-referrer');
    const code = typeof req.query['code'] === 'string' ? req.query['code'] : undefined;
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const oauthErr = req.query['error'];
    const verifiedPayload = state ? verifyState(state) : null;
    const callbackSessionId = parseArgusSessionCookie(req.headers.cookie);
    const nativeReturnTo = verifiedPayload?.returnTo
      && callbackSessionId
      && safeStringEqual(hashSession(callbackSessionId), verifiedPayload.shash)
      ? verifiedPayload.returnTo
      : null;
    if (oauthErr) {
      const message = 'Provider authorization was not completed. Please reconnect.';
      res.redirect(nativeReturnTo
        ? `${nativeReturnTo}?oauth=error&connection=${verifiedPayload!.bid}&message=${encodeURIComponent(message)}`
        : '/connections?error=' + encodeURIComponent(message));
      return;
    }
    if (!code || !state) {
      res.redirect(nativeReturnTo
        ? `${nativeReturnTo}?oauth=error&connection=${verifiedPayload!.bid}&message=missing+code+or+state`
        : '/connections?error=missing+code+or+state');
      return;
    }
    const payload = verifiedPayload;
    if (!payload) { res.redirect('/connections?error=invalid+or+expired+state'); return; }
    const currentUser = (req as unknown as { user?: SessionUser }).user;
    if (!currentUser || currentUser.id !== payload.uid) {
      res.redirect('/connections?error=active+original+session+required'); return;
    }

    // K1 — Session-Binding: state muss von der Session signiert worden sein, die jetzt callbacked.
    // Verhindert OAuth-Login-CSRF: ein geleakter state funktioniert nur in derselben Browser-Session.
    const sessionId = callbackSessionId;
    if (!sessionId) {
      res.redirect('/connections?error=session+required+for+callback');
      return;
    }
    const currentHash = hashSession(sessionId);
    if (!safeStringEqual(currentHash, payload.shash)) {
      logger.warn({ stateUid: payload.uid, bid: payload.bid }, 'oauth callback rejected: session-hash mismatch (state from different session)');
      res.redirect('/connections?error=session+mismatch+please+restart+flow');
      return;
    }

    // M1 — PKCE-Verifier deterministisch re-derived aus (state.nonce, SECRET).
    // Stateless: funktioniert über Pod-Grenzen hinweg, kein Memory-Store nötig.
    const verifier = recoverPkceVerifier(payload);
    if (!verifier) {
      logger.warn({ uid: payload.uid, bid: payload.bid }, 'oauth callback rejected: cannot derive PKCE verifier (malformed state)');
      res.redirect('/connections?error=PKCE+verifier+derivation+failed');
      return;
    }

    try {
      if (!getUpstreamTokenExchangeConfig().enabled || !await canConnectToBackend(sharedPool, currentUser, payload.bid)) {
        res.redirect('/connections?error=delegation+unavailable+or+backend+not+authorized'); return;
      }
      const redirectUri = buildRedirectUri(req);
      const result = await completeAuthorizationCodeFlow(
        sharedPool, payload.uid, payload.bid, code, redirectUri, verifier,
      );
      const { rows } = await sharedPool.query<{ name: string }>(
        'SELECT name FROM mcp_backends WHERE id = $1', [payload.bid],
      );
      const name = rows[0]?.name ?? `backend#${payload.bid}`;
      // M4 — Bei Scope-Downgrade Warning an User propagieren
      if (result.scopesMissing.length > 0) {
        const missing = result.scopesMissing.join(',').slice(0, 200);
        res.redirect(payload.returnTo
          ? `${payload.returnTo}?oauth=error&connection=${payload.bid}&message=${encodeURIComponent(`Scope-Downgrade: ${missing} nicht gewährt`)}`
          : '/connections?error=' + encodeURIComponent(`Scope-Downgrade: ${missing} nicht gewährt`));
        return;
      }
      res.redirect(payload.returnTo
        ? `${payload.returnTo}?oauth=connected&connection=${payload.bid}`
        : '/connections?connected=' + encodeURIComponent(name));
    } catch (err) {
      logger.error({ userId: payload.uid, backendId: payload.bid }, 'oauth callback failed');
      const message = 'OAuth connection failed. Please reconnect or contact an administrator.';
      res.redirect(payload.returnTo
        ? `${payload.returnTo}?oauth=error&connection=${payload.bid}&message=${encodeURIComponent(message)}`
        : '/connections?error=' + encodeURIComponent(message));
    }
  });

  // Disconnect — best-effort upstream revoke + local delete
  app.delete('/api/connections/:id', requireAuth, requireSameOrigin, async (req, res) => {
    if (!sharedPool) { res.status(503).json({ error: 'PostgreSQL not enabled' }); return; }
    const user = (req as unknown as { user?: SessionUser }).user;
    if (!user) { res.status(401).json({ error: 'auth required' }); return; }
    const backendId = Number(req.params['id']);
    if (!Number.isSafeInteger(backendId) || backendId < 1) { res.status(400).json({ error: 'invalid backend id' }); return; }
    try {
      // Delete under the refresh lock first; an unavailable provider must not
      // leave delegation locally usable. Revoke the latest rotated token.
      const { bestEffortUpstreamRevoke, fetchBackendOAuthConfig } = await import('../lib/upstreamOauth.js');
      const tok = await revokeToken(sharedPool, user.id, backendId);
      const cfg = await fetchBackendOAuthConfig(sharedPool, backendId).catch(() => null);
      if (tok && cfg) {
        await bestEffortUpstreamRevoke(cfg, tok.access_token, tok.refresh_token);
      }

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

}
