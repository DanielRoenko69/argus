import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { HookContext } from '../agents/hooks/types.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import type { UserLifecycleAuditContext } from '../auth/userLifecycle.js';
import {
  assessToolRisk,
  type RiskAssessment,
  type RiskFactor,
} from './riskEngine.js';

export type RuntimeApprovalStatus = 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired';

export interface RuntimeApprovalResolution {
  decision: 'allow' | 'pending' | 'rejected';
  requestId: number;
  comment?: string | null;
}

export interface RuntimeApprovalRecord {
  id: number;
  /** Persisted ownership; optional only for legacy fixtures. */
  tenant_key?: string;
  workspace_key?: string;
  request_key: string;
  grant_key: string;
  subject_type: 'agent' | 'workflow';
  agent_id: number | null;
  workflow_id: number | null;
  session_id: string;
  tool_name: string;
  tool_args: Record<string, unknown>;
  tool_args_hash: string;
  risk_level: 'medium' | 'high' | 'critical';
  risk_score: number;
  risk_factors: RiskFactor[];
  risk_model: string;
  reason: string;
  status: RuntimeApprovalStatus;
  requested_by_user_id: number | null;
  requested_at: string;
  last_seen_at: string;
  occurrence_count: number;
  decided_by_user_id: number | null;
  decided_by_username: string | null;
  decision_comment: string | null;
  decided_at: string | null;
  approval_expires_at: string | null;
  consumed_at: string | null;
  consumed_session_id: string | null;
  workflow_execution_id: number | null;
  workflow_step_id: string | null;
}

export interface AuditedRuntimeApprovalDecision {
  value: RuntimeApprovalRecord;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
  decision: 'approved' | 'rejected';
}

export class RuntimeApprovalDecisionError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 404 | 409,
    readonly code:
      | 'RUNTIME_APPROVAL_FORBIDDEN'
      | 'RUNTIME_APPROVAL_NOT_FOUND'
      | 'RUNTIME_APPROVAL_ALREADY_DECIDED'
      | 'RUNTIME_APPROVAL_IDEMPOTENCY_CONFLICT',
  ) {
    super(message);
    this.name = 'RuntimeApprovalDecisionError';
  }
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, normalizedJson(nested)]),
    );
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  return value;
}

