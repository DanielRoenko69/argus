import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  CanonicalAuditBackpressureError,
  claimCanonicalAuditOutboxBatch,
  executeCanonicalAuditedMutation,
  markCanonicalAuditDelivered,
  releaseCanonicalAuditDelivery,
} from '../canonicalAuditStore.js';
import type { CanonicalAuditEventInput } from '../canonicalAuditTypes.js';

const NOW = new Date('2026-09-08T10:00:00.000Z');
const EVENT_ID = '2bbfbe02-90d9-4f43-bd39-bcda25548a16';
const SCOPE = { environment: 'local', workspaceKey: 'workspace-1', tenantKey: 'tenant-1' };

function eventInput(): Omit<CanonicalAuditEventInput, 'producer'> {
  return {
    occurredAt: NOW,
    environment: 'local',
    workspaceKey: 'workspace-1',
    tenantKey: 'tenant-1',
    solution: 'argus.core',
    actor: {
      type: 'human', id: '17', ssoSubject: 'oidc|alex', authMethod: 'oidc', effectiveRoles: ['admin'],
    },
    action: 'tag.created',
    outcome: 'success',
    risk: 'medium',
    resource: { type: 'tag', id: '42', revision: '1' },
    correlation: { rootRunId: 'run-7', traceId: 'trace-7', requestId: 'request-7' },
    payload: { before: null, after: { label: 'Platform', apiKey: 'never-store-me' } },
  };
}

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    event_id: EVENT_ID, schema_version: 1, sequence: '1', occurred_at: NOW, received_at: NOW,
    environment: 'local', workspace_key: 'workspace-1', tenant_key: 'tenant-1', solution: 'argus.core',
    producer_name: 'tags', producer_event_id: 'request-7', actor_type: 'human', actor_id: '17',
    actor_sso_subject: 'oidc|alex', actor_auth_method: 'oidc', actor_roles: ['admin'],
    action: 'tag.created', outcome: 'success', risk_level: 'medium', resource_type: 'tag', resource_id: '42',
    resource_revision: '1', policy_id: null, policy_version: null, policy_decision: null, approval_id: null,
    root_run_id: 'run-7', trace_id: 'trace-7', span_id: null, request_id: 'request-7',
    payload_summary: { after: { label: 'Platform', apiKey: '[REDACTED]' }, before: null },
    payload_digest: 'a'.repeat(64), before_digest: 'b'.repeat(64), after_digest: 'c'.repeat(64),
    redaction_profile: 'argus.audit.redaction.v1', retention_class: 'business-audit-standard',
    retention_until: null, legal_hold: false, previous_hash: '', event_hash: 'd'.repeat(64), signing_key_id: null,
    ...overrides,
  };
}

function transactionalPool(handler: (sql: string, params: unknown[]) => Promise<unknown>) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params));
  const release = jest.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  return { pool: { connect: jest.fn(async () => client), query } as unknown as pg.Pool, query, release };
}

function successfulHandler(sql: string): Promise<unknown> {
  if (sql.includes('producer_name=$4')) return Promise.resolve({ rows: [] });
  if (sql.includes('count(*)::text AS pending')) return Promise.resolve({ rows: [{ pending: '0' }] });
  if (sql.includes('SELECT last_sequence')) return Promise.resolve({ rows: [{ last_sequence: '0', last_event_hash: '' }] });
  if (sql.includes('INSERT INTO mcp_canonical_audit_events')) return Promise.resolve({ rows: [eventRow()] });
  return Promise.resolve({ rows: [], rowCount: 1 });
}

