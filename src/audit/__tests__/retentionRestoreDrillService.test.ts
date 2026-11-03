import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeCanonicalAuditedMutation, verifyCanonicalAuditEventHash } from '../canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from '../canonicalAuditRedaction.js';
import { verifyAuditCheckpointSignature } from '../checkpoints.js';
import type { ExternalAnchorRequest, ExternalEvidenceAnchorProvider, RetrievedExternalArchiveObject, VerifiedExternalAnchorReceipt } from '../externalAnchorProvider.js';
import type { AuditRetentionArchivePackage, AuditRetentionArchiveRecord } from '../retentionArchiveService.js';
import { runAuditRetentionRestoreDrill, type RetentionRestoreDrillContext } from '../retentionRestoreDrillService.js';

jest.mock('../canonicalAuditStore.js', () => ({
  executeCanonicalAuditedMutation: jest.fn(),
  verifyCanonicalAuditEventHash: jest.fn(() => true),
}));
jest.mock('../checkpoints.js', () => ({ verifyAuditCheckpointSignature: jest.fn(() => true) }));

const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const verifyEventMock = verifyCanonicalAuditEventHash as jest.MockedFunction<typeof verifyCanonicalAuditEventHash>;
const verifyCheckpointMock = verifyAuditCheckpointSignature as jest.MockedFunction<typeof verifyAuditCheckpointSignature>;
const NOW = new Date('2026-09-10T12:00:00.000Z');
const ARCHIVE_ID = '10000000-0000-4000-8000-000000000001';
const PLAN_ID = '20000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '30000000-0000-4000-8000-000000000003';
const EVENT_ID = '40000000-0000-4000-8000-000000000004';
const canonical = (value: unknown) => stableAuditJson(value as AuditJsonValue);
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');

