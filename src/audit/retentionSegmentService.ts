import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from './canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';
import { mapAuditRetentionArchiveRow } from './retentionArchiveService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;

export interface AuditRetentionChainSegmentRecord {
  segmentId: string;
  segmentOrdinal: number;
  previousSegmentId: string | null;
  previousSegmentDigest: string;
  archiveId: string;
  restoreDrillId: string;
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  firstSequence: number;
  lastSequence: number;
  eventCount: number;
  firstPreviousHash: string;
  lastEventHash: string;
  continuationSequence: number;
  continuationPreviousHash: string;
  checkpointId: string;
  checkpointDigest: string;
  archivePackageSha256: string;
  archiveReceiptSha256: string;
  segmentDigest: string;
  verification: {
    archive: 'worm_receipt_verified';
    restoreDrill: 'full_download_verified';
    sourceBoundary: 'canonical_chain_verified';
    continuation: 'hash_anchored';
    purgeAuthorized: false;
  };
  sealedAt: string;
  requestedById: string;
  producerEventId: string;
  createdAt: string;
}

export interface RetentionSegmentContext {
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
const sha256 = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8').digest('hex');

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

function safeInteger(value: unknown, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} is invalid`);
  return parsed;
}

function normalizedScope(context: RetentionSegmentContext): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function assertAssurance(context: RetentionSegmentContext, now: Date): { actorId: string; ssoSubject: string; justification: string } {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new Error('Chain segment sealing requires a verified human OIDC/Entra identity');
  }
  const verifiedAt = Date.parse(context.mfaVerifiedAt);
  if (!Number.isFinite(verifiedAt) || !context.mfaMethod.trim() || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > context.mfaMaxAgeSeconds * 1_000) {
    throw new Error('Chain segment sealing requires fresh MFA verification');
  }
  return {
    actorId: required(context.actor.id, 'actor.id'),
    ssoSubject: required(context.actor.ssoSubject, 'actor.ssoSubject', 512),
    justification: required(context.justification, 'justification', 4_096),
  };
}

export function deterministicRetentionSegmentId(
  scope: Required<CanonicalAuditScope>,
  archiveId: string,
  producerEventId: string,
): string {
  const chars = sha256(['argus-retention-chain-segment-v1', scope.workspaceKey, scope.tenantKey, scope.environment, archiveId, producerEventId])
    .slice(0, 32).split('');
  chars[12] = '8';
  chars[16] = (8 + (Number.parseInt(chars[16]!, 16) % 4)).toString(16);
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function mapAuditRetentionChainSegmentRow(row: Row): AuditRetentionChainSegmentRecord {
  return {
    segmentId: String(row['segment_id']), segmentOrdinal: safeInteger(row['segment_ordinal'], 'segmentOrdinal'),
    previousSegmentId: row['previous_segment_id'] == null ? null : String(row['previous_segment_id']),
    previousSegmentDigest: String(row['previous_segment_digest']), archiveId: String(row['archive_id']),
    restoreDrillId: String(row['restore_drill_id']),
    scope: { workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']), environment: String(row['environment']) },
    firstSequence: safeInteger(row['first_sequence'], 'firstSequence'), lastSequence: safeInteger(row['last_sequence'], 'lastSequence'),
    eventCount: safeInteger(row['event_count'], 'eventCount'), firstPreviousHash: String(row['first_previous_hash']),
    lastEventHash: String(row['last_event_hash']), continuationSequence: safeInteger(row['continuation_sequence'], 'continuationSequence'),
    continuationPreviousHash: String(row['continuation_previous_hash']), checkpointId: String(row['checkpoint_id']),
    checkpointDigest: String(row['checkpoint_digest']), archivePackageSha256: String(row['archive_package_sha256']),
    archiveReceiptSha256: String(row['archive_receipt_sha256']), segmentDigest: String(row['segment_digest']),
    verification: row['verification_json'] as AuditRetentionChainSegmentRecord['verification'],
    sealedAt: iso(row['sealed_at'], 'sealedAt'), requestedById: String(row['requested_by_id']),
    producerEventId: String(row['producer_event_id']), createdAt: iso(row['created_at'], 'createdAt'),
  };
}

export async function listAuditRetentionChainSegments(
  pool: Pick<pg.Pool, 'query'>,
  archiveIds: string[],
): Promise<AuditRetentionChainSegmentRecord[]> {
  if (!archiveIds.length) return [];
  const result = await pool.query(
    'SELECT * FROM mcp_canonical_audit_chain_segments WHERE archive_id=ANY($1::uuid[]) ORDER BY segment_ordinal DESC,segment_id',
    [archiveIds],
  );
  return (result.rows as Row[]).map(mapAuditRetentionChainSegmentRow);
}

export async function sealAuditRetentionChainSegment(
  pool: pg.Pool,
  context: RetentionSegmentContext,
  archiveIdInput: string,
): Promise<{ segment: AuditRetentionChainSegmentRecord; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const archiveId = uuid(archiveIdInput, 'archiveId');
  const scope = normalizedScope(context);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('now is invalid');
  const assurance = assertAssurance(context, now);
  const producerEventId = identifier(context.producerEventId, 'producerEventId');
  const segmentId = deterministicRetentionSegmentId(scope, archiveId, producerEventId);

  const outcome = await executeCanonicalAuditedMutation<AuditRetentionChainSegmentRecord>(
    pool,
    { name: 'audit.retention.chain_segment', eventId: producerEventId },
    scope,
    async client => {
      const headResult = await client.query<Row>(
        `SELECT last_sequence,last_event_hash FROM mcp_canonical_audit_chain_heads
          WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 FOR UPDATE`,
        [scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      if (!headResult.rows[0]) throw new Error('canonical audit chain head is unavailable');
      const headSequence = safeInteger(headResult.rows[0]['last_sequence'], 'chain head sequence');
      const headHash = String(headResult.rows[0]['last_event_hash']);

      const archiveResult = await client.query<Row>(
        `SELECT * FROM mcp_canonical_audit_retention_archives
          WHERE archive_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 FOR SHARE`,
        [archiveId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      if (!archiveResult.rows[0]) throw new Error('retention archive was not found in the authorized scope');
      const archive = mapAuditRetentionArchiveRow(archiveResult.rows[0]);
      if (Date.parse(archive.retentionUntil) <= now.getTime()) throw new Error('archive WORM retention is no longer active');

      const drillResult = await client.query<Row>(
        `SELECT * FROM mcp_canonical_audit_retention_restore_drills
          WHERE archive_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4
            AND verification_status='verified'
          ORDER BY verified_at DESC,drill_id LIMIT 1 FOR SHARE`,
        [archiveId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      const drill = drillResult.rows[0];
      if (!drill) throw new Error('a successful full-download restore drill is required before segment sealing');
      if (String(drill['package_sha256']) !== archive.packageSha256 || String(drill['receipt_sha256']) !== archive.receiptSha256
        || String(drill['checkpoint_digest']) !== archive.checkpointDigest
        || safeInteger(drill['first_sequence'], 'restore first sequence') !== archive.firstSequence
        || safeInteger(drill['last_sequence'], 'restore last sequence') !== archive.lastSequence
        || String(drill['last_event_hash']) !== archive.lastEventHash) {
        throw new Error('restore drill no longer binds the immutable archive boundary');
      }

      const previousResult = await client.query<Row>(
        `SELECT * FROM mcp_canonical_audit_chain_segments
          WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3
          ORDER BY segment_ordinal DESC LIMIT 1 FOR SHARE`,
        [scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      const previous = previousResult.rows[0] ? mapAuditRetentionChainSegmentRow(previousResult.rows[0]) : null;
      const segmentOrdinal = (previous?.segmentOrdinal ?? 0) + 1;
      if (previous) {
        if (archive.firstSequence !== previous.continuationSequence || archive.firstPreviousHash !== previous.continuationPreviousHash) {
          throw new Error('archive overlaps or disconnects from the previously sealed chain segment');
        }
      } else if (archive.firstSequence !== 1 || archive.firstPreviousHash !== '') {
        throw new Error('the first sealed segment must start at the canonical chain genesis');
      }
      if (archive.lastSequence > headSequence || (archive.lastSequence === headSequence && archive.lastEventHash !== headHash)) {
        throw new Error('archive boundary is not present in the active canonical chain head');
      }

      const boundaryResult = await client.query<Row>(
        `SELECT sequence,previous_hash,event_hash FROM mcp_canonical_audit_events
          WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND sequence=ANY($4::bigint[])
          ORDER BY sequence`,
        [scope.workspaceKey, scope.tenantKey, scope.environment,
          [String(archive.firstSequence), String(archive.lastSequence), String(archive.lastSequence + 1)]],
      );
      const bySequence = new Map(boundaryResult.rows.map(row => [Number(row['sequence']), row]));
      const first = bySequence.get(archive.firstSequence);
      const last = bySequence.get(archive.lastSequence);
      const continuation = bySequence.get(archive.lastSequence + 1);
      if (!first || !last || String(first['previous_hash']) !== archive.firstPreviousHash || String(last['event_hash']) !== archive.lastEventHash) {
        throw new Error('canonical source boundary does not match the archived segment');
      }
      if (continuation && String(continuation['previous_hash']) !== archive.lastEventHash) {
        throw new Error('active canonical chain does not continue from the archived segment hash');
      }

      const descriptor = {
        schemaVersion: 1, kind: 'argus.canonical-audit-chain-segment', segmentId, segmentOrdinal,
        previousSegmentId: previous?.segmentId ?? null, previousSegmentDigest: previous?.segmentDigest ?? '', scope,
        archiveId, restoreDrillId: String(drill['drill_id']), firstSequence: archive.firstSequence,
        lastSequence: archive.lastSequence, eventCount: archive.eventCount, firstPreviousHash: archive.firstPreviousHash,
        lastEventHash: archive.lastEventHash, continuationSequence: archive.lastSequence + 1,
        continuationPreviousHash: archive.lastEventHash, checkpointId: archive.checkpointId,
        checkpointDigest: archive.checkpointDigest, archivePackageSha256: archive.packageSha256,
        archiveReceiptSha256: archive.receiptSha256, sealedAt: now.toISOString(), purgeAuthorized: false,
      };
      const segmentDigest = sha256(descriptor);
      const verification: AuditRetentionChainSegmentRecord['verification'] = {
        archive: 'worm_receipt_verified', restoreDrill: 'full_download_verified',
        sourceBoundary: 'canonical_chain_verified', continuation: 'hash_anchored', purgeAuthorized: false,
      };
      const inserted = await client.query<Row>(
        `INSERT INTO mcp_canonical_audit_chain_segments
          (segment_id,segment_ordinal,previous_segment_id,previous_segment_digest,workspace_key,tenant_key,environment,
           archive_id,restore_drill_id,first_sequence,last_sequence,event_count,first_previous_hash,last_event_hash,
           continuation_sequence,continuation_previous_hash,checkpoint_id,checkpoint_digest,archive_package_sha256,
           archive_receipt_sha256,segment_digest,verification_json,sealed_at,requested_by_id,actor_sso_subject,
           mfa_verified_at,mfa_method,justification_sha256,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29,$23)
         RETURNING *`,
        [segmentId, segmentOrdinal, previous?.segmentId ?? null, previous?.segmentDigest ?? '', scope.workspaceKey,
          scope.tenantKey, scope.environment, archiveId, String(drill['drill_id']), archive.firstSequence,
          archive.lastSequence, archive.eventCount, archive.firstPreviousHash, archive.lastEventHash,
          archive.lastSequence + 1, archive.lastEventHash, archive.checkpointId, archive.checkpointDigest,
          archive.packageSha256, archive.receiptSha256, segmentDigest, JSON.stringify(verification), now.toISOString(),
          assurance.actorId, assurance.ssoSubject, context.mfaVerifiedAt, context.mfaMethod.trim(),
          sha256(assurance.justification), producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('chain segment insert returned no row');
      return mapAuditRetentionChainSegmentRow(inserted.rows[0]);
    },
    segment => ({
      occurredAt: now, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.retention_segment.sealed', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_chain_segment', id: segment.segmentId, revision: segment.segmentDigest },
      policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision: 'segment_sealed_purge_disabled' },
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: { after: {
        archiveId, restoreDrillId: segment.restoreDrillId, segmentOrdinal: segment.segmentOrdinal,
        firstSequence: segment.firstSequence, lastSequence: segment.lastSequence,
        continuationSequence: segment.continuationSequence, continuationPreviousHash: segment.continuationPreviousHash,
        segmentDigest: segment.segmentDigest, purgeAuthorized: false,
      } },
      retentionClass: 'business-audit-governance', legalHold: true,
    }),
    { now: () => now },
  );

  let segment = outcome.result;
  if (!segment) {
    const existing = await pool.query<Row>(
      `SELECT * FROM mcp_canonical_audit_chain_segments
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND producer_event_id=$4`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, producerEventId],
    );
    segment = existing.rows[0] ? mapAuditRetentionChainSegmentRow(existing.rows[0]) : null;
  }
  if (!segment) throw new Error('chain segment replay could not resolve its immutable seal');
  return { segment, replayed: outcome.replayed, auditEvent: outcome.event };
}
