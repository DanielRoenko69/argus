import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditEventSummary, CanonicalAuditRisk } from '../audit/canonicalAuditTypes.js';
import type { UserLifecycleAuditContext } from '../auth/userLifecycle.js';

export type WorkflowApprovalAction = 'submitted' | 'approved' | 'rejected' | 'withdrawn';
export type WorkflowLifecycleStatus = 'draft' | 'review' | 'production';

interface WorkflowApprovalRow {
  id: number;
  name: string;
  lifecycle_status: WorkflowLifecycleStatus;
  human_oversight_required: boolean;
}

interface WorkflowApprovalMutation {
  workflowId: number;
  workflowName: string;
  beforeStatus: WorkflowLifecycleStatus;
  status: WorkflowLifecycleStatus;
  workflowVersion: number | null;
  approvalRecordId: string;
  submitterUsername: string | null;
  fourEyesOverrideApplied: boolean;
  humanOversightRequired: boolean;
}

interface WorkflowApprovalScope {
  tenantKey: string;
  workspaceKey: string;
}

export interface AuditedWorkflowApprovalTransition {
  value: WorkflowApprovalMutation;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
  action: WorkflowApprovalAction;
  status: WorkflowLifecycleStatus;
}

export class WorkflowApprovalTransitionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 403 | 404 | 409,
    readonly code:
      | 'WORKFLOW_APPROVAL_FORBIDDEN'
      | 'WORKFLOW_NOT_FOUND'
      | 'WORKFLOW_LIFECYCLE_CONFLICT'
      | 'WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT',
  ) {
    super(message);
    this.name = 'WorkflowApprovalTransitionError';
  }
}

const transitions: Record<WorkflowApprovalAction, {
  before: WorkflowLifecycleStatus;
  after: WorkflowLifecycleStatus;
  risk: CanonicalAuditRisk;
}> = {
  submitted: { before: 'draft', after: 'review', risk: 'medium' },
  approved: { before: 'review', after: 'production', risk: 'high' },
  rejected: { before: 'review', after: 'draft', risk: 'medium' },
  withdrawn: { before: 'review', after: 'draft', risk: 'medium' },
};

function digestText(value: string | null): string | null {
  return value == null ? null : createHash('sha256').update(value, 'utf8').digest('hex');
}

