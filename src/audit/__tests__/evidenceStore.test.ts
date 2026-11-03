import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { computeAuditCheckpointDigest, createAuditCheckpointSigner } from '../checkpoints.js';
import { loadAuditEvidencePage } from '../evidenceStore.js';
import type { AuditEvidenceQuery } from '../evidenceTypes.js';

const query: AuditEvidenceQuery = {
  limit: 1,
  cursor: null,
  actorId: '17',
  actorType: 'human',
  resourceType: 'workflow',
  resourceId: '161',
  tagId: '3',
  action: 'tag.assignments_replaced',
  outcome: 'success',
  risk: 'medium',
  policyId: null,
  rootRunId: 'run-24',
  traceId: 'trace-24',
  environment: 'test',
  from: '2026-09-01T00:00:00.000Z',
  to: '2026-09-08T00:00:00.000Z',
};

function row(id: string, occurredAt: string, payload: Record<string, unknown>, resourceTags: unknown = []) {
  return {
    event_id: id,
    schema_version: 1,
    sequence: 7,
    occurred_at: occurredAt,
    received_at: occurredAt,
    environment: 'test',
    workspace_key: 'default',
    tenant_key: 'default',
    solution: 'argus.core',
    producer_name: 'tags.assignments.replace',
    producer_event_id: `producer-${id}`,
    actor_type: 'human',
    actor_id: '17',
    actor_sso_subject: 'oidc:subject-17',
    actor_auth_method: 'oidc',
    actor_roles: ['developer'],
    action: 'tag.assignments_replaced',
    outcome: 'success',
    risk_level: 'medium',
    resource_type: 'workflow',
    resource_id: '161',
    resource_revision: '12',
    policy_id: null as string | null,
    policy_version: null as string | null,
    policy_decision: null as string | null,
    approval_id: null,
    root_run_id: 'run-24',
    trace_id: 'trace-24',
    span_id: 'span-1',
    request_id: 'request-1',
    payload_summary: payload,
    payload_digest: '1'.repeat(64),
    before_digest: '2'.repeat(64),
    after_digest: '3'.repeat(64),
    redaction_profile: 'argus.audit.redaction.v1',
    retention_class: 'business-audit-standard',
    retention_until: null,
    legal_hold: false,
    previous_hash: '4'.repeat(64),
    event_hash: '5'.repeat(64),
    signing_key_id: null,
    effective_retention_until: null,
    effective_legal_hold: false,
    resource_tags: resourceTags,
  };
}

