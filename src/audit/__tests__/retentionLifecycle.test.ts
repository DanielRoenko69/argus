import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../canonicalAuditStore.js';
import {
  classifyRetentionPrefix,
  decideAuditRetentionPlan,
  type AuditRetentionPlan,
  type RetentionCandidateRow,
  type RetentionLifecycleContext,
} from '../retentionLifecycle.js';

jest.mock('../canonicalAuditStore.js', () => ({ executeCanonicalAuditedMutation: jest.fn() }));
const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const now = new Date('2026-09-10T12:00:00.000Z');
const planId = '10000000-0000-4000-8000-000000000001';
const actionId = '20000000-0000-4000-8000-000000000002';

function candidate(sequence: number, input: Partial<RetentionCandidateRow> = {}): RetentionCandidateRow {
  return {
    event_id: `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`,
    sequence, occurred_at: '2025-01-01T00:00:00.000Z', event_hash: String(sequence).padStart(64, 'a').slice(-64),
    resource_type: 'workflow', resource_id: String(sequence), retention_class: sequence % 2 ? 'security' : 'operations',
    effective_retention_until: '2026-01-01T00:00:00.000Z', effective_legal_hold: false,
    policy_id: null, policy_version: null, policy_region: null, ...input,
  };
}

function plan(requestedById = '41'): AuditRetentionPlan {
  const eligibleEvents = [candidate(1)].map(row => ({
    eventId: row.event_id, sequence: Number(row.sequence), occurredAt: new Date(row.occurred_at).toISOString(),
    eventHash: row.event_hash, resourceType: row.resource_type, resourceId: row.resource_id,
    retentionClass: row.retention_class, retentionUntil: new Date(String(row.effective_retention_until)).toISOString(),
    policyId: null, policyVersion: null, region: null,
  }));
  const manifest = {
    schemaVersion: 1 as const, mode: 'dry_run' as const,
    scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'production' }, retentionClass: 'all-classes',
    checkpoint: { id: '30000000-0000-4000-8000-000000000003', digest: 'c'.repeat(64), throughSequence: 10 },
    evaluatedAt: now.toISOString(), eligibleEvents, blocker: { code: 'not_due' as const, sequence: 2 },
    purgeAllowed: false as const, nextRequiredAction: 'independent_approval_then_archive' as const,
  };
  // Digest is deliberately replaced by the database fixture in tests that reach verification.
  return {
    planId, workspaceKey: 'default', tenantKey: 'default', environment: 'production', retentionClass: 'all-classes',
    checkpointId: manifest.checkpoint.id, checkpointDigest: manifest.checkpoint.digest, throughSequence: 10,
    evaluatedAt: now.toISOString(), eligiblePrefixCount: 1, firstSequence: 1, lastSequence: 1,
    blocker: manifest.blocker, manifestSha256: 'd'.repeat(64), manifest, requestedById,
    requesterSsoSubject: `oidc:${requestedById}`, mfaVerifiedAt: now.toISOString(), mfaMethod: 'webauthn',
    producerEventId: 'plan-request', createdAt: now.toISOString(), status: 'planned',
  };
}

function context(actorId = '42'): RetentionLifecycleContext {
  return {
    scope: { workspaceKey: 'default', tenantKey: 'default', environment: 'production' },
    actor: { type: 'human', id: actorId, ssoSubject: `oidc:${actorId}`, authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    mfaVerifiedAt: '2026-09-10T11:59:00.000Z', mfaMethod: 'webauthn', producerEventId: 'decision-request',
    now: () => now, uuid: () => actionId,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockImplementation(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(_pool as unknown as pg.PoolClient);
    const event = eventFor(result);
    return { event: { ...event, eventId: '40000000-0000-4000-8000-000000000004' } as never, replayed: false, result };
  });
});

describe('audit retention lifecycle', () => {
  it('selects only a contiguous expired prefix across different retention classes', () => {
    const result = classifyRetentionPrefix([
      candidate(1), candidate(2), candidate(3, { effective_retention_until: '2027-01-01T00:00:00.000Z' }),
    ], now);
    expect(result.eligibleEvents.map(event => [event.sequence, event.retentionClass])).toEqual([[1, 'security'], [2, 'operations']]);
    expect(result.blocker).toEqual({ code: 'not_due', sequence: 3 });
  });

  it('fails closed at the first active legal hold without skipping later events', () => {
    const result = classifyRetentionPrefix([candidate(1), candidate(2, { effective_legal_hold: true }), candidate(3)], now);
    expect(result.eligibleEvents.map(event => event.sequence)).toEqual([1]);
    expect(result.blocker).toEqual({ code: 'legal_hold', sequence: 2 });
  });

  it('treats missing retention as indefinite and never as expired', () => {
    expect(classifyRetentionPrefix([candidate(1, { effective_retention_until: null })], now))
      .toMatchObject({ eligibleEvents: [], blocker: { code: 'indefinite', sequence: 1 } });
  });

  it('enforces the bounded archival batch without dropping the boundary', () => {
    const result = classifyRetentionPrefix([candidate(1), candidate(2), candidate(3)], now, 2);
    expect(result.eligibleEvents).toHaveLength(2);
    expect(result.blocker).toEqual({ code: 'batch_limit', sequence: 3 });
  });

  it('enforces four-eyes before reading or changing source evidence', async () => {
    const stored = plan('42');
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM mcp_canonical_audit_retention_plans')) return { rows: [{
        plan_id: stored.planId, workspace_key: stored.workspaceKey, tenant_key: stored.tenantKey,
        environment: stored.environment, retention_class: stored.retentionClass, checkpoint_id: stored.checkpointId,
        checkpoint_digest: stored.checkpointDigest, through_sequence: stored.throughSequence, evaluated_at: stored.evaluatedAt,
        eligible_prefix_count: stored.eligiblePrefixCount, first_sequence: stored.firstSequence, last_sequence: stored.lastSequence,
        blocker_code: stored.blocker.code, blocker_sequence: stored.blocker.sequence, manifest_sha256: stored.manifestSha256,
        manifest_json: stored.manifest, requested_by_id: stored.requestedById, requester_sso_subject: stored.requesterSsoSubject,
        mfa_verified_at: stored.mfaVerifiedAt, mfa_method: stored.mfaMethod, producer_event_id: stored.producerEventId,
        created_at: stored.createdAt,
      }] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;
    await expect(decideAuditRetentionPlan(pool, context('42'), planId, 'approved', 'Independent review'))
      .rejects.toThrow('four-eyes');
    expect(query.mock.calls.some(call => String(call[0]).includes('mcp_canonical_audit_events'))).toBe(false);
  });
});
