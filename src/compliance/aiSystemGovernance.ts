import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary, CanonicalAuditScope } from '../audit/canonicalAuditTypes.js';
import {
  aiActSystemRevisionSchema,
  type AiActClassificationDecisionInput,
  type AiActReleaseDecisionInput,
  type AiActRevisionDecisionInput,
  type AiActSystemRevision,
} from './aiActContracts.js';
import { AiSystemRegistryError, getAiSystemRevision } from './aiSystemRegistry.js';
import { assertAiSystemReleaseControls } from './aiSystemControlLedger.js';
import { matchesAiActControlCatalogPin } from './aiActControlCatalog.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AiSystemGovernanceContext {
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

export interface AiSystemGovernanceResult {
  value: AiActSystemRevision;
  decisionId: string;
  replayed: boolean;
  auditEvent: CanonicalAuditEventSummary;
}

type LockedRevisionRow = {
  current_revision: number;
  lifecycle_state: string;
  revision_json: unknown;
  created_by_actor_id: string;
};

type GovernanceAction = 'revision' | 'classification' | 'release';

function identifier(value: unknown, name: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || !IDENTIFIER.test(normalized)) {
    throw new AiSystemRegistryError(`${name} is invalid`);
  }
  return normalized;
}

function scope(context: AiSystemGovernanceContext): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(context.scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(context.scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(context.scope.environment, 'environment', 64),
  };
}

function digest(value: unknown): string {
  return createHash('sha256')
    .update(stableAuditJson(JSON.parse(JSON.stringify(value)) as AuditJsonValue), 'utf8')
    .digest('hex');
}

function uuid(context: AiSystemGovernanceContext, name: string): string {
  const value = (context.uuid ?? randomUUID)();
  if (!UUID.test(value)) throw new AiSystemRegistryError(`${name} must be a UUID`);
  return value;
}

function actorRef(context: AiSystemGovernanceContext): AiActSystemRevision['owner'] {
  if (
    context.actor.type !== 'human'
    || context.actor.authMethod !== 'oidc'
    || !context.actor.ssoSubject
    || context.actor.ssoSubject.length > 512
  ) {
    throw new AiSystemRegistryError(
      'AI-system governance decisions require a verified OIDC/Entra identity',
      403,
      'AI_SYSTEM_SSO_REQUIRED',
    );
  }
  return { actorType: 'user', actorId: identifier(context.actor.id, 'actor.id', 200) };
}

function assertFreshMfa(context: AiSystemGovernanceContext, now: Date): void {
  actorRef(context);
  const verifiedAt = new Date(context.mfaVerifiedAt);
  const ageMs = now.getTime() - verifiedAt.getTime();
  const method = context.mfaMethod.trim();
  if (
    !Number.isFinite(verifiedAt.getTime())
    || !Number.isSafeInteger(context.mfaMaxAgeSeconds)
    || context.mfaMaxAgeSeconds < 60
    || context.mfaMaxAgeSeconds > 3_600
    || ageMs < -60_000
    || ageMs > context.mfaMaxAgeSeconds * 1_000
    || !method
    || method.length > 160
  ) {
    throw new AiSystemRegistryError(
      'AI-system governance decision requires a fresh MFA assertion',
      428,
      'MFA_STEP_UP_REQUIRED',
    );
  }
}

async function lockCurrentRevision(
  client: pg.PoolClient,
  authorized: Required<CanonicalAuditScope>,
  aiSystemId: string,
  expectedRevision: number,
  expectedRevisionSha256: string,
): Promise<{ revision: AiActSystemRevision; createdByActorId: string }> {
  const result = await client.query<LockedRevisionRow>(
    `SELECT system.current_revision, system.lifecycle_state,
            revision.revision_json, revision.created_by_actor_id
       FROM mcp_ai_systems system
       JOIN mcp_ai_system_revisions revision
         ON revision.ai_system_id=system.id AND revision.revision=system.current_revision
      WHERE system.id=$1 AND system.workspace_key=$2 AND system.tenant_key=$3
      FOR UPDATE OF system`,
    [aiSystemId, authorized.workspaceKey, authorized.tenantKey],
  );
  const row = result.rows[0];
  if (!row) throw new AiSystemRegistryError('AI system was not found in the authorized scope', 404, 'AI_SYSTEM_NOT_FOUND');
  const revision = aiActSystemRevisionSchema.parse(row.revision_json);
  if (
    Number(row.current_revision) !== expectedRevision
    || revision.revision !== expectedRevision
    || revision.revisionSha256 !== expectedRevisionSha256
  ) {
    throw new AiSystemRegistryError(
      'AI system changed since this decision was prepared',
      409,
      'AI_SYSTEM_REVISION_CONFLICT',
    );
  }
  return { revision, createdByActorId: row.created_by_actor_id };
}