function scopeFor(context: UserLifecycleAuditContext) {
  const workspaceKey = context.workspaceKey ?? 'default';
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

async function latestSubmitter(
  client: pg.PoolClient,
  workflowId: number,
  scope: WorkflowApprovalScope,
): Promise<string | null> {
  const result = await client.query<{ actor_username: string }>(
    `SELECT actor_username
       FROM mcp_workflow_approvals
      WHERE workflow_id=$1 AND tenant_key=$2 AND workspace_key=$3 AND action='submitted'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [workflowId, scope.tenantKey, scope.workspaceKey],
  );
  return result.rows[0]?.actor_username ?? null;
}

async function mutateWorkflowApproval(
  client: pg.PoolClient,
  workflowId: number,
  action: WorkflowApprovalAction,
  actor: { username: string; role: string },
  comment: string | null,
  allowFourEyesOverride: boolean,
  scope: WorkflowApprovalScope,
): Promise<WorkflowApprovalMutation> {
  const transition = transitions[action];
  const currentResult = await client.query<WorkflowApprovalRow>(
    `SELECT id, name, lifecycle_status, human_oversight_required
       FROM mcp_workflows
      WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3
      FOR UPDATE`,
    [workflowId, scope.tenantKey, scope.workspaceKey],
  );
  const current = currentResult.rows[0];
  if (!current) {
    throw new WorkflowApprovalTransitionError('workflow not found', 404, 'WORKFLOW_NOT_FOUND');
  }
  if (current.lifecycle_status !== transition.before) {
    throw new WorkflowApprovalTransitionError(
      `workflow not in ${transition.before} state`, 409, 'WORKFLOW_LIFECYCLE_CONFLICT',
    );
  }

  const submitterUsername = action === 'submitted'
    ? actor.username
    : await latestSubmitter(client, workflowId, scope);
  const ownSubmission = submitterUsername === actor.username;
  if (action === 'approved' && ownSubmission && !allowFourEyesOverride) {
    throw new WorkflowApprovalTransitionError(
      '4-eyes: cannot approve your own submission (admin override possible)',
      403,
      'WORKFLOW_APPROVAL_FORBIDDEN',
    );
  }
  if (action === 'withdrawn' && !ownSubmission && !allowFourEyesOverride) {
    throw new WorkflowApprovalTransitionError(
      'only the submitter or an admin can withdraw',
      403,
      'WORKFLOW_APPROVAL_FORBIDDEN',
    );
  }

  const versionResult = await client.query<{ version: number | null }>(
    'SELECT MAX(version)::int AS version FROM mcp_workflow_versions WHERE workflow_id=$1',
    [workflowId],
  );
  const workflowVersion = versionResult.rows[0]?.version ?? null;
  const updated = await client.query(
    `UPDATE mcp_workflows SET lifecycle_status=$2, updated_at=now()
      WHERE id=$1 AND lifecycle_status=$3 AND tenant_key=$4 AND workspace_key=$5`,
    [workflowId, transition.after, transition.before, scope.tenantKey, scope.workspaceKey],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw new WorkflowApprovalTransitionError(
      `workflow not in ${transition.before} state`, 409, 'WORKFLOW_LIFECYCLE_CONFLICT',
    );
  }
  const approvalResult = await client.query<{ id: string | number }>(
    `INSERT INTO mcp_workflow_approvals
       (workflow_id, workflow_version, action, actor_username, actor_role, comment, tenant_key, workspace_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [workflowId, workflowVersion, action, actor.username, actor.role, comment, scope.tenantKey, scope.workspaceKey],
  );
  const approvalRecordId = String(approvalResult.rows[0]?.id ?? '');
  if (!approvalRecordId) throw new Error('workflow approval insert returned no id');
  return {
    workflowId,
    workflowName: current.name,
    beforeStatus: current.lifecycle_status,
    status: transition.after,
    workflowVersion,
    approvalRecordId,
    submitterUsername,
    fourEyesOverrideApplied: allowFourEyesOverride && ownSubmission && action === 'approved',
    humanOversightRequired: current.human_oversight_required,
  };
}

async function loadReplayValue(
  pool: pg.Pool,
  event: CanonicalAuditEventSummary,
  action: WorkflowApprovalAction,
  scope: WorkflowApprovalScope,
): Promise<WorkflowApprovalMutation> {
  const workflowId = Number(event.resource.id);
  if (!Number.isSafeInteger(workflowId) || workflowId < 1 || !event.approvalId) {
    throw new Error('Canonical workflow approval event has invalid resource identifiers');
  }
  const result = await pool.query<{
    name: string;
    human_oversight_required: boolean;
    workflow_version: number | null;
    actor_username: string;
  }>(
    `SELECT w.name, w.human_oversight_required,
            a.workflow_version, a.actor_username
       FROM mcp_workflow_approvals a
       JOIN mcp_workflows w ON w.id=a.workflow_id
      WHERE a.id=$1 AND a.workflow_id=$2 AND a.action=$3
        AND a.tenant_key=$4 AND a.workspace_key=$5
        AND w.tenant_key=$4 AND w.workspace_key=$5`,
    [event.approvalId, workflowId, action, scope.tenantKey, scope.workspaceKey],
  );
  const row = result.rows[0];
  if (!row) throw new WorkflowApprovalTransitionError('workflow not found', 404, 'WORKFLOW_NOT_FOUND');
  const beforeStatus = event.payloadSummary['before'];
  const before = beforeStatus && typeof beforeStatus === 'object'
    ? (beforeStatus as { lifecycleStatus?: unknown }).lifecycleStatus
    : undefined;
  if (before !== 'draft' && before !== 'review' && before !== 'production') {
    throw new Error('Canonical workflow approval event has invalid before status');
  }
  return {
    workflowId,
    workflowName: row.name,
    beforeStatus: before,
    status: transitions[action].after,
    workflowVersion: row.workflow_version,
    approvalRecordId: event.approvalId,
    submitterUsername: action === 'submitted' ? row.actor_username : null,
    fourEyesOverrideApplied: false,
    humanOversightRequired: row.human_oversight_required,
  };
}

/** Atomically changes workflow lifecycle, appends the legacy trail and emits canonical evidence. */
export async function transitionWorkflowApprovalAudited(
  pool: pg.Pool,
  workflowId: number,
  action: WorkflowApprovalAction,
  actor: { username: string; role: string },
  comment: string | null,
  allowFourEyesOverride: boolean,
  context: UserLifecycleAuditContext,
): Promise<AuditedWorkflowApprovalTransition> {
  const scope = scopeFor(context);
  const transition = transitions[action];
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'approval.workflow.lifecycle', eventId: context.producerEventId },
    scope,
    client => mutateWorkflowApproval(
      client, workflowId, action, actor, comment, allowFourEyesOverride, scope,
    ),
    result => ({
      ...scope,
      solution: 'argus.core',
      actor: context.actor,
      action: `approval.workflow.${action}`,
      outcome: 'success' as const,
      risk: transition.risk,
      resource: {
        type: 'workflow',
        id: String(result.workflowId),
        revision: result.workflowVersion == null ? null : String(result.workflowVersion),
      },
      policy: {
        id: 'argus.workflow-lifecycle',
        version: 'v1',
        decision: result.status,
      },
      approvalId: result.approvalRecordId,
      correlation: { requestId: context.requestId ?? context.producerEventId },
      payload: {
        before: { lifecycleStatus: result.beforeStatus },
        after: { lifecycleStatus: result.status },
        context: {
          workflowName: result.workflowName,
          workflowVersion: result.workflowVersion,
          humanOversightRequired: result.humanOversightRequired,
          submitterIdDigest: digestText(result.submitterUsername),
          commentPresent: comment != null,
          commentDigest: digestText(comment),
          fourEyesOverrideApplied: result.fourEyesOverrideApplied,
          freeFormText: 'excluded',
        },
      },
    }),
  );
  const committedAction = outcome.event.action;
  const expectedAction = `approval.workflow.${action}`;
  if (committedAction !== expectedAction) {
    throw new WorkflowApprovalTransitionError(
      'Canonical workflow approval event does not match the requested action',
      409,
      'WORKFLOW_APPROVAL_IDEMPOTENCY_CONFLICT',
    );
  }
  const committedStatus = outcome.event.policy.decision;
  if (committedStatus !== transition.after) {
    throw new Error('Canonical workflow approval event does not match the requested transition');
  }
  const value = outcome.result ?? await loadReplayValue(pool, outcome.event, action, scope);
  return {
    value,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
    action,
    status: transition.after,
  };
}