export function stableToolArgs(args: Record<string, unknown>): string {
  return JSON.stringify(normalizedJson(args));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function runtimeApprovalKeys(
  ctx: HookContext,
  scope: { tenantKey: string; workspaceKey: string } = { tenantKey: 'default', workspaceKey: 'default' },
): {
  requestKey: string;
  grantKey: string;
  argsHash: string;
  subjectType: 'agent' | 'workflow';
} {
  const argsHash = sha256(stableToolArgs(ctx.toolArgs));
  const subjectType = ctx.workflowId != null && ctx.workflowId > 0 ? 'workflow' : 'agent';
  const subject = subjectType === 'workflow' ? `workflow:${ctx.workflowId}` : `agent:${ctx.agentId}`;
  const grantScope = subjectType === 'workflow' ? subject : `${subject}:session:${ctx.sessionId}`;
  const grantKey = sha256(`tenant:${scope.tenantKey}|workspace:${scope.workspaceKey}|${grantScope}|tool:${ctx.toolName}|args:${argsHash}`);
  const requestKey = sha256(`${grantKey}|request-session:${ctx.sessionId}`);
  return { requestKey, grantKey, argsHash, subjectType };
}

async function resolveRuntimeApprovalScope(
  pool: pg.Pool,
  ctx: HookContext,
): Promise<{ tenantKey: string; workspaceKey: string }> {
  if (ctx.workflowId != null && ctx.workflowId > 0) {
    const result = await pool.query<{ tenant_key: string; workspace_key: string }>(
      `SELECT tenant_key, workspace_key
         FROM mcp_workflows
        WHERE id = $1`,
      [ctx.workflowId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Workflow #${ctx.workflowId} approval scope could not be resolved`);
    return { tenantKey: row.tenant_key, workspaceKey: row.workspace_key };
  }
  // Agents are still a legacy global resource. Their approvals remain inside
  // the historical boundary until the Agent/runtime identity migration lands.
  return { tenantKey: 'default', workspaceKey: 'default' };
}

async function consumeApprovedGrant(
  pool: pg.Pool,
  grantKey: string,
  sessionId: string,
  scope: { tenantKey: string; workspaceKey: string },
): Promise<number | null> {
  const consumed = await pool.query<{ id: number }>(
    `UPDATE mcp_runtime_approvals
     SET status = 'consumed',
         consumed_at = now(),
         consumed_session_id = $2,
         last_seen_at = now()
     WHERE id = (
       SELECT id
       FROM mcp_runtime_approvals
       WHERE grant_key = $1
         AND tenant_key = $3
         AND workspace_key = $4
         AND status = 'approved'
         AND approval_expires_at > now()
       ORDER BY decided_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id`,
    [grantKey, sessionId, scope.tenantKey, scope.workspaceKey],
  );
  return consumed.rows[0]?.id ?? null;
}

export async function resolveRuntimeApproval(
  pool: pg.Pool,
  ctx: HookContext,
  reason: string,
  suppliedAssessment?: RiskAssessment,
): Promise<RuntimeApprovalResolution> {
  const scope = await resolveRuntimeApprovalScope(pool, ctx);
  const { requestKey, grantKey, argsHash, subjectType } = runtimeApprovalKeys(ctx, scope);
  const assessment = suppliedAssessment ?? assessToolRisk({
    toolName: ctx.toolName,
    args: ctx.toolArgs,
    humanOversight: true,
    subjectType,
  });

  await pool.query(
    `UPDATE mcp_runtime_approvals
     SET status = 'expired'
     WHERE grant_key = $1
       AND tenant_key = $2
       AND workspace_key = $3
       AND status = 'approved'
       AND approval_expires_at <= now()`,
    [grantKey, scope.tenantKey, scope.workspaceKey],
  );

  const consumedId = await consumeApprovedGrant(pool, grantKey, ctx.sessionId, scope);
  if (consumedId != null) {
    return { decision: 'allow', requestId: consumedId };
  }

  const existing = await pool.query<Pick<RuntimeApprovalRecord, 'id' | 'status' | 'decision_comment'>>(
    `SELECT id, status, decision_comment
     FROM mcp_runtime_approvals
     WHERE request_key = $1
       AND tenant_key = $2
       AND workspace_key = $3
       AND status IN ('pending', 'approved', 'rejected')
     ORDER BY requested_at DESC
     LIMIT 1`,
    [requestKey, scope.tenantKey, scope.workspaceKey],
  );
  const current = existing.rows[0];
  if (current?.status === 'pending') {
    await pool.query(
      `UPDATE mcp_runtime_approvals
       SET last_seen_at = now(), occurrence_count = occurrence_count + 1
       WHERE id = $1`,
      [current.id],
    );
    return { decision: 'pending', requestId: current.id };
  }
  if (current?.status === 'rejected') {
    return { decision: 'rejected', requestId: current.id, comment: current.decision_comment };
  }
  if (current?.status === 'approved') {
    // The status may have changed between the consume attempt and lookup.
    const racedConsumption = await consumeApprovedGrant(pool, grantKey, ctx.sessionId, scope);
    if (racedConsumption != null) return { decision: 'allow', requestId: racedConsumption };
    throw new Error('Approved runtime grant could not be consumed');
  }

  const inserted = await pool.query<Pick<RuntimeApprovalRecord, 'id' | 'status' | 'decision_comment'>>(
    `INSERT INTO mcp_runtime_approvals (
       request_key, grant_key, subject_type, agent_id, workflow_id,
       session_id, tool_name, tool_args, tool_args_hash, risk_level,
       risk_score, risk_factors, risk_model, reason, requested_by_user_id,
       workflow_execution_id, workflow_step_id, tenant_key, workspace_key
     )
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10,
       $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19
     )
     ON CONFLICT (request_key) WHERE status IN ('pending', 'approved', 'rejected')
     DO UPDATE SET
       last_seen_at = now(),
       occurrence_count = mcp_runtime_approvals.occurrence_count + 1,
       risk_level = EXCLUDED.risk_level,
       risk_score = EXCLUDED.risk_score,
       risk_factors = EXCLUDED.risk_factors,
       risk_model = EXCLUDED.risk_model
     RETURNING id, status, decision_comment`,
    [
      requestKey,
      grantKey,
      subjectType,
      subjectType === 'agent' ? ctx.agentId : null,
      subjectType === 'workflow' ? ctx.workflowId : null,
      ctx.sessionId,
      ctx.toolName,
      stableToolArgs(ctx.toolArgs),
      argsHash,
      assessment.level,
      assessment.score,
      JSON.stringify(assessment.factors),
      assessment.model,
      reason,
      ctx.userId ?? null,
      ctx.workflowExecutionId ?? null,
      ctx.workflowStepId ?? null,
      scope.tenantKey,
      scope.workspaceKey,
    ],
  );
  const request = inserted.rows[0];
  if (!request) throw new Error('Runtime approval request was not persisted');
  if (request.status === 'approved') {
    const racedConsumption = await consumeApprovedGrant(pool, grantKey, ctx.sessionId, scope);
    if (racedConsumption != null) return { decision: 'allow', requestId: racedConsumption };
    throw new Error('Approved runtime grant could not be consumed');
  }
  if (request.status === 'rejected') {
    return { decision: 'rejected', requestId: request.id, comment: request.decision_comment };
  }
  return { decision: 'pending', requestId: request.id };
}

export async function getRuntimeApproval(
  pool: pg.Pool,
  id: number,
  scope?: { tenantKey: string; workspaceKey: string },
): Promise<RuntimeApprovalRecord | null> {
  const { rows } = await pool.query<RuntimeApprovalRecord>(
    `SELECT * FROM mcp_runtime_approvals
      WHERE id = $1
        ${scope ? 'AND tenant_key = $2 AND workspace_key = $3' : ''}`,
    scope ? [id, scope.tenantKey, scope.workspaceKey] : [id],
  );
  return rows[0] ?? null;
}

export async function decideRuntimeApproval(
  pool: pg.Pool,
  id: number,
  decision: 'approve' | 'reject',
  reviewer: { id: number; username: string },
  comment: string | null,
  scope?: { tenantKey: string; workspaceKey: string },
): Promise<RuntimeApprovalRecord | null> {
  const result = await decideRuntimeApprovalRecord(pool, id, decision, reviewer, comment, true, scope);
  return result?.value ?? null;
}

async function decideRuntimeApprovalRecord(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  id: number,
  decision: 'approve' | 'reject',
  reviewer: { id: number; username: string },
  comment: string | null,
  allowSelfApproval: boolean,
  scope?: { tenantKey: string; workspaceKey: string },
): Promise<{ before: RuntimeApprovalRecord; value: RuntimeApprovalRecord; fourEyesOverrideApplied: boolean } | null> {
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const current = await queryable.query<RuntimeApprovalRecord>(
    `SELECT * FROM mcp_runtime_approvals
      WHERE id=$1 ${scope ? 'AND tenant_key=$2 AND workspace_key=$3' : ''}
      FOR UPDATE`,
    scope ? [id, scope.tenantKey, scope.workspaceKey] : [id],
  );
  const before = current.rows[0];
  if (!before || before.status !== 'pending') return null;
  const selfApproval = decision === 'approve' && before.requested_by_user_id === reviewer.id;
  if (selfApproval && !allowSelfApproval) {
    throw new RuntimeApprovalDecisionError(
      'Four-eyes policy forbids approving your own request.',
      403,
      'RUNTIME_APPROVAL_FORBIDDEN',
    );
  }
  const { rows } = await queryable.query<RuntimeApprovalRecord>(
    `UPDATE mcp_runtime_approvals
     SET status = $2,
         decided_by_user_id = $3,
         decided_by_username = $4,
         decision_comment = $5,
         decided_at = now(),
         approval_expires_at = CASE WHEN $2 = 'approved' THEN now() + interval '30 minutes' ELSE NULL END
     WHERE id = $1 AND status = 'pending'
       ${scope ? 'AND tenant_key = $6 AND workspace_key = $7' : ''}
     RETURNING *`,
    scope
      ? [id, status, reviewer.id, reviewer.username, comment, scope.tenantKey, scope.workspaceKey]
      : [id, status, reviewer.id, reviewer.username, comment],
  );
  return rows[0] ? { before, value: rows[0], fourEyesOverrideApplied: selfApproval } : null;
}

function runtimeApprovalScope(context: UserLifecycleAuditContext) {
  const workspaceKey = context.workspaceKey ?? 'default';
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

/**
 * Records the human decision in the same transaction as canonical evidence.
 * Arguments, reviewer comments and free-form reasons are deliberately omitted;
 * their stable digest/identifiers are sufficient to bind the decision.
 */
export async function decideRuntimeApprovalAudited(
  pool: pg.Pool,
  id: number,
  decision: 'approve' | 'reject',
  reviewer: { id: number; username: string },
  comment: string | null,
  allowSelfApproval: boolean,
  context: UserLifecycleAuditContext,
): Promise<AuditedRuntimeApprovalDecision> {
  const scope = runtimeApprovalScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'approval.runtime.decision', eventId: context.producerEventId },
    scope,
    async client => {
      const result = await decideRuntimeApprovalRecord(
        client, id, decision, reviewer, comment, allowSelfApproval, scope,
      );
      if (!result) {
        const existing = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM mcp_runtime_approvals
              WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3
           ) AS exists`,
          [id, scope.tenantKey, scope.workspaceKey],
        );
        throw existing.rows[0]?.exists
          ? new RuntimeApprovalDecisionError(
            'Runtime approval was already decided or consumed.', 409, 'RUNTIME_APPROVAL_ALREADY_DECIDED',
          )
          : new RuntimeApprovalDecisionError(
            'Runtime approval was not found.', 404, 'RUNTIME_APPROVAL_NOT_FOUND',
          );
      }
      return result;
    },
    result => ({
      ...scope,
      solution: 'argus.core',
      actor: context.actor,
      action: result.value.status === 'approved'
        ? 'approval.runtime.approved'
        : 'approval.runtime.rejected',
      outcome: 'success' as const,
      risk: result.value.risk_level,
      resource: { type: 'runtime_approval', id: String(result.value.id) },
      policy: {
        id: 'argus.runtime-approval',
        version: result.value.risk_model,
        decision: result.value.status,
      },
      approvalId: String(result.value.id),
      correlation: {
        requestId: context.requestId ?? context.producerEventId,
        rootRunId: result.value.workflow_execution_id == null
          ? null
          : String(result.value.workflow_execution_id),
      },
      payload: {
        before: { status: result.before.status },
        after: {
          status: result.value.status,
          approvalExpiresAt: result.value.approval_expires_at,
        },
        context: {
          subjectType: result.value.subject_type,
          subjectId: result.value.subject_type === 'workflow'
            ? result.value.workflow_id
            : result.value.agent_id,
          toolName: result.value.tool_name,
          toolArgsDigest: result.value.tool_args_hash,
          riskScore: result.value.risk_score,
          riskFactorIds: (Array.isArray(result.value.risk_factors)
            ? result.value.risk_factors
            : []).map(factor => factor.id).sort(),
          requestedByUserId: result.value.requested_by_user_id,
          fourEyesOverrideApplied: result.fourEyesOverrideApplied,
          freeFormText: 'excluded',
        },
      },
    }),
  );
  const committedApprovalId = Number(outcome.event.resource.id);
  if (!Number.isSafeInteger(committedApprovalId) || committedApprovalId < 1) {
    throw new Error('Canonical runtime approval event has an invalid resource id');
  }
  const expectedAction = decision === 'approve'
    ? 'approval.runtime.approved'
    : 'approval.runtime.rejected';
  if (outcome.event.action !== expectedAction) {
    throw new RuntimeApprovalDecisionError(
      'Canonical runtime approval event does not match the requested action',
      409,
      'RUNTIME_APPROVAL_IDEMPOTENCY_CONFLICT',
    );
  }
  const committedDecision = outcome.event.policy.decision;
  const expectedDecision = decision === 'approve' ? 'approved' : 'rejected';
  if (committedDecision !== expectedDecision) {
    throw new Error('Canonical runtime approval event does not match the requested decision');
  }
  const value = outcome.result?.value ?? await getRuntimeApproval(pool, committedApprovalId, scope);
  if (!value) {
    throw new RuntimeApprovalDecisionError(
      'Runtime approval was not found.', 404, 'RUNTIME_APPROVAL_NOT_FOUND',
    );
  }
  return {
    value,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
    decision: committedDecision,
  };
}
