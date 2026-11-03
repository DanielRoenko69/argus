import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from './canonicalAuditStore.js';
import { mapCanonicalAuditEventRow, verifyCanonicalAuditEventHash } from './canonicalAuditStore.js';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';
import {
  mapCanonicalAuditCheckpoint,
  verifyAuditCheckpointSignature,
  type CanonicalAuditCheckpoint,
} from './checkpoints.js';
import type {
  ExternalAnchorRequest,
  ExternalEvidenceAnchorProvider,
  VerifiedExternalAnchorReceipt,
} from './externalAnchorProvider.js';
import {
  mapAuditRetentionPlanRow,
  revalidateAuditRetentionPlanSources,
  type AuditRetentionPlan,
} from './retentionLifecycle.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;
export const MAX_RETENTION_ARCHIVE_BYTES = 64 * 1024 * 1024;

export interface AuditRetentionArchivePackage {
  schemaVersion: 1;
  kind: 'argus.audit-retention-archive';
  archiveId: string;
  plan: {
    planId: string;
    manifestSha256: string;
    evaluatedAt: string;
    approvedAt: string;
    approvedById: string;
  };
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  generatedAt: string;
  generatedBy: { actorId: string; ssoSubject: string; authMethod: 'oidc'; mfaMethod: string };
  checkpoint: { value: CanonicalAuditCheckpoint; publicKeyPem: string };
  chain: {
    firstSequence: 1;
    lastSequence: number;
    firstPreviousHash: '';
    lastEventHash: string;
    eventCount: number;
  };
  events: CanonicalAuditEventSummary[];
  verification: {
    state: 'event_hashes_and_checkpoint_valid';
    sourceEventsRevalidatedAt: string;
    purgeAuthorized: false;
  };
}

export interface AuditRetentionArchiveRecord {
  archiveId: string;
  planId: string;
  scope: { workspaceKey: string; tenantKey: string; environment: string };
  checkpointId: string;
  checkpointDigest: string;
  manifestSha256: string;
  packageSha256: string;
  packageBytes: number;
  eventCount: number;
  firstSequence: number;
  lastSequence: number;
  firstPreviousHash: string;
  lastEventHash: string;
  provider: string;
  reference: string;
  archivedAt: string;
  retentionUntil: string;
  statementSha256: string;
  receiptSha256: string;
  verificationKeyId: string;
  verificationKeyFingerprint: string;
  verification: 'verified';
  receipt: VerifiedExternalAnchorReceipt;
  producerEventId: string;
  requestedById: string;
  createdAt: string;
}

export interface RetentionArchiveContext {
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
type ActionRow = { action: string; actor_id: string; occurred_at: string | Date };
type CheckpointRow = Record<string, unknown> & { public_key_pem: string };

const canonical = (value: unknown): string => stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue);
const digest = (value: unknown): string => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

function iso(value: unknown, name: string): string {
  const parsed = new Date(value as string | number | Date);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

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

function normalizedScope(context: RetentionArchiveContext): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function assertAssurance(context: RetentionArchiveContext, now: Date): { actorId: string; ssoSubject: string; justification: string } {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new Error('Retention archival requires a verified human OIDC/Entra identity');
  }
  const verifiedAt = Date.parse(context.mfaVerifiedAt);
  if (!Number.isFinite(verifiedAt) || !context.mfaMethod.trim() || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > context.mfaMaxAgeSeconds * 1_000) {
    throw new Error('Retention archival requires fresh MFA verification');
  }
  const justification = required(context.justification, 'justification', 4_096);
  return {
    actorId: required(context.actor.id, 'actor.id', 256),
    ssoSubject: required(context.actor.ssoSubject, 'actor.ssoSubject', 512),
    justification,
  };
}

