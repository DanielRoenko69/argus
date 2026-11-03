import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { canonicalAuditDigest } from '../canonicalAuditRedaction.js';
import { computeCanonicalAuditEventHash } from '../canonicalAuditStore.js';
import { computeAuditCheckpointDigest, createAuditCheckpointSigner } from '../checkpoints.js';
import {
  computeAuditEvidencePackDigest,
  createAuditEvidencePack,
  verifyAuditEvidencePack,
  type AuditEvidencePackV1,
} from '../evidencePack.js';

const NOW = '2026-09-08T12:00:00.000Z';
const EVENT_ID = 'a788b5ca-7035-4baf-b5bd-e732540269cc';
const CHECKPOINT_ID = '2a40cac2-1e14-41f0-a6eb-eb28af710bf5';
const PACK_ID = '7df64330-8842-4a18-adf0-a4e5562a35a2';

function fixture() {
  const payloadSummary = { after: { label: 'Release workflow' } };
  const normalized = {
    eventId: EVENT_ID, occurredAt: NOW, receivedAt: NOW, environment: 'production',
    workspaceKey: 'default', tenantKey: 'default', solution: 'argus.core',
    producerName: 'workflow.approval.lifecycle', producerEventId: 'request-1',
    actorType: 'human', actorId: '17', actorSsoSubject: 'oidc|17', actorAuthMethod: 'oidc',
    actorRoles: ['operations_admin'], action: 'approval.workflow.approved', outcome: 'success',
    riskLevel: 'critical', resourceType: 'workflow', resourceId: '161', resourceRevision: '12',
    policyId: 'argus.workflow.lifecycle', policyVersion: '1', policyDecision: 'approved',
    approvalId: 'approval-7', rootRunId: 'run-24', traceId: 'trace-24', spanId: null, requestId: 'request-1',
    payloadSummary, payloadDigest: canonicalAuditDigest(payloadSummary), beforeDigest: null,
    afterDigest: canonicalAuditDigest(payloadSummary.after), retentionClass: 'business-audit-standard',
    retentionUntil: null, legalHold: false, signingKeyId: null,
  };
  const eventHash = computeCanonicalAuditEventHash(normalized as never, '1', '');
  const eventRow = {
    event_id: EVENT_ID, schema_version: 1, sequence: '1', occurred_at: NOW, received_at: NOW,
    environment: normalized.environment, workspace_key: normalized.workspaceKey, tenant_key: normalized.tenantKey,
    solution: normalized.solution, producer_name: normalized.producerName, producer_event_id: normalized.producerEventId,
    actor_type: normalized.actorType, actor_id: normalized.actorId, actor_sso_subject: normalized.actorSsoSubject,
    actor_auth_method: normalized.actorAuthMethod, actor_roles: normalized.actorRoles, action: normalized.action,
    outcome: normalized.outcome, risk_level: normalized.riskLevel, resource_type: normalized.resourceType,
    resource_id: normalized.resourceId, resource_revision: normalized.resourceRevision, policy_id: normalized.policyId,
    policy_version: normalized.policyVersion, policy_decision: normalized.policyDecision, approval_id: normalized.approvalId,
    root_run_id: normalized.rootRunId, trace_id: normalized.traceId, span_id: normalized.spanId,
    request_id: normalized.requestId, payload_summary: payloadSummary, payload_digest: normalized.payloadDigest,
    before_digest: null, after_digest: normalized.afterDigest, redaction_profile: 'argus.audit.redaction.v1',
    retention_class: normalized.retentionClass, retention_until: null, legal_hold: false,
    previous_hash: '', event_hash: eventHash, signing_key_id: null,
  };
  const { privateKey } = generateKeyPairSync('ed25519');
  const signer = createAuditCheckpointSigner(
    'audit-key-2026-09', privateKey.export({ type: 'pkcs8', format: 'pem' }),
  );
  const unsignedCheckpoint = {
    checkpointId: CHECKPOINT_ID, schemaVersion: 1 as const, workspaceKey: 'default', tenantKey: 'default',
    environment: 'production', lastSequence: 1, lastEventId: EVENT_ID, lastEventHash: eventHash,
    previousCheckpointId: null, previousCheckpointDigest: '', createdAt: NOW, algorithm: 'Ed25519' as const,
    keyId: signer.keyId, publicKeyFingerprint: signer.publicKeyFingerprint,
  };
  const checkpointDigest = computeAuditCheckpointDigest(unsignedCheckpoint);
  const checkpointRow = {
    checkpoint_id: CHECKPOINT_ID, schema_version: 1, workspace_key: 'default', tenant_key: 'default',
    environment: 'production', last_sequence: '1', last_event_id: EVENT_ID, last_event_hash: eventHash,
    previous_checkpoint_id: null, previous_checkpoint_digest: '', created_at: NOW, algorithm: 'Ed25519',
    key_id: signer.keyId, public_key_fingerprint: signer.publicKeyFingerprint, checkpoint_digest: checkpointDigest,
    signature: sign(null, Buffer.from(checkpointDigest, 'hex'), signer.privateKey).toString('base64url'),
    public_key_pem: signer.publicKeyPem,
  };
  return { eventRow, checkpointRow };
}

