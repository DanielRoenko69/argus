import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { resolveBackendAuthentication, effectiveBackendAuthMode } from '../backendAuthentication.js';
import { executeCustomBackendStructured, type CustomBackendRow } from '../customBackends.js';
import { setUpstreamTokenExchangeConfig } from '../../lib/platformConfig.js';
import { setSharedPool } from '../../lib/sharedPool.js';
import { withRequestContext } from '../../lib/requestContext.js';
import * as tokens from '../../lib/upstreamTokens.js';

jest.mock('../../audit/immutableAudit.js', () => ({ writeImmutableAudit: jest.fn() }));

const backend: CustomBackendRow = {
  id: 42, name: 'gitea', description: '', base_url: 'https://8.8.8.8/api/v1',
  auth_type: 'header', auth_value: 'X-License:service-secret', health_path: null,
  default_headers: { authorization: 'Bearer old-default', Cookie: 'old-cookie', 'X-API-Key': 'other-secret', Accept: 'application/json' },
  timeout_ms: 1000, tls_skip_verify: false, enabled: true, backend_type: 'http',
  mcp_endpoint: null, transport_type: 'streamable-http', builtin_key: null, auth_mode: 'strict',
  oauth_authorize_url: 'https://8.8.8.8/oauth/authorize', oauth_token_url: 'https://8.8.8.8/oauth/token',
  oauth_client_id: 'client', oauth_client_secret: 'client-secret', oauth_scopes: ['read:repository'], oauth_revoke_url: null,
  config: {}, bundle_id: 50, bundle_ids: [50], created_at: '', updated_at: '',
};
const asDani = <T>(fn: () => Promise<T>) => withRequestContext({ callingUser: { id: 3, username: 'alex' } }, fn);
let tokenSpy: jest.SpiedFunction<typeof tokens.getValidToken>;
beforeEach(() => {
  process.env['MCP_API_KEYS'] = 'test-key';
  process.env['SESSION_SECRET'] = 's'.repeat(32);
  process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
  setSharedPool({} as pg.Pool);
  setUpstreamTokenExchangeConfig({ enabled: true });
  tokenSpy = jest.spyOn(tokens, 'getValidToken').mockResolvedValue({
    user_id: 3, backend_id: 42, access_token: 'personal-token', expires_at: new Date(Date.now() + 600_000), scopes_granted: ['read:repository'],
  });
});
afterEach(() => { jest.restoreAllMocks(); setSharedPool(null); setUpstreamTokenExchangeConfig({ enabled: false }); });

describe('Core backend identity selection', () => {
  it.each(['strict', 'permissive'] as const)('does not silently fall back for %s with feature disabled', async auth_mode => {
    setUpstreamTokenExchangeConfig({ enabled: false });
    await expect(asDani(() => resolveBackendAuthentication({ ...backend, auth_mode }, 'service-account', { token: 'override-secret' })))
      .rejects.toMatchObject({ code: 'delegation_disabled' });
    expect(tokenSpy).not.toHaveBeenCalled();
  });
  it.each(['strict', 'permissive'] as const)('requires a personal connection in %s mode', async auth_mode => {
    tokenSpy.mockResolvedValue(null);
    await expect(asDani(() => resolveBackendAuthentication({ ...backend, auth_mode }))).rejects.toMatchObject({ code: 'connection_required' });
  });
  it('keeps explicit service accounts usable with delegation disabled', async () => {
    setUpstreamTokenExchangeConfig({ enabled: false });
    expect(await resolveBackendAuthentication({ ...backend, auth_mode: 'service-account' }))
      .toEqual({ authorization: null, evidence: { backendId: 42, mode: 'service-account' } });
    expect(tokenSpy).not.toHaveBeenCalled();
  });
  it('does not downgrade backend requirements using tool settings', () => {
    expect(effectiveBackendAuthMode('strict', 'service-account')).toBe('strict');
    expect(effectiveBackendAuthMode('permissive', 'service-account')).toBe('permissive');
    expect(effectiveBackendAuthMode('service-account', 'strict')).toBe('strict');
  });
  it('fails closed on incomplete OAuth config', async () => {
    await expect(asDani(() => resolveBackendAuthentication({ ...backend, oauth_token_url: null }))).rejects.toMatchObject({ code: 'oauth_not_configured' });
  });
  it('requires a verified local user; a worker must not borrow one', async () => {
    await expect(resolveBackendAuthentication(backend)).rejects.toMatchObject({ code: 'user_identity_required' });
  });
  it('requires the credential store', async () => {
    setSharedPool(null);
    await expect(asDani(() => resolveBackendAuthentication(backend))).rejects.toMatchObject({ code: 'credential_store_unavailable' });
  });
  it('rejects incomplete granted scopes', async () => {
    tokenSpy.mockResolvedValue({ user_id: 3, backend_id: 42, access_token: 'personal', expires_at: new Date(), scopes_granted: [] });
    await expect(asDani(() => resolveBackendAuthentication(backend))).rejects.toMatchObject({ code: 'insufficient_oauth_scopes' });
  });
  it.each([{ user_id: 4, backend_id: 42 }, { user_id: 3, backend_id: 99 }])('rejects an identity/target mismatch: %p', async ids => {
    tokenSpy.mockResolvedValue({ ...ids, access_token: 'personal', expires_at: new Date(), scopes_granted: ['read:repository'] });
    await expect(asDani(() => resolveBackendAuthentication(backend))).rejects.toMatchObject({ code: 'connection_required' });
  });
  it('binds workflow credential references to the actual backend', async () => {
    await expect(asDani(() => resolveBackendAuthentication(backend, null, { backendId: 99, token: null })))
      .rejects.toMatchObject({ code: 'credential_backend_mismatch' });
  });
  it('uses only personal OAuth at the actual HTTP boundary, including cred_ref', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('echo personal-token'));
    const result = await asDani(() => executeCustomBackendStructured(backend, 'GET', '/user', undefined, 'service-account', { backendId: 42, token: 'override-secret' }));
    expect(fetchSpy).toHaveBeenCalledWith('https://8.8.8.8/api/v1/user', expect.objectContaining({
      headers: { Accept: 'application/json', Authorization: 'Bearer personal-token' }, redirect: 'manual',
    }));
    expect(result.body).toBe('echo [REDACTED]');
    expect(result.authentication).toEqual({ backendId: 42, mode: 'user-oauth', userId: 3 });
  });
  it('sends no backend request when OAuth cannot be satisfied', async () => {
    tokenSpy.mockResolvedValue(null);
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    await expect(asDani(() => executeCustomBackendStructured(backend, 'GET', '/user'))).rejects.toMatchObject({ code: 'connection_required' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('does not expose underlying credential-store exception details', async () => {
    tokenSpy.mockRejectedValue(new Error('database contains private-token'));
    await expect(asDani(() => resolveBackendAuthentication(backend))).rejects.not.toThrow('private-token');
  });
});
