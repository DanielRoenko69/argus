import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableAuditJson, type AuditJsonValue } from './canonicalAuditRedaction.js';
import { executeCanonicalAuditedMutation } from './canonicalAuditStore.js';
import { verifyAuditCheckpointSignature, type AuditCheckpointEnvelope } from './checkpoints.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
export const MAX_RETENTION_PLAN_EVENTS = 5_000;

export type RetentionBlockerCode = 'empty' | 'legal_hold' | 'not_due' | 'indefinite' | 'batch_limit' | 'checkpoint_boundary';
export type RetentionPlanStatus = 'planned' | 'approved' | 'rejected' | 'archive_verified' | 'purge_executed' | 'failed';

export interface RetentionLifecycleContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  mfaVerifiedAt: string;
  mfaMethod: string;
  producerEventId: string;
  now?: () => Date;
  uuid?: () => string;
}

export interface RetentionCandidateRow {
  event_id: string;
  sequence: number | string;
  occurred_at: string | Date;
  event_hash: string;
  resource_type: string;
  resource_id: string;
  retention_class: string;
  effective_retention_until: string | Date | null;
  effective_legal_hold: boolean;
  policy_id: string | null;
  policy_version: number | string | null;
  policy_region: string | null;
}

export interface RetentionManifestEvent {
  eventId: string;
  sequence: number;
  occurredAt: string;
  eventHash: string;
  resourceType: string;
  resourceId: string;
  retentionClass: string;
  retentionUntil: string;
  policyId: string | null;
  policyVersion: number | null;
  region: string | null;
}

export interface AuditRetentionPlan {
  planId: string;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  retentionClass: string;
  checkpointId: string;
  checkpointDigest: string;
  throughSequence: number;
  evaluatedAt: string;
  eligiblePrefixCount: number;
  firstSequence: number | null;
  lastSequence: number | null;
  blocker: { code: RetentionBlockerCode; sequence: number | null };
  manifestSha256: string;
  manifest: {
    schemaVersion: 1;
    mode: 'dry_run';
    scope: { workspaceKey: string; tenantKey: string; environment: string };
    retentionClass: string;
    checkpoint: { id: string; digest: string; throughSequence: number };
    evaluatedAt: string;
    eligibleEvents: RetentionManifestEvent[];
    blocker: { code: RetentionBlockerCode; sequence: number | null };
    purgeAllowed: false;
    nextRequiredAction: 'none' | 'independent_approval_then_archive';
  };
  requestedById: string;
  requesterSsoSubject: string;
  mfaVerifiedAt: string;
  mfaMethod: string;
  producerEventId: string;
  createdAt: string;
  status: RetentionPlanStatus;
}

type PlanRow = Record<string, unknown>;

function text(value: unknown, name: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function uuid(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID.test(normalized)) throw new Error(`${name} must be a UUID`);
  return normalized;
}

