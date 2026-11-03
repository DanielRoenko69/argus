import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableAuditJson } from './canonicalAuditRedaction.js';
import { executeCanonicalAuditedMutation } from './canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from './canonicalAuditTypes.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AuditRetentionPolicy {
  policyId: string;
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  retentionClass: string;
  version: number;
  durationDays: number | null;
  region: string;
  effectiveFrom: string;
  createdAt: string;
  createdBy: string;
  policyDigest: string;
}

export interface AuditLegalHoldAction {
  holdActionId: string;
  holdId: string;
  action: 'placed' | 'released';
  workspaceKey: string;
  tenantKey: string;
  environment: string;
  fromSequence: number;
  throughSequence: number | null;
  resourceType: string | null;
  resourceId: string | null;
  justificationDigest: string;
  actorId: string;
  occurredAt: string;
  producerEventId: string;
}

export interface AuditGovernanceMutationContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  now?: () => Date;
  uuid?: () => string;
}

type RetentionPolicyRow = {
  policy_id: string; workspace_key: string; tenant_key: string; environment: string;
  retention_class: string; version: number | string; duration_days: number | string | null;
  region: string; effective_from: string | Date; created_at: string | Date; created_by: string;
  policy_digest: string;
};

type LegalHoldRow = {
  hold_action_id: string; hold_id: string; action: 'placed' | 'released'; workspace_key: string;
  tenant_key: string; environment: string; from_sequence: number | string;
  through_sequence: number | string | null; resource_type: string | null; resource_id: string | null;
  justification_digest: string; actor_id: string; occurred_at: string | Date; producer_event_id: string;
};

function identifier(value: unknown, name: string, max: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max || !IDENTIFIER.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function optionalIdentifier(value: unknown, name: string, max: number): string | null {
  if (value == null || value === '') return null;
  return identifier(value, name, max);
}

function uuid(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID.test(normalized)) throw new Error(`${name} must be a UUID`);
  return normalized;
}

