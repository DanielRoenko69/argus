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
  aiActProductionRunBindingSchema,
  type AiActProductionRunBinding,
  type AiActSystemRevision,
} from './aiActContracts.js';
import { getAiSystemRevision } from './aiSystemRegistry.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;

export class AiSystemRunBindingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'AI_SYSTEM_RUN_BINDING_INVALID',
  ) {
    super(message);
    this.name = 'AiSystemRunBindingError';
  }
}

export interface AiSystemRunIdentity {
  actorType: 'human' | 'service';
  subjectId: string;
  role: string;
  authenticationMethod: 'sso' | 'workload_identity' | 'local' | 'api_key';
  identityVerified: boolean;
  mfaStepUpAt: string | null;
}

export interface AiSystemProductionGateContext {
  scope: CanonicalAuditScope;
  environment: string;
  workflowExecutionId: number;
  aiSystemId: string;
  aiSystemRevision: number;
  identity: AiSystemRunIdentity;
  now?: () => Date;
}

export interface AiSystemRunBindingMutationContext extends AiSystemProductionGateContext {
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  uuid?: () => string;
}

export interface AiSystemRunBindingResult {
  binding: AiActProductionRunBinding;
  bindingId: string;
  bindingSha256: string;
  replayed: boolean;
  auditEvent: CanonicalAuditEventSummary;
}

type BindingRow = {
  binding_id: string;
  binding_sha256: string;
  binding_json: unknown;
};

function digest(value: unknown): string {
  const canonical = JSON.parse(JSON.stringify(value)) as AuditJsonValue;
  return createHash('sha256').update(stableAuditJson(canonical), 'utf8').digest('hex');
}

function identifier(value: unknown, name: string, maximum: number): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > maximum || !IDENTIFIER.test(normalized)) {
    throw new AiSystemRunBindingError(`${name} is invalid`);
  }
  return normalized;
}

function checkedExecutionId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiSystemRunBindingError('workflowExecutionId must be a positive safe integer');
  }
  return value;
}

function normalizedScope(scope: CanonicalAuditScope): Required<CanonicalAuditScope> {
  return {
    workspaceKey: identifier(scope.workspaceKey ?? 'default', 'workspaceKey', 128),
    tenantKey: identifier(scope.tenantKey ?? 'default', 'tenantKey', 128),
    environment: identifier(scope.environment, 'scope.environment', 64),
  };
}

function releaseBlockers(
  revision: AiActSystemRevision,
  identity: AiSystemRunIdentity,
  now: Date,
): string[] {
  const blockers: string[] = [];
  if (revision.lifecycleState !== 'released') {
    blockers.push(`AI system revision is '${revision.lifecycleState}', not released.`);
  }
  if (!revision.releasedAt || Date.parse(revision.releasedAt) > now.getTime()) {
    blockers.push('AI system revision has no effective release timestamp.');
  }
  if (revision.prohibitedPracticeCheck.decision !== 'clear') {
    blockers.push(`Prohibited-practice decision is '${revision.prohibitedPracticeCheck.decision}'.`);
  }
  if (revision.classification.classification === 'assessment_required') {
    blockers.push('AI system classification is still pending.');
  }
  if (revision.classification.classification === 'prohibited') {
    blockers.push('Prohibited AI systems cannot execute in production.');
  }
  if (Date.parse(revision.classification.nextReviewAt) <= now.getTime()) {
    blockers.push('AI system classification review has expired.');
  }
  if (!identity.identityVerified) {
    blockers.push('The effective production identity is not verified.');
  }
  if (identity.actorType === 'human' && identity.authenticationMethod !== 'sso') {
    blockers.push('Human production execution requires SSO.');
  }
  if (identity.actorType === 'service' && identity.authenticationMethod !== 'workload_identity') {
    blockers.push('Automated production execution requires workload identity.');
  }
  return [...new Set(blockers)];
}

