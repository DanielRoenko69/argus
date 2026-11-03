import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation, verifyCanonicalAuditEventHash } from './canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';
import { verifyAuditCheckpointSignature } from './checkpoints.js';
import type {
  ExternalAnchorRequest,
  ExternalArchiveRetrieveRequest,
  ExternalEvidenceAnchorProvider,
} from './externalAnchorProvider.js';
import {
  mapAuditRetentionArchiveRow,
  type AuditRetentionArchivePackage,
  type AuditRetentionArchiveRecord,
} from './retentionArchiveService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;

export interface AuditRetentionRestoreDrillRecord {
  drillId: string;
  archiveId: string;
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  provider: string;
  reference: string;
  packageSha256: string;
  receiptSha256: string;
  checkpointDigest: string;
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  lastEventHash: string;
  retrievedBytes: number;
  retrievedAt: string;
  verifiedAt: string;
  durationMs: number;
  verificationStatus: 'verified';
  verification: {
    receipt: 'signature_valid';
    package: 'sha256_valid';
    checkpoint: 'signature_valid';
    eventChain: 'complete_and_valid';
    wormRetention: 'active';
    purgeAuthorized: false;
  };
  requestedById: string;
  producerEventId: string;
  createdAt: string;
}

export interface RetentionRestoreDrillContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  justification: string;
  mfaVerifiedAt: string;
  mfaMethod: string;
  mfaMaxAgeSeconds: number;
  now?: () => Date;
}

