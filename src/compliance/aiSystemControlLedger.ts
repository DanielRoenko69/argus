import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from '../audit/canonicalAuditTypes.js';
import { aiActSystemRevisionSchema, type AiActControlCatalog, type AiActSystemRevision } from './aiActContracts.js';
import { AI_ACT_CONTROL_CATALOG, findAiActControl } from './aiActControlCatalog.js';
import { AiSystemRegistryError } from './aiSystemRegistry.js';

const bounded = (maximum: number) => z.string().trim().min(1).max(maximum);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
const evidenceSchema = z.object({
  evidenceType: z.enum(['canonical_event', 'report', 'evidence_pack']),
  evidenceId: bounded(240),
  sha256,
  href: z.string().trim().url().max(1_000).optional(),
}).strict();

export const aiSystemControlAssessmentInputSchema = z.object({
  expectedRevision: z.number().int().positive(),
  expectedRevisionSha256: sha256,
  status: z.enum(['not_assessed', 'in_progress', 'satisfied', 'exception', 'not_applicable']),
  ownerParty: z.enum(['argus_platform', 'provider', 'deployer', 'external_assessor']),
  ownerId: bounded(200),
  dueAt: timestamp.nullable(),
  reassessmentAt: timestamp.nullable(),
  rationale: bounded(2_000),
  evidence: z.array(evidenceSchema).max(128),
  exception: z.object({
    rationale: bounded(2_000),
    compensatingControls: z.array(bounded(500)).min(1).max(32),
    expiresAt: timestamp,
  }).strict().nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === 'satisfied' && value.evidence.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'satisfied controls require verified content-addressed evidence' });
  }
  if ((value.status === 'exception') !== (value.exception !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['exception'], message: 'exception details are required only for exception status' });
  }
  const evidenceKeys = value.evidence.map(item => `${item.evidenceType}\0${item.evidenceId}\0${item.sha256}`);
  if (new Set(evidenceKeys).size !== evidenceKeys.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['evidence'], message: 'evidence references must be unique' });
  }
});

export type AiSystemControlAssessmentInput = z.infer<typeof aiSystemControlAssessmentInputSchema>;
export type AiSystemControlStatus = AiSystemControlAssessmentInput['status'];

export interface AiSystemControlAssessment {
  schemaVersion: 1;
  kind: 'ai-system-control-assessment';
  assessmentId: string;
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  catalogId: string;
  catalogVersion: number;
  catalogSha256: string;
  controlId: string;
  sequence: number;
  status: AiSystemControlStatus;
  ownerParty: AiSystemControlAssessmentInput['ownerParty'];
  ownerId: string;
  dueAt: string | null;
  reassessmentAt: string | null;
  rationale: string;
  evidence: AiSystemControlAssessmentInput['evidence'];
  exception: (NonNullable<AiSystemControlAssessmentInput['exception']> & {
    approvedBy: { actorType: 'user'; actorId: string };
    approvedAt: string;
  }) | null;
  assessedBy: { actorType: 'user'; actorId: string };
  assessedAt: string;
  assessmentSha256: string;
}

export interface AiSystemControlProjection {
  definition: AiActControlCatalog['controls'][number];
  applicable: boolean;
  assessment: AiSystemControlAssessment | null;
  effectiveStatus: AiSystemControlStatus;
  expired: boolean;
  releaseBlocking: boolean;
  issues: string[];
}

export interface AiSystemControlLedger {
  schemaVersion: 1;
  kind: 'ai-system-control-ledger';
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  assessmentSourceRevision: {
    revisionId: string;
    revision: number;
    revisionSha256: string;
    relation: 'current_revision' | 'release_source';
  };
  generatedAt: string;
  catalog: AiActControlCatalog;
  coverage: { applicable: number; satisfied: number; open: number; exceptions: number; expired: number };
  releaseReady: boolean;
  blockingReasons: string[];
  controls: AiSystemControlProjection[];
  claimBoundary: string;
}

export interface AiSystemControlContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  mfaVerifiedAt: string;
  mfaMethod: string;
  mfaMaxAgeSeconds: number;
  now?: () => Date;
  uuid?: () => string;
}

export interface AiSystemControlMutationResult {
  ledger: AiSystemControlLedger;
  assessment: AiSystemControlAssessment;
  replayed: boolean;
  auditEvent: CanonicalAuditEventSummary;
}

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
type RevisionRow = { revision_json: unknown };
type ReleaseSourceRevisionRow = { source_revision_json: unknown };
type AssessmentRow = { assessment_json: unknown };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function identifier(value: unknown, name: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || !IDENTIFIER.test(normalized)) throw new AiSystemRegistryError(`${name} is invalid`);
  return normalized;
}