describe('audit evidence store', () => {
  it('authorizes in SQL, keeps payload private and returns an opaque cursor', async () => {
    const queryFn = jest.fn(async () => ({ rows: [
      row('6d826b73-3280-4fdc-a387-6c8ceee493ad', '2026-09-07T12:01:04.000Z', {
        after: { label: 'Release workflow', tags: [{ id: '3', label: 'Platform', color: '#7C3AED' }] },
        context: { token: '[redacted]', internal: 'must-not-leave-the-service' },
      }),
      row('7d826b73-3280-4fdc-a387-6c8ceee493ad', '2026-09-07T12:00:00.000Z', {}),
    ] }));
    const pool = { query: queryFn } as unknown as pg.Pool;
    const page = await loadAuditEvidencePage(
      pool,
      [{ workspaceKey: 'default', tenantKey: 'default' }],
      query,
      { canExport: false, now: new Date('2026-09-08T00:00:00.000Z'), loadCheckpoint: async () => null },
    );

    expect(queryFn).toHaveBeenCalledTimes(1);
    const [sql, params] = queryFn.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('unnest($1::text[], $2::text[])');
    expect(sql).toContain("event.payload_summary #> '{after,tags}'");
    expect(params.slice(0, 2)).toEqual([['default'], ['default']]);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      resource: {
        label: 'Release workflow', labelSource: 'event_payload',
        tags: [{ id: '3', label: 'Platform', color: '#7c3aed' }], tagSource: 'event_payload',
      },
      integrity: { hashState: 'event_hash_invalid', checkpointId: null },
    });
    expect(page.verification.state).toBe('integrity_failure');
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.export).toEqual({ allowed: false, state: 'not_authorized', formats: [], requiresStepUp: false });
    expect(JSON.stringify(page)).not.toContain('must-not-leave-the-service');
    expect(JSON.stringify(page)).not.toContain('payloadSummary');
  });

  it('declares mutable tag enrichment instead of presenting it as immutable evidence', async () => {
    const pool = { query: jest.fn(async () => ({ rows: [
      row('8d826b73-3280-4fdc-a387-6c8ceee493ad', '2026-09-07T11:00:00.000Z', {}, [
        { id: '9', label: 'Current tag', color: '#112233' },
      ]),
    ] })) } as unknown as pg.Pool;
    const page = await loadAuditEvidencePage(
      pool,
      [{ workspaceKey: 'default', tenantKey: 'default' }],
      { ...query, limit: 50, tagId: null, action: null },
      { canExport: true, now: new Date('2026-09-08T00:00:00.000Z'), loadCheckpoint: async () => null },
    );
    expect(page.items[0]?.resource.tagSource).toBe('current_live_fallback');
    expect(page.coverage.legacyGaps).toContainEqual(expect.objectContaining({ code: 'resource_tags_live_fallback' }));
    expect(page.export.allowed).toBe(true);
    expect(page.export.requiresStepUp).toBe(true);
  });

  it('links access-policy evidence to the governed policy surface', async () => {
    const policyRow = row(
      'ad826b73-3280-4fdc-a387-6c8ceee493ad',
      '2026-09-07T11:30:00.000Z',
      { after: { agentIds: [3, 8] } },
    );
    policyRow.resource_type = 'user_access_policy';
    policyRow.resource_id = '42';
    policyRow.action = 'access.user_agent_allow.replaced';
    policyRow.policy_id = 'argus.access.policy-management';
    policyRow.policy_version = '1';
    policyRow.policy_decision = 'allow';
    policyRow.risk_level = 'critical';
    const pool = { query: jest.fn(async () => ({ rows: [policyRow] })) } as unknown as pg.Pool;

    const page = await loadAuditEvidencePage(
      pool,
      [{ workspaceKey: 'default', tenantKey: 'default' }],
      { ...query, limit: 50, tagId: null, action: null },
      { canExport: false, now: new Date('2026-09-08T00:00:00.000Z'), loadCheckpoint: async () => null },
    );

    expect(page.items[0]).toMatchObject({
      resource: { type: 'user_access_policy', id: '42', href: '/governance/policies?tab=users&user=42' },
      policy: { id: 'argus.access.policy-management', version: '1', decision: 'allow' },
    });
  });

  it('attaches a valid signed checkpoint that covers the returned event page', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const checkpointSigner = createAuditCheckpointSigner(
      'audit-key-2026-09',
      privateKey.export({ type: 'pkcs8', format: 'pem' }),
    );
    const unsigned = {
      checkpointId: '1fdaec54-b2e4-4f54-8079-ff3ae7359b8c',
      schemaVersion: 1 as const,
      workspaceKey: 'default', tenantKey: 'default', environment: 'test',
      lastSequence: 7,
      lastEventId: '6d826b73-3280-4fdc-a387-6c8ceee493ad',
      lastEventHash: '5'.repeat(64),
      previousCheckpointId: null, previousCheckpointDigest: '',
      createdAt: '2026-09-08T00:00:00.000Z', algorithm: 'Ed25519' as const,
      keyId: checkpointSigner.keyId,
      publicKeyFingerprint: checkpointSigner.publicKeyFingerprint,
    };
    const checkpointDigest = computeAuditCheckpointDigest(unsigned);
    const checkpoint = {
      ...unsigned,
      checkpointDigest,
      signature: sign(null, Buffer.from(checkpointDigest, 'hex'), checkpointSigner.privateKey).toString('base64url'),
      replayed: false,
    };
    const pool = { query: jest.fn(async () => ({ rows: [
      row(unsigned.lastEventId, '2026-09-07T12:01:04.000Z', {}),
    ] })) } as unknown as pg.Pool;

    const page = await loadAuditEvidencePage(
      pool,
      [{ workspaceKey: 'default', tenantKey: 'default' }],
      { ...query, limit: 50, tagId: null, action: null },
      {
        canExport: true,
        hasFreshMfa: true,
        now: new Date('2026-09-08T00:00:00.000Z'),
        loadCheckpoint: async () => ({ checkpoint, publicKeyPem: checkpointSigner.publicKeyPem }),
      },
    );

    expect(page.verification).toMatchObject({
      state: 'integrity_failure',
      checkpointId: checkpoint.checkpointId,
    });
    expect(page.export.requiresStepUp).toBe(false);
    expect(page.items[0]?.integrity.checkpointId).toBe(checkpoint.checkpointId);
    expect(page.coverage.legacyGaps).not.toContainEqual(expect.objectContaining({ code: 'unsigned_checkpoint' }));
  });

  it('fails closed when no authorized workspace scope is available', async () => {
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    await expect(loadAuditEvidencePage(pool, [], query, { canExport: false, loadCheckpoint: async () => null })).rejects.toThrow('scope is unavailable');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('fails closed for an unsupported canonical audit schema version', async () => {
    const unsupportedRow = row(
      '9d826b73-3280-4fdc-a387-6c8ceee493ad',
      '2026-09-07T10:00:00.000Z',
      {},
    );
    unsupportedRow.schema_version = 2;
    const pool = { query: jest.fn(async () => ({ rows: [unsupportedRow] })) } as unknown as pg.Pool;

    await expect(loadAuditEvidencePage(
      pool,
      [{ workspaceKey: 'default', tenantKey: 'default' }],
      { ...query, tagId: null, action: null },
      { canExport: false, loadCheckpoint: async () => null },
    )).rejects.toThrow('audit evidence schema version is unsupported');
  });
});