/** Stable across retries even when the provider succeeded before the DB transaction committed. */
export function deterministicRetentionArchiveId(
  scope: Required<CanonicalAuditScope>,
  planId: string,
  producerEventId: string,
): string {
  const chars = createHash('sha256')
    .update(canonical(['argus-retention-archive-v1', scope.workspaceKey, scope.tenantKey, scope.environment, planId, producerEventId]))
    .digest('hex').slice(0, 32).split('');
  chars[12] = '8';
  chars[16] = (8 + (Number.parseInt(chars[16]!, 16) % 4)).toString(16);
  const raw = chars.join('');
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

function assertReceipt(
  receipt: VerifiedExternalAnchorReceipt,
  request: ExternalAnchorRequest,
  provider: ExternalEvidenceAnchorProvider,
): void {
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'argus.external-evidence-anchor-receipt' || receipt.verification !== 'verified') {
    throw new Error('external archive adapter returned an unverified receipt');
  }
  if (receipt.statement.provider !== provider.name || receipt.statement.anchorKind !== 'worm_object'
    || receipt.statement.artifact.type !== 'audit_retention_archive'
    || receipt.statement.artifact.id !== request.artifact.id
    || receipt.statement.artifact.sha256 !== request.artifact.sha256
    || receipt.statement.idempotencyKey !== request.idempotencyKey
    || receipt.statement.scope.workspaceKey !== request.scope.workspaceKey
    || receipt.statement.scope.tenantKey !== request.scope.tenantKey
    || receipt.statement.scope.environment !== request.scope.environment) {
    throw new Error('external archive receipt does not bind the requested retention package');
  }
  const archivedAt = Date.parse(receipt.statement.anchoredAt);
  const retentionUntil = Date.parse(receipt.statement.retentionUntil ?? '');
  if (!Number.isFinite(archivedAt) || !Number.isFinite(retentionUntil) || retentionUntil <= archivedAt) {
    throw new Error('external archive receipt does not prove an enforceable WORM retention period');
  }
  if (!SHA256.test(receipt.statementSha256) || !SHA256.test(receipt.receiptSha256) || !SHA256.test(receipt.verificationKeyFingerprint)
    || digest(receipt.statement) !== receipt.statementSha256
    || digest({ statement: receipt.statement, signature: receipt.signature }) !== receipt.receiptSha256) {
    throw new Error('external archive receipt digest verification failed');
  }
}