type Row = Record<string, unknown>;
const canonical = (value: unknown): string => stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue);
const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function required(value: unknown, name: string, maximum = 256): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function identifier(value: unknown, name: string, maximum = 256): string {
  const normalized = required(value, name, maximum);
  if (!IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function uuid(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID.test(normalized)) throw new Error(`${name} must be a UUID`);
  return normalized;
}

function iso(value: unknown, name: string): string {
  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

function normalizedScope(context: RetentionRestoreDrillContext): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function assertAssurance(context: RetentionRestoreDrillContext, now: Date) {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new Error('Restore drill requires a verified human OIDC/Entra identity');
  }
  const verifiedAt = Date.parse(context.mfaVerifiedAt);
  if (!Number.isFinite(verifiedAt) || !context.mfaMethod.trim() || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > context.mfaMaxAgeSeconds * 1_000) {
    throw new Error('Restore drill requires fresh MFA verification');
  }
  return {
    actorId: required(context.actor.id, 'actor.id', 256),
    ssoSubject: required(context.actor.ssoSubject, 'actor.ssoSubject', 512),
    justification: required(context.justification, 'justification', 4_096),
  };
}

function deterministicRestoreDrillId(scope: Required<CanonicalAuditScope>, archiveId: string, producerEventId: string): string {
  const chars = createHash('sha256')
    .update(canonical(['argus-retention-restore-drill-v1', scope.workspaceKey, scope.tenantKey, scope.environment, archiveId, producerEventId]))
    .digest('hex').slice(0, 32).split('');
  chars[12] = '8';
  chars[16] = (8 + (Number.parseInt(chars[16]!, 16) % 4)).toString(16);
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} is invalid`);
  return value as Record<string, unknown>;
}

export function verifyAuditRetentionArchivePackage(
  raw: unknown,
  archive: AuditRetentionArchiveRecord,
): AuditRetentionArchivePackage {
  const root = object(raw, 'archive package');
  if (root['schemaVersion'] !== 1 || root['kind'] !== 'argus.audit-retention-archive' || root['archiveId'] !== archive.archiveId) {
    throw new Error('archive package identity or schema is invalid');
  }
  const plan = object(root['plan'], 'archive plan');
  const scope = object(root['scope'], 'archive scope');
  const chain = object(root['chain'], 'archive chain');
  const checkpointEnvelope = object(root['checkpoint'], 'archive checkpoint');
  const verification = object(root['verification'], 'archive verification');
  if (plan['planId'] !== archive.planId || plan['manifestSha256'] !== archive.manifestSha256
    || scope['workspaceKey'] !== archive.scope.workspaceKey || scope['tenantKey'] !== archive.scope.tenantKey
    || scope['environment'] !== archive.scope.environment) {
    throw new Error('archive package plan or tenant scope binding is invalid');
  }
  if (verification['state'] !== 'event_hashes_and_checkpoint_valid' || verification['purgeAuthorized'] !== false) {
    throw new Error('archive package verification boundary is invalid');
  }
  const events = root['events'];
  if (!Array.isArray(events) || events.length !== archive.eventCount || events.length < 1) {
    throw new Error('archive package event count is invalid');
  }
  if (chain['firstSequence'] !== 1 || chain['firstPreviousHash'] !== '' || chain['eventCount'] !== events.length
    || chain['lastSequence'] !== archive.lastSequence || chain['lastEventHash'] !== archive.lastEventHash) {
    throw new Error('archive package chain summary is invalid');
  }
  let previousHash = '';
  for (let index = 0; index < events.length; index += 1) {
    const event = object(events[index], `archive event ${index + 1}`) as unknown as CanonicalAuditEventSummary;
    let hashValid = false;
    try { hashValid = verifyCanonicalAuditEventHash(event); } catch { hashValid = false; }
    if (event.sequence !== index + 1 || event.previousHash !== previousHash || !SHA256.test(event.eventHash)
      || event.workspaceKey !== archive.scope.workspaceKey || event.tenantKey !== archive.scope.tenantKey
      || event.environment !== archive.scope.environment || event.replayed !== false || !hashValid) {
      throw new Error(`archive package event-chain verification failed at sequence ${index + 1}`);
    }
    previousHash = event.eventHash;
  }
  if (previousHash !== archive.lastEventHash) throw new Error('archive package terminal event hash is invalid');
  const checkpoint = object(checkpointEnvelope['value'], 'archive checkpoint value') as unknown as AuditRetentionArchivePackage['checkpoint']['value'];
  const publicKeyPem = required(checkpointEnvelope['publicKeyPem'], 'archive checkpoint public key', 16_384);
  if (checkpoint.checkpointId !== archive.checkpointId || checkpoint.checkpointDigest !== archive.checkpointDigest
    || checkpoint.workspaceKey !== archive.scope.workspaceKey || checkpoint.tenantKey !== archive.scope.tenantKey
    || checkpoint.environment !== archive.scope.environment || checkpoint.lastSequence < archive.lastSequence
    || checkpoint.replayed !== false || !verifyAuditCheckpointSignature(checkpoint, publicKeyPem)) {
    throw new Error('archive package checkpoint signature or binding is invalid');
  }
  return JSON.parse(canonical(raw)) as AuditRetentionArchivePackage;
}

function mapDrill(row: Row): AuditRetentionRestoreDrillRecord {
  return {
    drillId: String(row['drill_id']), archiveId: String(row['archive_id']),
    scope: { workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']), environment: String(row['environment']) },
    provider: String(row['provider']), reference: String(row['reference']), packageSha256: String(row['package_sha256']),
    receiptSha256: String(row['receipt_sha256']), checkpointDigest: String(row['checkpoint_digest']),
    eventCount: Number(row['event_count']), firstSequence: Number(row['first_sequence']), lastSequence: Number(row['last_sequence']),
    lastEventHash: String(row['last_event_hash']), retrievedBytes: Number(row['retrieved_bytes']),
    retrievedAt: iso(row['retrieved_at'], 'retrievedAt'), verifiedAt: iso(row['verified_at'], 'verifiedAt'),
    durationMs: Number(row['duration_ms']), verificationStatus: 'verified',
    verification: row['verification_json'] as AuditRetentionRestoreDrillRecord['verification'],
    requestedById: String(row['requested_by_id']), producerEventId: String(row['producer_event_id']),
    createdAt: iso(row['created_at'], 'createdAt'),
  };
}

export async function listAuditRetentionRestoreDrills(
  pool: Pick<pg.Pool, 'query'>,
  archiveIds: string[],
): Promise<AuditRetentionRestoreDrillRecord[]> {
  if (!archiveIds.length) return [];
  const result = await pool.query(
    'SELECT * FROM mcp_canonical_audit_retention_restore_drills WHERE archive_id=ANY($1::uuid[]) ORDER BY verified_at DESC,drill_id',
    [archiveIds],
  );
  return (result.rows as Row[]).map(mapDrill);
}

export async function runAuditRetentionRestoreDrill(
  pool: pg.Pool,
  context: RetentionRestoreDrillContext,
  archiveIdInput: string,
  provider: ExternalEvidenceAnchorProvider,
): Promise<{ drill: AuditRetentionRestoreDrillRecord; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const archiveId = uuid(archiveIdInput, 'archiveId');
  if (!provider.retrieveArchive || !provider.verifyStoredReceipt) throw new Error('Configured WORM provider does not support verified restore drills');
  const scope = normalizedScope(context);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('now is invalid');
  const assurance = assertAssurance(context, now);
  const producerEventId = identifier(context.producerEventId, 'producerEventId');
  const drillId = deterministicRestoreDrillId(scope, archiveId, producerEventId);
  const startedAt = Date.now();
  const outcome = await (async () => {
    try {
      return await executeCanonicalAuditedMutation<AuditRetentionRestoreDrillRecord>(
    pool,
    { name: 'audit.retention.restore_drill', eventId: producerEventId },
    scope,
    async client => {
      const archiveResult = await client.query<Row>(
        `SELECT * FROM mcp_canonical_audit_retention_archives
          WHERE archive_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 FOR SHARE`,
        [archiveId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      if (!archiveResult.rows[0]) throw new Error('retention archive was not found in the authorized scope');
      const archive = mapAuditRetentionArchiveRow(archiveResult.rows[0]);
      if (archive.provider !== provider.name) throw new Error('configured provider does not own this retention archive');
      if (Date.parse(archive.retentionUntil) <= now.getTime()) throw new Error('archive WORM retention is no longer active');
      const anchorRequest: ExternalAnchorRequest = {
        anchorKind: 'worm_object',
        artifact: { type: 'audit_retention_archive', id: archive.archiveId, sha256: archive.packageSha256 },
        scope: archive.scope,
        idempotencyKey: archive.producerEventId,
        requestedAt: archive.archivedAt,
      };
      const verifiedReceipt = provider.verifyStoredReceipt!(archive.receipt, anchorRequest);
      if (verifiedReceipt.receiptSha256 !== archive.receiptSha256
        || verifiedReceipt.statementSha256 !== archive.statementSha256
        || verifiedReceipt.verificationKeyFingerprint !== archive.verificationKeyFingerprint
        || verifiedReceipt.statement.reference !== archive.reference) {
        throw new Error('stored WORM receipt no longer verifies against the archive record');
      }
      const retrieveRequest: ExternalArchiveRetrieveRequest = {
        schemaVersion: 1,
        kind: 'argus.external-retention-archive-retrieve-request',
        artifact: anchorRequest.artifact as ExternalArchiveRetrieveRequest['artifact'],
        scope: archive.scope,
        reference: archive.reference,
        requestedAt: now.toISOString(),
      };
      const retrieved = await provider.retrieveArchive!(retrieveRequest);
      const retrievedAt = new Date(retrieved.retrievedAt);
      if (!Number.isFinite(retrievedAt.getTime()) || retrievedAt.getTime() > now.getTime() + 300_000) {
        throw new Error('external archive retrieval timestamp is invalid');
      }
      const packageJson = canonical(retrieved.content);
      const packageBytes = Buffer.byteLength(packageJson, 'utf8');
      const packageSha256 = sha256(packageJson);
      if (retrieved.bytes !== packageBytes || packageBytes !== archive.packageBytes || packageSha256 !== archive.packageSha256) {
        throw new Error('retrieved archive package size or digest does not match the immutable receipt');
      }
      verifyAuditRetentionArchivePackage(retrieved.content, archive);
      const verification: AuditRetentionRestoreDrillRecord['verification'] = {
        receipt: 'signature_valid', package: 'sha256_valid', checkpoint: 'signature_valid',
        eventChain: 'complete_and_valid', wormRetention: 'active', purgeAuthorized: false,
      };
      const durationMs = Math.max(0, Date.now() - startedAt);
      const inserted = await client.query<Row>(
        `INSERT INTO mcp_canonical_audit_retention_restore_drills
          (drill_id,archive_id,workspace_key,tenant_key,environment,provider,reference,package_sha256,receipt_sha256,
           checkpoint_digest,event_count,first_sequence,last_sequence,last_event_hash,retrieved_bytes,retrieved_at,verified_at,
           duration_ms,verification_status,verification_json,requested_by_id,actor_sso_subject,mfa_verified_at,mfa_method,
           justification_sha256,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,$14,$15,$16,$17,'verified',$18::jsonb,$19,$20,$21,$22,$23,$24,$16)
         RETURNING *`,
        [drillId, archiveId, scope.workspaceKey, scope.tenantKey, scope.environment, provider.name, archive.reference,
          archive.packageSha256, archive.receiptSha256, archive.checkpointDigest, archive.eventCount, archive.lastSequence,
          archive.lastEventHash, packageBytes, retrieved.retrievedAt, now.toISOString(), durationMs, JSON.stringify(verification),
          assurance.actorId, assurance.ssoSubject, context.mfaVerifiedAt, context.mfaMethod.trim(), sha256(assurance.justification),
          producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('restore drill insert returned no row');
      return mapDrill(inserted.rows[0]);
    },
    drill => ({
      occurredAt: now, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.retention_restore_drill.verified', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_retention_archive', id: archiveId, revision: drill.packageSha256 },
      policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision: 'restore_verified_purge_disabled' },
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: { after: { drillId: drill.drillId, archiveId, packageSha256: drill.packageSha256, receiptSha256: drill.receiptSha256, eventCount: drill.eventCount, purgeAuthorized: false } },
      retentionClass: 'business-audit-governance', legalHold: true,
    }),
        { now: () => now },
      );
    } catch (error) {
      const normalizedReason = String(error instanceof Error ? error.message : error).trim().slice(0, 1_000) || 'unknown restore verification failure';
      const reasonDigest = sha256(normalizedReason);
      const reasonCode = /receipt/i.test(normalizedReason) ? 'receipt_invalid'
        : /checkpoint/i.test(normalizedReason) ? 'checkpoint_invalid'
          : /event-chain|event count|terminal event/i.test(normalizedReason) ? 'event_chain_invalid'
            : /retention/i.test(normalizedReason) ? 'retention_inactive'
              : /size|digest|byte/i.test(normalizedReason) ? 'package_invalid'
                : /retriev|provider/i.test(normalizedReason) ? 'retrieval_failed'
                  : 'verification_failed';
      const failureEventId = `restore-failure-${sha256(canonical([scope, archiveId, producerEventId, reasonDigest])).slice(0, 48)}`;
      await executeCanonicalAuditedMutation(
        pool,
        { name: 'audit.retention.restore_drill.failure', eventId: failureEventId },
        scope,
        async () => ({ reasonCode, reasonDigest }),
        failure => ({
          occurredAt: now, ...scope, solution: 'argus.core', actor: context.actor,
          action: 'audit.retention_restore_drill.failed', outcome: 'failure', risk: 'critical',
          resource: { type: 'audit_retention_archive', id: archiveId, revision: null },
          policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision: 'restore_failed_purge_disabled' },
          correlation: { requestId: context.requestId ?? producerEventId },
          payload: { after: { archiveId, failureCode: failure.reasonCode, reasonDigest: failure.reasonDigest, purgeAuthorized: false } },
          retentionClass: 'business-audit-governance', legalHold: true,
        }),
        { now: () => now },
      ).catch(() => undefined);
      throw error;
    }
  })();
  let drill = outcome.result;
  if (!drill) {
    const existing = await pool.query<Row>(
      `SELECT * FROM mcp_canonical_audit_retention_restore_drills
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND producer_event_id=$4 AND archive_id=$5`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, producerEventId, archiveId],
    );
    drill = existing.rows[0] ? mapDrill(existing.rows[0]) : null;
  }
  if (!drill) throw new Error('restore drill replay could not resolve its immutable verification record');
  return { drill, replayed: outcome.replayed, auditEvent: outcome.event };
}