function withDigest(
  value: Omit<AiActSystemRevision, 'revisionSha256'> | AiActSystemRevision,
): AiActSystemRevision {
  const { revisionSha256: _previousDigest, ...withoutDigest } = value as AiActSystemRevision;
  return aiActSystemRevisionSchema.parse({
    ...withoutDigest,
    revisionSha256: digest(withoutDigest),
  });
}

async function persistDerivedRevision(
  client: pg.PoolClient,
  context: AiSystemGovernanceContext,
  action: GovernanceAction,
  source: AiActSystemRevision,
  result: AiActSystemRevision,
  decisionId: string,
  decisionDocument: Record<string, AuditJsonValue>,
  roleAssignmentIds: string[],
  prohibitedAssessmentId: string | null,
): Promise<void> {
  const actor = actorRef(context);
  await client.query(
    `INSERT INTO mcp_ai_system_revisions
       (ai_system_id, revision, revision_id, schema_version, revision_sha256,
        revision_json, created_by_actor_type, created_by_actor_id, created_at, released_at)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)`,
    [result.aiSystemId, result.revision, result.revisionId, result.schemaVersion,
      result.revisionSha256, JSON.stringify(result), actor.actorType, actor.actorId,
      result.createdAt, result.releasedAt],
  );
  for (let index = 0; index < result.marketRoles.length; index += 1) {
    const role = result.marketRoles[index]!;
    await client.query(
      `INSERT INTO mcp_ai_system_role_assignments
         (assignment_id, ai_system_id, revision, market_role, organisation_id,
          organisation_name, role_json, confirmed_by_type, confirmed_by_id,
          confirmed_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)`,
      [roleAssignmentIds[index], result.aiSystemId, result.revision, role.role,
        role.organisationId, role.organisationName, JSON.stringify(role),
        role.confirmedBy.actorType, role.confirmedBy.actorId, role.confirmedAt, result.createdAt],
    );
  }
  if (prohibitedAssessmentId !== null) {
    await client.query(
      `INSERT INTO mcp_ai_system_assessments
         (assessment_id, ai_system_id, revision, assessment_type, decision,
          assessment_sha256, assessment_json, assessed_by_type, assessed_by_id,
          assessed_at, next_review_at, created_at)
       VALUES ($1,$2,$3,'prohibited_practices',$4,$5,$6::jsonb,$7,$8,$9,NULL,$10)`,
      [prohibitedAssessmentId, result.aiSystemId, result.revision,
        result.prohibitedPracticeCheck.decision, digest(result.prohibitedPracticeCheck),
        JSON.stringify(result.prohibitedPracticeCheck), result.prohibitedPracticeCheck.decidedBy.actorType,
        result.prohibitedPracticeCheck.decidedBy.actorId, result.prohibitedPracticeCheck.decidedAt,
        result.createdAt],
    );
    await client.query(
      `INSERT INTO mcp_ai_system_assessments
         (assessment_id, ai_system_id, revision, assessment_type, decision,
          assessment_sha256, assessment_json, assessed_by_type, assessed_by_id,
          assessed_at, next_review_at, created_at)
       VALUES ($1,$2,$3,'classification',$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [result.classification.assessmentId, result.aiSystemId, result.revision,
        result.classification.classification, digest(result.classification),
        JSON.stringify(result.classification), result.classification.assessedBy.actorType,
        result.classification.assessedBy.actorId, result.classification.assessedAt,
        result.classification.nextReviewAt, result.createdAt],
    );
  }
  const decisionSha256 = digest(decisionDocument);
  await client.query(
    `INSERT INTO mcp_ai_system_governance_decisions
       (decision_id, ai_system_id, action, source_revision, result_revision,
        actor_type, actor_id, actor_sso_subject, mfa_verified_at, mfa_method,
        decision_sha256, decision_json, created_at)
     VALUES ($1,$2,$3,$4,$5,'user',$6,$7,$8,$9,$10,$11::jsonb,$12)`,
    [decisionId, result.aiSystemId, action, source.revision, result.revision,
      actor.actorId, context.actor.ssoSubject, context.mfaVerifiedAt,
      context.mfaMethod.trim(), decisionSha256, JSON.stringify(decisionDocument), result.createdAt],
  );
  const updated = await client.query(
    `UPDATE mcp_ai_systems
        SET current_revision=$2, display_name=$3, lifecycle_state=$4, updated_at=$5
      WHERE id=$1 AND current_revision=$6`,
    [result.aiSystemId, result.revision, result.displayName, result.lifecycleState,
      result.createdAt, source.revision],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new AiSystemRegistryError('AI system current revision changed concurrently', 409, 'AI_SYSTEM_REVISION_CONFLICT');
  }
}

async function verifiedReleaseEvidence(
  client: pg.PoolClient,
  authorized: Required<CanonicalAuditScope>,
  evidence: AiActReleaseDecisionInput['evidence'],
): Promise<void> {
  for (const ref of evidence) {
    if (ref.evidenceType === 'canonical_event') {
      const found = await client.query(
        `SELECT 1 FROM mcp_canonical_audit_events
          WHERE event_id::text=$1 AND event_hash=$2
            AND workspace_key=$3 AND tenant_key=$4 AND environment=$5`,
        [ref.evidenceId, ref.sha256, authorized.workspaceKey, authorized.tenantKey, authorized.environment],
      );
      if (!found.rows[0]) throw new AiSystemRegistryError('Release evidence could not be verified', 422, 'AI_SYSTEM_RELEASE_EVIDENCE_UNVERIFIED');
      continue;
    }
    if (ref.evidenceType === 'report' || ref.evidenceType === 'evidence_pack') {
      const selector = ref.evidenceType === 'report' ? 'id' : 'pack_id';
      const found = await client.query(
        `SELECT 1 FROM mcp_audit_report_runs
          WHERE ${selector}::text=$1 AND pack_digest=$2 AND status='completed' AND verification_state='valid'
            AND workspace_key=$3 AND tenant_key=$4 AND environment=$5`,
        [ref.evidenceId, ref.sha256, authorized.workspaceKey, authorized.tenantKey, authorized.environment],
      );
      if (!found.rows[0]) throw new AiSystemRegistryError('Release evidence could not be verified', 422, 'AI_SYSTEM_RELEASE_EVIDENCE_UNVERIFIED');
      continue;
    }
    throw new AiSystemRegistryError(
      `Release evidence type '${ref.evidenceType}' has no server verifier`,
      422,
      'AI_SYSTEM_RELEASE_EVIDENCE_UNVERIFIED',
    );
  }
}

async function finish(
  pool: pg.Pool,
  context: AiSystemGovernanceContext,
  producerName: string,
  action: GovernanceAction,
  aiSystemId: string,
  operation: (client: pg.PoolClient, authorized: Required<CanonicalAuditScope>, now: Date) => Promise<{
    source: AiActSystemRevision;
    result: AiActSystemRevision;
    decisionId: string;
    decisionDocument: Record<string, AuditJsonValue>;
    roleAssignmentIds: string[];
    prohibitedAssessmentId: string | null;
  }>,
  policyDecision: (result: AiActSystemRevision) => string,
): Promise<AiSystemGovernanceResult> {
  const authorized = scope(context);
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new AiSystemRegistryError('now is invalid');
  assertFreshMfa(context, now);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: producerName, eventId: producerEventId },
    authorized,
    async client => {
      const transition = await operation(client, authorized, now);
      await persistDerivedRevision(client, context, action, transition.source, transition.result,
        transition.decisionId, transition.decisionDocument, transition.roleAssignmentIds,
        transition.prohibitedAssessmentId);
      return transition;
    },
    transition => ({
      occurredAt: now,
      ...authorized,
      solution: 'argus.core',
      actor: context.actor,
      action: `compliance.ai_system.${action === 'classification' ? 'classified' : action === 'release' ? 'released' : 'revised'}`,
      outcome: 'success',
      risk: action === 'release' ? 'critical' : 'high',
      resource: { type: 'ai_system', id: aiSystemId, revision: String(transition.result.revision) },
      policy: { id: `argus.ai-act.${action}`, version: '1', decision: policyDecision(transition.result) },
      approvalId: transition.decisionId,
      correlation: { requestId: context.requestId ?? producerEventId },
      payload: {
        before: { revision: transition.source.revision, revisionSha256: transition.source.revisionSha256, lifecycleState: transition.source.lifecycleState },
        after: { revision: transition.result.revision, revisionSha256: transition.result.revisionSha256, lifecycleState: transition.result.lifecycleState },
        context: { decisionSha256: digest(transition.decisionDocument), mfaMethod: context.mfaMethod.trim(), fourEyesEnforced: action !== 'revision' },
      },
      retentionClass: 'business-audit-ai-system',
    }),
    { now: () => now },
  );
  const revisionNumber = Number(outcome.event.resource.revision);
  const value = outcome.result?.result ?? await getAiSystemRevision(pool, authorized, aiSystemId, revisionNumber);
  return {
    value,
    decisionId: outcome.result?.decisionId ?? outcome.event.approvalId ?? '',
    replayed: outcome.replayed,
    auditEvent: outcome.event,
  };
}

export async function reviseAiSystemAudited(
  pool: pg.Pool,
  context: AiSystemGovernanceContext,
  aiSystemId: string,
  input: AiActRevisionDecisionInput,
): Promise<AiSystemGovernanceResult> {
  if (!matchesAiActControlCatalogPin(input.controlCatalog)) {
    throw new AiSystemRegistryError('AI-system revisions must use the active server-owned control catalog', 409, 'AI_CONTROL_CATALOG_UNSUPPORTED');
  }
  return finish(pool, context, 'compliance.ai-system.revision', 'revision', aiSystemId,
    async (client, authorized, now) => {
      const current = await lockCurrentRevision(client, authorized, aiSystemId, input.expectedRevision, input.expectedRevisionSha256);
      if (current.revision.lifecycleState === 'retired') throw new AiSystemRegistryError('Retired AI systems cannot be revised', 409, 'AI_SYSTEM_LIFECYCLE_CONFLICT');
      const actor = actorRef(context);
      const createdAt = now.toISOString();
      const revisionId = uuid(context, 'revisionId');
      const classificationAssessmentId = uuid(context, 'classificationAssessmentId');
      const prohibitedAssessmentId = uuid(context, 'prohibitedAssessmentId');
      const decisionId = uuid(context, 'decisionId');
      const roleAssignmentIds = input.marketRoles.map((_role, index) => uuid(context, `roleAssignmentIds[${index}]`));
      const nextReviewAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString();
      const result = withDigest({
        schemaVersion: 1, kind: 'ai-system-revision', aiSystemId, revisionId,
        revision: current.revision.revision + 1, displayName: input.displayName,
        lifecycleState: 'assessment_in_progress', owner: current.revision.owner,
        intendedPurpose: input.intendedPurpose, prohibitedUses: input.prohibitedUses,
        targetUsers: input.targetUsers, affectedGroups: input.affectedGroups, regions: input.regions,
        marketRoles: input.marketRoles.map(role => ({ ...role, confirmedBy: actor, confirmedAt: createdAt })),
        prohibitedPracticeCheck: {
          decision: 'external_review_required', articleRefs: current.revision.prohibitedPracticeCheck.articleRefs,
          rationale: 'Reassessment required after an immutable AI-system revision.', decidedBy: actor, decidedAt: createdAt,
        },
        classification: {
          assessmentId: classificationAssessmentId, classification: 'assessment_required', articleRefs: [], annexRefs: [],
          rationale: 'Regulatory classification must be confirmed by a different authorized reviewer.',
          legalReviewRequired: true, assessedBy: actor, assessedAt: createdAt, nextReviewAt,
        },
        componentBindings: input.componentBindings, dataCategories: input.dataCategories,
        controlCatalog: input.controlCatalog, createdAt, releasedAt: null,
      });
      return {
        source: current.revision, result, decisionId, roleAssignmentIds, prohibitedAssessmentId,
        decisionDocument: {
          schemaVersion: 1, action: 'revision', sourceRevision: current.revision.revision,
          resultRevision: result.revision, changeSummarySha256: digest(input.changeSummary),
          resultRevisionSha256: result.revisionSha256,
        },
      };
    }, result => result.lifecycleState);
}

export async function classifyAiSystemAudited(
  pool: pg.Pool,
  context: AiSystemGovernanceContext,
  aiSystemId: string,
  input: AiActClassificationDecisionInput,
): Promise<AiSystemGovernanceResult> {
  return finish(pool, context, 'compliance.ai-system.classification', 'classification', aiSystemId,
    async (client, authorized, now) => {
      const current = await lockCurrentRevision(client, authorized, aiSystemId, input.expectedRevision, input.expectedRevisionSha256);
      if (['released', 'retired'].includes(current.revision.lifecycleState)) throw new AiSystemRegistryError('Released or retired revisions require a new draft revision before classification', 409, 'AI_SYSTEM_LIFECYCLE_CONFLICT');
      if (current.createdByActorId === context.actor.id) {
        throw new AiSystemRegistryError('Four-eyes policy forbids an AI-system revision author from classifying it', 403, 'AI_SYSTEM_FOUR_EYES_REQUIRED');
      }
      const actor = actorRef(context);
      const createdAt = now.toISOString();
      const revisionId = uuid(context, 'revisionId');
      const classificationAssessmentId = uuid(context, 'classificationAssessmentId');
      const prohibitedAssessmentId = uuid(context, 'prohibitedAssessmentId');
      const decisionId = uuid(context, 'decisionId');
      const roleAssignmentIds = current.revision.marketRoles.map((_role, index) => uuid(context, `roleAssignmentIds[${index}]`));
      const blocked = input.prohibitedPracticeCheck.decision === 'blocked' || input.classification.classification === 'prohibited';
      const result = withDigest({
        ...current.revision,
        revisionId, revision: current.revision.revision + 1,
        lifecycleState: blocked ? 'blocked' : 'ready_for_independent_review',
        marketRoles: current.revision.marketRoles,
        prohibitedPracticeCheck: { ...input.prohibitedPracticeCheck, decidedBy: actor, decidedAt: createdAt },
        classification: { assessmentId: classificationAssessmentId, ...input.classification, assessedBy: actor, assessedAt: createdAt },
        createdAt, releasedAt: null,
      });
      return {
        source: current.revision, result, decisionId, roleAssignmentIds, prohibitedAssessmentId,
        decisionDocument: {
          schemaVersion: 1, action: 'classification', sourceRevision: current.revision.revision,
          resultRevision: result.revision, classification: result.classification.classification,
          classificationAssessmentId, prohibitedPracticeDecision: result.prohibitedPracticeCheck.decision,
          rationaleSha256: digest({ classification: input.classification.rationale, prohibitedPractice: input.prohibitedPracticeCheck.rationale }),
          resultRevisionSha256: result.revisionSha256,
        },
      };
    }, result => result.classification.classification);
}

export async function releaseAiSystemAudited(
  pool: pg.Pool,
  context: AiSystemGovernanceContext,
  aiSystemId: string,
  input: AiActReleaseDecisionInput,
): Promise<AiSystemGovernanceResult> {
  return finish(pool, context, 'compliance.ai-system.release', 'release', aiSystemId,
    async (client, authorized, now) => {
      const current = await lockCurrentRevision(client, authorized, aiSystemId, input.expectedRevision, input.expectedRevisionSha256);
      if (!['ready_for_independent_review', 'externally_assessed'].includes(current.revision.lifecycleState)) {
        throw new AiSystemRegistryError('AI system is not ready for a release decision', 409, 'AI_SYSTEM_LIFECYCLE_CONFLICT');
      }
      if (current.revision.classification.assessedBy.actorId === context.actor.id) {
        throw new AiSystemRegistryError('Four-eyes policy forbids the classifier from releasing the same revision', 403, 'AI_SYSTEM_FOUR_EYES_REQUIRED');
      }
      if (
        current.revision.prohibitedPracticeCheck.decision !== 'clear'
        || ['assessment_required', 'prohibited'].includes(current.revision.classification.classification)
        || Date.parse(current.revision.classification.nextReviewAt) <= now.getTime()
      ) {
        throw new AiSystemRegistryError('AI system classification does not permit release', 409, 'AI_SYSTEM_RELEASE_BLOCKED');
      }
      await assertAiSystemReleaseControls(client, authorized, current.revision, now);
      await verifiedReleaseEvidence(client, authorized, input.evidence);
      const createdAt = now.toISOString();
      const revisionId = uuid(context, 'revisionId');
      const decisionId = uuid(context, 'decisionId');
      const roleAssignmentIds = current.revision.marketRoles.map((_role, index) => uuid(context, `roleAssignmentIds[${index}]`));
      const result = withDigest({
        ...current.revision,
        revisionId, revision: current.revision.revision + 1, lifecycleState: 'released',
        classification: current.revision.classification,
        createdAt, releasedAt: createdAt,
      });
      return {
        source: current.revision, result, decisionId, roleAssignmentIds, prohibitedAssessmentId: null,
        decisionDocument: {
          schemaVersion: 1, action: 'release', sourceRevision: current.revision.revision,
          resultRevision: result.revision, rationaleSha256: digest(input.decisionRationale),
          evidence: input.evidence.map(ref => ({ evidenceType: ref.evidenceType, evidenceId: ref.evidenceId, sha256: ref.sha256 })),
          resultRevisionSha256: result.revisionSha256,
        },
      };
    }, () => 'released');
}
