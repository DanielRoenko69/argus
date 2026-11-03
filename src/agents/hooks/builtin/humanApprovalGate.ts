import type pg from 'pg';
import { logger } from '../../../lib/logger.js';
import type { ToolHook } from '../types.js';
import { isKnownWriteTool } from '../../../tools/dynamic/index.js';
import {
  resolveRuntimeApproval,
  type RuntimeApprovalResolution,
} from '../../../approvals/runtimeApprovalStore.js';
import { assessToolRisk, type RiskAssessment } from '../../../approvals/riskEngine.js';

// Tools that change real-world state outside the sandbox workspace. These
// require human oversight when the agent has human_oversight_required=true.
const SENSITIVE_TOOLS = new Set([
  'gitea_create_pr',
  'gitea_merge_pr',
  'gitea_close_pr',
  'jira_transition',
  'jira_create_issue',
  'helmrelease_deploy',
  'helmrelease_rollback',
  'jenkins_trigger_build',
  'k8s_apply',
  'k8s_delete',
  'confluence_create_page',
  'confluence_delete_page',
]);

/**
 * Hook factory — captures the DB pool so the hook itself stays a pure
 * stateless function. Use this from index.ts where the pool is available.
 */
type ApprovalResolver = (
  pool: pg.Pool,
  ctx: Parameters<NonNullable<ToolHook['preToolUse']>>[0],
  reason: string,
  assessment?: RiskAssessment,
) => Promise<RuntimeApprovalResolution>;

export function makeHumanApprovalGate(
  pool: pg.Pool,
  approvalResolver: ApprovalResolver = resolveRuntimeApproval,
): ToolHook {
  return {
    name: 'human-approval-gate',
    priority: 900, // after security + transformations, near the end
    description: 'Persists sensitive tool requests when human oversight is required. A short-lived approval is consumed exactly once when the exact action is retried.',
    async preToolUse(ctx) {
      // Gate built-in sensitive tools AND imported write-actions (is_write, surfaced via the warm set).
      const knownWrite = isKnownWriteTool(ctx.toolName);
      if (!SENSITIVE_TOOLS.has(ctx.toolName) && !knownWrite) return null;

      // Fail-open on DB errors — never block a tool because we can't reach DB.
      // Two oversight sources: the calling AGENT (interactive/worker runs) and
      // the calling WORKFLOW (audit #2 — workflow tool steps run with agentId=0,
      // so the agent check no-ops; the workflow flag covers them).
      let oversight = false;
      let subject = `agent '${ctx.agentName}'`;

      if (ctx.agentId > 0) {
        try {
          const { rows } = await pool.query<{ human_oversight_required: boolean }>(
            'SELECT human_oversight_required FROM mcp_agents WHERE id = $1',
            [ctx.agentId],
          );
          oversight = rows[0]?.human_oversight_required === true;
        } catch (err) {
          logger.warn({ err, agentId: ctx.agentId }, 'human-approval-gate: agent lookup failed — failing open');
          return null;
        }
      }

      if (!oversight && ctx.workflowId != null && ctx.workflowId > 0) {
        try {
          const { rows } = await pool.query<{ human_oversight_required: boolean }>(
            'SELECT human_oversight_required FROM mcp_workflows WHERE id = $1',
            [ctx.workflowId],
          );
          if (rows[0]?.human_oversight_required === true) {
            oversight = true;
            subject = `workflow #${ctx.workflowId}`;
          }
        } catch (err) {
          logger.warn({ err, workflowId: ctx.workflowId }, 'human-approval-gate: workflow lookup failed — failing open');
          return null;
        }
      }

      if (!oversight) return null;

      const reason = `Tool '${ctx.toolName}' requires human approval because ${subject} has human_oversight_required=true.`;
      const assessment = assessToolRisk({
        toolName: ctx.toolName,
        args: ctx.toolArgs,
        isWrite: knownWrite,
        humanOversight: true,
        subjectType: ctx.workflowId != null && ctx.workflowId > 0 ? 'workflow' : 'agent',
      });
      try {
        const resolution = await approvalResolver(pool, ctx, reason, assessment);
        if (resolution.decision === 'allow') {
          logger.info(
            { approvalId: resolution.requestId, tool: ctx.toolName, sessionId: ctx.sessionId },
            'Runtime approval consumed',
          );
          return null;
        }
        if (resolution.decision === 'rejected') {
          return {
            block: `Runtime approval #${resolution.requestId} was rejected for tool '${ctx.toolName}'.` +
              `${resolution.comment ? ` Reviewer feedback: ${resolution.comment}` : ''} Change the action or start a new run before retrying.`,
          };
        }
        return {
          block: `Runtime human approval #${resolution.requestId} is pending for tool '${ctx.toolName}' because ${subject} requires oversight. ` +
            `Argus assessed ${assessment.level} risk (${assessment.score}/100). ` +
            `Open the Argus Approval Inbox, review the exact arguments, then retry this action. ` +
            `Approved grants expire after 30 minutes and are consumed once.`,
          metadata: {
            approval: {
              approvalId: resolution.requestId,
              toolName: ctx.toolName,
              parameters: ctx.toolArgs,
              riskLevel: assessment.level,
              riskScore: assessment.score,
              riskFactors: assessment.factors,
              reason,
              sessionId: ctx.sessionId,
            },
          },
        };
      } catch (err) {
        logger.error({ err, tool: ctx.toolName, sessionId: ctx.sessionId }, 'Runtime approval persistence failed');
        return {
          block: `Tool '${ctx.toolName}' requires human approval, but the approval service is unavailable. ` +
            `The action was blocked safely; retry when Argus governance storage is healthy.`,
        };
      }
    },
  };
}