describe('offline-verifiable audit evidence packs', () => {
  it('exports JSON, JSONL and CSV with a complete signed chain proof', async () => {
    const { eventRow, checkpointRow } = fixture();
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('JOIN mcp_canonical_audit_signing_keys')) return { rows: [checkpointRow] };
      return { rows: [eventRow] };
    });
    const pack = await createAuditEvidencePack({ query } as unknown as pg.Pool, {
      workspaceKey: 'default', tenantKey: 'default', environment: 'production',
      resourceType: 'workflow', resourceId: '161',
      generatedBy: { actorId: '17', authMethod: 'oidc' },
      now: () => new Date(NOW), packId: () => PACK_ID,
    });

    expect(pack).toMatchObject({
      manifest: { packId: PACK_ID, eventCount: 1, chainEntryCount: 1, formats: ['json', 'jsonl', 'csv'] },
      checkpoint: { checkpointId: CHECKPOINT_ID },
    });
    expect(pack.artifacts.eventsCsv).toContain('approval.workflow.approved');
    expect(pack.artifacts.eventsJsonl).toContain(EVENT_ID);
    expect(verifyAuditEvidencePack(pack)).toEqual({
      state: 'valid', packId: PACK_ID, verifiedEvents: 1, verifiedChainEntries: 1, reasons: [],
    });
  });

  it('detects event tampering even when an attacker recomputes the outer pack digest', async () => {
    const { eventRow, checkpointRow } = fixture();
    const pool = { query: jest.fn(async (sql: string) => ({
      rows: sql.includes('JOIN mcp_canonical_audit_signing_keys') ? [checkpointRow] : [eventRow],
    })) } as unknown as pg.Pool;
    const pack = await createAuditEvidencePack(pool, {
      workspaceKey: 'default', tenantKey: 'default', environment: 'production',
      generatedBy: { actorId: '17', authMethod: 'oidc' }, now: () => new Date(NOW), packId: () => PACK_ID,
    });
    const tampered = structuredClone(pack) as AuditEvidencePackV1;
    tampered.chainEvents[0]!.actor.id = 'attacker';
    const { packDigest: _old, ...unsigned } = tampered;
    tampered.packDigest = computeAuditEvidencePackDigest(unsigned);

    expect(verifyAuditEvidencePack(tampered)).toMatchObject({
      state: 'invalid', reasons: expect.arrayContaining(['chain_continuity_invalid']),
    });
  });

  it('rejects a selected event that does not satisfy a rewritten manifest filter', async () => {
    const { eventRow, checkpointRow } = fixture();
    const pool = { query: jest.fn(async (sql: string) => ({
      rows: sql.includes('JOIN mcp_canonical_audit_signing_keys') ? [checkpointRow] : [eventRow],
    })) } as unknown as pg.Pool;
    const pack = await createAuditEvidencePack(pool, {
      workspaceKey: 'default', tenantKey: 'default', environment: 'production',
      generatedBy: { actorId: '17', authMethod: 'oidc' }, now: () => new Date(NOW), packId: () => PACK_ID,
    });
    const tampered = structuredClone(pack) as AuditEvidencePackV1;
    tampered.manifest.selection.action = 'approval.workflow.denied';
    const { packDigest: _old, ...unsigned } = tampered;
    tampered.packDigest = computeAuditEvidencePackDigest(unsigned);

    expect(verifyAuditEvidencePack(tampered)).toMatchObject({
      state: 'invalid', reasons: expect.arrayContaining(['selected_event_outside_manifest']),
    });
  });
});
