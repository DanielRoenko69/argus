import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { registerUpstreamConnectionRoutes } from '../upstreamConnectionRoutes.js';
import { requireAuth, requireSameOrigin, type AuthenticatedRequest } from '../sessionMiddleware.js';
import type { SessionUser } from '../userAuth.js';
import * as oauth from '../../lib/upstreamOauth.js';
import * as tokens from '../../lib/upstreamTokens.js';
import { setUpstreamTokenExchangeConfig } from '../../lib/platformConfig.js';

const user = { id: 3, role: 'developer', allowed_bundles: [50] } as SessionUser;
let currentUser: SessionUser | undefined;
let allowed: boolean;
let server: Server;
let origin: string;
let complete: jest.SpiedFunction<typeof oauth.completeAuthorizationCodeFlow>;
const config: oauth.BackendOAuthRow = { id: 42, name: 'gitea', oauth_authorize_url: 'https://gitea.example/authorize', oauth_token_url: 'https://gitea.example/token', oauth_client_id: 'client', oauth_client_secret: 'fixture-secret', oauth_scopes: ['read'], oauth_revoke_url: null };
const query = jest.fn(async (sql: string) => {
  if (sql.includes('SELECT b.id FROM')) return { rows: allowed ? [{ id: 42 }] : [] };
  if (sql.includes('SELECT id, name, oauth_authorize_url')) return { rows: [config] };
  if (sql.includes('SELECT name FROM')) return { rows: [{ name: 'gitea' }] };
  return { rows: [] };
});
function state() {
  const nonce = 'a'.repeat(32);
  return oauth.signState({ uid: 3, bid: 42, exp: Date.now() + 60_000, nonce,
    shash: oauth.hashSession('original-session'), pkce: oauth.derivePkce(nonce).challenge });
}
function callback(headers: Record<string, string> = { Cookie: 'argus_session=original-session' }) {
  return fetch(`${origin}/connections/callback?${new URLSearchParams({ code: 'fixture-code', state: state() })}`, { headers, redirect: 'manual' });
}
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => { (req as AuthenticatedRequest).user = currentUser; next(); });
  registerUpstreamConnectionRoutes(app, { query } as unknown as pg.Pool, requireAuth, requireSameOrigin);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', error => { if (error) reject(error); else resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server unavailable');
  origin = `http://127.0.0.1:${address.port}`;
});
beforeEach(() => {
  currentUser = user; allowed = true; query.mockClear();
  setUpstreamTokenExchangeConfig({ enabled: true });
  complete = jest.spyOn(oauth, 'completeAuthorizationCodeFlow').mockResolvedValue({ scopesGranted: ['read'], scopesRequested: ['read'], scopesMissing: [] });
});
afterEach(() => { jest.restoreAllMocks(); setUpstreamTokenExchangeConfig({ enabled: false }); });
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe('personal connection HTTP security boundaries', () => {
  it('requires authentication to list delegations', async () => {
    currentUser = undefined;
    expect((await fetch(`${origin}/api/connections`)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });
  it('includes the delegation switch without exposing secrets', async () => {
    setUpstreamTokenExchangeConfig({ enabled: false });
    expect(await (await fetch(`${origin}/api/connections`)).json()).toEqual({ delegationEnabled: false, connections: [] });
  });
  it('starts an authorized code+PKCE flow', async () => {
    const result = await fetch(`${origin}/connections/connect/42`, { headers: { Cookie: 'argus_session=original-session' }, redirect: 'manual' });
    const url = new URL(result.headers.get('location')!);
    expect(url.origin).toBe('https://gitea.example');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(oauth.verifyState(url.searchParams.get('state')!)?.uid).toBe(3);
    expect(result.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('denies connecting outside the current Bundle scope', async () => {
    allowed = false;
    const response = await fetch(`${origin}/connections/connect/42`, { headers: { Cookie: 'argus_session=original-session' }, redirect: 'manual' });
    expect(response.headers.get('location')).toContain('not+authorized');
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a cookie without a still-active authenticated session', async () => {
    currentUser = undefined;
    expect((await callback()).headers.get('location')).toContain('active+original+session+required');
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a different local user even with a copied original cookie', async () => {
    currentUser = { ...user, id: 4 };
    await callback();
    expect(complete).not.toHaveBeenCalled();
  });
  it('rejects a different browser session for the same user', async () => {
    expect((await callback({ Cookie: 'argus_session=different-session' })).headers.get('location')).toContain('session+mismatch');
    expect(complete).not.toHaveBeenCalled();
  });
  it('rechecks Bundle access at callback time', async () => {
    allowed = false;
    expect((await callback()).headers.get('location')).toContain('not+authorized');
    expect(complete).not.toHaveBeenCalled();
  });
  it('rechecks the feature switch at callback time', async () => {
    setUpstreamTokenExchangeConfig({ enabled: false });
    await callback();
    expect(complete).not.toHaveBeenCalled();
  });
  it('exchanges the code only after all identity checks', async () => {
    expect((await callback()).headers.get('location')).toBe('/connections?connected=gitea');
    expect(complete).toHaveBeenCalledWith(expect.anything(), 3, 42, 'fixture-code', expect.stringContaining('/connections/callback'), oauth.derivePkce('a'.repeat(32)).verifier);
  });
  it('does not reflect provider errors or tokens in redirect URLs', async () => {
    complete.mockRejectedValue(new Error('private-provider-token'));
    expect((await callback()).headers.get('location')).not.toContain('private-provider-token');
    const response = await fetch(`${origin}/connections/callback?error=private-code&error_description=private-token`, { redirect: 'manual' });
    expect(response.headers.get('location')).not.toContain('private-');
  });
  it('blocks cross-origin disconnect before reading or deleting a token', async () => {
    const revoke = jest.spyOn(tokens, 'revokeToken');
    expect((await fetch(`${origin}/api/connections/42`, { method: 'DELETE', headers: { Origin: 'https://attacker.example' } })).status).toBe(403);
    expect(revoke).not.toHaveBeenCalled();
  });
  it('disconnects locally before the optional provider revocation', async () => {
    const revoke = jest.spyOn(tokens, 'revokeToken').mockResolvedValue({ user_id: 3, backend_id: 42, access_token: 'fixture-token', expires_at: new Date(), scopes_granted: ['read'] });
    const provider = jest.spyOn(oauth, 'bestEffortUpstreamRevoke').mockResolvedValue();
    const response = await fetch(`${origin}/api/connections/42`, { method: 'DELETE', headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(revoke.mock.invocationCallOrder[0]).toBeLessThan(provider.mock.invocationCallOrder[0]!);
  });
});
