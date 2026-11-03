import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { createAuditRetentionPolicy, placeAuditLegalHold, releaseAuditLegalHold } from '../retention.js';

const NOW = new Date('2026-09-08T12:00:00.000Z');
const POLICY_ID = '62c990b5-4935-4a97-8a97-2c23c78901f8';
const HOLD_ID = '0a0d260e-234f-4ac5-b16d-7c23ce1c5ea9';
const HOLD_ACTION_ID = 'b0b00a78-73e9-49e1-bbaa-a214602f5e58';
const EVENT_ID = '0abf3b0b-b0fe-409d-a159-91ae32ea6bba';
const scope = { workspaceKey: 'default', tenantKey: 'default', environment: 'production' };
const actor = { type: 'human' as const, id: '17', ssoSubject: 'oidc|17', authMethod: 'oidc', effectiveRoles: ['operations_admin'] };

function canonicalRow(action: string, resourceType: string, resourceId: string, revision: string) {
  return {
    event_id: EVENT_ID, schema_version: 1, sequence: '1', occurred_at: NOW, received_at: NOW,
    environment: scope.environment, workspace_key: scope.workspaceKey, tenant_key: scope.tenantKey,
    solution: 'argus.core', producer_name: 'test', producer_event_id: 'request-1', actor_type: actor.type,
    actor_id: actor.id, actor_sso_subject: actor.ssoSubject, actor_auth_method: actor.authMethod,
    actor_roles: actor.effectiveRoles, action, outcome: 'success', risk_level: 'critical',
    resource_type: resourceType, resource_id: resourceId, resource_revision: revision,
    policy_id: 'argus.audit.governance', policy_version: '1', policy_decision: 'configured', approval_id: null,
    root_run_id: null, trace_id: null, span_id: null, request_id: null, payload_summary: {},
    payload_digest: 'a'.repeat(64), before_digest: null, after_digest: 'b'.repeat(64),
    redaction_profile: 'argus.audit.redaction.v1', retention_class: 'business-audit-governance',
    retention_until: null, legal_hold: false, previous_hash: '', event_hash: 'c'.repeat(64), signing_key_id: null,
  };
}

function poolFor(handler: (sql: string, params: unknown[]) => Promise<unknown>) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => handler(sql, params));
  const release = jest.fn();
  const client = { query, release } as unknown as pg.PoolClient;
  return { pool: { connect: jest.fn(async () => client), query } as unknown as pg.Pool, query, release };
}

function canonicalInfrastructure(sql: string, row: ReturnType<typeof canonicalRow>): unknown | null {
  if (sql.includes('producer_name=$4')) return { rows: [] };
  if (sql.includes('count(*)::text AS pending')) return { rows: [{ pending: '0' }] };
  if (sql.includes('SELECT last_sequence')) return { rows: [{ last_sequence: '0', last_event_hash: '' }] };
  if (sql.includes('INSERT INTO mcp_canonical_audit_events')) return { rows: [row] };
  return null;
}