export async function evaluateAiSystemProductionGate(
  queryable: Queryable,
  context: AiSystemProductionGateContext,
): Promise<AiActProductionRunBinding> {
  const scope = normalizedScope(context.scope);
  const executionId = checkedExecutionId(context.workflowExecutionId);
  const now = (context.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) throw new AiSystemRunBindingError('now is invalid');
  const environment = identifier(context.environment, 'environment', 120);
  const revision = await getAiSystemRevision(
    queryable,
    scope,
    context.aiSystemId,
    context.aiSystemRevision,
  );
  const blockers = releaseBlockers(revision, context.identity, now);
  const executionAuthorized = blockers.length === 0;
  const checkedAt = now.toISOString();
  return aiActProductionRunBindingSchema.parse({
    schemaVersion: 1,
    kind: 'ai-system-production-run-binding',
    rootRunId: `workflow:${executionId}`,
    environment,
    production: true,
    executionAuthorized,
    boundAt: checkedAt,
    aiSystemId: revision.aiSystemId,
    aiSystemRevisionId: revision.revisionId,
    classificationAssessmentId: revision.classification.assessmentId,
    controlCatalog: revision.controlCatalog,
    controlSetSha256: digest({
      controlCatalog: revision.controlCatalog,
      componentBindings: revision.componentBindings,
    }),
    intendedPurposeSha256: digest(revision.intendedPurpose),
    componentBindings: revision.componentBindings,
    effectiveIdentity: context.identity,
    releaseGate: {
      status: executionAuthorized ? 'passed' : 'blocked',
      checkedAt,
      blockingReasons: blockers,
      evidence: [
        {
          evidenceType: 'document',
          evidenceId: `ai-system-revision:${revision.revisionId}`,
          sha256: revision.revisionSha256,
          href: `/api/ui/compliance/ai-systems/${revision.aiSystemId}`,
        },
        {
          evidenceType: 'document',
          evidenceId: `classification:${revision.classification.assessmentId}`,
          sha256: digest(revision.classification),
          href: `/api/ui/compliance/ai-systems/${revision.aiSystemId}/readiness`,
        },
        {
          evidenceType: 'document',
          evidenceId: `control-catalog:${revision.controlCatalog.catalogId}:${revision.controlCatalog.catalogVersion}`,
          sha256: revision.controlCatalog.catalogSha256,
        },
      ],
    },
    retentionClass: 'ai-system-production-evidence',
    legalHoldIds: [],
  });
}

export async function getAiSystemRunBinding(
  queryable: Queryable,
  workflowExecutionId: number,
): Promise<{ bindingId: string; bindingSha256: string; binding: AiActProductionRunBinding }> {
  const result = await queryable.query<BindingRow>(
    `SELECT binding_id, binding_sha256, binding_json
       FROM mcp_ai_system_run_bindings
      WHERE workflow_execution_id=$1`,
    [checkedExecutionId(workflowExecutionId)],
  );
  const row = result.rows[0];
  if (!row) {
    throw new AiSystemRunBindingError('AI-system run binding was not found', 404, 'AI_SYSTEM_RUN_BINDING_NOT_FOUND');
  }
  return {
    bindingId: row.binding_id,
    bindingSha256: row.binding_sha256,
    binding: aiActProductionRunBindingSchema.parse(row.binding_json),
  };
}

export async function bindAiSystemProductionRunAudited(
  pool: pg.Pool,
  context: AiSystemRunBindingMutationContext,
): Promise<AiSystemRunBindingResult> {
  const scope = normalizedScope(context.scope);
  const producerEventId = identifier(context.producerEventId, 'producerEventId', 256);
  const executionId = checkedExecutionId(context.workflowExecutionId);
  const now = context.now ?? (() => new Date());
  const binding = await evaluateAiSystemProductionGate(pool, { ...context, now });
  const bindingSha256 = digest(binding);
  const bindingId = (context.uuid ?? randomUUID)();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(bindingId)) {
    throw new AiSystemRunBindingError('bindingId must be a UUID');
  }
  const decision = binding.executionAuthorized ? 'passed' : 'blocked';
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'compliance.ai-system.production-run-gate', eventId: producerEventId },
    scope,
    async client => {
      await client.query(
        `INSERT INTO mcp_ai_system_run_bindings
           (binding_id, workflow_execution_id, ai_system_id, ai_system_revision,
            ai_system_revision_id, production, execution_authorized, environment,
            binding_sha256, binding_json, created_at)
         VALUES ($1,$2,$3,$4,$5,true,$6,$7,$8,$9::jsonb,$10)`,
        [bindingId, executionId, binding.aiSystemId, context.aiSystemRevision,
          binding.aiSystemRevisionId, binding.executionAuthorized, binding.environment,
          bindingSha256, JSON.stringify(binding), binding.boundAt],
      );
      return { bindingId, bindingSha256, binding };
    },
    result => ({
      occurredAt: result.binding.boundAt,
      ...scope,
      solution: 'argus.core',
      actor: context.actor,
      action: result.binding.executionAuthorized
        ? 'compliance.ai_system.production_run_authorized'
        : 'compliance.ai_system.production_run_blocked',
      outcome: result.binding.executionAuthorized ? 'success' : 'denied',
      risk: 'critical',
      resource: { type: 'workflow_execution', id: String(executionId) },
      policy: { id: 'argus.ai-act.production-release-gate', version: '1', decision },
      correlation: { rootRunId: result.binding.rootRunId, requestId: context.requestId ?? producerEventId },
      payload: {
        after: {
          bindingId: result.bindingId,
          bindingSha256: result.bindingSha256,
          aiSystemId: result.binding.aiSystemId,
          aiSystemRevisionId: result.binding.aiSystemRevisionId,
          executionAuthorized: result.binding.executionAuthorized,
          blockingReasons: result.binding.releaseGate.blockingReasons,
        },
      },
      retentionClass: result.binding.retentionClass,
    }),
    { now },
  );
  const resolved = outcome.result ?? await getAiSystemRunBinding(pool, executionId);
  return {
    binding: resolved.binding,
    bindingId: resolved.bindingId,
    bindingSha256: resolved.bindingSha256,
    replayed: outcome.replayed,
    auditEvent: outcome.event,
  };
}
