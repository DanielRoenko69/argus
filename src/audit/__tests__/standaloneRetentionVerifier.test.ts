import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from '@jest/globals';
import { stableAuditJson, type AuditJsonValue } from '../canonicalAuditRedaction.js';

const canonical = (value: unknown) => stableAuditJson(value as AuditJsonValue);
const digest = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function fingerprint(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
}

function fixture() {
  const checkpointKeys = generateKeyPairSync('ed25519');
  const providerKeys = generateKeyPairSync('ed25519');
  const event = {
    eventId: '10000000-0000-4000-8000-000000000001', schemaVersion: 1, sequence: 1,
    occurredAt: '2026-01-01T00:00:00.000Z', receivedAt: '2026-01-01T00:00:01.000Z',
    environment: 'production', workspaceKey: 'workspace-1', tenantKey: 'tenant-1', solution: 'argus.core',
    producer: { name: 'workflow', eventId: 'workflow-1' },
    actor: { type: 'human', id: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', effectiveRoles: ['platform_admin'] },
    action: 'workflow.executed', outcome: 'success', risk: 'medium',
    resource: { type: 'workflow', id: '1', revision: null }, policy: { id: null, version: null, decision: null },
    approvalId: null, correlation: { rootRunId: null, traceId: 'trace-1', spanId: null, requestId: null },
    payloadSummary: {}, payloadDigest: digest({}), beforeDigest: null, afterDigest: null,
    redactionProfile: 'argus.audit.redaction.v1', retentionClass: 'operations',
    retentionUntil: '2027-01-01T00:00:00.000Z', legalHold: false, previousHash: '', eventHash: '', signingKeyId: null, replayed: false,
  };
  const eventPayload = {
    schemaVersion: 1, sequence: '1', eventId: event.eventId, occurredAt: event.occurredAt, receivedAt: event.receivedAt,
    environment: event.environment, workspaceKey: event.workspaceKey, tenantKey: event.tenantKey, solution: event.solution,
    producer: event.producer, actor: event.actor, action: event.action, outcome: event.outcome, risk: event.risk,
    resource: event.resource, policy: event.policy, approvalId: null, correlation: event.correlation,
    payloadSummary: event.payloadSummary, payloadDigest: event.payloadDigest, beforeDigest: null, afterDigest: null,
    redactionProfile: event.redactionProfile, retentionClass: event.retentionClass, retentionUntil: event.retentionUntil,
    legalHold: false, previousHash: '', signingKeyId: null,
  };
  event.eventHash = digest(eventPayload);

  const checkpointUnsigned = {
    schemaVersion: 1, checkpointId: '20000000-0000-4000-8000-000000000002',
    workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production', lastSequence: 1,
    lastEventId: event.eventId, lastEventHash: event.eventHash, previousCheckpointId: null, previousCheckpointDigest: '',
    createdAt: '2026-01-02T00:00:00.000Z', algorithm: 'Ed25519', keyId: 'audit-key-1',
    publicKeyFingerprint: fingerprint(checkpointKeys.publicKey),
  };
  const checkpointPayload = { ...checkpointUnsigned, lastSequence: '1' };
  const checkpointDigest = digest(checkpointPayload);
  const checkpoint = { ...checkpointUnsigned, checkpointDigest,
    signature: sign(null, Buffer.from(checkpointDigest, 'hex'), checkpointKeys.privateKey).toString('base64url'), replayed: false };
  const archive = {
    schemaVersion: 1, kind: 'argus.audit-retention-archive', archiveId: '30000000-0000-4000-8000-000000000003',
    plan: { planId: '40000000-0000-4000-8000-000000000004', manifestSha256: 'a'.repeat(64),
      evaluatedAt: '2026-01-02T00:00:00.000Z', approvedAt: '2026-01-02T00:05:00.000Z', approvedById: '41' },
    scope: { workspaceKey: 'workspace-1', tenantKey: 'tenant-1', environment: 'production' },
    generatedAt: '2026-01-02T00:10:00.000Z', generatedBy: { actorId: '42', ssoSubject: 'oidc:alex', authMethod: 'oidc', mfaMethod: 'webauthn' },
    checkpoint: { value: checkpoint, publicKeyPem: checkpointKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString() },
    chain: { firstSequence: 1, lastSequence: 1, firstPreviousHash: '', lastEventHash: event.eventHash, eventCount: 1 },
    events: [event], verification: { state: 'event_hashes_and_checkpoint_valid', sourceEventsRevalidatedAt: '2026-01-02T00:10:00.000Z', purgeAuthorized: false },
  };
  const statement = {
    schemaVersion: 1, kind: 'argus.external-evidence-anchor-statement', anchorKind: 'worm_object', provider: 'Customer WORM',
    reference: 's3://audit-lock/archive.json?versionId=1', idempotencyKey: 'archive-1', anchoredAt: '2026-01-02T00:11:00.000Z',
    retentionUntil: '2036-01-02T00:11:00.000Z', artifact: { type: 'audit_retention_archive', id: archive.archiveId, sha256: digest(archive) },
    scope: archive.scope,
  };
  const signature = { algorithm: 'Ed25519', keyId: 'worm-key-1', value: sign(null, Buffer.from(canonical(statement)), providerKeys.privateKey).toString('base64url') };
  const receipt = { schemaVersion: 1, kind: 'argus.external-evidence-anchor-receipt', statement, signature,
    statementSha256: digest(statement), receiptSha256: digest({ statement, signature }),
    verificationKeyFingerprint: fingerprint(providerKeys.publicKey), verification: 'verified' };
  return { archive, receipt, providerKeys };
}

describe('standalone audit retention verifier', () => {
  it('verifies the provider receipt, package, checkpoint and complete canonical chain without Argus', () => {
    const folder = mkdtempSync(join(tmpdir(), 'argus-audit-verifier-')); folders.push(folder);
    const { archive, receipt, providerKeys } = fixture();
    const archiveFile = join(folder, 'archive.json'); const receiptFile = join(folder, 'receipt.json'); const keyFile = join(folder, 'provider.pem');
    writeFileSync(archiveFile, JSON.stringify(archive)); writeFileSync(receiptFile, JSON.stringify(receipt));
    writeFileSync(keyFile, providerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
    const result = spawnSync(process.execPath, [resolve('src/assets/argus-audit-retention-verifier.mjs'),
      '--archive', archiveFile, '--receipt', receiptFile, '--provider-key', keyFile,
      '--expect-provider', 'Customer WORM', '--expect-key-id', 'worm-key-1', '--now', '2026-09-10T12:00:00.000Z'],
    { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'valid', archiveId: archive.archiveId,
      checks: { providerReceiptSignature: 'valid', checkpointSignature: 'valid', canonicalEventChain: 'complete_and_valid', purgeAuthorized: false },
      wormRetention: { state: 'active' } });
  });

  it('fails closed when the archived event content is changed', () => {
    const folder = mkdtempSync(join(tmpdir(), 'argus-audit-verifier-')); folders.push(folder);
    const { archive, receipt, providerKeys } = fixture();
    archive.events[0]!.action = 'workflow.tampered';
    const archiveFile = join(folder, 'archive.json'); const receiptFile = join(folder, 'receipt.json'); const keyFile = join(folder, 'provider.pem');
    writeFileSync(archiveFile, JSON.stringify(archive)); writeFileSync(receiptFile, JSON.stringify(receipt));
    writeFileSync(keyFile, providerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
    const result = spawnSync(process.execPath, [resolve('src/assets/argus-audit-retention-verifier.mjs'),
      '--archive', archiveFile, '--receipt', receiptFile, '--provider-key', keyFile], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VERIFICATION FAILED');
  });
});
