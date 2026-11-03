import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { stableAuditJson, type AuditJsonValue } from '../audit/canonicalAuditRedaction.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventSummary,
  CanonicalAuditScope,
} from '../audit/canonicalAuditTypes.js';
import {
  aiActSystemRevisionSchema,
  type AiActCreateSystemInput,
  type AiActSystemRevision,
} from './aiActContracts.js';
import { matchesAiActControlCatalogPin } from './aiActControlCatalog.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class AiSystemRegistryError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'AI_SYSTEM_REGISTRY_INVALID',
  ) {
    super(message);
    this.name = 'AiSystemRegistryError';
  }
}

export interface AiSystemRegistryMutationContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  now?: () => Date;
  uuid?: () => string;
}

export type CreateAiSystemInput = AiActCreateSystemInput;

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
type RevisionRow = { revision_json: unknown };

export interface AiSystemRegistryListItem {
  aiSystemId: string;
  revisionId: string;
  revision: number;
  revisionSha256: string;
  displayName: string;
  lifecycleState: AiActSystemRevision['lifecycleState'];
  classification: AiActSystemRevision['classification']['classification'];
  owner: AiActSystemRevision['owner'];
  marketRoles: AiActSystemRevision['marketRoles'][number]['role'][];
  componentCount: number;
  createdAt: string;
  releasedAt: string | null;
}

function identifier(value: unknown, name: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || !IDENTIFIER.test(normalized)) {
    throw new AiSystemRegistryError(`${name} is invalid`);
  }
  return normalized;
}

function normalizedScope(scope: CanonicalAuditScope): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(scope.environment, 'environment', 64),
  };
}

function actorRef(actor: CanonicalAuditActor): AiActSystemRevision['owner'] {
  return {
    actorType: actor.type === 'human' ? 'user' : actor.type,
    actorId: identifier(actor.id, 'actor.id', 200),
  };
}

function digest(value: unknown): string {
  const canonicalInput = JSON.parse(JSON.stringify(value)) as AuditJsonValue;
  return createHash('sha256').update(stableAuditJson(canonicalInput), 'utf8').digest('hex');
}

function nextUuid(context: AiSystemRegistryMutationContext, name: string): string {
  const value = (context.uuid ?? randomUUID)();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AiSystemRegistryError(`${name} must be a UUID`);
  }
  return value;
}

function buildInitialRevision(
  context: AiSystemRegistryMutationContext,
  input: CreateAiSystemInput,
  ids: { aiSystemId: string; revisionId: string; classificationAssessmentId: string },
  createdAt: string,
): AiActSystemRevision {
  const actor = actorRef(context.actor);
  const lifecycleState = input.prohibitedPracticeCheck.decision === 'blocked'
    || input.classification.classification === 'prohibited'
    ? 'blocked'
    : 'controls_incomplete';
  const revisionWithoutDigest = {
    schemaVersion: 1 as const,
    kind: 'ai-system-revision' as const,
    aiSystemId: ids.aiSystemId,
    revisionId: ids.revisionId,
    revision: 1,
    displayName: input.displayName,
    lifecycleState,
    owner: actor,
    intendedPurpose: input.intendedPurpose,
    prohibitedUses: input.prohibitedUses,
    targetUsers: input.targetUsers,
    affectedGroups: input.affectedGroups,
    regions: input.regions,
    marketRoles: input.marketRoles.map(role => ({
      role: role.role,
      organisationId: role.organisationId,
      organisationName: role.organisationName,
      rationale: role.rationale,
      confirmedBy: actor,
      confirmedAt: createdAt,
    })),
    prohibitedPracticeCheck: {
      ...input.prohibitedPracticeCheck,
      decidedBy: actor,
      decidedAt: createdAt,
    },
    classification: {
      assessmentId: ids.classificationAssessmentId,
      ...input.classification,
      assessedBy: actor,
      assessedAt: createdAt,
    },
    componentBindings: input.componentBindings,
    dataCategories: input.dataCategories,
    controlCatalog: input.controlCatalog,
    createdAt,
    releasedAt: null,
  };
  return aiActSystemRevisionSchema.parse({
    ...revisionWithoutDigest,
    revisionSha256: digest(revisionWithoutDigest),
  });
}

