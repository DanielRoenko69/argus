/**
 * Hooked Tool Runner — routes EVERY non-agent tool-invocation path through the
 * same tool-execution hook pipeline that agentRunner/claudeRunner enforce.
 *
 * SECURITY (audit 2026-06-12, finding #1 — "one safety layer, three doors"):
 * The shared hook chain (destructive-cmd, pii-pre-write, cost-budget,
 * user-policy, production-cluster, external-policy and human-approval) used to
 * fire ONLY inside the two agent runners. `executeTool()` at the actual tool
 * boundary enforced nothing, so a workflow `argus.tool` step, a cron/webhook
 * trigger, the raw `/mcp` tool path, and the legacy admin /run endpoint could
 * all run `workspace_exec rm -rf …`, `k8s_apply`, `helmrelease_deploy`, or
 * write PII with no destructive-command block and no approval. Wrapping the
 * ToolRunner here closes that hole once for all four wiring sites.
 *
 * Notes on the synthetic hook context:
 *  - agentId = 0: workflows/MCP clients have no agent. production-cluster-guard
 *    looks up mcp_agents by id; id 0 → no row → it fails open (allow).
 *    human-approval-gate ALSO honours a WORKFLOW-level oversight flag (audit #2):
 *    when `workflowId` is threaded in and that workflow has
 *    human_oversight_required=true, sensitive tools are blocked even with no
 *    agent. destructive-cmd-guard, pii-pre-write-guard, cost-budget-guard and
 *    (when a userId is threaded in) user-policy-gate DO fire on these paths.
 *  - userId/userGroups are populated on the interactive builder-execute path
 *    (the request is SSO/RBAC-authenticated). Cron/webhook/MCP paths have no
 *    end-user identity → undefined → user-policy-gate allows (its API-key
 *    branch), which is the documented service-identity behaviour.
 */

import type pg from 'pg';
import type { Config } from '../config/env.js';
import { runPreToolHooks, runPostToolHooks, type HookContext } from '../agents/hooks/index.js';
import type { ToolRunner, StepCredOverride } from './types.js';
import { getCurrentCallingUser, withRequestContext } from '../lib/requestContext.js';

export interface HookedRunnerIdentity {
  /** Human-readable origin label used as the hook context's agentName + audit tag. */
  source: string;
  /** Synthetic session id — isolates cost-budget counters + audit per run. */
  sessionId: string;
  /** Argus user id when the caller is SSO/RBAC-authenticated (interactive path). */
  userId?: number;
  /** Entra group object-ids of the calling user, when known. */
  userGroups?: string[];
  /** API-key prefix for direct MCP callers; full keys are never propagated. */
  apiKeyPrefix?: string | null;
  /**
   * Workflow id whose steps drive these tool calls. Threaded into the hook
   * context so the human-approval-gate can enforce workflow-level oversight
   * (audit #2). Undefined for the raw /mcp path (no workflow).
   */
  workflowId?: number;
  /** Persisted workflow execution, used for checkpoint/resume linking. */
  workflowExecutionId?: number;
}

/**
 * Wrap a ToolRunner with the pre/post tool-execution hook pipeline. On a `block`
 * decision the call fails CLOSED: the inner runner is never invoked and the hook
 * reason is returned as an error tool-result (`[hook:<name>] <reason>`), exactly
 * as agentRunner surfaces it so the executor treats the step as failed.
 *
 * @param inner Optional pre-existing runner to wrap (e.g. the /mcp path's
 *   RBAC-tool-filtered runner). Defaults to a direct executeTool call.
 */
export function makeHookedToolRunner(
  pool: pg.Pool,
  config: Config,
  identity: HookedRunnerIdentity,
  inner?: ToolRunner,
): ToolRunner {
  // Lazy import of executeTool so merely importing this module does NOT pull
  // the whole tool dependency chain (toolRunner → ragTools …), which uses a
  // top-level dynamic import that breaks jest module-load. Production supports
  // the dynamic import; tests always pass `inner`, so this branch is never hit
  // under jest.
  const run: ToolRunner =
    inner ?? (async (name, args, credOverride) => {
      const { executeTool } = await import('../tools/toolRunner.js');
      return executeTool(name, args, { config, pool }, credOverride);
    });

  return async (toolName, args, credOverride?: StepCredOverride, executionMeta?: { stepId?: string }) => {
    const hookCtx: HookContext = {
      agentId: 0,
      agentName: identity.source,
      sessionId: identity.sessionId,
      toolName,
      toolArgs: args,
      iteration: 1,
      agentDepth: 0,
      userId: identity.userId,
      userGroups: identity.userGroups,
      apiKeyPrefix: identity.apiKeyPrefix ?? null,
      workflowId: identity.workflowId,
      workflowExecutionId: identity.workflowExecutionId,
      workflowStepId: executionMeta?.stepId,
    };

    const pre = await runPreToolHooks(pool, hookCtx);
    if (pre.decision === 'block') {
      const approvalMatch = pre.hookName === 'human-approval-gate'
        ? /(?:human )?approval #(\d+)/i.exec(pre.reason ?? '')
        : null;
      // Fail closed — do NOT run the tool.
      return {
        content: [{ type: 'text' as const, text: `[hook:${pre.hookName}] ${pre.reason}` }],
        isError: true,
        ...(approvalMatch ? { approvalRequestId: Number(approvalMatch[1]) } : {}),
      };
    }

    const finalArgs =
      pre.decision === 'modify' && pre.modifiedArgs ? pre.modifiedArgs : args;

    let result: Awaited<ReturnType<ToolRunner>>;
    let isError = false;
    try {
      const current = getCurrentCallingUser();
      // The execution's verified identity wins over the ambient request (resume,
      // scheduled work and admin approval must not silently change the actor).
      const callingUser = identity.userId === undefined ? undefined
        : current?.id === identity.userId ? current
        : { id: identity.userId, entra_groups: identity.userGroups };
      result = await withRequestContext({ callingUser }, () => run(toolName, finalArgs, credOverride));
      isError = Boolean(result.isError);
    } catch (err) {
      isError = true;
      result = {
        content: [
          { type: 'text' as const, text: `Tool execution failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
        isError: true,
      };
    }

    // Post-hooks are observability-only (cannot block) — mirror agentRunner.
    await runPostToolHooks(pool, {
      ...hookCtx,
      toolArgs: finalArgs,
      toolResult: result.content.map((c) => c.text).join('\n'),
      toolIsError: isError,
    });

    return result;
  };
}
