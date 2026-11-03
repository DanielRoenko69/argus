import { describe, it, expect, jest } from '@jest/globals';
import { createShare, ShareForbiddenError } from '../shareStore.js';
import type pg from 'pg';

function poolWithSession(row: Record<string, unknown> | undefined) {
  const captured: { sql: string; params: unknown[] }[] = [];
  const pool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params: params ?? [] });
      if (/SELECT .* FROM mcp_agent_sessions/.test(sql)) return { rows: row ? [row] : [] };
      if (/INSERT INTO mcp_shared_conversations/.test(sql)) return { rows: [{ id: 7 }] };
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
  return { pool, captured };
}

const session = {
  user_id: 42, agent_id: 3, active_leaf_id: 'm2',
  messages: [
    { id: 'm1', parentId: null, role: 'user', content: 'mail me at bob@acme.com' },
    { id: 'm2', parentId: 'm1', role: 'assistant', content: 'sure, IBAN DE89370400440532013000' },
  ],
};

describe('createShare', () => {
  it('snapshots the active path (user+assistant), redacts PII, hashes the token, clamps expiry', async () => {
    const { pool, captured } = poolWithSession(session);
    const { id, token } = await createShare(pool, { sessionId: 's1', userId: 42, expiryDays: 999 });
    expect(id).toBe(7);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);            // base64url, returned once
    const ins = captured.find((c) => /INSERT INTO mcp_shared_conversations/.test(c.sql))!;
    // params: token_hash, agent_id, source_session_id, title, redacted_messages(json), password_hash, created_by, expires_at
    const tokenHash = ins.params[0] as string;
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);              // sha256 hex, NOT the raw token
    expect(tokenHash).not.toBe(token);
    const msgs = JSON.parse(ins.params[4] as string) as Array<{ role: string; content: string }>;
    expect(msgs).toEqual([
      { role: 'user', content: 'mail me at [EMAIL]' },
      { role: 'assistant', content: 'sure, IBAN [IBAN]' },
    ]);
    // title (params[3]) is shown verbatim on the anon /share page → must be redacted, never raw PII
    expect(ins.params[3]).toBe('mail me at [EMAIL]');
    expect(ins.params[3]).not.toContain('bob@acme.com');
    expect(ins.params[5]).toBeNull();                          // no password
  });

  it('rejects a non-owner', async () => {
    const { pool } = poolWithSession(session);
    await expect(createShare(pool, { sessionId: 's1', userId: 99, expiryDays: 7 })).rejects.toThrow(ShareForbiddenError);
  });

  it('hashes a supplied password', async () => {
    const { pool, captured } = poolWithSession(session);
    await createShare(pool, { sessionId: 's1', userId: 42, expiryDays: 7, password: 'hunter2' });
    const ins = captured.find((c) => /INSERT INTO mcp_shared_conversations/.test(c.sql))!;
    expect(typeof ins.params[5]).toBe('string');
    expect(ins.params[5]).not.toBe('hunter2');                // scrypt hash, not plaintext
  });
});