function scope(context: Pick<AiSystemControlContext, 'scope'>): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function digest(value: unknown): string {
  return createHash('sha256').update(stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue), 'utf8').digest('hex');
}

function nextUuid(context: AiSystemControlContext, name: string): string {
  const value = (context.uuid ?? randomUUID)();
  if (!UUID.test(value)) throw new AiSystemRegistryError(`${name} must be a UUID`);
  return value;
}

function actor(context: AiSystemControlContext): { actorType: 'user'; actorId: string } {
  if (context.actor.type !== 'human' || context.actor.authMethod !== 'oidc' || !context.actor.ssoSubject) {
    throw new AiSystemRegistryError('Control decisions require a verified OIDC/Entra identity', 403, 'AI_CONTROL_SSO_REQUIRED');
  }
  return { actorType: 'user', actorId: identifier(context.actor.id, 'actor.id', 200) };
}

function assertFreshMfa(context: AiSystemControlContext, now: Date): void {
  const verifiedAt = Date.parse(context.mfaVerifiedAt);
  if (!Number.isFinite(verifiedAt) || !context.mfaMethod.trim() || verifiedAt > now.getTime() + 30_000
    || now.getTime() - verifiedAt > context.mfaMaxAgeSeconds * 1_000) {
    throw new AiSystemRegistryError('Control decisions require fresh MFA verification', 403, 'AI_CONTROL_MFA_REQUIRED');
  }
}

function assertCatalog(revision: AiActSystemRevision): void {
  const actual = revision.controlCatalog;
  if (actual.catalogId !== AI_ACT_CONTROL_CATALOG.catalogId
    || actual.catalogVersion !== AI_ACT_CONTROL_CATALOG.catalogVersion
    || actual.catalogSha256 !== AI_ACT_CONTROL_CATALOG.catalogSha256) {
    throw new AiSystemRegistryError('AI-system revision is not pinned to the active server-owned control catalog', 409, 'AI_CONTROL_CATALOG_UNSUPPORTED');
  }
}

async function loadRevision(queryable: Queryable, authorized: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>, aiSystemId: string, lock = false): Promise<AiActSystemRevision> {
  const result = await queryable.query<RevisionRow>(
    `SELECT revision.revision_json
       FROM mcp_ai_systems system
       JOIN mcp_ai_system_revisions revision
         ON revision.ai_system_id=system.id AND revision.revision=system.current_revision
      WHERE system.id=$1 AND system.workspace_key=$2 AND system.tenant_key=$3
      ${lock ? 'FOR UPDATE OF system' : ''}`,
    [aiSystemId, authorized.workspaceKey, authorized.tenantKey],
  );
  if (!result.rows[0]) throw new AiSystemRegistryError('AI system was not found in the authorized scope', 404, 'AI_SYSTEM_NOT_FOUND');
  return aiActSystemRevisionSchema.parse(result.rows[0].revision_json);
}

function isApplicable(definition: AiActControlCatalog['controls'][number], revision: AiActSystemRevision): boolean {
  return definition.applicability !== 'high_risk' || revision.classification.classification === 'high_risk';
}

function projection(definition: AiActControlCatalog['controls'][number], revision: AiActSystemRevision, assessment: AiSystemControlAssessment | null, now: Date): AiSystemControlProjection {
  const applicable = isApplicable(definition, revision);
  if (!applicable) return { definition, applicable: false, assessment, effectiveStatus: 'not_applicable', expired: false, releaseBlocking: false, issues: [] };
  const effectiveStatus = assessment?.status ?? 'not_assessed';
  const expiry = assessment?.status === 'exception' ? assessment.exception?.expiresAt : assessment?.reassessmentAt;
  const expired = Boolean(expiry && Date.parse(expiry) <= now.getTime());
  const issues: string[] = [];
  if (!assessment) issues.push('No implementation or evidence decision has been recorded for this revision.');
  if (effectiveStatus === 'in_progress') issues.push('Control implementation is still in progress.');
  if (effectiveStatus === 'not_assessed') issues.push('Control applicability and evidence have not been assessed.');
  if (effectiveStatus === 'not_applicable') issues.push('This conditional control was marked not applicable; the rationale remains reviewable.');
  if (effectiveStatus === 'exception') issues.push(definition.blocksProduction ? 'A recorded exception cannot bypass this production-blocking control.' : 'A time-bounded exception is active.');
  if (expired) issues.push('The evidence, reassessment or exception deadline has expired.');
  const releaseBlocking = definition.blocksProduction && (effectiveStatus !== 'satisfied' || expired);
  return { definition, applicable, assessment, effectiveStatus, expired, releaseBlocking, issues };
}