function iso(value: unknown, name: string): string {
  const parsed = new Date(value as string | Date);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

export function computeAuditRetentionManifestSha256(value: unknown): string {
  return createHash('sha256').update(stableAuditJson(value as AuditJsonValue)).digest('hex');
}

function scopeOf(scope: CanonicalAuditScope): Required<CanonicalAuditScope> {
  return {
    workspaceKey: text(scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: text(scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: text(scope.environment, 'environment', 64),
  };
}

function validateHumanAssurance(context: RetentionLifecycleContext): void {
  if (context.actor.type !== 'human' || !context.actor.ssoSubject || context.actor.authMethod !== 'oidc') {
    throw new Error('retention lifecycle requires a human OIDC/Entra identity');
  }
  iso(context.mfaVerifiedAt, 'mfaVerifiedAt');
  text(context.mfaMethod, 'mfaMethod', 160);
}

export function classifyRetentionPrefix(
  rows: RetentionCandidateRow[],
  evaluatedAt: Date,
  batchLimit = MAX_RETENTION_PLAN_EVENTS,
): { eligibleEvents: RetentionManifestEvent[]; blocker: { code: RetentionBlockerCode; sequence: number | null } } {
  if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > MAX_RETENTION_PLAN_EVENTS) {
    throw new Error(`batchLimit must be between 1 and ${MAX_RETENTION_PLAN_EVENTS}`);
  }
  const eligibleEvents: RetentionManifestEvent[] = [];
  if (rows.length === 0) return { eligibleEvents, blocker: { code: 'empty', sequence: null } };
  let expected = 1;
  for (const row of rows) {
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence !== expected) {
      return { eligibleEvents, blocker: { code: 'checkpoint_boundary', sequence: Number.isSafeInteger(sequence) ? sequence : null } };
    }
    if (row.effective_legal_hold) return { eligibleEvents, blocker: { code: 'legal_hold', sequence } };
    if (row.effective_retention_until == null) return { eligibleEvents, blocker: { code: 'indefinite', sequence } };
    const retentionUntil = iso(row.effective_retention_until, 'effectiveRetentionUntil');
    if (Date.parse(retentionUntil) > evaluatedAt.getTime()) {
      return { eligibleEvents, blocker: { code: 'not_due', sequence } };
    }
    if (eligibleEvents.length >= batchLimit) return { eligibleEvents, blocker: { code: 'batch_limit', sequence } };
    const eventHash = String(row.event_hash);
    if (!SHA256.test(eventHash)) throw new Error('candidate event hash is invalid');
    eligibleEvents.push({
      eventId: uuid(row.event_id, 'eventId'), sequence, occurredAt: iso(row.occurred_at, 'occurredAt'), eventHash,
      resourceType: text(row.resource_type, 'resourceType', 64), resourceId: text(row.resource_id, 'resourceId', 256),
      retentionClass: text(row.retention_class, 'retentionClass', 64),
      retentionUntil, policyId: row.policy_id == null ? null : uuid(row.policy_id, 'policyId'),
      policyVersion: row.policy_version == null ? null : Number(row.policy_version),
      region: row.policy_region == null ? null : text(row.policy_region, 'policyRegion', 64),
    });
    expected += 1;
  }
  return {
    eligibleEvents,
    blocker: rows.length > batchLimit
      ? { code: 'batch_limit', sequence: Number(rows[batchLimit]?.sequence ?? null) || null }
      : { code: 'checkpoint_boundary', sequence: null },
  };
}

function candidateSql(filterEventIds = false): string {
  return `SELECT event.event_id,event.sequence,event.occurred_at,event.event_hash,event.resource_type,event.resource_id,
            event.retention_class,
            COALESCE(event.retention_until,CASE WHEN policy.duration_days IS NULL THEN NULL ELSE event.occurred_at + (policy.duration_days * interval '1 day') END) AS effective_retention_until,
            (event.legal_hold OR EXISTS (
              SELECT 1 FROM mcp_canonical_audit_legal_hold_actions placed
               WHERE placed.workspace_key=event.workspace_key AND placed.tenant_key=event.tenant_key
                 AND placed.environment=event.environment AND placed.action='placed'
                 AND event.sequence>=placed.from_sequence
                 AND (placed.through_sequence IS NULL OR event.sequence<=placed.through_sequence)
                 AND (placed.resource_type IS NULL OR (placed.resource_type=event.resource_type AND placed.resource_id=event.resource_id))
                 AND NOT EXISTS (SELECT 1 FROM mcp_canonical_audit_legal_hold_actions released WHERE released.hold_id=placed.hold_id AND released.action='released')
            )) AS effective_legal_hold,
            policy.policy_id,policy.version AS policy_version,policy.region AS policy_region
       FROM mcp_canonical_audit_events event
       LEFT JOIN LATERAL (
         SELECT p.policy_id,p.version,p.duration_days,p.region
           FROM mcp_canonical_audit_retention_policies p
          WHERE p.workspace_key=event.workspace_key AND p.tenant_key=event.tenant_key
            AND p.environment=event.environment AND p.retention_class=event.retention_class
            AND p.effective_from<=event.occurred_at
          ORDER BY p.effective_from DESC,p.version DESC LIMIT 1
      ) policy ON true
      WHERE event.workspace_key=$1 AND event.tenant_key=$2 AND event.environment=$3
        AND event.sequence<=$4${filterEventIds ? ' AND event.event_id=ANY($5::uuid[])' : ''}
      ORDER BY event.sequence ASC
      ${filterEventIds ? '' : 'LIMIT $5'}`;
}

export function mapAuditRetentionPlanRow(row: PlanRow): AuditRetentionPlan {
  const manifest = row['manifest_json'] as AuditRetentionPlan['manifest'];
  return {
    planId: String(row['plan_id']), workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']),
    environment: String(row['environment']), retentionClass: String(row['retention_class']), checkpointId: String(row['checkpoint_id']),
    checkpointDigest: String(row['checkpoint_digest']), throughSequence: Number(row['through_sequence']), evaluatedAt: iso(row['evaluated_at'], 'evaluatedAt'),
    eligiblePrefixCount: Number(row['eligible_prefix_count']), firstSequence: row['first_sequence'] == null ? null : Number(row['first_sequence']),
    lastSequence: row['last_sequence'] == null ? null : Number(row['last_sequence']),
    blocker: { code: String(row['blocker_code']) as RetentionBlockerCode, sequence: row['blocker_sequence'] == null ? null : Number(row['blocker_sequence']) },
    manifestSha256: String(row['manifest_sha256']), manifest, requestedById: String(row['requested_by_id']),
    requesterSsoSubject: String(row['requester_sso_subject']), mfaVerifiedAt: iso(row['mfa_verified_at'], 'mfaVerifiedAt'),
    mfaMethod: String(row['mfa_method']), producerEventId: String(row['producer_event_id']), createdAt: iso(row['created_at'], 'createdAt'),
    status: String(row['lifecycle_status'] ?? 'planned') as RetentionPlanStatus,
  };
}

export async function createAuditRetentionPlan(
  pool: pg.Pool,
  context: RetentionLifecycleContext,
  checkpointEnvelope: AuditCheckpointEnvelope,
  batchLimit = MAX_RETENTION_PLAN_EVENTS,
): Promise<{ plan: AuditRetentionPlan; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  validateHumanAssurance(context);
  const scope = scopeOf(context.scope);
  const retentionClass = 'all-classes';
  const producerEventId = text(context.producerEventId, 'producerEventId', 256);
  const evaluatedAtDate = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(evaluatedAtDate.getTime())) throw new Error('now() returned an invalid timestamp');
  const evaluatedAt = evaluatedAtDate.toISOString();
  const checkpoint = checkpointEnvelope.checkpoint;
  if (!verifyAuditCheckpointSignature(checkpoint, checkpointEnvelope.publicKeyPem)
    || checkpoint.workspaceKey !== scope.workspaceKey || checkpoint.tenantKey !== scope.tenantKey
    || checkpoint.environment !== scope.environment) throw new Error('a valid scope-bound signed checkpoint is required');
  const candidates = await pool.query<RetentionCandidateRow>(candidateSql(), [
    scope.workspaceKey, scope.tenantKey, scope.environment, String(checkpoint.lastSequence), batchLimit + 1,
  ]);
  const classified = classifyRetentionPrefix(candidates.rows, evaluatedAtDate, batchLimit);
  const planId = uuid((context.uuid ?? randomUUID)(), 'planId');
  const manifest: AuditRetentionPlan['manifest'] = {
    schemaVersion: 1, mode: 'dry_run', scope, retentionClass,
    checkpoint: { id: checkpoint.checkpointId, digest: checkpoint.checkpointDigest, throughSequence: checkpoint.lastSequence },
    evaluatedAt, eligibleEvents: classified.eligibleEvents, blocker: classified.blocker,
    purgeAllowed: false,
    nextRequiredAction: classified.eligibleEvents.length > 0 ? 'independent_approval_then_archive' : 'none',
  };
  const manifestSha256 = computeAuditRetentionManifestSha256(manifest);
  const firstSequence = classified.eligibleEvents.at(0)?.sequence ?? null;
  const lastSequence = classified.eligibleEvents.at(-1)?.sequence ?? null;
  const outcome = await executeCanonicalAuditedMutation(
    pool, { name: 'audit.retention.plan', eventId: producerEventId }, scope,
    async client => {
      const inserted = await client.query<PlanRow>(
        `INSERT INTO mcp_canonical_audit_retention_plans
          (plan_id,workspace_key,tenant_key,environment,retention_class,checkpoint_id,checkpoint_digest,through_sequence,evaluated_at,
           eligible_prefix_count,first_sequence,last_sequence,blocker_code,blocker_sequence,manifest_sha256,manifest_json,
           requested_by_id,requester_sso_subject,mfa_verified_at,mfa_method,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$9)
         RETURNING *, 'planned'::text AS lifecycle_status`,
        [planId, scope.workspaceKey, scope.tenantKey, scope.environment, retentionClass, checkpoint.checkpointId,
          checkpoint.checkpointDigest, String(checkpoint.lastSequence), evaluatedAt, classified.eligibleEvents.length,
          firstSequence, lastSequence, classified.blocker.code, classified.blocker.sequence, manifestSha256, manifest,
          context.actor.id, context.actor.ssoSubject, iso(context.mfaVerifiedAt, 'mfaVerifiedAt'), context.mfaMethod, producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('retention plan insert returned no row');
      return mapAuditRetentionPlanRow(inserted.rows[0]);
    },
    plan => ({
      occurredAt: evaluatedAt, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.retention_plan.created', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_retention_plan', id: plan.planId, revision: plan.manifestSha256 },
      policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision: 'dry_run_only' },
      payload: { after: { retentionClass, eligiblePrefixCount: plan.eligiblePrefixCount, blocker: plan.blocker, checkpointId: plan.checkpointId, manifestSha256 } },
      retentionClass: 'business-audit-governance', legalHold: true,
    }), { now: () => evaluatedAtDate },
  );
  let plan: AuditRetentionPlan | null = outcome.result;
  if (!plan) {
    const replay = await pool.query<PlanRow>(
      `SELECT plan.*,COALESCE(action.action,'planned') AS lifecycle_status
         FROM mcp_canonical_audit_retention_plans plan
         LEFT JOIN LATERAL (SELECT action FROM mcp_canonical_audit_retention_plan_actions a WHERE a.plan_id=plan.plan_id ORDER BY occurred_at DESC LIMIT 1) action ON true
        WHERE plan.workspace_key=$1 AND plan.tenant_key=$2 AND plan.environment=$3 AND plan.producer_event_id=$4`,
      [scope.workspaceKey, scope.tenantKey, scope.environment, producerEventId],
    );
    plan = replay.rows[0] ? mapAuditRetentionPlanRow(replay.rows[0]) : null;
  }
  if (!plan) throw new Error('retention plan replay could not resolve its immutable manifest');
  return { plan, replayed: outcome.replayed, auditEvent: outcome.event };
}

