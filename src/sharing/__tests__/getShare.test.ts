import { describe, it, expect, jest } from '@jest/globals';
import { getShareByToken, revokeShare } from '../shareStore.js';
import type pg from 'pg';

describe('getShareByToken', () => {
  it('hashes the token, filters revoked/expired, maps hasPassword', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ id: 7, title: 'T', agent_id: 3, redacted_messages: [{ role: 'user', content: 'hi' }], password_hash: 'x', expires_at: '2099-01-01' }],
    }));
    const pool = { query } as unknown as pg.Pool;
    const rec = await getShareByToken(pool, 'tok');
    expect(rec).not.toBeNull();
    expect(rec!.hasPassword).toBe(true);
    const sql = query.mock.calls[0]![0];
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(query.mock.calls[0]![1]).not.toContain('tok');   // looked up by hash, not raw token
  });
  it('returns null when no row (expired/revoked/unknown)', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [] })) } as unknown as pg.Pool;
    expect(await getShareByToken(pool, 'tok')).toBeNull();
  });
});

describe('revokeShare', () => {
  it('scopes by owner and returns false when nothing updated', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rowCount: 0 }));
    const pool = { query } as unknown as pg.Pool;
    expect(await revokeShare(pool, 7, 42)).toBe(false);
    expect(query.mock.calls[0]![0]).toMatch(/created_by=\$2/);
  });
});