async function latestAssessments(queryable: Queryable, revision: AiActSystemRevision): Promise<Map<string, AiSystemControlAssessment>> {
  const result = await queryable.query<AssessmentRow>(
    `SELECT DISTINCT ON (control_id) assessment_json
       FROM mcp_ai_system_control_assessments
      WHERE ai_system_id=$1 AND revision=$2
      ORDER BY control_id, sequence DESC`,
    [revision.aiSystemId, revision.revision],
  );
  const values = result.rows.map(row => row.assessment_json as AiSystemControlAssessment);
  return new Map(values.map(value => [value.controlId, value]));
}

async function resolveAssessmentSourceRevision(
  queryable: Queryable,
  revision: AiActSystemRevision,
): Promise<{ revision: AiActSystemRevision; relation: 'current_revision' | 'release_source' }> {
  if (revision.lifecycleState !== 'released') return { revision, relation: 'current_revision' };
  const result = await queryable.query<ReleaseSourceRevisionRow>(
    `SELECT source.revision_json AS source_revision_json
       FROM mcp_ai_system_governance_decisions decision
       JOIN mcp_ai_system_revisions source
         ON source.ai_system_id=decision.ai_system_id AND source.revision=decision.source_revision
      WHERE decision.ai_system_id=$1 AND decision.action='release' AND decision.result_revision=$2
      ORDER BY decision.created_at DESC
      LIMIT 1`,
    [revision.aiSystemId, revision.revision],
  );
  if (!result.rows[0]) {
    throw new AiSystemRegistryError(
      'Released revision has no immutable control-assessment source',
      422,
      'AI_CONTROL_RELEASE_SOURCE_MISSING',
    );
  }
  const source = aiActSystemRevisionSchema.parse(result.rows[0].source_revision_json);
  if (source.aiSystemId !== revision.aiSystemId || source.revision >= revision.revision) {
    throw new AiSystemRegistryError('Released revision control-assessment source is invalid', 422, 'AI_CONTROL_RELEASE_SOURCE_INVALID');
  }
  assertCatalog(source);
  return { revision: source, relation: 'release_source' };
}

export async function getAiSystemControlLedger(queryable: Queryable, authorized: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>, aiSystemId: string, options: { now?: Date; revision?: AiActSystemRevision } = {}): Promise<AiSystemControlLedger> {
  const revision = options.revision ?? await loadRevision(queryable, authorized, aiSystemId);
  assertCatalog(revision);
  const now = options.now ?? new Date();
  const assessmentSource = await resolveAssessmentSourceRevision(queryable, revision);
  const assessments = await latestAssessments(queryable, assessmentSource.revision);
  const controls = AI_ACT_CONTROL_CATALOG.controls.map(definition => projection(definition, revision, assessments.get(definition.controlId) ?? null, now));
  const applicable = controls.filter(control => control.applicable);
  const expired = applicable.filter(control => control.expired).length;
  const satisfied = applicable.filter(control => control.effectiveStatus === 'satisfied' && !control.expired).length;
  const exceptions = applicable.filter(control => control.effectiveStatus === 'exception' && !control.expired).length;
  const open = applicable.length - satisfied - exceptions - expired;
  const blockingReasons = controls.filter(control => control.releaseBlocking).map(control => `${control.definition.controlId}: ${control.issues[0] ?? 'production-blocking evidence is not satisfied'}`);
  return {
    schemaVersion: 1, kind: 'ai-system-control-ledger', aiSystemId: revision.aiSystemId,
    revisionId: revision.revisionId, revision: revision.revision, revisionSha256: revision.revisionSha256,
    assessmentSourceRevision: {
      revisionId: assessmentSource.revision.revisionId,
      revision: assessmentSource.revision.revision,
      revisionSha256: assessmentSource.revision.revisionSha256,
      relation: assessmentSource.relation,
    },
    generatedAt: now.toISOString(), catalog: AI_ACT_CONTROL_CATALOG,
    coverage: { applicable: applicable.length, satisfied, open, exceptions, expired },
    releaseReady: blockingReasons.length === 0, blockingReasons, controls,
    claimBoundary: AI_ACT_CONTROL_CATALOG.claimBoundary,
  };
}