export async function getAiSystemRevision(
  queryable: Queryable,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  aiSystemId: string,
  revision?: number,
): Promise<AiActSystemRevision> {
  const result = await queryable.query<RevisionRow>(
    revision == null
      ? `SELECT revision.revision_json
           FROM mcp_ai_systems system
           JOIN mcp_ai_system_revisions revision
             ON revision.ai_system_id=system.id AND revision.revision=system.current_revision
          WHERE system.id=$1 AND system.workspace_key=$2 AND system.tenant_key=$3`
      : `SELECT revision.revision_json
           FROM mcp_ai_systems system
           JOIN mcp_ai_system_revisions revision ON revision.ai_system_id=system.id
          WHERE system.id=$1 AND system.workspace_key=$2 AND system.tenant_key=$3
            AND revision.revision=$4`,
    revision == null
      ? [aiSystemId, scope.workspaceKey, scope.tenantKey]
      : [aiSystemId, scope.workspaceKey, scope.tenantKey, revision],
  );
  const row = result.rows[0];
  if (!row) throw new AiSystemRegistryError('AI system revision was not found in the authorized scope', 404, 'AI_SYSTEM_NOT_FOUND');
  return aiActSystemRevisionSchema.parse(row.revision_json);
}

export async function listAiSystems(
  queryable: Queryable,
  scope: Pick<Required<CanonicalAuditScope>, 'workspaceKey' | 'tenantKey'>,
  limit = 100,
): Promise<AiSystemRegistryListItem[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new AiSystemRegistryError('limit must be an integer between 1 and 200');
  }
  const result = await queryable.query<RevisionRow>(
    `SELECT revision.revision_json
       FROM mcp_ai_systems system
       JOIN mcp_ai_system_revisions revision
         ON revision.ai_system_id=system.id AND revision.revision=system.current_revision
      WHERE system.workspace_key=$1 AND system.tenant_key=$2
      ORDER BY system.updated_at DESC, system.id
      LIMIT $3`,
    [scope.workspaceKey, scope.tenantKey, limit],
  );
  return result.rows.map(row => {
    const revision = aiActSystemRevisionSchema.parse(row.revision_json);
    return {
      aiSystemId: revision.aiSystemId,
      revisionId: revision.revisionId,
      revision: revision.revision,
      revisionSha256: revision.revisionSha256,
      displayName: revision.displayName,
      lifecycleState: revision.lifecycleState,
      classification: revision.classification.classification,
      owner: revision.owner,
      marketRoles: revision.marketRoles.map(role => role.role),
      componentCount: revision.componentBindings.length,
      createdAt: revision.createdAt,
      releasedAt: revision.releasedAt,
    };
  });
}

