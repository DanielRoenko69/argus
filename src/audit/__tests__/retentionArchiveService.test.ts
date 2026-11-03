import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeCanonicalAuditedMutation, mapCanonicalAuditEventRow, verifyCanonicalAuditEventHash } from '../canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from '../canonicalAuditRedaction.js';
import { mapCanonicalAuditCheckpoint, verifyAuditCheckpointSignature } from '../checkpoints.js';
import type { ExternalAnchorRequest, ExternalEvidenceAnchorProvider, VerifiedExternalAnchorReceipt } from '../externalAnchorProvider.js';
import { computeAuditRetentionManifestSha256, type AuditRetentionPlan } from '../retentionLifecycle.js';
import { archiveAuditRetentionPlan, deterministicRetentionArchiveId, type RetentionArchiveContext } from '../retentionArchiveService.js';

jest.mock('../canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
  mapCanonicalAuditEventRow: jest.fn((row: { summary: unknown }) => row.summary),
  verifyCanonicalAuditEventHash: jest.fn(() => true),
}));
jest.mock('../checkpoints.js', () => ({
  mapCanonicalAuditCheckpoint: jest.fn((row: { checkpoint: unknown }) => row.checkpoint),
  verifyAuditCheckpointSignature: jest.fn(() => true),
}));

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const mapEventMock = mapCanonicalAuditEventRow as jest.MockedFunction<typeof mapCanonicalAuditEventRow>;
const verifyEventMock = verifyCanonicalAuditEventHash as jest.MockedFunction<typeof verifyCanonicalAuditEventHash>;
const mapCheckpointMock = mapCanonicalAuditCheckpoint as jest.MockedFunction<typeof mapCanonicalAuditCheckpoint>;
const verifyCheckpointMock = verifyAuditCheckpointSignature as jest.MockedFunction<typeof verifyAuditCheckpointSignature>;
const now = new Date('2026-09-10T12:00:00.000Z');
const planId = '10000000-0000-4000-8000-000000000001';
const checkpointId = '20000000-0000-4000-8000-000000000002';
const eventId = '30000000-0000-4000-8000-000000000003';

const digest = (value: unknown) => createHash('sha256').update(stableAuditJson(value as AuditJsonValue)).digest('hex');