async function verifyEvidence(client: pg.PoolClient, authorized: Required<CanonicalAuditScope>, evidence: AiSystemControlAssessmentInput['evidence']): Promise<void> {
  for (const ref of evidence) {
    if (ref.evidenceType === 'canonical_event') {
      const found = await client.query(
        `SELECT 1 FROM mcp_canonical_audit_events WHERE event_id::text=$1 AND event_hash=$2 AND workspace_key=$3 AND tenant_key=$4 AND environment=$5`,
        [ref.evidenceId, ref.sha256, authorized.workspaceKey, authorized.tenantKey, authorized.environment],
      );
      if (!found.rows[0]) throw new AiSystemRegistryError('Control evidence could not be verified', 422, 'AI_CONTROL_EVIDENCE_UNVERIFIED');
      continue;
    }
    const selector = ref.evidenceType === 'report' ? 'id' : 'pack_id';
    const found = await client.query(
      `SELECT 1 FROM mcp_audit_report_runs WHERE ${selector}::text=$1 AND pack_digest=$2 AND status='completed' AND verification_state='valid' AND workspace_key=$3 AND tenant_key=$4 AND environment=$5`,
      [ref.evidenceId, ref.sha256, authorized.workspaceKey, authorized.tenantKey, authorized.environment],
    );
    if (!found.rows[0]) throw new AiSystemRegistryError('Control evidence could not be verified', 422, 'AI_CONTROL_EVIDENCE_UNVERIFIED');
  }
}