export async function createAiSystemAudited(
  pool: pg.Pool,
  context: AiSystemRegistryMutationContext,
  input: CreateAiSystemInput,
): Promise<{ value: AiActSystemRevision; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  if (!matchesAiActControlCatalogPin(input.controlCatalog)) {
    throw new AiSystemRegistryError('New AI systems must use the active server-owned control catalog', 409, 'AI_CONTROL_CATALOG_UNSUPPORTED');
  }
  const scope = normalizedScope(context.scope);
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new AiSystemRegistryError('now is invalid');
  const createdAt = now.toISOString();
  const aiSystemId = nextUuid(context, 'aiSystemId');
  const revisionId = nextUuid(context, 'revisionId');
  const classificationAssessmentId = nextUuid(context, 'classificationAssessmentId');
  const prohibitedAssessmentId = nextUuid(context, 'prohibitedAssessmentId');
  const roleAssignmentIds = input.marketRoles.map((_role, index) => nextUuid(context, `roleAssignmentIds[${index}]`));
  const value = buildInitialRevision(context, input, {
    aiSystemId, revisionId, classificationAssessmentId,
  }, createdAt);
  const prohibitedAssessment = value.prohibitedPracticeCheck;
  const classificationAssessment = value.classification;

  try {
    const outcome = await executeCanonicalAuditedMutation(
      pool,
      { name: 'compliance.ai-system.create', eventId: producerEventId },
      scope,
      async client => {
        await client.query(
          `INSERT INTO mcp_ai_systems
             (id, workspace_key, tenant_key, display_name, lifecycle_state,
              owner_actor_type, owner_actor_id, current_revision, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$8)`,
          [value.aiSystemId, scope.workspaceKey, scope.tenantKey, value.displayName,
            value.lifecycleState, value.owner.actorType, value.owner.actorId, createdAt],
        );
        await client.query(
          `INSERT INTO mcp_ai_system_revisions
             (ai_system_id, revision, revision_id, schema_version, revision_sha256,
              revision_json, created_by_actor_type, created_by_actor_id, created_at, released_at)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,NULL)`,
          [value.aiSystemId, value.revision, value.revisionId, value.schemaVersion,
            value.revisionSha256, JSON.stringify(value), value.owner.actorType, value.owner.actorId, createdAt],
        );
        for (let index = 0; index < value.marketRoles.length; index += 1) {
          const role = value.marketRoles[index]!;
          await client.query(
            `INSERT INTO mcp_ai_system_role_assignments
               (assignment_id, ai_system_id, revision, market_role, organisation_id,
                organisation_name, role_json, confirmed_by_type, confirmed_by_id,
                confirmed_at, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$10)`,
            [roleAssignmentIds[index], value.aiSystemId, value.revision, role.role,
              role.organisationId, role.organisationName, JSON.stringify(role),
              role.confirmedBy.actorType, role.confirmedBy.actorId, role.confirmedAt],
          );
        }
        await client.query(
          `INSERT INTO mcp_ai_system_assessments
             (assessment_id, ai_system_id, revision, assessment_type, decision,
              assessment_sha256, assessment_json, assessed_by_type, assessed_by_id,
              assessed_at, next_review_at, created_at)
           VALUES ($1,$2,$3,'prohibited_practices',$4,$5,$6::jsonb,$7,$8,$9,NULL,$9)`,
          [prohibitedAssessmentId, value.aiSystemId, value.revision, prohibitedAssessment.decision,
            digest(prohibitedAssessment), JSON.stringify(prohibitedAssessment),
            prohibitedAssessment.decidedBy.actorType, prohibitedAssessment.decidedBy.actorId,
            prohibitedAssessment.decidedAt],
        );
        await client.query(
          `INSERT INTO mcp_ai_system_assessments
             (assessment_id, ai_system_id, revision, assessment_type, decision,
              assessment_sha256, assessment_json, assessed_by_type, assessed_by_id,
              assessed_at, next_review_at, created_at)
           VALUES ($1,$2,$3,'classification',$4,$5,$6::jsonb,$7,$8,$9,$10,$9)`,
          [classificationAssessment.assessmentId, value.aiSystemId, value.revision,
            classificationAssessment.classification, digest(classificationAssessment),
            JSON.stringify(classificationAssessment), classificationAssessment.assessedBy.actorType,
            classificationAssessment.assessedBy.actorId, classificationAssessment.assessedAt,
            classificationAssessment.nextReviewAt],
        );
        await client.query(
          `UPDATE mcp_ai_systems SET current_revision=$2 WHERE id=$1`,
          [value.aiSystemId, value.revision],
        );
        return value;
      },
      revision => ({
        occurredAt: createdAt,
        ...scope,
        solution: 'argus.core',
        actor: context.actor,
        action: 'compliance.ai_system.created',
        outcome: 'success',
        risk: 'high',
        resource: { type: 'ai_system', id: revision.aiSystemId, revision: String(revision.revision) },
        policy: { id: 'argus.ai-act.system-registry', version: '1', decision: revision.lifecycleState },
        correlation: { requestId: context.requestId ?? producerEventId },
        payload: {
          before: null,
          after: {
            revisionId: revision.revisionId,
            revisionSha256: revision.revisionSha256,
            lifecycleState: revision.lifecycleState,
            classification: revision.classification.classification,
            classificationAssessmentId: revision.classification.assessmentId,
            marketRoles: revision.marketRoles.map(role => role.role),
            componentCount: revision.componentBindings.length,
            controlCatalog: revision.controlCatalog,
          },
        },
        retentionClass: 'business-audit-ai-system',
      }),
      { now: () => now },
    );
    const resolved = outcome.result ?? await getAiSystemRevision(
      pool,
      scope,
      outcome.event.resource.id,
      Number(outcome.event.resource.revision),
    );
    return { value: resolved, replayed: outcome.replayed, auditEvent: outcome.event };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AiSystemRegistryError('An AI system with this name or immutable identity already exists', 409, 'AI_SYSTEM_CONFLICT');
    }
    throw error;
  }
}
