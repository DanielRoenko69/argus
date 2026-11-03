import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Point the outbox at an isolated temp file BEFORE importing the module.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-outbox-test-'));
const OUTBOX_FILE = path.join(TMP_DIR, 'audit-outbox.jsonl');
process.env['AUDIT_OUTBOX_PATH'] = OUTBOX_FILE;
// Disable auto-drain interval — tests trigger drain manually
process.env['AUDIT_OUTBOX_DRAIN_INTERVAL_MS'] = '60000000';

import { enqueueFailedAudit, drainOutbox } from '../auditOutbox.js';
import type { ImmutableAuditEntry } from '../immutableAudit.js';

afterAll(() => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

beforeEach(() => {
  try { fs.unlinkSync(OUTBOX_FILE); } catch { /* ok */ }
});

function entry(eventType: ImmutableAuditEntry['eventType'] = 'request_failure'): ImmutableAuditEntry {
  return { eventType, apiKeyPrefix: 'test_abc', model: 'gpt-4', riskLevel: 'low' };
}

// insertAuditRow chains under a pg advisory lock → it needs pool.connect() and
// runs BEGIN / pg_advisory_xact_lock / SELECT row_hash / INSERT / COMMIT on the
// client. This mock yields such a client; `onInsert(n, params)` decides what the
// INSERT does (return rows = success, throw = failure). Control statements + the
// prev-hash SELECT always succeed.
function makeConnectPool(
  onInsert: (n: number, params: unknown[]) => unknown,
): { pool: { connect: jest.Mock; query: jest.Mock }; insertCount: () => number } {
  let inserts = 0;
  const query = jest.fn(async (sql: string, params: unknown[]) => {
    const s = String(sql);
    if (/INSERT INTO mcp_immutable_audit_log/i.test(s)) {
      const r = await onInsert(++inserts, params ?? []);
      return (r as { rows: unknown[] }) ?? { rows: [] };
    }
    if (/SELECT row_hash FROM mcp_immutable_audit_log/i.test(s)) return { rows: [] };
    return { rows: [] }; // BEGIN / pg_advisory_xact_lock / COMMIT / ROLLBACK
  });
  const client = { query, release: jest.fn() };
  const connect = jest.fn(async () => client);
  return { pool: { connect, query }, insertCount: () => inserts };
}

const ok = () => ({ rows: [] });
const boom = () => { throw new Error('DB unreachable'); };

describe('auditOutbox — enqueueFailedAudit', () => {
  it('appends a JSON line to the outbox file', () => {
    enqueueFailedAudit(entry('rate_limit_exceeded'));
    const content = fs.readFileSync(OUTBOX_FILE, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.entry.eventType).toBe('rate_limit_exceeded');
    expect(parsed.attempts).toBe(0);
    expect(parsed.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends multiple entries — each on its own line', () => {
    enqueueFailedAudit(entry('request_success'));
    enqueueFailedAudit(entry('upstream_token_acquired'));
    enqueueFailedAudit(entry('user_policy_block'));
    const lines = fs.readFileSync(OUTBOX_FILE, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.every(l => JSON.parse(l).entry?.eventType)).toBe(true);
  });

  it('preserves the original event timestamp via enqueuedAt', () => {
    const fixedTime = new Date('2026-05-22T14:00:00Z').getTime();
    enqueueFailedAudit(entry(), () => fixedTime);
    const row = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8').trim());
    expect(row.enqueuedAt).toBe('2026-05-22T14:00:00.000Z');
  });
});

describe('auditOutbox — drainOutbox', () => {
  it('drains all entries when DB is healthy and removes the file', async () => {
    enqueueFailedAudit(entry('request_success'));
    enqueueFailedAudit(entry('cache_hit'));
    const { pool, insertCount } = makeConnectPool(ok);
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result.drained).toBe(2);
    expect(result.failed).toBe(0);
    expect(insertCount()).toBe(2);
    expect(fs.existsSync(OUTBOX_FILE)).toBe(false);
  });

  it('keeps entries when DB is still down, increments attempts', async () => {
    enqueueFailedAudit(entry('request_failure'));
    const { pool } = makeConnectPool(boom);
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result.drained).toBe(0);
    expect(result.failed).toBe(1);
    expect(fs.existsSync(OUTBOX_FILE)).toBe(true);
    const row = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8').trim());
    expect(row.attempts).toBe(1);
  });

  it('passes original enqueuedAt to insertAuditRow as the created_at param', async () => {
    enqueueFailedAudit(entry());
    const enq = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8').trim()).enqueuedAt as string;
    let captured: unknown[] = [];
    const { pool } = makeConnectPool((_n, params) => { captured = params; return { rows: [] }; });
    await drainOutbox(pool as unknown as import('pg').Pool);
    // Chained INSERT carries 22 params; created_at (index 21) is the original enqueuedAt ISO.
    expect(captured).toHaveLength(22);
    expect(captured[21]).toBe(enq);
  });

  it('drops entries after MAX_ATTEMPTS', async () => {
    fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true });
    const row = { entry: entry('request_failure'), enqueuedAt: new Date().toISOString(), attempts: 19 };
    fs.writeFileSync(OUTBOX_FILE, JSON.stringify(row) + '\n');

    const { pool } = makeConnectPool(boom);
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result.drained).toBe(0);
    expect(result.failed).toBe(0);     // not retried — exceeded threshold
    expect(result.dropped).toBe(1);
    expect(fs.existsSync(OUTBOX_FILE)).toBe(false);
  });

  it('drops corrupt lines (un-parseable JSON)', async () => {
    fs.mkdirSync(path.dirname(OUTBOX_FILE), { recursive: true });
    fs.writeFileSync(OUTBOX_FILE, '{not valid json\n' + JSON.stringify({
      entry: entry(), enqueuedAt: new Date().toISOString(), attempts: 0,
    }) + '\n');
    const { pool } = makeConnectPool(ok);
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result.drained).toBe(1);
    expect(result.dropped).toBe(1);
  });

  it('drains partial — keeps failing entries, removes successful ones', async () => {
    enqueueFailedAudit(entry('request_failure'));
    enqueueFailedAudit(entry('rate_limit_exceeded'));
    enqueueFailedAudit(entry('upstream_token_acquired'));

    // INSERT #2 succeeds; #1 and #3 fail.
    const { pool } = makeConnectPool((n) => { if (n === 2) return { rows: [] }; throw new Error('transient'); });
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result.drained).toBe(1);
    expect(result.failed).toBe(2);
    const remaining = fs.readFileSync(OUTBOX_FILE, 'utf8').trim().split('\n');
    expect(remaining).toHaveLength(2);
    expect(remaining.every(l => JSON.parse(l).attempts === 1)).toBe(true);
  });

  it('returns zero counts when outbox file does not exist', async () => {
    const { pool } = makeConnectPool(ok);
    const result = await drainOutbox(pool as unknown as import('pg').Pool);
    expect(result).toEqual({ drained: 0, failed: 0, dropped: 0 });
  });
});

describe('auditOutbox — concurrent drain guard', () => {
  it('second drain returns immediately while first is in flight', async () => {
    enqueueFailedAudit(entry());
    // Slow client: the first statement (BEGIN) hangs, holding the first drain.
    let resolveSlow: () => void = () => {};
    const slow = new Promise<{ rows: [] }>(r => { resolveSlow = () => r({ rows: [] }); });
    const query = jest.fn(() => slow);
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client), query };

    const first = drainOutbox(pool as unknown as import('pg').Pool);
    const second = drainOutbox(pool as unknown as import('pg').Pool);
    // Second should resolve immediately with zero counts (drainInProgress guard).
    const r2 = await second;
    expect(r2).toEqual({ drained: 0, failed: 0, dropped: 0 });
    // Only the first drain reached the DB, and it's parked on BEGIN.
    expect(query).toHaveBeenCalledTimes(1);

    // Let the first drain finish.
    resolveSlow();
    await first;
  });
});