export async function recordAiSystemControlAssessment(
  pool: pg.Pool,
  context: AiSystemControlContext,
  aiSystemId: string,
  controlId: string,
  rawInput: AiSystemControlAssessmentInput,
): Promise<AiSystemControlMutationResult> {
  const input = aiSystemControlAssessmentInputSchema.parse(rawInput);
  const authorized = scope(context);
  const now = (context.now ?? (() => new Date()))();
  const assessedBy = actor(context);
  assertFreshMfa(context, now);
  const definition = findAiActControl(controlId);
  if (!definition) throw new AiSystemRegistryError('Control is not part of the active catalog', 404, 'AI_CONTROL_NOT_FOUND');
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const outcome = await executeCanonicalAuditedMutation<{ revision: AiActSystemRevision; assessment: AiSystemControlAssessment }>(
    pool,
    { name: 'compliance.ai-system.control-assessment', eventId: producerEventId },
    authorized,
    async client => {
      const revision = await loadRevision(client, authorized, aiSystemId, true);
      assertCatalog(revision);
      if (revision.revision !== input.expectedRevision || revision.revisionSha256 !== input.expectedRevisionSha256) {
        throw new AiSystemRegistryError('AI-system revision or digest changed', 409, 'AI_SYSTEM_REVISION_CONFLICT');
      }
      if (revision.lifecycleState === 'released' || revision.lifecycleState === 'retired') {
        throw new AiSystemRegistryError('Released or retired revisions cannot receive new control decisions', 409, 'AI_SYSTEM_LIFECYCLE_CONFLICT');
      }
      const applicable = isApplicable(definition, revision);
      if (!applicable && input.status !== 'not_applicable') throw new AiSystemRegistryError('This high-risk control is not applicable to the current classification', 409, 'AI_CONTROL_NOT_APPLICABLE');
      if (definition.applicability === 'always' && input.status === 'not_applicable') throw new AiSystemRegistryError('Always-applicable controls cannot be marked not applicable', 409, 'AI_CONTROL_APPLICABILITY_REQUIRED');
      if (input.status === 'exception') {
        if (input.ownerId === assessedBy.actorId) throw new AiSystemRegistryError('Four-eyes policy forbids the control owner from approving their own exception', 403, 'AI_CONTROL_FOUR_EYES_REQUIRED');
        if (Date.parse(input.exception!.expiresAt) <= now.getTime()) throw new AiSystemRegistryError('Control exceptions must expire in the future', 409, 'AI_CONTROL_EXCEPTION_EXPIRED');
      }
      if (input.status === 'satisfied') await verifyEvidence(client, authorized, input.evidence);
      const sequenceResult = await client.query<{ next_sequence: number | string }>(
        `SELECT coalesce(max(sequence),0)+1 AS next_sequence FROM mcp_ai_system_control_assessments WHERE ai_system_id=$1 AND revision=$2 AND control_id=$3`,
        [aiSystemId, revision.revision, controlId],
      );
      const sequence = Number(sequenceResult.rows[0]?.next_sequence ?? 1);
      const assessedAt = now.toISOString();
      const withoutDigest = {
        schemaVersion: 1 as const, kind: 'ai-system-control-assessment' as const,
        assessmentId: nextUuid(context, 'assessmentId'), aiSystemId, revisionId: revision.revisionId,
        revision: revision.revision, revisionSha256: revision.revisionSha256,
        catalogId: AI_ACT_CONTROL_CATALOG.catalogId, catalogVersion: AI_ACT_CONTROL_CATALOG.catalogVersion,
        catalogSha256: AI_ACT_CONTROL_CATALOG.catalogSha256, controlId, sequence,
        status: input.status, ownerParty: input.ownerParty, ownerId: input.ownerId,
        dueAt: input.dueAt, reassessmentAt: input.reassessmentAt, rationale: input.rationale,
        evidence: input.evidence,
        exception: input.exception ? { ...input.exception, approvedBy: assessedBy, approvedAt: assessedAt } : null,
        assessedBy, assessedAt,
      };
      const assessment: AiSystemControlAssessment = { ...withoutDigest, assessmentSha256: digest(withoutDigest) };
      await client.query(
        `INSERT INTO mcp_ai_system_control_assessments
          (assessment_id,ai_system_id,revision,control_id,sequence,catalog_id,catalog_version,catalog_sha256,status,owner_party,owner_id,due_at,reassessment_at,evidence_json,exception_json,assessment_sha256,assessment_json,assessed_by_id,actor_sso_subject,mfa_verified_at,mfa_method,producer_event_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb,$16,$17::jsonb,$18,$19,$20,$21,$22,$23)`,
        [assessment.assessmentId, aiSystemId, revision.revision, controlId, sequence,
          assessment.catalogId, assessment.catalogVersion, assessment.catalogSha256, assessment.status,
          assessment.ownerParty, assessment.ownerId, assessment.dueAt, assessment.reassessmentAt,
          JSON.stringify(assessment.evidence), JSON.stringify(assessment.exception), assessment.assessmentSha256,
          JSON.stringify(assessment), assessedBy.actorId, context.actor.ssoSubject, context.mfaVerifiedAt,
          context.mfaMethod.trim(), producerEventId, assessedAt],
      );
      return { revision, assessment };
    },
    result => ({
      occurredAt: now, ...authorized, solution: 'argus.core', actor: context.actor,
      action: 'compliance.ai_system.control_assessed', outcome: 'success', risk: result.assessment.status === 'exception' ? 'critical' : 'high',
      resource: { type: 'ai_system_control', id: `${aiSystemId}:${controlId}`, revision: `${result.revision.revision}.${result.assessment.sequence}` },
      policy: { id: 'argus.ai-act.control-ledger', version: String(AI_ACT_CONTROL_CATALOG.catalogVersion), decision: result.assessment.status },
      approvalId: result.assessment.assessmentId,
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: { after: { controlId, assessmentSha256: result.assessment.assessmentSha256, evidenceCount: result.assessment.evidence.length, ownerParty: result.assessment.ownerParty, dueAt: result.assessment.dueAt, reassessmentAt: result.assessment.reassessmentAt } },
      retentionClass: 'business-audit-ai-system',
    }),
    { now: () => now },
  );
  const ledger = await getAiSystemControlLedger(pool, authorized, aiSystemId, { now });
  const assessment = outcome.result?.assessment ?? ledger.controls.find(control => control.definition.controlId === controlId)?.assessment;
  if (!assessment) throw new AiSystemRegistryError('Replayed control assessment could not be resolved', 409, 'AI_CONTROL_REPLAY_STATE_MISSING');
  return { ledger, assessment, replayed: outcome.replayed, auditEvent: outcome.event };
}

export async function assertAiSystemReleaseControls(
  client: pg.PoolClient,
  authorized: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  revision: AiActSystemRevision,
  now: Date,
): Promise<AiSystemControlLedger> {
  const ledger = await getAiSystemControlLedger(client, authorized, revision.aiSystemId, { revision, now });
  if (!ledger.releaseReady) {
    throw new AiSystemRegistryError(`Production-blocking AI Act controls are incomplete: ${ledger.blockingReasons.slice(0, 4).join('; ')}`, 409, 'AI_SYSTEM_CONTROLS_INCOMPLETE');
  }
  return ledger;
}