describe('canonical audit retention governance', () => {
  it('creates the next immutable retention-policy version with canonical evidence', async () => {
    const db = poolFor(async (sql, params) => {
      const infrastructure = canonicalInfrastructure(
        sql,
        canonicalRow('audit.retention_policy.version_created', 'audit_retention_policy', POLICY_ID, '3'),
      );
      if (infrastructure) return infrastructure;
      if (sql.includes('MAX(version)')) return { rows: [{ version: '3' }] };
      if (sql.includes('INSERT INTO mcp_canonical_audit_retention_policies')) return { rows: [{
        policy_id: params[0], workspace_key: params[1], tenant_key: params[2], environment: params[3],
        retention_class: params[4], version: params[5], duration_days: params[6], region: params[7],
        effective_from: params[8], created_at: params[9], created_by: params[10], policy_digest: params[11],
      }] };
      return { rows: [], rowCount: 1 };
    });

    const result = await createAuditRetentionPolicy(db.pool, {
      scope, actor, producerEventId: 'request-1', now: () => NOW, uuid: () => POLICY_ID,
    }, {
      retentionClass: 'business-audit-standard', durationDays: 2555, region: 'eu',
    });

    expect(result).toMatchObject({
      replayed: false,
      policy: { policyId: POLICY_ID, version: 3, durationDays: 2555, region: 'eu' },
    });
    const sql = db.query.mock.calls.map(call => String(call[0]));
    expect(JSON.stringify(db.query.mock.calls)).toContain('audit-retention-policy');
    expect(sql.some(value => value.includes('INSERT INTO mcp_canonical_audit_events'))).toBe(true);
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it('places a legal hold without persisting its raw justification or mutating events', async () => {
    const uuids = [HOLD_ID, HOLD_ACTION_ID];
    const db = poolFor(async (sql, params) => {
      const infrastructure = canonicalInfrastructure(
        sql,
        canonicalRow('audit.legal_hold.placed', 'audit_legal_hold', HOLD_ID, HOLD_ACTION_ID),
      );
      if (infrastructure) return infrastructure;
      if (sql.includes('INSERT INTO mcp_canonical_audit_legal_hold_actions')) return { rows: [{
        hold_action_id: params[0], hold_id: params[1], action: 'placed', workspace_key: params[2],
        tenant_key: params[3], environment: params[4], from_sequence: params[5], through_sequence: params[6],
        resource_type: params[7], resource_id: params[8], justification_digest: params[9],
        actor_id: params[10], occurred_at: params[11], producer_event_id: params[12],
      }] };
      return { rows: [], rowCount: 1 };
    });

    const result = await placeAuditLegalHold(db.pool, {
      scope, actor, producerEventId: 'request-hold-1', now: () => NOW, uuid: () => uuids.shift()!,
    }, {
      fromSequence: 2, throughSequence: 9, resourceType: 'workflow', resourceId: '161',
      justification: 'Privileged legal case details that must not enter the ledger',
    });

    expect(result).toMatchObject({
      replayed: false,
      hold: { holdId: HOLD_ID, holdActionId: HOLD_ACTION_ID, fromSequence: 2, throughSequence: 9 },
    });
    const calls = JSON.stringify(db.query.mock.calls);
    expect(calls).not.toContain('Privileged legal case details');
    expect(calls).not.toContain('UPDATE mcp_canonical_audit_events');
    expect(result.hold.justificationDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects incomplete resource scopes before opening a transaction', async () => {
    const pool = { connect: jest.fn() } as unknown as pg.Pool;
    await expect(placeAuditLegalHold(pool, {
      scope, actor, producerEventId: 'request-bad',
    }, {
      resourceType: 'workflow', justification: 'legal basis',
    })).rejects.toThrow('provided together');
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rejects malformed database UUIDs before opening a transaction', async () => {
    const pool = { connect: jest.fn() } as unknown as pg.Pool;

    await expect(createAuditRetentionPolicy(pool, {
      scope, actor, producerEventId: 'request-bad-policy', uuid: () => 'not-a-uuid',
    }, {
      retentionClass: 'business-audit-standard', durationDays: 365, region: 'eu',
    })).rejects.toThrow('policyId must be a UUID');

    await expect(placeAuditLegalHold(pool, {
      scope, actor, producerEventId: 'request-bad-hold',
    }, {
      holdId: 'not-a-uuid', justification: 'legal basis',
    })).rejects.toThrow('holdId must be a UUID');

    await expect(releaseAuditLegalHold(pool, {
      scope, actor, producerEventId: 'request-bad-release',
    }, {
      holdId: 'not-a-uuid', justification: 'release basis',
    })).rejects.toThrow('holdId must be a UUID');

    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('checks an existing release inside the authorized tenant scope', async () => {
    const db = poolFor(async (sql, params) => {
      const infrastructure = canonicalInfrastructure(
        sql,
        canonicalRow('audit.legal_hold.released', 'audit_legal_hold', HOLD_ID, HOLD_ACTION_ID),
      );
      if (infrastructure) return infrastructure;
      if (sql.includes("action='placed'")) return { rows: [{
        hold_action_id: 'c00d1054-b0dc-4995-b83e-47c30c9c9022', hold_id: HOLD_ID, action: 'placed',
        workspace_key: scope.workspaceKey, tenant_key: scope.tenantKey, environment: scope.environment,
        from_sequence: '2', through_sequence: '9', resource_type: 'workflow', resource_id: '161',
        justification_digest: 'd'.repeat(64), actor_id: actor.id, occurred_at: NOW,
        producer_event_id: 'request-place',
      }] };
      if (sql.includes("action='released'") && sql.startsWith('SELECT 1')) return { rows: [] };
      if (sql.includes('INSERT INTO mcp_canonical_audit_legal_hold_actions')) return { rows: [{
        hold_action_id: params[0], hold_id: params[1], action: 'released', workspace_key: params[2],
        tenant_key: params[3], environment: params[4], from_sequence: params[5], through_sequence: params[6],
        resource_type: params[7], resource_id: params[8], justification_digest: params[9],
        actor_id: params[10], occurred_at: params[11], producer_event_id: params[12],
      }] };
      return { rows: [], rowCount: 1 };
    });

    await releaseAuditLegalHold(db.pool, {
      scope, actor, producerEventId: 'request-release', now: () => NOW, uuid: () => HOLD_ACTION_ID,
    }, { holdId: HOLD_ID, justification: 'release basis' });

    const releaseLookup = db.query.mock.calls.find(call => String(call[0]).startsWith('SELECT 1')
      && String(call[0]).includes("action='released'"));
    expect(releaseLookup?.[1]).toEqual([
      HOLD_ID, scope.workspaceKey, scope.tenantKey, scope.environment,
    ]);
  });
});