export function mapAuditRetentionArchiveRow(row: Row): AuditRetentionArchiveRecord {
  return {
    archiveId: String(row['archive_id']), planId: String(row['plan_id']),
    scope: { workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']), environment: String(row['environment']) },
    checkpointId: String(row['checkpoint_id']), checkpointDigest: String(row['checkpoint_digest']), manifestSha256: String(row['manifest_sha256']),
    packageSha256: String(row['package_sha256']), packageBytes: Number(row['package_bytes']), eventCount: Number(row['event_count']),
    firstSequence: Number(row['first_sequence']), lastSequence: Number(row['last_sequence']), firstPreviousHash: String(row['first_previous_hash']),
    lastEventHash: String(row['last_event_hash']), provider: String(row['provider']), reference: String(row['reference']),
    archivedAt: iso(row['archived_at'], 'archivedAt'), retentionUntil: iso(row['retention_until'], 'retentionUntil'),
    statementSha256: String(row['statement_sha256']), receiptSha256: String(row['receipt_sha256']),
    verificationKeyId: String(row['verification_key_id']), verificationKeyFingerprint: String(row['verification_key_fingerprint']),
    verification: 'verified', receipt: row['receipt_json'] as VerifiedExternalAnchorReceipt,
    producerEventId: String(row['producer_event_id']),
    requestedById: String(row['requested_by_id']), createdAt: iso(row['created_at'], 'createdAt'),
  };
}

export async function listAuditRetentionArchives(
  pool: Pick<pg.Pool, 'query'>,
  planIds: string[],
): Promise<AuditRetentionArchiveRecord[]> {
  if (!planIds.length) return [];
  const result = await pool.query(
    'SELECT * FROM mcp_canonical_audit_retention_archives WHERE plan_id=ANY($1::uuid[]) ORDER BY archived_at DESC,archive_id',
    [planIds],
  );
  return (result.rows as Row[]).map(mapAuditRetentionArchiveRow);
}

function buildArchivePackage(
  archiveId: string,
  plan: AuditRetentionPlan,
  approval: ActionRow,
  checkpoint: CanonicalAuditCheckpoint,
  publicKeyPem: string,
  events: CanonicalAuditEventSummary[],
  context: RetentionArchiveContext,
  assurance: { actorId: string; ssoSubject: string },
  generatedAt: string,
): AuditRetentionArchivePackage {
  const last = events.at(-1)!;
  return {
    schemaVersion: 1, kind: 'argus.audit-retention-archive', archiveId,
    plan: {
      planId: plan.planId, manifestSha256: plan.manifestSha256,
      evaluatedAt: plan.evaluatedAt, approvedAt: iso(approval.occurred_at, 'approvedAt'), approvedById: approval.actor_id,
    },
    scope: { workspaceKey: plan.workspaceKey, tenantKey: plan.tenantKey, environment: plan.environment },
    generatedAt,
    generatedBy: { actorId: assurance.actorId, ssoSubject: assurance.ssoSubject, authMethod: 'oidc', mfaMethod: context.mfaMethod.trim() },
    checkpoint: { value: { ...checkpoint, replayed: false }, publicKeyPem },
    chain: {
      firstSequence: 1, lastSequence: last.sequence, firstPreviousHash: '', lastEventHash: last.eventHash, eventCount: events.length,
    },
    events: events.map(event => ({ ...event, replayed: false })),
    verification: { state: 'event_hashes_and_checkpoint_valid', sourceEventsRevalidatedAt: generatedAt, purgeAuthorized: false },
  };
}

export async function archiveAuditRetentionPlan(
  pool: pg.Pool,
  context: RetentionArchiveContext,
  planIdInput: string,
  provider: ExternalEvidenceAnchorProvider,
): Promise<{ archive: AuditRetentionArchiveRecord; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const planId = uuid(planIdInput, 'planId');
  if (!provider.supportedKinds.includes('worm_object')) throw new Error('Configured provider does not support WORM archival');
  const scope = normalizedScope(context);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new Error('now is invalid');
  const assurance = assertAssurance(context, now);
  const producerEventId = identifier(context.producerEventId, 'producerEventId');
  const archiveId = deterministicRetentionArchiveId(scope, planId, producerEventId);
  const outcome = await executeCanonicalAuditedMutation<AuditRetentionArchiveRecord>(
    pool,
    { name: 'audit.retention.archive', eventId: producerEventId },
    scope,
    async client => {
      const planResult = await client.query<Row>(
        `SELECT * FROM mcp_canonical_audit_retention_plans
          WHERE plan_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 FOR UPDATE`,
        [planId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      if (!planResult.rows[0]) throw new Error('retention plan was not found in the authorized scope');
      const plan = mapAuditRetentionPlanRow({ ...planResult.rows[0], lifecycle_status: 'planned' });
      const actionResult = await client.query<ActionRow>(
        'SELECT action,actor_id,occurred_at FROM mcp_canonical_audit_retention_plan_actions WHERE plan_id=$1 ORDER BY occurred_at,action_id',
        [planId],
      );
      const approval = actionResult.rows.find(action => action.action === 'approved');
      if (!approval || actionResult.rows.some(action => action.action === 'rejected')) throw new Error('retention plan requires an independent approval before archival');
      if (approval.actor_id === plan.requestedById) throw new Error('retention plan approval violates the four-eyes policy');
      if (actionResult.rows.some(action => action.action === 'archive_verified')) throw new Error('retention plan already has a verified archive');
      if (plan.firstSequence !== 1 || plan.lastSequence == null || plan.lastSequence !== plan.eligiblePrefixCount) {
        throw new Error('only a complete canonical chain prefix can be archived');
      }
      await revalidateAuditRetentionPlanSources(client, plan, now);

      const checkpointResult = await client.query<CheckpointRow>(
        `SELECT checkpoint.*,signing_key.public_key_pem
           FROM mcp_canonical_audit_checkpoints checkpoint
           JOIN mcp_canonical_audit_signing_keys signing_key ON signing_key.key_id=checkpoint.key_id
          WHERE checkpoint.checkpoint_id=$1`,
        [plan.checkpointId],
      );
      const checkpointRow = checkpointResult.rows[0];
      if (!checkpointRow) throw new Error('retention checkpoint is unavailable');
      const checkpoint = mapCanonicalAuditCheckpoint(checkpointRow as never);
      if (checkpoint.checkpointDigest !== plan.checkpointDigest || checkpoint.lastSequence !== plan.throughSequence
        || checkpoint.workspaceKey !== scope.workspaceKey || checkpoint.tenantKey !== scope.tenantKey || checkpoint.environment !== scope.environment
        || !verifyAuditCheckpointSignature(checkpoint, checkpointRow.public_key_pem)) {
        throw new Error('retention checkpoint binding or signature is invalid');
      }

      const eventResult = await client.query(
        `SELECT * FROM mcp_canonical_audit_events
          WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND sequence BETWEEN 1 AND $4
          ORDER BY sequence ASC`,
        [scope.workspaceKey, scope.tenantKey, scope.environment, String(plan.lastSequence)],
      );
      const events = (eventResult.rows as Row[]).map(row => mapCanonicalAuditEventRow(row as never, false));
      if (events.length !== plan.eligiblePrefixCount) throw new Error('retention archive source event count is invalid');
      let previousHash = '';
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index]!;
        const expected = plan.manifest.eligibleEvents[index]!;
        if (event.sequence !== index + 1 || event.eventId !== expected.eventId || event.eventHash !== expected.eventHash
          || event.previousHash !== previousHash || !verifyCanonicalAuditEventHash(event)) {
          throw new Error(`retention archive chain verification failed at sequence ${event.sequence}`);
        }
        previousHash = event.eventHash;
      }

      const archivePackage = buildArchivePackage(
        archiveId, plan, approval, checkpoint, checkpointRow.public_key_pem, events, context, assurance, now.toISOString(),
      );
      const packageJson = canonical(archivePackage);
      const packageBytes = Buffer.byteLength(packageJson, 'utf8');
      if (packageBytes < 1 || packageBytes > MAX_RETENTION_ARCHIVE_BYTES) {
        throw new Error(`retention archive package exceeds the ${MAX_RETENTION_ARCHIVE_BYTES}-byte safety limit`);
      }
      const packageSha256 = createHash('sha256').update(packageJson, 'utf8').digest('hex');
      const request: ExternalAnchorRequest = {
        anchorKind: 'worm_object',
        artifact: { type: 'audit_retention_archive', id: archiveId, sha256: packageSha256 },
        scope,
        idempotencyKey: producerEventId,
        requestedAt: now.toISOString(),
        payload: {
          mediaType: 'application/vnd.argus.audit-retention-archive.v1+json',
          bytes: packageBytes,
          content: JSON.parse(packageJson) as AuditJsonValue,
        },
      };
      const receipt = await provider.anchor(request);
      assertReceipt(receipt, request, provider);
      const summary = {
        schemaVersion: 1, kind: 'argus.audit-retention-archive-summary', archiveId, planId,
        packageSha256, packageBytes, eventCount: events.length,
        firstSequence: 1, lastSequence: plan.lastSequence, lastEventHash: events.at(-1)!.eventHash,
        checkpointId: checkpoint.checkpointId, checkpointDigest: checkpoint.checkpointDigest,
      };
      const inserted = await client.query<Row>(
        `INSERT INTO mcp_canonical_audit_retention_archives
          (archive_id,plan_id,workspace_key,tenant_key,environment,checkpoint_id,checkpoint_digest,manifest_sha256,
           package_sha256,package_bytes,event_count,first_sequence,last_sequence,first_previous_hash,last_event_hash,
           provider,reference,archived_at,retention_until,statement_sha256,receipt_sha256,verification_key_id,
           verification_key_fingerprint,package_summary_json,receipt_json,requested_by_id,actor_sso_subject,
           mfa_verified_at,mfa_method,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,'',$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23::jsonb,$24,$25,$26,$27,$28,$16)
         RETURNING *`,
        [archiveId, planId, scope.workspaceKey, scope.tenantKey, scope.environment, checkpoint.checkpointId,
          checkpoint.checkpointDigest, plan.manifestSha256, packageSha256, packageBytes, events.length, plan.lastSequence,
          events.at(-1)!.eventHash, provider.name, receipt.statement.reference, receipt.statement.anchoredAt,
          receipt.statement.retentionUntil, receipt.statementSha256, receipt.receiptSha256, receipt.signature.keyId,
          receipt.verificationKeyFingerprint, JSON.stringify(summary), JSON.stringify(receipt), assurance.actorId,
          assurance.ssoSubject, context.mfaVerifiedAt, context.mfaMethod.trim(), producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('retention archive insert returned no row');
      await client.query(
        `INSERT INTO mcp_canonical_audit_retention_plan_actions
          (action_id,plan_id,action,actor_id,actor_sso_subject,mfa_verified_at,mfa_method,justification_sha256,anchor_id,archive_id,producer_event_id,occurred_at)
         VALUES ($1,$2,'archive_verified',$3,$4,$5,$6,$7,NULL,$8,$9,$10)`,
        [deterministicRetentionArchiveId(scope, planId, `${producerEventId}:action`), planId, assurance.actorId,
          assurance.ssoSubject, context.mfaVerifiedAt, context.mfaMethod.trim(), createHash('sha256').update(assurance.justification, 'utf8').digest('hex'),
          archiveId, `${archiveId}:archive_verified`, now.toISOString()],
      );
      return mapAuditRetentionArchiveRow(inserted.rows[0]);
    },
    archive => ({
      occurredAt: now, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.retention_archive.verified', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_retention_archive', id: archive.archiveId, revision: archive.packageSha256 },
      policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision: 'archive_verified_purge_disabled' },
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: { after: { planId, archiveId: archive.archiveId, provider: archive.provider, packageSha256: archive.packageSha256, receiptSha256: archive.receiptSha256, eventCount: archive.eventCount, purgeAuthorized: false } },
      retentionClass: 'business-audit-governance', legalHold: true,
    }),
    { now: () => now },
  );
  let archive = outcome.result;
  if (!archive) {
    const existing = await pool.query<Row>(
      `SELECT * FROM mcp_canonical_audit_retention_archives
        WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND producer_event_id=$4 AND provider=$5 AND plan_id=$6`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, producerEventId, provider.name, planId],
    );
    archive = existing.rows[0] ? mapAuditRetentionArchiveRow(existing.rows[0]) : null;
  }
  if (!archive) throw new Error('retention archive replay could not resolve its immutable receipt');
  return { archive, replayed: outcome.replayed, auditEvent: outcome.event };
}