function context(): RetentionArchiveContext {
  return {
    scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' },
    actor: { type: 'human', id: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'retention-archive-request-1', requestId: 'request-1', justification: 'Approved package archived into customer WORM storage.',
    mfaVerifiedAt: '2026-09-10T11:59:00.000Z', mfaMethod: 'webauthn', mfaMaxAgeSeconds: 600, now: () => now,
  };
}

function plan(): AuditRetentionPlan {
  const manifest = {
    schemaVersion: 1 as const, mode: 'dry_run' as const,
    scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' }, retentionClass: 'all-classes',
    checkpoint: { id: checkpointId, digest: 'c'.repeat(64), throughSequence: 1 }, evaluatedAt: now.toISOString(),
    eligibleEvents: [{ eventId, sequence: 1, occurredAt: '2025-01-01T00:00:00.000Z', eventHash: 'a'.repeat(64), resourceType: 'workflow', resourceId: '1', retentionClass: 'operations', retentionUntil: '2026-01-01T00:00:00.000Z', policyId: null, policyVersion: null, region: null }],
    blocker: { code: 'not_due' as const, sequence: 2 }, purgeAllowed: false as const,
    nextRequiredAction: 'independent_approval_then_archive' as const,
  };
  return {
    planId, workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production', retentionClass: 'all-classes',
    checkpointId, checkpointDigest: 'c'.repeat(64), throughSequence: 1, evaluatedAt: now.toISOString(), eligiblePrefixCount: 1,
    firstSequence: 1, lastSequence: 1, blocker: manifest.blocker, manifestSha256: computeAuditRetentionManifestSha256(manifest),
    manifest, requestedById: '41', requesterSsoSubject: 'oidc:requester', mfaVerifiedAt: now.toISOString(), mfaMethod: 'webauthn',
    producerEventId: 'plan-request', createdAt: now.toISOString(), status: 'planned',
  };
}

function planRow(stored: AuditRetentionPlan) {
  return {
    plan_id: stored.planId, workspace_key: stored.workspaceKey, tenant_key: stored.tenantKey, environment: stored.environment,
    retention_class: stored.retentionClass, checkpoint_id: stored.checkpointId, checkpoint_digest: stored.checkpointDigest,
    through_sequence: stored.throughSequence, evaluated_at: stored.evaluatedAt, eligible_prefix_count: stored.eligiblePrefixCount,
    first_sequence: stored.firstSequence, last_sequence: stored.lastSequence, blocker_code: stored.blocker.code,
    blocker_sequence: stored.blocker.sequence, manifest_sha256: stored.manifestSha256, manifest_json: stored.manifest,
    requested_by_id: stored.requestedById, requester_sso_subject: stored.requesterSsoSubject,
    mfa_verified_at: stored.mfaVerifiedAt, mfa_method: stored.mfaMethod, producer_event_id: stored.producerEventId, created_at: stored.createdAt,
  };
}

function receiptFor(request: ExternalAnchorRequest): VerifiedExternalAnchorReceipt {
  const statement = {
    schemaVersion: 1 as const, kind: 'argus.external-evidence-anchor-statement' as const,
    anchorKind: 'worm_object' as const, provider: 'customer-worm', reference: 's3://customer-audit-lock/archive.json?versionId=1',
    idempotencyKey: request.idempotencyKey, anchoredAt: '2026-09-10T12:00:01.000Z', retentionUntil: '2036-09-10T12:00:01.000Z',
    artifact: request.artifact, scope: request.scope,
  };
  const signature = { algorithm: 'Ed25519' as const, keyId: 'customer-key-1', value: 'signed-receipt' };
  return {
    schemaVersion: 1, kind: 'argus.external-evidence-anchor-receipt', statement, signature,
    statementSha256: digest(statement), receiptSha256: digest({ statement, signature }),
    verificationKeyFingerprint: 'f'.repeat(64), verification: 'verified',
  };
}

function database(held = false) {
  const stored = plan();
  const archiveRows: Record<string, unknown>[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM mcp_canonical_audit_retention_plans/i.test(sql)) return { rows: [planRow(stored)], rowCount: 1 };
    if (/SELECT action,actor_id,occurred_at FROM mcp_canonical_audit_retention_plan_actions/i.test(sql)) {
      return { rows: [{ action: 'approved', actor_id: '43', occurred_at: '2026-09-10T11:30:00.000Z' }], rowCount: 1 };
    }
    if (/effective_legal_hold/i.test(sql)) return { rows: [{
      event_id: eventId, sequence: 1, occurred_at: '2025-01-01T00:00:00.000Z', event_hash: 'a'.repeat(64),
      resource_type: 'workflow', resource_id: '1', retention_class: 'operations', effective_retention_until: '2026-01-01T00:00:00.000Z',
      effective_legal_hold: held, policy_id: null, policy_version: null, policy_region: null,
    }], rowCount: 1 };
    if (/FROM mcp_canonical_audit_checkpoints checkpoint/i.test(sql)) return { rows: [{
      checkpoint: { checkpointId, schemaVersion: 1, workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production', lastSequence: 1, lastEventId: eventId, lastEventHash: 'a'.repeat(64), previousCheckpointId: null, previousCheckpointDigest: '', createdAt: '2026-09-10T11:00:00.000Z', algorithm: 'Ed25519', keyId: 'audit-key', publicKeyFingerprint: 'b'.repeat(64), checkpointDigest: 'c'.repeat(64), signature: 'signed', replayed: false },
      public_key_pem: 'PUBLIC KEY',
    }], rowCount: 1 };
    if (/FROM mcp_canonical_audit_events/i.test(sql)) return { rows: [{ summary: {
      eventId, schemaVersion: 1, sequence: 1, occurredAt: '2025-01-01T00:00:00.000Z', receivedAt: '2025-01-01T00:00:01.000Z',
      environment: 'production', workspaceKey: 'default', tenantKey: 'tenant-a', solution: 'argus.core',
      producer: { name: 'workflow', eventId: 'producer-1' }, actor: { type: 'human', id: '1', ssoSubject: 'oidc:1', authMethod: 'oidc', effectiveRoles: ['developer'] },
      action: 'workflow.executed', outcome: 'success', risk: 'medium', resource: { type: 'workflow', id: '1', revision: null },
      policy: { id: null, version: null, decision: null }, approvalId: null, correlation: { rootRunId: 'run-1', traceId: 'trace-1', spanId: null, requestId: null },
      payloadSummary: {}, payloadDigest: 'd'.repeat(64), beforeDigest: null, afterDigest: null, redactionProfile: 'canonical-v1',
      retentionClass: 'operations', retentionUntil: '2026-01-01T00:00:00.000Z', legalHold: false, previousHash: '', eventHash: 'a'.repeat(64), signingKeyId: null, replayed: false,
    } }], rowCount: 1 };
    if (/INSERT INTO mcp_canonical_audit_retention_archives/i.test(sql)) {
      const receipt = JSON.parse(String(params[22])) as VerifiedExternalAnchorReceipt;
      const row = {
        archive_id: params[0], plan_id: params[1], workspace_key: params[2], tenant_key: params[3], environment: params[4],
        checkpoint_id: params[5], checkpoint_digest: params[6], manifest_sha256: params[7], package_sha256: params[8], package_bytes: params[9],
        event_count: params[10], first_sequence: 1, last_sequence: params[11], first_previous_hash: '', last_event_hash: params[12],
        provider: params[13], reference: params[14], archived_at: params[15], retention_until: params[16], statement_sha256: params[17],
        receipt_sha256: params[18], verification_key_id: params[19], verification_key_fingerprint: params[20], receipt_json: receipt,
        requested_by_id: params[23], created_at: params[15],
      };
      archiveRows.push(row); return { rows: [row], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query, archiveRows };
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockImplementation(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(_pool as unknown as pg.PoolClient);
    const input = eventFor(result);
    return { event: { ...input, eventId: '40000000-0000-4000-8000-000000000004' } as never, replayed: false, result };
  });
});

describe('external WORM retention archive', () => {
  it('uploads the complete verified chain package and stores its signed receipt', async () => {
    const db = database();
    const provider: ExternalEvidenceAnchorProvider = {
      name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn(async (request: ExternalAnchorRequest) => receiptFor(request)),
    };
    const result = await archiveAuditRetentionPlan(db as unknown as pg.Pool, context(), planId, provider);
    expect(result.archive).toMatchObject({ planId, eventCount: 1, verification: 'verified', provider: 'customer-worm' });
    expect(result.archive.archiveId).toBe(deterministicRetentionArchiveId({ workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' }, planId, context().producerEventId));
    expect(provider.anchor).toHaveBeenCalledWith(expect.objectContaining({
      anchorKind: 'worm_object', artifact: expect.objectContaining({ type: 'audit_retention_archive' }),
      payload: expect.objectContaining({ mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: expect.any(Number) }),
    }));
    const request = (provider.anchor as jest.Mock).mock.calls[0]![0] as ExternalAnchorRequest;
    expect(request.payload?.content).toMatchObject({ kind: 'argus.audit-retention-archive', events: [expect.objectContaining({ eventId })] });
    expect(mapEventMock).toHaveBeenCalled(); expect(verifyEventMock).toHaveBeenCalled();
    expect(mapCheckpointMock).toHaveBeenCalled(); expect(verifyCheckpointMock).toHaveBeenCalled();
    const auditInput = (executeMock.mock.calls[0]?.[4] as (value: unknown) => Record<string, unknown>)(result.archive);
    expect(auditInput).toMatchObject({ action: 'audit.retention_archive.verified', risk: 'critical', legalHold: true });
  });

  it('rechecks Legal Holds before contacting external storage', async () => {
    const db = database(true);
    const provider: ExternalEvidenceAnchorProvider = { name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() as never };
    await expect(archiveAuditRetentionPlan(db as unknown as pg.Pool, context(), planId, provider)).rejects.toThrow('legal hold');
    expect(provider.anchor).not.toHaveBeenCalled();
    expect(db.archiveRows).toHaveLength(0);
  });

  it('requires fresh OIDC-backed MFA before doing any archive work', async () => {
    const invalid = context(); invalid.mfaVerifiedAt = '2026-09-10T10:00:00.000Z';
    const provider: ExternalEvidenceAnchorProvider = { name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() as never };
    await expect(archiveAuditRetentionPlan({} as pg.Pool, invalid, planId, provider)).rejects.toThrow('fresh MFA');
    expect(executeMock).not.toHaveBeenCalled(); expect(provider.anchor).not.toHaveBeenCalled();
  });
});