describe('canonical audit transactional mutation', () => {
  it('commits business mutation, event, outbox and chain head atomically', async () => {
    const db = transactionalPool(async (sql, params) => {
      if (sql.includes('INSERT INTO business_resource')) return { rows: [{ id: '42' }] };
      return successfulHandler(sql);
    });
    const mutate = jest.fn(async (client: pg.PoolClient) => {
      await client.query('INSERT INTO business_resource DEFAULT VALUES');
      return { id: '42' };
    });
    const result = await executeCanonicalAuditedMutation(
      db.pool,
      { name: 'tags', eventId: 'request-7' },
      SCOPE,
      mutate,
      () => eventInput(),
      { now: () => NOW, eventId: () => EVENT_ID },
    );
    expect(result).toMatchObject({ replayed: false, result: { id: '42' }, event: { eventId: EVENT_ID } });
    const sql = db.query.mock.calls.map(call => call[0]);
    expect(sql.indexOf('BEGIN')).toBeLessThan(sql.findIndex(value => value.includes('INSERT INTO business_resource')));
    expect(sql.findIndex(value => value.includes('INSERT INTO mcp_canonical_audit_events')))
      .toBeLessThan(sql.findIndex(value => value.includes('INSERT INTO mcp_canonical_audit_outbox')));
    expect(sql.at(-1)).toBe('COMMIT');
    const eventCall = db.query.mock.calls.find(call => call[0].includes('INSERT INTO mcp_canonical_audit_events'))!;
    expect(JSON.stringify(eventCall[1])).not.toContain('never-store-me');
    expect(db.release).toHaveBeenCalled();
  });

  it('rolls back the business mutation when the durable outbox insert fails', async () => {
    const db = transactionalPool(async sql => {
      if (sql.includes('INSERT INTO mcp_canonical_audit_outbox')) throw new Error('outbox unavailable');
      return successfulHandler(sql);
    });
    await expect(executeCanonicalAuditedMutation(
      db.pool,
      { name: 'tags', eventId: 'request-7' },
      SCOPE,
      async client => { await client.query('INSERT INTO business_resource DEFAULT VALUES'); return { id: '42' }; },
      () => eventInput(),
      { now: () => NOW, eventId: () => EVENT_ID },
    )).rejects.toThrow('outbox unavailable');
    expect(db.query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
    expect(db.query.mock.calls.map(call => call[0])).not.toContain('COMMIT');
  });

  it('returns the prior event and does not repeat the mutation for the same producer event', async () => {
    const db = transactionalPool(async sql => {
      if (sql.includes('producer_name=$4')) return { rows: [eventRow()] };
      return { rows: [], rowCount: 1 };
    });
    const mutate = jest.fn(async () => ({ id: 'duplicate' }));
    const result = await executeCanonicalAuditedMutation(
      db.pool, { name: 'tags', eventId: 'request-7' }, SCOPE, mutate, () => eventInput(),
    );
    expect(result).toMatchObject({ replayed: true, result: null, event: { replayed: true } });
    expect(mutate).not.toHaveBeenCalled();
    const lookup = db.query.mock.calls.find(call => call[0].includes('producer_name=$4'))!;
    expect(lookup[1]).toEqual(['workspace-1', 'tenant-1', 'local', 'tags', 'request-7']);
    expect(db.query.mock.calls.map(call => call[0]).at(-1)).toBe('COMMIT');
  });

  it('fails closed under queue backpressure instead of dropping an event', async () => {
    const db = transactionalPool(async sql => {
      if (sql.includes('count(*)::text AS pending')) return { rows: [{ pending: '2' }] };
      return successfulHandler(sql);
    });
    await expect(executeCanonicalAuditedMutation(
      db.pool,
      { name: 'tags', eventId: 'request-7' },
      SCOPE,
      async () => ({ id: '42' }),
      () => eventInput(),
      { now: () => NOW, eventId: () => EVENT_ID, maxPendingOutbox: 2 },
    )).rejects.toBeInstanceOf(CanonicalAuditBackpressureError);
    expect(db.query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
    expect(db.query.mock.calls.some(call => call[0].includes('INSERT INTO mcp_canonical_audit_events'))).toBe(false);
  });

  it('rolls back when the event envelope changes the locked tenant scope', async () => {
    const db = transactionalPool(async sql => successfulHandler(sql));
    await expect(executeCanonicalAuditedMutation(
      db.pool,
      { name: 'tags', eventId: 'request-7' },
      SCOPE,
      async () => ({ id: '42' }),
      () => ({ ...eventInput(), tenantKey: 'another-tenant' }),
      { now: () => NOW, eventId: () => EVENT_ID },
    )).rejects.toThrow('event scope does not match idempotency scope');
    expect(db.query.mock.calls.map(call => call[0])).toContain('ROLLBACK');
    expect(db.query.mock.calls.some(call => call[0].includes('INSERT INTO mcp_canonical_audit_events'))).toBe(false);
  });
});

describe('canonical audit durable delivery', () => {
  it('claims a bounded batch with skip-locked leasing and its canonical events', async () => {
    const db = transactionalPool(async sql => {
      if (sql.includes('WITH candidates AS')) return {
        rows: [{ id: '9', event_id: EVENT_ID, topic: 'audit.canonical.v1', attempt_count: 3 }],
      };
      if (sql.includes('WHERE event_id=ANY')) return { rows: [eventRow()] };
      return { rows: [], rowCount: 1 };
    });
    const deliveries = await claimCanonicalAuditOutboxBatch(db.pool, { workerId: 'worker-1', limit: 5 });
    expect(deliveries).toMatchObject([{ id: '9', eventId: EVENT_ID, attemptCount: 3 }]);
    expect(db.query.mock.calls.some(call => call[0].includes('FOR UPDATE SKIP LOCKED'))).toBe(true);
    expect(db.query.mock.calls.map(call => call[0]).at(-1)).toBe('COMMIT');
  });

  it('marks delivery idempotently and retries indefinitely with redacted errors', async () => {
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const pool = { query } as unknown as pg.Pool;
    await expect(markCanonicalAuditDelivered(pool, '9', 'worker-1')).resolves.toBe(true);
    await expect(releaseCanonicalAuditDelivery(
      pool, '9', 'worker-1', new Error('authorization=Bearer-super-secret\nretry'),
    )).resolves.toBe(true);
    const retryCall = query.mock.calls[1] as unknown as [string, unknown[]];
    expect(retryCall[0]).not.toMatch(/DELETE|max_attempt/i);
    expect(retryCall[1][2]).not.toContain('Bearer-super-secret');
    expect(retryCall[1][2]).not.toContain('\n');
  });
});