function context(): RetentionRestoreDrillContext {
  return {
    scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
    actor: { type: 'human', id: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'restore-drill-1', justification: 'Quarterly independent archive recovery verification.',
    mfaVerifiedAt: '2026-09-10T11:59:00.000Z', mfaMethod: 'webauthn', mfaMaxAgeSeconds: 600, now: () => NOW,
  };
}

function receipt(packageSha256: string): VerifiedExternalAnchorReceipt {
  const statement = {
    schemaVersion: 1 as const, kind: 'argus.external-evidence-anchor-statement' as const, anchorKind: 'worm_object' as const,
    provider: 'customer-worm', reference: 's3://audit-lock/archive.json?versionId=1', idempotencyKey: 'archive-create-1',
    anchoredAt: '2026-09-09T12:00:00.000Z', retentionUntil: '2036-09-09T12:00:00.000Z',
    artifact: { type: 'audit_retention_archive' as const, id: ARCHIVE_ID, sha256: packageSha256 },
    scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
  };
  const signature = { algorithm: 'Ed25519' as const, keyId: 'worm-key-1', value: 'signed' };
  return { schemaVersion: 1, kind: 'argus.external-evidence-anchor-receipt', statement, signature,
    statementSha256: digest(statement), receiptSha256: digest({ statement, signature }),
    verificationKeyFingerprint: 'f'.repeat(64), verification: 'verified' };
}

function fixture() {
  const event = {
    eventId: EVENT_ID, schemaVersion: 1 as const, sequence: 1, occurredAt: '2025-01-01T00:00:00.000Z', receivedAt: '2025-01-01T00:00:01.000Z',
    environment: 'production', workspaceKey: 'workspace-1', tenantKey: 'tenant-1', solution: 'argus.core',
    producer: { name: 'workflow', eventId: 'event-source-1' }, actor: { type: 'human' as const, id: '7', ssoSubject: 'oidc:7', authMethod: 'oidc', effectiveRoles: ['developer'] },
    action: 'workflow.executed', outcome: 'success' as const, risk: 'medium' as const,
    resource: { type: 'workflow', id: '1', revision: null }, policy: { id: null, version: null, decision: null }, approvalId: null,
    correlation: { rootRunId: null, traceId: 'trace-1', spanId: null, requestId: null }, payloadSummary: {}, payloadDigest: 'd'.repeat(64),
    beforeDigest: null, afterDigest: null, redactionProfile: 'canonical-v1', retentionClass: 'operations', retentionUntil: '2026-01-01T00:00:00.000Z',
    legalHold: false, previousHash: '', eventHash: 'a'.repeat(64), signingKeyId: null, replayed: false,
  };
  const checkpoint = {
    checkpointId: CHECKPOINT_ID, schemaVersion: 1 as const, workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production',
    lastSequence: 1, lastEventId: EVENT_ID, lastEventHash: event.eventHash, previousCheckpointId: null, previousCheckpointDigest: '',
    createdAt: '2026-09-09T11:00:00.000Z', algorithm: 'Ed25519' as const, keyId: 'audit-key-1', publicKeyFingerprint: 'b'.repeat(64),
    checkpointDigest: 'c'.repeat(64), signature: 'signed', replayed: false,
  };
  const packageValue: AuditRetentionArchivePackage = {
    schemaVersion: 1, kind: 'argus.audit-retention-archive', archiveId: ARCHIVE_ID,
    plan: { planId: PLAN_ID, manifestSha256: 'e'.repeat(64), evaluatedAt: '2026-09-09T10:00:00.000Z', approvedAt: '2026-09-09T10:30:00.000Z', approvedById: '41' },
    scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' }, generatedAt: '2026-09-09T12:00:00.000Z',
    generatedBy: { actorId: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', mfaMethod: 'webauthn' },
    checkpoint: { value: checkpoint, publicKeyPem: 'PUBLIC KEY' },
    chain: { firstSequence: 1, lastSequence: 1, firstPreviousHash: '', lastEventHash: event.eventHash, eventCount: 1 }, events: [event],
    verification: { state: 'event_hashes_and_checkpoint_valid', sourceEventsRevalidatedAt: '2026-09-09T12:00:00.000Z', purgeAuthorized: false },
  };
  const json = canonical(packageValue); const packageSha256 = digest(json); const signedReceipt = receipt(packageSha256);
  const archive: AuditRetentionArchiveRecord = {
    archiveId: ARCHIVE_ID, planId: PLAN_ID, scope: packageValue.scope, checkpointId: CHECKPOINT_ID, checkpointDigest: checkpoint.checkpointDigest,
    manifestSha256: packageValue.plan.manifestSha256, packageSha256, packageBytes: Buffer.byteLength(json), eventCount: 1, firstSequence: 1,
    lastSequence: 1, firstPreviousHash: '', lastEventHash: event.eventHash, provider: 'customer-worm', reference: signedReceipt.statement.reference,
    archivedAt: signedReceipt.statement.anchoredAt, retentionUntil: signedReceipt.statement.retentionUntil!, statementSha256: signedReceipt.statementSha256,
    receiptSha256: signedReceipt.receiptSha256, verificationKeyId: 'worm-key-1', verificationKeyFingerprint: signedReceipt.verificationKeyFingerprint,
    verification: 'verified', receipt: signedReceipt, producerEventId: 'archive-create-1', requestedById: '42', createdAt: signedReceipt.statement.anchoredAt,
  };
  return { packageValue, archive, json };
}

function archiveRow(archive: AuditRetentionArchiveRecord) {
  return {
    archive_id: archive.archiveId, plan_id: archive.planId, workspace_key: archive.scope.workspaceKey, tenant_key: archive.scope.tenantKey,
    environment: archive.scope.environment, checkpoint_id: archive.checkpointId, checkpoint_digest: archive.checkpointDigest,
    manifest_sha256: archive.manifestSha256, package_sha256: archive.packageSha256, package_bytes: archive.packageBytes, event_count: archive.eventCount,
    first_sequence: archive.firstSequence, last_sequence: archive.lastSequence, first_previous_hash: archive.firstPreviousHash,
    last_event_hash: archive.lastEventHash, provider: archive.provider, reference: archive.reference, archived_at: archive.archivedAt,
    retention_until: archive.retentionUntil, statement_sha256: archive.statementSha256, receipt_sha256: archive.receiptSha256,
    verification_key_id: archive.verificationKeyId, verification_key_fingerprint: archive.verificationKeyFingerprint, receipt_json: archive.receipt,
    producer_event_id: archive.producerEventId, requested_by_id: archive.requestedById, created_at: archive.createdAt,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  verifyEventMock.mockReturnValue(true); verifyCheckpointMock.mockReturnValue(true);
  executeMock.mockImplementation(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(_pool as unknown as pg.PoolClient); const input = eventFor(result);
    return { event: { ...input, eventId: '50000000-0000-4000-8000-000000000005' } as never, replayed: false, result };
  });
});

describe('audit retention restore drill', () => {
  it('downloads and independently verifies receipt, package, checkpoint and complete event chain', async () => {
    const { packageValue, archive } = fixture();
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (/FROM mcp_canonical_audit_retention_archives/i.test(sql)) return { rows: [archiveRow(archive)], rowCount: 1 };
      if (/INSERT INTO mcp_canonical_audit_retention_restore_drills/i.test(sql)) return { rows: [{
        drill_id: params[0], archive_id: params[1], workspace_key: params[2], tenant_key: params[3], environment: params[4],
        provider: params[5], reference: params[6], package_sha256: params[7], receipt_sha256: params[8], checkpoint_digest: params[9],
        event_count: params[10], first_sequence: 1, last_sequence: params[11], last_event_hash: params[12], retrieved_bytes: params[13],
        retrieved_at: params[14], verified_at: params[15], duration_ms: params[16], verification_status: 'verified',
        verification_json: JSON.parse(String(params[17])), requested_by_id: params[18], producer_event_id: params[23], created_at: params[15],
      }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    const provider: ExternalEvidenceAnchorProvider = {
      name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() as never,
      verifyStoredReceipt: jest.fn((stored: VerifiedExternalAnchorReceipt) => stored),
      retrieveArchive: jest.fn(async (): Promise<RetrievedExternalArchiveObject> => ({ schemaVersion: 1, kind: 'argus.external-retention-archive-object',
        reference: archive.reference, mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: archive.packageBytes,
        retrievedAt: NOW.toISOString(), content: packageValue as unknown as AuditJsonValue })),
    };
    const result = await runAuditRetentionRestoreDrill({ query } as unknown as pg.Pool, context(), ARCHIVE_ID, provider);
    expect(result.drill).toMatchObject({ archiveId: ARCHIVE_ID, verificationStatus: 'verified', eventCount: 1 });
    expect(provider.verifyStoredReceipt).toHaveBeenCalled(); expect(provider.retrieveArchive).toHaveBeenCalled();
    expect(verifyEventMock).toHaveBeenCalledTimes(1); expect(verifyCheckpointMock).toHaveBeenCalledTimes(1);
    const auditInput = (executeMock.mock.calls[0]?.[4] as (value: unknown) => Record<string, unknown>)(result.drill);
    expect(auditInput).toMatchObject({ action: 'audit.retention_restore_drill.verified', risk: 'critical', legalHold: true });
  });

  it('rejects a changed object before recording a successful drill', async () => {
    const { packageValue, archive } = fixture();
    const query = jest.fn(async (sql: string) => /FROM mcp_canonical_audit_retention_archives/i.test(sql)
      ? { rows: [archiveRow(archive)], rowCount: 1 } : { rows: [], rowCount: 1 });
    const provider: ExternalEvidenceAnchorProvider = {
      name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() as never, verifyStoredReceipt: stored => stored,
      retrieveArchive: async () => ({ schemaVersion: 1, kind: 'argus.external-retention-archive-object', reference: archive.reference,
        mediaType: 'application/vnd.argus.audit-retention-archive.v1+json', bytes: archive.packageBytes,
        retrievedAt: NOW.toISOString(), content: { ...packageValue, generatedAt: '2026-09-10T11:59:59.000Z' } as unknown as AuditJsonValue }),
    };
    await expect(runAuditRetentionRestoreDrill({ query } as unknown as pg.Pool, context(), ARCHIVE_ID, provider))
      .rejects.toThrow('size or digest');
    expect(query.mock.calls.some(call => /INSERT INTO/i.test(String(call[0])))).toBe(false);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock.mock.calls[1]?.[1]).toMatchObject({ name: 'audit.retention.restore_drill.failure' });
    const failedAuditInput = (executeMock.mock.calls[1]?.[4] as (value: { reasonCode: string; reasonDigest: string }) => Record<string, unknown>)({ reasonCode: 'package_invalid', reasonDigest: 'f'.repeat(64) });
    expect(failedAuditInput).toMatchObject({ action: 'audit.retention_restore_drill.failed', outcome: 'failure', risk: 'critical', legalHold: true });
  });

  it('requires fresh MFA before contacting external storage', async () => {
    const invalid = context(); invalid.mfaVerifiedAt = '2026-09-10T10:00:00.000Z';
    const provider: ExternalEvidenceAnchorProvider = { name: 'customer-worm', supportedKinds: ['worm_object'], anchor: jest.fn() as never,
      verifyStoredReceipt: jest.fn() as never, retrieveArchive: jest.fn() as never };
    await expect(runAuditRetentionRestoreDrill({} as pg.Pool, invalid, ARCHIVE_ID, provider)).rejects.toThrow('fresh MFA');
    expect(provider.retrieveArchive).not.toHaveBeenCalled(); expect(executeMock).not.toHaveBeenCalled();
  });
});
