import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from '../canonicalAuditRedaction.js';
import type { ExternalAnchorRequest, ExternalEvidenceAnchorProvider, VerifiedExternalAnchorReceipt } from '../externalAnchorProvider.js';
import { anchorAuditEvidencePack, type ExternalAnchorContext } from '../externalAnchorService.js';

jest.mock('../canonicalAuditStore.js', () => ({ executeCanonicalAuditedMutation: jest.fn() }));
const executeMock = executeCanonicalAuditedMutation as jest.MockedFunction<typeof executeCanonicalAuditedMutation>;
const reportRunId = '10000000-0000-4000-8000-000000000001';
const packId = '20000000-0000-4000-8000-000000000002';
const anchorId = '30000000-0000-4000-8000-000000000003';
const now = new Date('2026-09-10T10:00:00.000Z');
const sha = (value: unknown) => createHash('sha256').update(stableAuditJson(value as AuditJsonValue)).digest('hex');
const unsignedEvidencePack = { schemaVersion: 1, kind: 'argus.audit.evidence-pack', manifest: { packId, scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' } } };
const evidencePack = { ...unsignedEvidencePack, packDigest: sha(unsignedEvidencePack) };

function context(): ExternalAnchorContext {
  return {
    scope: { workspaceKey: 'default', tenantKey: 'tenant-a', environment: 'production' },
    actor: { type: 'human', id: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    producerEventId: 'anchor-request-1', requestId: 'request-1',
    mfaVerifiedAt: '2026-09-10T09:59:00.000Z', mfaMethod: 'webauthn', mfaMaxAgeSeconds: 600,
    now: () => now, uuid: () => anchorId,
  };
}

function receiptFor(request: ExternalAnchorRequest): VerifiedExternalAnchorReceipt {
  const statement = {
    schemaVersion: 1 as const, kind: 'argus.external-evidence-anchor-statement' as const,
    anchorKind: request.anchorKind, provider: 'customer-worm', reference: 'immutable://pack/version-1',
    idempotencyKey: request.idempotencyKey,
    anchoredAt: '2026-09-10T10:00:01.000Z', retentionUntil: '2036-09-10T10:00:01.000Z',
    artifact: request.artifact, scope: request.scope,
  };
  const signature = { algorithm: 'Ed25519' as const, keyId: 'customer-key-1', value: 'signed-receipt' };
  return {
    schemaVersion: 1, kind: 'argus.external-evidence-anchor-receipt', statement, signature,
    statementSha256: sha(statement), receiptSha256: sha({ statement, signature }),
    verificationKeyFingerprint: 'f'.repeat(64), verification: 'verified',
  };
}

function database() {
  const inserts: unknown[][] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/FROM mcp_audit_report_runs/i.test(sql)) return { rows: [{
      id: reportRunId, workspace_key: 'default', tenant_key: 'tenant-a', environment: 'production',
      status: 'completed', verification_state: 'valid', pack_id: packId, pack_digest: evidencePack.packDigest, evidence_pack: evidencePack,
    }], rowCount: 1 };
    if (/INSERT INTO mcp_external_evidence_anchors/i.test(sql)) {
      inserts.push(params);
      return { rows: [{
        anchor_id: params[0], report_run_id: params[1], workspace_key: params[2], tenant_key: params[3], environment: params[4],
        pack_id: params[5], pack_sha256: params[6], anchor_kind: params[7], provider: params[8], reference: params[9],
        anchored_at: params[10], retention_until: params[11], statement_sha256: params[12], receipt_sha256: params[13],
        verification_key_id: params[14], verification_key_fingerprint: params[15], receipt_json: JSON.parse(String(params[16])),
        requested_by_id: params[17], actor_sso_subject: params[18], mfa_verified_at: params[19], mfa_method: params[20],
        producer_event_id: params[21], created_at: params[22],
      }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, inserts };
}

beforeEach(() => {
  jest.clearAllMocks();
  executeMock.mockImplementation(async (_pool, _producer, _scope, mutate, eventFor) => {
    const result = await mutate(_pool as unknown as pg.PoolClient);
    const event = eventFor(result);
    return { event: { ...event, eventId: '40000000-0000-4000-8000-000000000004', eventHash: 'e'.repeat(64) } as never, replayed: false, result };
  });
});

describe('external Evidence Pack anchor service', () => {
  it('stores the detached receipt in the exact scope and emits critical legal-hold evidence', async () => {
    const db = database();
    const provider: ExternalEvidenceAnchorProvider = {
      name: 'customer-worm', supportedKinds: ['worm_object'],
      anchor: jest.fn(async (request: ExternalAnchorRequest) => receiptFor(request)),
    };
    const result = await anchorAuditEvidencePack(db as unknown as pg.Pool, context(), reportRunId, 'worm_object', provider);
    expect(result.anchor).toMatchObject({ anchorId, packId, verification: 'verified', scope: context().scope });
    expect(db.inserts[0]?.slice(2, 5)).toEqual(['default', 'tenant-a', 'production']);
    expect(provider.anchor).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({
      mediaType: 'application/vnd.argus.audit-evidence-pack.v1+json', content: evidencePack,
    }) }));
    const auditInput = (executeMock.mock.calls[0]?.[4] as (value: unknown) => Record<string, unknown>)(result.anchor);
    expect(auditInput).toMatchObject({ action: 'audit.evidence_pack.externally_anchored', risk: 'critical', legalHold: true });
  });

  it('requires a fresh SSO-backed MFA session before contacting the provider', async () => {
    const invalid = context(); invalid.mfaVerifiedAt = '2026-09-10T09:00:00.000Z';
    const anchor = jest.fn(async (request: ExternalAnchorRequest) => receiptFor(request));
    const provider: ExternalEvidenceAnchorProvider = { name: 'customer-worm', supportedKinds: ['worm_object'], anchor };
    await expect(anchorAuditEvidencePack({} as pg.Pool, invalid, reportRunId, 'worm_object', provider)).rejects.toThrow('fresh MFA');
    expect(anchor).not.toHaveBeenCalled();
    expect(executeMock).not.toHaveBeenCalled();
  });
});
