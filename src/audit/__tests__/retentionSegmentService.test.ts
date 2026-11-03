import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../canonicalAuditStore.js';
import { sealAuditRetentionChainSegment, type RetentionSegmentContext } from '../retentionSegmentService.js';

jest.mock('../canonicalAuditStore.js', () => ({ executeCanonicalAuditedMutation: jest.fn() }));
const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const NOW = new Date('2026-09-10T12:00:00.000Z');
const ARCHIVE_ID = '10000000-0000-4000-8000-000000000001';

function context(): RetentionSegmentContext {
  return {
    scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
    actor: { type: 'human', id: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'segment-seal-1', justification: 'Verified WORM and restore evidence reviewed before sealing.',
    mfaVerifiedAt: '2026-09-10T11:59:00.000Z', mfaMethod: 'webauthn', mfaMaxAgeSeconds: 600, now: () => NOW,
  };
}

const archiveRow = {
  archive_id: ARCHIVE_ID, plan_id: '20000000-0000-4000-8000-000000000002', workspace_key: 'workspace-1', tenant_key: 'tenant-1', environment: 'production',
  checkpoint_id: '30000000-0000-4000-8000-000000000003', checkpoint_digest: 'c'.repeat(64), manifest_sha256: 'd'.repeat(64),
  package_sha256: 'e'.repeat(64), package_bytes: 4096, event_count: 12, first_sequence: 1, last_sequence: 12, first_previous_hash: '',
  last_event_hash: 'f'.repeat(64), provider: 'Customer WORM', reference: 'immutable://archive/1', archived_at: '2026-09-10T10:00:00.000Z',
  retention_until: '2036-09-10T10:00:00.000Z', statement_sha256: 'a'.repeat(64), receipt_sha256: 'b'.repeat(64),
  verification_key_id: 'worm-key-1', verification_key_fingerprint: '9'.repeat(64), receipt_json: {}, producer_event_id: 'archive-1',
  requested_by_id: '41', created_at: '2026-09-10T10:00:00.000Z',
};

function poolWith(drill = true) {
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM mcp_canonical_audit_chain_heads/i.test(sql)) return { rows: [{ last_sequence: 14, last_event_hash: '1'.repeat(64) }], rowCount: 1 };
    if (/FROM mcp_canonical_audit_retention_archives/i.test(sql)) return { rows: [archiveRow], rowCount: 1 };
    if (/FROM mcp_canonical_audit_retention_restore_drills/i.test(sql)) return { rows: drill ? [{
      drill_id: '40000000-0000-4000-8000-000000000004', package_sha256: archiveRow.package_sha256,
      receipt_sha256: archiveRow.receipt_sha256, checkpoint_digest: archiveRow.checkpoint_digest,
      first_sequence: 1, last_sequence: 12, last_event_hash: archiveRow.last_event_hash,
    }] : [], rowCount: drill ? 1 : 0 };
    if (/FROM mcp_canonical_audit_chain_segments/i.test(sql)) return { rows: [], rowCount: 0 };
    if (/FROM mcp_canonical_audit_events/i.test(sql)) return { rows: [
      { sequence: 1, previous_hash: '', event_hash: '2'.repeat(64) },
      { sequence: 12, previous_hash: '3'.repeat(64), event_hash: archiveRow.last_event_hash },
      { sequence: 13, previous_hash: archiveRow.last_event_hash, event_hash: '4'.repeat(64) },
    ], rowCount: 3 };
    if (/INSERT INTO mcp_canonical_audit_chain_segments/i.test(sql)) return { rows: [{
      segment_id: params[0], segment_ordinal: params[1], previous_segment_id: params[2], previous_segment_digest: params[3],
      workspace_key: params[4], tenant_key: params[5], environment: params[6], archive_id: params[7], restore_drill_id: params[8],
      first_sequence: params[9], last_sequence: params[10], event_count: params[11], first_previous_hash: params[12], last_event_hash: params[13],
      continuation_sequence: params[14], continuation_previous_hash: params[15], checkpoint_id: params[16], checkpoint_digest: params[17],
      archive_package_sha256: params[18], archive_receipt_sha256: params[19], segment_digest: params[20], verification_json: JSON.parse(String(params[21])),
      sealed_at: params[22], requested_by_id: params[23], producer_event_id: params[28], created_at: params[22],
    }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  return { query } as unknown as pg.Pool;
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockImplementation(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(_pool as unknown as pg.PoolClient);
    return { result, replayed: false, event: { ...eventFor(result), eventId: '50000000-0000-4000-8000-000000000005' } as never };
  });
});

describe('canonical audit retention chain segment sealing', () => {
  it('seals a verified archive boundary and records a non-purge continuation anchor', async () => {
    const result = await sealAuditRetentionChainSegment(poolWith(), context(), ARCHIVE_ID);
    expect(result.segment).toMatchObject({ segmentOrdinal: 1, archiveId: ARCHIVE_ID, firstSequence: 1, lastSequence: 12,
      continuationSequence: 13, continuationPreviousHash: archiveRow.last_event_hash,
      verification: { archive: 'worm_receipt_verified', restoreDrill: 'full_download_verified', purgeAuthorized: false } });
    const auditInput = (executeMock.mock.calls[0]?.[4] as (value: typeof result.segment) => Record<string, unknown>)(result.segment);
    expect(auditInput).toMatchObject({ action: 'audit.retention_segment.sealed', risk: 'critical', legalHold: true,
      policy: { decision: 'segment_sealed_purge_disabled' } });
  });

  it('fails closed until a successful full-download restore drill exists', async () => {
    await expect(sealAuditRetentionChainSegment(poolWith(false), context(), ARCHIVE_ID)).rejects.toThrow('restore drill is required');
  });

  it('requires fresh MFA before touching the canonical chain', async () => {
    const invalid = context(); invalid.mfaVerifiedAt = '2026-09-10T10:00:00.000Z';
    await expect(sealAuditRetentionChainSegment(poolWith(), invalid, ARCHIVE_ID)).rejects.toThrow('fresh MFA');
    expect(executeMock).not.toHaveBeenCalled();
  });
});