function date(value: string | Date | undefined, name: string, fallback: Date): string {
  const parsed = value == null ? fallback : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${name} is invalid`);
  return parsed.toISOString();
}

function digestText(value: unknown, name: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 4096) throw new Error(`${name} must contain 1 to 4096 characters`);
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function normalizedScope(scope: CanonicalAuditScope): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(scope.environment, 'environment', 64),
  };
}

function mapPolicy(row: RetentionPolicyRow): AuditRetentionPolicy {
  return {
    policyId: row.policy_id, workspaceKey: row.workspace_key, tenantKey: row.tenant_key,
    environment: row.environment, retentionClass: row.retention_class, version: Number(row.version),
    durationDays: row.duration_days == null ? null : Number(row.duration_days), region: row.region,
    effectiveFrom: new Date(row.effective_from).toISOString(), createdAt: new Date(row.created_at).toISOString(),
    createdBy: row.created_by, policyDigest: row.policy_digest,
  };
}

function mapHold(row: LegalHoldRow): AuditLegalHoldAction {
  return {
    holdActionId: row.hold_action_id, holdId: row.hold_id, action: row.action,
    workspaceKey: row.workspace_key, tenantKey: row.tenant_key, environment: row.environment,
    fromSequence: Number(row.from_sequence),
    throughSequence: row.through_sequence == null ? null : Number(row.through_sequence),
    resourceType: row.resource_type, resourceId: row.resource_id,
    justificationDigest: row.justification_digest, actorId: row.actor_id,
    occurredAt: new Date(row.occurred_at).toISOString(), producerEventId: row.producer_event_id,
  };
}

export async function createAuditRetentionPolicy(
  pool: pg.Pool,
  context: AuditGovernanceMutationContext,
  input: {
    retentionClass: string;
    durationDays: number | null;
    region: string;
    effectiveFrom?: string | Date;
  },
): Promise<{ policy: AuditRetentionPolicy; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const scope = normalizedScope(context.scope);
  const retentionClass = identifier(input.retentionClass, 'retentionClass', 64);
  const region = identifier(input.region, 'region', 64);
  if (input.durationDays != null
    && (!Number.isSafeInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 36500)) {
    throw new Error('durationDays must be null or an integer between 1 and 36500');
  }
  const now = (context.now ?? (() => new Date()))();
  const createdAt = date(undefined, 'createdAt', now);
  const effectiveFrom = date(input.effectiveFrom, 'effectiveFrom', now);
  const policyId = uuid((context.uuid ?? randomUUID)(), 'policyId');
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const result = await executeCanonicalAuditedMutation(
    pool,
    { name: 'audit.retention.policy', eventId: producerEventId },
    scope,
    async client => {
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [stableAuditJson([
          'audit-retention-policy', scope.workspaceKey, scope.tenantKey, scope.environment, retentionClass,
        ])],
      );
      const versionResult = await client.query<{ version: number | string }>(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM mcp_canonical_audit_retention_policies
          WHERE workspace_key=$1 AND tenant_key=$2 AND environment=$3 AND retention_class=$4
          `,
        [scope.workspaceKey, scope.tenantKey, scope.environment, retentionClass],
      );
      const version = Number(versionResult.rows[0]?.version ?? 1);
      const policyDigest = createHash('sha256').update(stableAuditJson({
        schemaVersion: 1, ...scope, retentionClass, version: String(version),
        durationDays: input.durationDays, region, effectiveFrom,
      })).digest('hex');
      const inserted = await client.query<RetentionPolicyRow>(
        `INSERT INTO mcp_canonical_audit_retention_policies
           (policy_id, workspace_key, tenant_key, environment, retention_class, version,
            duration_days, region, effective_from, created_at, created_by, policy_digest)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [policyId, scope.workspaceKey, scope.tenantKey, scope.environment, retentionClass, version,
          input.durationDays, region, effectiveFrom, createdAt, context.actor.id, policyDigest],
      );
      if (!inserted.rows[0]) throw new Error('audit retention policy insert returned no row');
      return mapPolicy(inserted.rows[0]);
    },
    policy => ({
      occurredAt: createdAt, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.retention_policy.version_created', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_retention_policy', id: policy.policyId, revision: String(policy.version) },
      policy: { id: 'argus.audit.retention', version: '1', decision: 'configured' },
      payload: { after: {
        retentionClass: policy.retentionClass, durationDays: policy.durationDays,
        region: policy.region, effectiveFrom: policy.effectiveFrom, policyDigest: policy.policyDigest,
      } },
      retentionClass: 'business-audit-governance',
    }),
    { now: () => now },
  );
  if (result.result) return { policy: result.result, replayed: false, auditEvent: result.event };
  const replay = await pool.query<RetentionPolicyRow>(
    `SELECT * FROM mcp_canonical_audit_retention_policies WHERE policy_id=$1`,
    [result.event.resource.id],
  );
  if (!replay.rows[0]) throw new Error('replayed audit retention policy is missing');
  return { policy: mapPolicy(replay.rows[0]), replayed: true, auditEvent: result.event };
}

export async function placeAuditLegalHold(
  pool: pg.Pool,
  context: AuditGovernanceMutationContext,
  input: {
    holdId?: string;
    fromSequence?: number;
    throughSequence?: number | null;
    resourceType?: string | null;
    resourceId?: string | null;
    justification: string;
  },
): Promise<{ hold: AuditLegalHoldAction; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const scope = normalizedScope(context.scope);
  const fromSequence = input.fromSequence ?? 1;
  const throughSequence = input.throughSequence ?? null;
  if (!Number.isSafeInteger(fromSequence) || fromSequence < 1) throw new Error('fromSequence must be a positive integer');
  if (throughSequence != null
    && (!Number.isSafeInteger(throughSequence) || throughSequence < fromSequence)) {
    throw new Error('throughSequence must be null or at least fromSequence');
  }
  const resourceType = optionalIdentifier(input.resourceType, 'resourceType', 64);
  const resourceId = optionalIdentifier(input.resourceId, 'resourceId', 256);
  if ((resourceType == null) !== (resourceId == null)) throw new Error('resourceType and resourceId must be provided together');
  const holdId = uuid(input.holdId ?? (context.uuid ?? randomUUID)(), 'holdId');
  const holdActionId = uuid((context.uuid ?? randomUUID)(), 'holdActionId');
  const justificationDigest = digestText(input.justification, 'justification');
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const now = (context.now ?? (() => new Date()))();
  const occurredAt = date(undefined, 'occurredAt', now);
  const result = await executeCanonicalAuditedMutation(
    pool,
    { name: 'audit.legal_hold.place', eventId: producerEventId },
    scope,
    async client => {
      const inserted = await client.query<LegalHoldRow>(
        `INSERT INTO mcp_canonical_audit_legal_hold_actions
           (hold_action_id, hold_id, action, workspace_key, tenant_key, environment,
            from_sequence, through_sequence, resource_type, resource_id,
            justification_digest, actor_id, occurred_at, producer_event_id)
         VALUES ($1,$2,'placed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [holdActionId, holdId, scope.workspaceKey, scope.tenantKey, scope.environment,
          fromSequence, throughSequence, resourceType, resourceId, justificationDigest,
          context.actor.id, occurredAt, producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('audit legal hold insert returned no row');
      return mapHold(inserted.rows[0]);
    },
    hold => ({
      occurredAt, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.legal_hold.placed', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_legal_hold', id: hold.holdId, revision: hold.holdActionId },
      policy: { id: 'argus.audit.legal-hold', version: '1', decision: 'hold' },
      payload: { after: {
        fromSequence: hold.fromSequence, throughSequence: hold.throughSequence,
        resourceType: hold.resourceType, resourceId: hold.resourceId,
        justificationDigest: hold.justificationDigest,
      } },
      retentionClass: 'business-audit-legal-hold', legalHold: true,
    }),
    { now: () => now },
  );
  if (result.result) return { hold: result.result, replayed: false, auditEvent: result.event };
  const replay = await pool.query<LegalHoldRow>(
    `SELECT * FROM mcp_canonical_audit_legal_hold_actions WHERE hold_action_id=$1`,
    [result.event.resource.revision],
  );
  if (!replay.rows[0]) throw new Error('replayed audit legal hold is missing');
  return { hold: mapHold(replay.rows[0]), replayed: true, auditEvent: result.event };
}

