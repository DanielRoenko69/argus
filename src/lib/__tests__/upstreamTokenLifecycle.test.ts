import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { encryptToken, decryptToken, getValidToken, revokeToken } from '../upstreamTokens.js';

jest.mock('../../audit/immutableAudit.js', () => ({ writeImmutableAudit: jest.fn() }));
const cfg = { id: 42, oauth_client_id: 'client', oauth_client_secret_enc: 'fixture-secret', oauth_token_url: 'https://8.8.8.8/token' };
beforeEach(() => {
  process.env['MCP_API_KEYS'] = 'test-key';
  process.env['SESSION_SECRET'] = 's'.repeat(32);
  process.env['DB_ENCRYPTION_KEY'] = 'e'.repeat(64);
});
afterEach(() => { jest.restoreAllMocks(); });

function database(overrides: Record<string, unknown> = {}) {
  let row: Record<string, unknown> | null = {
    user_id: 3, backend_id: 42, access_token_enc: encryptToken('old-access'), refresh_token_enc: null,
    expires_at: new Date(Date.now() + 600_000), scopes_granted: ['read'], upstream_username: 'alex', refresh_failed_at: null,
    ...overrides,
  };
  const query = jest.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    if (sql.includes('SELECT user_id')) return { rows: row ? [{ ...row }] : [] };
    if (sql.includes('SET refresh_failed_at = now()') && row) row.refresh_failed_at = new Date();
    if (sql.includes('SET\n         access_token_enc') && row) {
      row = { ...row, access_token_enc: params[2], refresh_token_enc: params[3], expires_at: params[4], scopes_granted: params[5], refresh_failed_at: null };
    }
    if (sql.startsWith('DELETE')) row = null;
    return { rows: [] };
  });
  const release = jest.fn();
  const pool = { query, connect: async () => ({ query, release }) } as unknown as pg.Pool;
  return { pool, query, release, row: () => row };
}

describe('per-user token lifecycle (no provider/network calls)', () => {
  it('refuses unencrypted OAuth storage even in development', () => {
    const key = process.env['DB_ENCRYPTION_KEY'];
    delete process.env['DB_ENCRYPTION_KEY'];
    try { expect(() => encryptToken('fixture-access')).toThrow(); }
    finally { process.env['DB_ENCRYPTION_KEY'] = key; }
  });
  it('returns a valid non-refreshable lease and touches last use', async () => {
    const db = database();
    expect((await getValidToken(db.pool, 3, 42, cfg))?.access_token).toBe('old-access');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('last_used_at'), [3, 42]);
  });
  it.each([new Date(0), new Date(NaN)])('rejects expired or invalid non-refreshable leases: %p', async expires_at => {
    const db = database({ expires_at });
    expect(await getValidToken(db.pool, 3, 42, cfg)).toBeNull();
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('last_used_at'), expect.anything());
  });
  it('does not keep using a token whose refresh previously failed', async () => {
    const db = database({ refresh_failed_at: new Date(), refresh_token_enc: encryptToken('refresh') });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    expect(await getValidToken(db.pool, 3, 42, cfg)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rotates encrypted credentials under the user/backend lock', async () => {
    const db = database({ expires_at: new Date(0), refresh_token_enc: encryptToken('refresh') });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, scope: 'read' }));
    const result = await getValidToken(db.pool, 3, 42, cfg);
    expect(result?.access_token).toBe('new-access');
    expect(decryptToken(db.row()?.refresh_token_enc as string)).toBe('new-refresh');
    expect(db.row()?.access_token_enc).not.toContain('new-access');
    expect(db.query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1::int, $2::int)', [3, 42]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(db.release).toHaveBeenCalled();
  });
  it.each(['rejected', 'transport', 'malformed'])('blocks after a %s refresh, without automatic retry', async failure => {
    const db = database({ expires_at: new Date(0), refresh_token_enc: encryptToken('refresh') });
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    if (failure === 'transport') fetchSpy.mockRejectedValue(new Error('private-provider-details'));
    else fetchSpy.mockResolvedValue(failure === 'rejected' ? new Response('private-provider-details', { status: 400 }) : Response.json({ access_token: {} }));
    expect(await getValidToken(db.pool, 3, 42, cfg)).toBeNull();
    expect(db.row()?.refresh_failed_at).toBeInstanceOf(Date);
    expect(await getValidToken(db.pool, 3, 42, cfg)).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
  it('preserves an explicit scope downgrade for policy to reject', async () => {
    const db = database({ expires_at: new Date(0), refresh_token_enc: encryptToken('refresh') });
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ access_token: 'new-access', expires_in: 3600, scope: '' }));
    expect((await getValidToken(db.pool, 3, 42, cfg))?.scopes_granted).toEqual([]);
  });
  it('disconnects under the same lock before returning the token for provider revocation', async () => {
    const db = database({ refresh_token_enc: encryptToken('rotated-refresh') });
    const removed = await revokeToken(db.pool, 3, 42);
    expect(removed?.refresh_token).toBe('rotated-refresh');
    expect(db.row()).toBeNull();
    expect(await getValidToken(db.pool, 3, 42, cfg)).toBeNull();
    const sql = db.query.mock.calls.map(call => call[0]);
    expect(sql.indexOf('SELECT pg_advisory_xact_lock($1::int, $2::int)')).toBeLessThan(sql.findIndex(s => s.startsWith('DELETE')));
    expect(db.release).toHaveBeenCalled();
  });
});
