import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventSummary,
  CanonicalAuditScope,
} from '../audit/canonicalAuditTypes.js';
import { AiSystemRegistryError, getAiSystemRevision } from './aiSystemRegistry.js';

type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface WorkflowAiSystemBinding {
  workflowId: number;
  workflowName: string;
  lifecycleStatus: 'draft' | 'review' | 'production';
  governed: boolean;
  aiSystemId: string | null;
  aiSystemRevision: number | null;
}

export interface ConfigureWorkflowAiSystemBindingInput {
  workflowId: number;
  governed: boolean;
  aiSystemId: string | null;
  aiSystemRevision: number | null;
}

export interface ConfigureWorkflowAiSystemBindingContext {
  scope: CanonicalAuditScope;
  actor: CanonicalAuditActor;
  producerEventId: string;
  requestId?: string | null;
  now?: () => Date;
}

type WorkflowBindingRow = {
  id: number;
  name: string;
  lifecycle_status: WorkflowAiSystemBinding['lifecycleStatus'];
  ai_act_governed: boolean;
  ai_system_id: string | null;
  ai_system_revision: number | null;
};

function positiveWorkflowId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AiSystemRegistryError('workflowId must be a positive safe integer');
  }
  return value;
}

function projection(row: WorkflowBindingRow): WorkflowAiSystemBinding {
  return {
    workflowId: row.id,
    workflowName: row.name,
    lifecycleStatus: row.lifecycle_status,
    governed: row.ai_act_governed,
    aiSystemId: row.ai_system_id,
    aiSystemRevision: row.ai_system_revision,
  };
}

export async function getWorkflowAiSystemBinding(
  queryable: Queryable,
  workflowId: number,
): Promise<WorkflowAiSystemBinding> {
  const result = await queryable.query<WorkflowBindingRow>(
    `SELECT id, name, lifecycle_status, ai_act_governed, ai_system_id, ai_system_revision
       FROM mcp_workflows WHERE id=$1`,
    [positiveWorkflowId(workflowId)],
  );
  if (!result.rows[0]) {
    throw new AiSystemRegistryError('Workflow was not found', 404, 'WORKFLOW_NOT_FOUND');
  }
  return projection(result.rows[0]);
}

export async function configureWorkflowAiSystemBindingAudited(
  pool: pg.Pool,
  context: ConfigureWorkflowAiSystemBindingContext,
  input: ConfigureWorkflowAiSystemBindingInput,
): Promise<{ value: WorkflowAiSystemBinding; replayed: boolean; auditEvent: CanonicalAuditEventSummary }> {
  const workflowId = positiveWorkflowId(input.workflowId);
  if (input.governed !== (input.aiSystemId !== null && input.aiSystemRevision !== null)) {
    throw new AiSystemRegistryError('Governed workflows require both aiSystemId and aiSystemRevision; ungoverned workflows require neither');
  }
  const now = context.now ?? (() => new Date());
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'compliance.ai-system.workflow-binding', eventId: context.producerEventId },
    context.scope,
    async client => {
      const before = await getWorkflowAiSystemBinding(client, workflowId);
      if (before.lifecycleStatus === 'production') {
        throw new AiSystemRegistryError(
          'Demote the workflow from production before changing its AI-system binding',
          409,
          'PRODUCTION_WORKFLOW_BINDING_LOCKED',
        );
      }
      if (input.governed) {
        await getAiSystemRevision(client, {
          workspaceKey: context.scope.workspaceKey ?? 'default',
          tenantKey: context.scope.tenantKey ?? 'default',
        }, input.aiSystemId!, input.aiSystemRevision!);
      }
      const result = await client.query<WorkflowBindingRow>(
        `UPDATE mcp_workflows
            SET ai_act_governed=$2, ai_system_id=$3, ai_system_revision=$4, updated_at=now()
          WHERE id=$1
          RETURNING id, name, lifecycle_status, ai_act_governed, ai_system_id, ai_system_revision`,
        [workflowId, input.governed, input.aiSystemId, input.aiSystemRevision],
      );
      return { before, after: projection(result.rows[0]!) };
    },
    result => ({
      occurredAt: now(),
      ...context.scope,
      solution: 'argus.core',
      actor: context.actor,
      action: result.after.governed
        ? 'compliance.ai_system.workflow_bound'
        : 'compliance.ai_system.workflow_unbound',
      outcome: 'success',
      risk: 'high',
      resource: { type: 'workflow', id: String(workflowId) },
      policy: { id: 'argus.ai-act.production-release-gate', version: '1', decision: result.after.governed ? 'governed' : 'ungoverned' },
      correlation: { requestId: context.requestId ?? context.producerEventId },
      payload: { before: result.before, after: result.after },
      retentionClass: 'business-audit-ai-system',
    }),
    { now },
  );
  const value = outcome.result?.after ?? await getWorkflowAiSystemBinding(pool, workflowId);
  return { value, replayed: outcome.replayed, auditEvent: outcome.event };
}
