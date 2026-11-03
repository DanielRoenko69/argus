import { it, expect, beforeAll, afterAll } from '@jest/globals';
import { describeLiveDb } from '../helpers/liveDb.js';
import pg from 'pg';

// Integration test for migration 095 — Postgres-enforced append-only audit log.
//
// Requires a running Postgres with migration 095 applied. Set POSTGRES_CONNECTION_URL
// to point at your test DB, default targets the docker-compose Postgres on localhost:5432.
//
// Notes on schema (from migration 058 + 077):
//   - event_type has CHECK constraint, only certain values allowed.
//   - api_key_prefix and model are NOT NULL.
//   - We use 'tool_hook_decision' as a valid event_type for inserts.

describeLiveDb('Migration 095 — audit log immutability', () => {
  let pool: pg.Pool;
  const testRid = `t-095-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const bypassRid = `${testRid}-bypass`;

  const insertRow = async (rid: string) =>
    pool.query(
      `INSERT INTO mcp_immutable_audit_log (event_type, request_id, api_key_prefix, model)
       VALUES ('tool_hook_decision', $1, 'test', 'test-model')`,
      [rid],
    );

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: process.env['POSTGRES_CONNECTION_URL']
        ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    });
  });

  afterAll(async () => {
    if (!pool) return;
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL argus.audit_bypass='true'`);
        await client.query(`DELETE FROM mcp_immutable_audit_log WHERE request_id LIKE $1`, [`t-%`]);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('blocks UPDATE without bypass', async () => {
    await insertRow(testRid);
    await expect(
      pool.query(
        `UPDATE mcp_immutable_audit_log SET event_type='request_failure' WHERE request_id=$1`,
        [testRid],
      ),
    ).rejects.toThrow(/append-only/);
  });

  it('blocks DELETE without bypass', async () => {
    await expect(
      pool.query(`DELETE FROM mcp_immutable_audit_log WHERE request_id=$1`, [testRid]),
    ).rejects.toThrow(/append-only/);
  });

  it('allows DELETE with bypass in TX', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL argus.audit_bypass='true'`);
      await client.query(
        `INSERT INTO mcp_immutable_audit_log (event_type, request_id, api_key_prefix, model)
         VALUES ('tool_hook_decision', $1, 'test', 'test-model')`,
        [bypassRid],
      );
      const del = await client.query(
        `DELETE FROM mcp_immutable_audit_log WHERE request_id=$1`,
        [bypassRid],
      );
      expect(del.rowCount).toBe(1);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  });
});