export async function listAuditRetentionPlans(pool: pg.Pool, scopeInput: CanonicalAuditScope, limit = 25): Promise<AuditRetentionPlan[]> {
  const scope = scopeOf(scopeInput);
  const safeLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 25;
  const result = await pool.query<PlanRow>(
    `SELECT plan.*,COALESCE(action.action,'planned') AS lifecycle_status
       FROM mcp_canonical_audit_retention_plans plan
       LEFT JOIN LATERAL (SELECT action FROM mcp_canonical_audit_retention_plan_actions a WHERE a.plan_id=plan.plan_id ORDER BY occurred_at DESC LIMIT 1) action ON true
      WHERE plan.workspace_key=$1 AND plan.tenant_key=$2 AND plan.environment=$3
      ORDER BY plan.created_at DESC LIMIT $4`,
    [scope.workspaceKey, scope.tenantKey, scope.environment, safeLimit],
  );
  return result.rows.map(mapAuditRetentionPlanRow);
}

export async function revalidateAuditRetentionPlanSources(
  queryable: Pick<pg.Pool, 'query'>,
  plan: AuditRetentionPlan,
  evaluatedAt = new Date(),
): Promise<RetentionCandidateRow[]> {
  if (computeAuditRetentionManifestSha256(plan.manifest) !== plan.manifestSha256) {
    throw new Error('retention plan manifest digest is invalid');
  }
  if (plan.eligiblePrefixCount < 1 || plan.manifest.eligibleEvents.length !== plan.eligiblePrefixCount) {
    throw new Error('retention plan has no complete archiveable prefix');
  }
  const ids = plan.manifest.eligibleEvents.map(event => event.eventId);
  const events = await queryable.query<RetentionCandidateRow>(candidateSql(true), [
    plan.workspaceKey, plan.tenantKey, plan.environment, String(plan.throughSequence), ids,
  ]);
  if (events.rows.length !== ids.length) throw new Error('retention plan source events changed or are missing');
  for (let index = 0; index < events.rows.length; index += 1) {
    const current = events.rows[index]!;
    const expected = plan.manifest.eligibleEvents[index]!;
    if (current.event_id !== expected.eventId || Number(current.sequence) !== expected.sequence || current.event_hash !== expected.eventHash) {
      throw new Error('retention plan source event binding is invalid');
    }
    if (current.effective_legal_hold) throw new Error(`retention plan is blocked by a legal hold at sequence ${expected.sequence}`);
    if (current.effective_retention_until == null || Date.parse(iso(current.effective_retention_until, 'effectiveRetentionUntil')) > evaluatedAt.getTime()) {
      throw new Error(`retention plan event is no longer due at sequence ${expected.sequence}`);
    }
  }
  return events.rows;
}