export async function releaseAuditLegalHold(
  pool: pg.Pool,
  context: AuditGovernanceMutationContext,
  input: { holdId: string; justification: string },
): Promise<{ hold: AuditLegalHoldAction; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const scope = normalizedScope(context.scope);
  const holdId = uuid(input.holdId, 'holdId');
  const holdActionId = uuid((context.uuid ?? randomUUID)(), 'holdActionId');
  const justificationDigest = digestText(input.justification, 'justification');
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const now = (context.now ?? (() => new Date()))();
  const occurredAt = date(undefined, 'occurredAt', now);
  const result = await executeCanonicalAuditedMutation(
    pool,
    { name: 'audit.legal_hold.release', eventId: producerEventId },
    scope,
    async client => {
      const placedResult = await client.query<LegalHoldRow>(
        `SELECT * FROM mcp_canonical_audit_legal_hold_actions
          WHERE hold_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 AND action='placed'
          FOR UPDATE`,
        [holdId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      const placed = placedResult.rows[0];
      if (!placed) throw new Error('audit legal hold was not found in the authorized scope');
      const released = await client.query(
        `SELECT 1 FROM mcp_canonical_audit_legal_hold_actions
          WHERE hold_id=$1 AND workspace_key=$2 AND tenant_key=$3 AND environment=$4 AND action='released'`,
        [holdId, scope.workspaceKey, scope.tenantKey, scope.environment],
      );
      if (released.rows[0]) throw new Error('audit legal hold is already released');
      const inserted = await client.query<LegalHoldRow>(
        `INSERT INTO mcp_canonical_audit_legal_hold_actions
           (hold_action_id, hold_id, action, workspace_key, tenant_key, environment,
            from_sequence, through_sequence, resource_type, resource_id,
            justification_digest, actor_id, occurred_at, producer_event_id)
         VALUES ($1,$2,'released',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [holdActionId, holdId, scope.workspaceKey, scope.tenantKey, scope.environment,
          placed.from_sequence, placed.through_sequence, placed.resource_type, placed.resource_id,
          justificationDigest, context.actor.id, occurredAt, producerEventId],
      );
      if (!inserted.rows[0]) throw new Error('audit legal hold release returned no row');
      return mapHold(inserted.rows[0]);
    },
    hold => ({
      occurredAt, ...scope, solution: 'argus.core', actor: context.actor,
      action: 'audit.legal_hold.released', outcome: 'success', risk: 'critical',
      resource: { type: 'audit_legal_hold', id: hold.holdId, revision: hold.holdActionId },
      policy: { id: 'argus.audit.legal-hold', version: '1', decision: 'released' },
      payload: { after: {
        fromSequence: hold.fromSequence, throughSequence: hold.throughSequence,
        resourceType: hold.resourceType, resourceId: hold.resourceId,
        justificationDigest: hold.justificationDigest,
      } },
      retentionClass: 'business-audit-governance',
    }),
    { now: () => now },
  );
  if (result.result) return { hold: result.result, replayed: false, auditEvent: result.event };
  const replay = await pool.query<LegalHoldRow>(
    `SELECT * FROM mcp_canonical_audit_legal_hold_actions WHERE hold_action_id=$1`,
    [result.event.resource.revision],
  );
  if (!replay.rows[0]) throw new Error('replayed audit legal hold release is missing');
  return { hold: mapHold(replay.rows[0]), replayed: true, auditEvent: result.event };
}
