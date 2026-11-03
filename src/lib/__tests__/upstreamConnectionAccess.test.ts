import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { canConnectToBackend, connectionReadiness } from '../upstreamConnectionAccess.js';

describe('connect and callback access policy', () => {
  it('checks backend enablement, OAuth mode and current Bundle access in SQL', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [] } as never);
    expect(await canConnectToBackend({ query } as unknown as pg.Pool, { id: 3, role: 'developer', allowed_bundles: [50] }, 42)).toBe(false);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('b.enabled = true'), [42, [50]]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("b.auth_mode IN ('strict', 'permissive')"), [42, [50]]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('bb.bundle_id = ANY($2::int[])'), [42, [50]]);
  });
  it('does not turn an empty Bundle allowlist into unrestricted access', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [] } as never);
    await canConnectToBackend({ query } as unknown as pg.Pool, { id: 3, role: 'developer', allowed_bundles: [] }, 42);
    expect(query).toHaveBeenCalledWith(expect.any(String), [42, []]);
  });
  it('rejects invalid IDs without querying', async () => {
    const query = jest.fn();
    expect(await canConnectToBackend({ query } as unknown as pg.Pool, { id: 3, role: 'admin' }, -1)).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('safe connection readiness', () => {
  const row = { connected: true, expires_at: new Date(2000), has_refresh_token: false, refresh_failed_at: null, oauth_scopes: ['read'], scopes_granted: ['read'] };
  it('does not label disabled delegation as ready', () => expect(connectionReadiness(row, false, 1000)).toBe('disabled'));
  it('reports a valid connection', () => expect(connectionReadiness(row, true, 1000)).toBe('ready'));
  it('reports a missing connection', () => expect(connectionReadiness({ ...row, connected: false }, true, 1000)).toBe('not_connected'));
  it('reports expired tokens without refresh', () => expect(connectionReadiness(row, true, 2000)).toBe('reconnect_required'));
  it('distinguishes refreshable expiry from a completed refresh', () => expect(connectionReadiness({ ...row, has_refresh_token: true }, true, 2000)).toBe('refresh_required'));
  it('reports refresh failure', () => expect(connectionReadiness({ ...row, refresh_failed_at: new Date() }, true, 1000)).toBe('reconnect_required'));
  it('reports invalid expiry', () => expect(connectionReadiness({ ...row, expires_at: 'invalid' }, true, 1000)).toBe('reconnect_required'));
  it('reports missing scopes', () => expect(connectionReadiness({ ...row, scopes_granted: [] }, true, 1000)).toBe('reconnect_required'));
});