export async function decideAuditRetentionPlan(
  pool: pg.Pool,
  context: RetentionLifecycleContext,
  planIdInput: string,
  decision: 'approved' | 'rejected',
  justificationInput: string,
): Promise<{ plan: AuditRetentionPlan; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  validateHumanAssurance(context);
  const scope = scopeOf(context.scope);
  const planId = uuid(planIdInput, 'planId');
  const producerEventId = text(context.producerEventId, 'producerEventId', 256);
  const justification = typeof justificationInput === 'string' ? justificationInput.trim() : '';
  if (!justification || justification.length > 4096) throw new Error('justification must contain 1 to 4096 characters');
  const occurredAtDate = (context.now ?? (() => new Date()))();
  const occurredAt = occurredAtDate.toISOString();
  const actionId = uuid((context.uuid ?? randomUUID)(), 'actionId');
  const outcome = await executeCanonicalAuditedMutation(
    pool, { name: 'audit.retention.plan-decision', eventId: producerEventId }, scope,
    async client => {
      const loaded = await client.query<PlanRow>(
        `SELECT * FROM mcp_canonical_audit_retention_plans WHERE plan_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 FOR UPDATE`,
        [planId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      const row = loaded.rows[0];
      if (!row) throw new Error('retention plan was not found in the authorized scope');
      const plan = mapAuditRetentionPlanRow({ ...row, lifecycle_status: 'planned' });
      if (plan.requestedById === context.actor.id) throw new Error('four-eyes policy forbids the requester from deciding this retention plan');
      if (decision === 'approved') {
        if (plan.eligiblePrefixCount === 0) throw new Error('an empty retention plan cannot be approved');
        await revalidateAuditRetentionPlanSources(client, plan, occurredAtDate);
      }
      await client.query(
        `INSERT INTO mcp_canonical_audit_retention_plan_actions
          (action_id,plan_id,action,actor_id,actor_sso_subject,mfa_verified_at,mfa_method,justification_sha256,anchor_id,producer_event_id,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9,$10)`,
        [actionId, planId, decision, context.actor.id, context.actor.ssoSubject, iso(context.mfaVerifiedAt, 'mfaVerifiedAt'),
          context.mfaMethod, createHash('sha256').update(justification, 'utf8').digest('hex'), producerEventId, occurredAt],
      );
      return { ...plan, status: decision };
    },
    plan => ({
      occurredAt, ...scope, solution: 'argus.core', actor: context.actor,
      action: `audit.retention_plan.${decision}`, outcome: 'success', risk: 'critical',
      resource: { type: 'audit_retention_plan', id: plan.planId, revision: plan.manifestSha256 },
      policy: { id: 'argus.audit.retention-lifecycle', version: '1', decision },
      payload: { after: { decision, manifestSha256: plan.manifestSha256, eligiblePrefixCount: plan.eligiblePrefixCount, nextRequiredAction: decision === 'approved' ? 'archive_and_external_anchor' : 'none' } },
      retentionClass: 'business-audit-governance', legalHold: true,
    }), { now: () => occurredAtDate },
  );
  let plan: AuditRetentionPlan | null = outcome.result;
  if (!plan) {
    const replay = await pool.query<PlanRow>(
      `SELECT plan.*,action.action AS lifecycle_status FROM mcp_canonical_audit_retention_plans plan
         JOIN mcp_canonical_audit_retention_plan_actions action ON action.plan_id=plan.plan_id
        WHERE plan.plan_id=$1 AND action.producer_event_id=$2`, [planId, producerEventId],
    );
    plan = replay.rows[0] ? mapAuditRetentionPlanRow(replay.rows[0]) : null;
  }
  if (!plan) throw new Error('retention decision replay could not resolve its immutable plan');
  return { plan, replayed: outcome.replayed, auditEvent: outcome.event };
}
