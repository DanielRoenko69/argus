/**
 * Visual Workflow Builder — execute + SSE routes.
 *
 *   POST /api/workflows/:id/execute              → starts execution, returns { executionId }
 *   GET  /api/workflows/:id/executions/:eid/stream → SSE: started | completed | failed | done events
 *
 * The execution runs in the background; live events fan out through an in-memory
 * EventEmitter so the SSE handler can stream them. Events are buffered per-execution
 * so a late client connection still gets the full event history.
 */

import type { Express, Request, Response } from 'express';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import {
  executeWorkflow,
  type StepEvent,
  type StepRunners,
  type SubWorkflowExecutionEvidence,
  MAX_SUBWORKFLOW_DEPTH,
  SubWorkflowExecutionError,
} from './executor.js';
import { makeHookedToolRunner } from './hookedToolRunner.js';
import { notifySubscribers } from './subscriberRoutes.js';
import type {
  WorkflowExecutionRow,
  WorkflowRow,
  WorkflowStep,
  WorkflowStatus,
  ToolRunner,
  StepCredOverride,
} from './types.js';
import type { Config } from '../config/env.js';
import { getRbacUser, isAdmin, type RbacUser } from './rbacHelpers.js';
import { resolveBundleBackendReference } from './backendCredsStore.js';
import { runAgentChatSync } from '../agents/agentRunner.js';
import { agentAccessGate, createSession, type AgentAccessUser } from '../agents/agentStore.js';
import { getSkill } from '../agents/skillStore.js';
import { retrieveMemories, storeMemory } from '../agents/memory.js';
import { formatRagContext } from '../agents/ragClient.js';
import { searchRagIndex } from '../agents/ragSearch.js';
import {
  AGENT_OUTPUT_CONTRACT_ARG,
  isAgentOutputContractName,
  mockAgentOutputForContract,
} from './agentOutputContracts.js';
import type { RagIndex } from '../agents/types.js';
import { getRuntimeApproval, resolveRuntimeApproval } from '../approvals/runtimeApprovalStore.js';
import {
  dispatchRuntimeApprovalDecision,
  registerRuntimeApprovalDecisionHandler,
} from './runtimeResumeCoordinator.js';
import { persistExecutionResult } from './executionPersistence.js';
import {
  applyWorkflowAgentAssignments,
  applyWorkflowAgentSnapshot,
  preflightWorkflowAgents,
  workflowExecutionSnapshot,
} from './agentContracts.js';
import { buildWorkflowRetryPlan } from './executionRetry.js';
import { resolveRetryableForEachItem } from './childExecutionRetry.js';
import { getNativeTelemetryContext, workflowTelemetryTraceId } from '../observability/telemetryStore.js';
import { enforceHumanAiActProductionGate } from './aiActExecutionGate.js';
import { markGoldenPathRetryStarted } from '../goldenPath/runStore.js';
import {
  LEGACY_WORKFLOW_SCOPE,
  type WorkflowScope,
} from './workflowStore.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
} from '../auth/workspaceScope.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';

// ── per-execution event broker ──────────────────────────────────
interface ExecutionTracker {
  emitter: EventEmitter;
  buffer: BroadcastEvent[];        // replay buffer for late subscribers
  finished: boolean;
  finalStatus?: 'waiting_for_approval' | 'completed' | 'failed';
  finalError?: string;
}
type BroadcastEvent = ({ event: 'step' } & StepEvent) | {
  event: 'done';
  status: 'waiting_for_approval' | 'completed' | 'failed';
  error?: string;
};
const trackers = new Map<number, ExecutionTracker>();

interface ChildRetrySourceRow extends pg.QueryResultRow {
  id: number | string;
  workflow_id: number;
  status: WorkflowStatus;
  input_args: Record<string, unknown>;
}

interface SourceAiSystemRunBindingRow extends pg.QueryResultRow {
  ai_system_id: string;
  ai_system_revision: number;
  production: boolean;
}

function emit(tracker: ExecutionTracker, ev: BroadcastEvent): void {
  tracker.buffer.push(ev);
  // Cap buffer at 1000 events to bound memory
  if (tracker.buffer.length > 1000) tracker.buffer.shift();
  tracker.emitter.emit('event', ev);
}

/**
 * Build real Argus step-runners. Each runner translates a visual-builder
 * step (argus.agent / .skill / .knowledge / .memory) into the corresponding
 * Argus backend call and returns a string result that becomes the step's
 * `result` in the executor context (and is template-available via
 * `{{ steps.<id>.result }}` in downstream steps).
 */
export function buildRealRunners(
  pool: pg.Pool,
  config: Config,
  toolRunnerRef: ToolRunner,
  callStack: Set<number> = new Set(),
  depth: number = 0,
  // audit #11: SSO identity of the user who triggered this run. Threaded into
  // agent steps so the user-policy-gate hook can enforce per-user tool policy.
  // undefined for cron/webhook (service identity) — gate then allows (its
  // API-key branch), the documented service-identity behaviour.
  callingUser?: AgentAccessUser,
  // audit M4: factory that builds a hook-wrapped ToolRunner bound to a SPECIFIC
  // workflowId. Used so a sub-workflow's tool steps carry the SUB-workflow's id
  // (not the parent's) into the human-approval-gate — otherwise a sub-workflow
  // flagged human_oversight_required=true runs sensitive tools unguarded when
  // invoked by a non-flagged parent. Optional → falls back to toolRunnerRef.
  makeWorkflowToolRunner?: (workflowId: number, executionId?: number) => ToolRunner,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): StepRunners {
  return {
    approvalRunner: async ({ workflowId, executionId, stepId, message }) => {
      return resolveRuntimeApproval(
        pool,
        {
          agentId: 0,
          agentName: 'visual-workflow',
          sessionId: `workflow:${executionId}:approval`,
          toolName: 'workflow_explicit_approval',
          toolArgs: {
            workflow_execution_id: executionId,
            workflow_step_id: stepId,
            message,
          },
          iteration: 1,
          agentDepth: 0,
          userId: callingUser?.id,
          userGroups: callingUser?.entra_groups,
          workflowId,
          workflowExecutionId: executionId,
          workflowStepId: stepId,
        },
        `Workflow #${workflowId} requires explicit human approval at step '${stepId}': ${message}`,
      );
    },

    agentRunner: async (agentId, prompt, args) => {
      // Per-role gate for session-triggered runs (mirror the HTTP routes). For
      // cron/webhook triggers callingUser is undefined (service identity) → skip,
      // consistent with the API-key exemption on /chat + /runs.
      if (callingUser) {
        const gate = await agentAccessGate(pool, agentId, callingUser);
        if (gate.verdict === 'not_found') throw new Error(`agent #${agentId} not found`);
        if (gate.verdict === 'forbidden') throw new Error(`agent #${agentId} not permitted for this caller`);
      }
      // Synthetic sessionId per builder-execution so each run is isolated
      const sessionId = `builder-${randomUUID()}`;
      // runAgentChatSync intentionally requires an existing persisted session
      // (the interactive HTTP route creates one before invoking it). Real
      // visual/triggered workflow runs must honor the same contract; otherwise
      // every argus.agent step fails with "Session ... not found" while mock
      // executions appear healthy.
      await createSession(pool, agentId, sessionId, callingUser?.id);
      // Item 3: optional per-step subset of the agent's bound RAG indexes.
      // Empty / absent → undefined → runner uses ALL bound indexes (unchanged).
      const rawIds = (args as { rag_index_ids?: unknown })?.rag_index_ids;
      const ragIndexIds = Array.isArray(rawIds)
        ? rawIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
        : undefined;
      const result = await runAgentChatSync(
        agentId, sessionId, prompt, pool, config,
        ragIndexIds && ragIndexIds.length > 0 ? ragIndexIds : undefined,
        callingUser,
      );
      return result.response;
    },

    skillRunner: async (skillId) => {
      const skill = await getSkill(pool, skillId);
      if (!skill) throw new Error(`skill #${skillId} not found`);
      return skill.content;
    },

    ragRunner: async (indexName, query, topK) => {
      const normalizedName = indexName.trim();
      if (!normalizedName) throw new Error('argus.knowledge requires an index_name');
      if (!query.trim()) throw new Error('argus.knowledge requires a query');

      // Resolve the complete provider configuration. `searchRagIndex` then
      // dispatches through the shared Knowledge provider registry, keeping
      // workflow retrieval identical to Agent Chat, the playground and evals.
      const { rows } = await pool.query<RagIndex>(
        `SELECT id, name, label, description, provider, endpoint, index_name,
                api_key, semantic_config, top_k, enabled, created_at, updated_at,
                vector_field, adapter_config, hyde_enabled
         FROM mcp_rag_indexes
         WHERE name = $1 AND enabled = true
         LIMIT 1`,
        [normalizedName]
      );
      const idx = rows[0];
      if (!idx) throw new Error(`rag index '${normalizedName}' not found or disabled`);

      // Override the configured top_k with a bounded per-step value. Invalid
      // values fall back to the source default instead of reaching a provider.
      const requestedTopK = Number.isFinite(topK) ? Math.trunc(topK) : idx.top_k;
      const effectiveTopK = Math.min(20, Math.max(1, requestedTopK || idx.top_k || 5));
      const index: RagIndex = { ...idx, top_k: effectiveTopK };
      const results = await searchRagIndex(index, query, pool);
      return formatRagContext(results, idx.label);
    },

    memoryRunner: async (op, args) => {
      const agentId = Number(args['agent_id'] ?? 0);
      if (!agentId) throw new Error(`argus.memory requires agent_id in args`);
      if (op === 'retrieve') {
        const query = String(args['query'] ?? '');
        const memories = await retrieveMemories(pool, agentId, query, Number(args['top_k'] ?? 5));
        return memories.map((m) => `[${m.memory_type}] ${m.content}`).join('\n');
      }
      if (op === 'store') {
        const sessionId = String(args['session_id'] ?? `builder-${randomUUID()}`);
        const kind = String(args['kind'] ?? 'semantic') as 'semantic' | 'episodic' | 'procedural' | 'working';
        await storeMemory(
          pool, agentId, sessionId, String(args['content'] ?? ''), kind,
          Number(args['importance'] ?? 0.5),
        );
        return 'stored';
      }
      throw new Error(`unsupported memory op: ${op}`);
    },

    subWorkflowRunner: async (targetId, inputs, invocation) => {
      // Cycle protection: targetId already in the active call stack → reject.
      if (callStack.has(targetId)) {
        throw new Error(`sub-workflow cycle detected: workflow #${targetId} is already on the call stack`);
      }
      if (depth >= MAX_SUBWORKFLOW_DEPTH) {
        throw new Error(`sub-workflow recursion limit reached (max ${MAX_SUBWORKFLOW_DEPTH})`);
      }
      const { rows } = await pool.query<WorkflowRow>(
        `SELECT id, name, description, steps, input_params, enabled, agent_requirements
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
        [targetId, scope.tenantKey, scope.workspaceKey]
      );
      const target = rows[0];
      if (!target) throw new Error(`sub-workflow #${targetId} not found`);
      if (!target.enabled) throw new Error(`sub-workflow #${targetId} is disabled`);
      const targetPreflight = await preflightWorkflowAgents(pool, target);
      if (!targetPreflight.ready) {
        throw new Error(`sub-workflow #${targetId} Agent contract is not ready: ${targetPreflight.blockers.join('; ')}`);
      }
      const resolvedTarget = applyWorkflowAgentAssignments(target, targetPreflight);

      const ambientTelemetry = getNativeTelemetryContext();

      // Persist a first-class child execution relation. The parent identifiers
      // remain queryable even when the parent's bounded result preview expires.
      const rawSubExecutionId = (await pool.query<{ id: number | string }>(
        `INSERT INTO mcp_workflow_executions (
           workflow_id, status, triggered_by, input_args, execution_snapshot,
           parent_execution_id, parent_step_id, parent_item_index,
           retry_of_execution_id, tenant_key, workspace_key
         )
         VALUES ($1, 'running', $2, $3::jsonb, $4::jsonb, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          targetId,
          `sub-workflow:depth-${depth + 1}`,
          JSON.stringify(inputs),
          JSON.stringify(workflowExecutionSnapshot(targetPreflight)),
          invocation?.parentExecutionId ?? ambientTelemetry?.workflowExecutionId ?? null,
          invocation?.parentStepId ?? ambientTelemetry?.workflowStepId ?? null,
          invocation?.itemIndex ?? null,
          invocation?.retryOfExecutionId ?? null,
          scope.tenantKey,
          scope.workspaceKey,
        ]
      )).rows[0]!.id;
      const subExecutionId = Number(rawSubExecutionId);
      if (!Number.isSafeInteger(subExecutionId) || subExecutionId <= 0) {
        throw new Error(`sub-workflow #${targetId} returned an invalid persisted execution id`);
      }
      const persistedChildTraceId = workflowTelemetryTraceId(subExecutionId);
      const rootTraceId = ambientTelemetry?.rootTraceId ?? persistedChildTraceId;
      const evidence = (status: WorkflowStatus) => ({
        workflow_id: targetId,
        execution_id: subExecutionId,
        trace_id: persistedChildTraceId,
        root_trace_id: rootTraceId,
        status,
      });
      invocation?.onExecutionCreated?.(evidence('running'));

      // Build nested runners with the deeper call stack + depth.
      // audit M4: bind the sub-workflow's tool runner to ITS OWN id so the
      // human-approval-gate sees the sub-workflow's human_oversight_required,
      // not the parent's. Falls back to the parent runner when no factory given.
      const nextStack = new Set(callStack);
      nextStack.add(targetId);
      const subToolRunner = makeWorkflowToolRunner
        ? makeWorkflowToolRunner(targetId, subExecutionId)
        : toolRunnerRef;
      const nestedRunners = buildRealRunners(
        pool,
        config,
        subToolRunner,
        nextStack,
        depth + 1,
        callingUser,
        makeWorkflowToolRunner,
        scope,
      );

      const result = await executeWorkflow({
        workflow: { ...resolvedTarget, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
        inputs,
        toolRunner: subToolRunner,
        runners: nestedRunners,
        executionId: subExecutionId,
        triggeredBy: `sub-workflow:depth-${depth + 1}`,
        telemetryUserId: callingUser?.id,
      });
      await persistExecutionResult(pool, subExecutionId, result);
      if (result.status !== 'completed') {
        throw new SubWorkflowExecutionError(
          `sub-workflow #${targetId} ${result.status}${result.error ? `: ${result.error}` : ''}`,
          evidence(result.status),
        );
      }
      // Return the rendered "response" of the sub-workflow if present, else
      // concatenate all step results.
      const responseStep = Object.entries(result.stepResults).find(
        ([sid]) => resolvedTarget.steps.find((s) => s.id === sid)?.type === 'logic.response'
      );
      if (responseStep) {
        const r = responseStep[1] as { result?: unknown };
        return { output: r?.result ?? '', evidence: evidence(result.status) };
      }
      return { output: result.stepResults, evidence: evidence(result.status) };
    },
  };
}

export interface WorkflowExecutionTriggerEvidence {
  source: string;
  event_id: string;
  event_type: string;
  received_at: string;
  payload_sha256: string;
  event_id_source?: string;
  path?: string;
}

export interface StartWorkflowExecutionInput {
  workflowId: number;
  /** Server-resolved ownership boundary. Trusted legacy callers default to default/default. */
  scope?: WorkflowScope;
  inputs: Record<string, unknown>;
  mockMode?: boolean;
  user: RbacUser;
  source?: 'builder' | 'golden-path';
  triggerEvidence?: WorkflowExecutionTriggerEvidence;
}

export interface StartWorkflowExecutionResult {
  executionId: number;
  traceId: string;
  replayed: boolean;
}

export class WorkflowExecutionStartError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkflowExecutionStartError';
  }
}

function makeExecutionCredResolver(pool: pg.Pool, user: RbacUser) {
  return async (step: WorkflowStep): Promise<StepCredOverride | null> => {
    const ref = step.cred_ref;
    if (!ref || typeof ref.bundle_id !== 'number') return null;
    if (credRefBundleDenied(user, ref)) {
      throw new Error(`cred_ref bundle #${ref.bundle_id} not accessible to ${user.username ?? 'identity'}`);
    }
    const backendId = await resolveBundleBackendReference(pool, ref.bundle_id, ref.backend_cred_id);
    return { token: null, backendId };
  };
}

/**
 * Starts the authoritative visual workflow executor without going through an
 * internal HTTP request. Builder, Golden Path and future trusted producers can
 * therefore share RBAC, Agent preflight, MCP hooks, approval checkpoints,
 * persistence and telemetry.
 */
export async function startWorkflowExecution(
  pool: pg.Pool,
  config: Config,
  toolRunner: ToolRunner,
  input: StartWorkflowExecutionInput,
): Promise<StartWorkflowExecutionResult> {
  const wfId = input.workflowId;
  const inputs = input.inputs;
  const mockMode = input.mockMode === true;
  const user = input.user;
  const source = input.source ?? 'builder';
  const scope = input.scope ?? LEGACY_WORKFLOW_SCOPE;

  if (!Number.isSafeInteger(wfId) || wfId <= 0) {
    throw new WorkflowExecutionStartError(400, 'WORKFLOW_ID_INVALID', 'invalid workflow id');
  }

  let workflow: WorkflowRow | undefined;
  try {
    let sql = `SELECT id, name, description, steps, input_params, enabled, agent_requirements,
                      human_oversight_required, lifecycle_status, ai_act_governed,
                      ai_system_id, ai_system_revision
       FROM mcp_workflows
       WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
    const params: unknown[] = [wfId, scope.tenantKey, scope.workspaceKey];
    if (!isAdmin(user)) {
      sql += ` AND (
        NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
        OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
      )`;
      params.push(user.allowed_bundles ?? []);
    }
    workflow = (await pool.query<WorkflowRow>(sql, params)).rows[0];
  } catch (error) {
    logger.error({ err: error, wfId, source }, 'workflow start: failed to load workflow');
    throw new WorkflowExecutionStartError(500, 'WORKFLOW_DATABASE_ERROR', 'database error');
  }
  if (!workflow) throw new WorkflowExecutionStartError(404, 'WORKFLOW_NOT_FOUND', 'workflow not found');
  if (!workflow.enabled) throw new WorkflowExecutionStartError(409, 'WORKFLOW_DISABLED', 'workflow disabled');
  if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
    throw new WorkflowExecutionStartError(400, 'WORKFLOW_EMPTY', 'workflow has no steps');
  }

  const agentPreflight = await preflightWorkflowAgents(pool, workflow, { probeRuntime: !mockMode });
  if (!agentPreflight.ready) {
    throw new WorkflowExecutionStartError(409, 'WORKFLOW_AGENT_NOT_READY', 'Workflow Agent contract is not ready', {
      preflight: agentPreflight,
    });
  }
  const resolvedWorkflow = applyWorkflowAgentAssignments(workflow, agentPreflight);
  if (!isAdmin(user)) {
    const denied = await findInaccessibleStepRefs(pool, workflow.steps, user);
    if (denied.length > 0) {
      throw new WorkflowExecutionStartError(403, 'WORKFLOW_RESOURCE_FORBIDDEN', 'workflow references resources you cannot access', {
        inaccessible: denied,
      });
    }
  }

  let executionId: number;
  let replayed = false;
  try {
    const triggeredBy = `${source}:${user.username ?? 'anonymous'}`.slice(0, 128);
    const triggerEvidence = input.triggerEvidence ?? null;
    const inserted = await pool.query<{ id: number | string }>(
      `INSERT INTO mcp_workflow_executions
         (workflow_id, status, triggered_by, input_args, execution_snapshot, trigger_evidence,
          tenant_key, workspace_key)
       VALUES ($1, 'running', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
       ON CONFLICT (
         workflow_id,
         (trigger_evidence->>'source'),
         (trigger_evidence->>'event_id')
       ) WHERE trigger_evidence ? 'event_id' AND trigger_evidence->>'event_id' <> ''
       DO NOTHING
       RETURNING id`,
      [
        wfId,
        triggeredBy,
        JSON.stringify(inputs),
        JSON.stringify(workflowExecutionSnapshot(agentPreflight)),
        JSON.stringify(triggerEvidence ?? {}),
        scope.tenantKey,
        scope.workspaceKey,
      ],
    );
    const insertedId = inserted.rows[0]?.id;
    if (insertedId == null && triggerEvidence) {
      const existing = await pool.query<{ id: number | string }>(
        `SELECT id
           FROM mcp_workflow_executions
          WHERE workflow_id=$1
            AND trigger_evidence->>'source'=$2
            AND trigger_evidence->>'event_id'=$3
            AND tenant_key=$4
            AND workspace_key=$5
          LIMIT 1`,
        [wfId, triggerEvidence.source, triggerEvidence.event_id, scope.tenantKey, scope.workspaceKey],
      );
      if (existing.rows[0]?.id == null) throw new Error('idempotent workflow execution could not be resolved');
      executionId = Number(existing.rows[0].id);
      replayed = true;
    } else {
      executionId = Number(insertedId);
    }
    if (!Number.isSafeInteger(executionId) || executionId <= 0) throw new Error('invalid persisted execution id');
  } catch (error) {
    logger.error({ err: error, wfId, source }, 'workflow start: failed to persist execution');
    throw new WorkflowExecutionStartError(500, 'WORKFLOW_DATABASE_ERROR', 'database error');
  }

  const traceId = workflowTelemetryTraceId(executionId);
  if (replayed) return { executionId, traceId, replayed: true };

  if (!mockMode && workflow.lifecycle_status === 'production' && workflow.ai_act_governed) {
    const gate = await enforceHumanAiActProductionGate(pool, {
      executionId,
      target: { aiSystemId: workflow.ai_system_id, aiSystemRevision: workflow.ai_system_revision },
      user,
      source,
    });
    if (!gate.authorized) {
      throw new WorkflowExecutionStartError(409, 'AI_SYSTEM_PRODUCTION_GATE_BLOCKED', gate.message ?? 'AI-system production gate blocked execution', {
        executionId,
        bindingId: gate.bindingId,
      });
    }
  }

  const tracker: ExecutionTracker = { emitter: new EventEmitter(), buffer: [], finished: false };
  trackers.set(executionId, tracker);
  await pool.query(
    `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
     VALUES ($1, $2, $3::jsonb, false)`,
    [
      `${source}:${(user.username ?? '').slice(0, 8)}`,
      'workflow_execution_started',
      JSON.stringify({
        workflow_id: wfId,
        execution_id: executionId,
        user_id: user.id,
        username: user.username,
        role: user.role,
        source,
        tenant_key: scope.tenantKey,
        workspace_key: scope.workspaceKey,
      }),
    ],
  ).catch(error => logger.warn({ err: error, executionId }, 'Failed to append workflow start audit'));

  const callingUser = user.id != null
    ? { id: user.id, entra_groups: user.entra_groups ?? [], role: user.role, allowed_bundles: user.allowed_bundles }
    : undefined;
  const hookedToolRunner = makeHookedToolRunner(pool, config, {
    source,
    sessionId: `${source}:${executionId}`,
    userId: callingUser?.id,
    userGroups: callingUser?.entra_groups,
    workflowId: wfId,
    workflowExecutionId: executionId,
  }, toolRunner);
  const makeWfRunner = (workflowId: number, nestedExecutionId?: number) => makeHookedToolRunner(pool, config, {
    source,
    sessionId: `${source}:${nestedExecutionId ?? executionId}:wf${workflowId}`,
    userId: callingUser?.id,
    userGroups: callingUser?.entra_groups,
    workflowId,
    workflowExecutionId: nestedExecutionId ?? executionId,
  }, toolRunner);
  const requestRunners = buildRealRunners(
    pool,
    config,
    hookedToolRunner,
    new Set(),
    0,
    callingUser,
    makeWfRunner,
    scope,
  );

  void (async () => {
    try {
      const result = await executeWorkflow({
        workflow: { ...resolvedWorkflow, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
        inputs,
        toolRunner: mockMode
          ? (async (name, args) => ({ content: [{ type: 'text' as const, text: `[mock] tool=${name} args=${JSON.stringify(args).slice(0, 80)}` }] }))
          : hookedToolRunner,
        runners: mockMode ? {
          agentRunner: async (id, prompt, args) => {
            const outputContract = args[AGENT_OUTPUT_CONTRACT_ARG];
            return isAgentOutputContractName(outputContract)
              ? mockAgentOutputForContract(outputContract, id)
              : `[mock] agent #${id} prompt-len=${prompt.length}`;
          },
          skillRunner: async id => `[mock] skill #${id}`,
          ragRunner: async (index, query) => `[mock] rag(${index}, "${query.slice(0, 40)}…")`,
          memoryRunner: async operation => `[mock] memory.${operation}`,
          subWorkflowRunner: async id => `[mock] sub-workflow #${id}`,
        } : requestRunners,
        executionId,
        telemetryUserId: callingUser?.id,
        triggeredBy: `${mockMode ? `mock-${source}` : source}:${user.username ?? 'anonymous'}`,
        onStepEvent: (event: StepEvent) => emit(tracker, { event: 'step', ...event }),
        credResolver: mockMode ? undefined : makeExecutionCredResolver(pool, user),
      });
      await persistExecutionResult(pool, executionId, result);
      tracker.finished = true;
      tracker.finalStatus = result.status === 'completed'
        ? 'completed'
        : result.status === 'waiting_for_approval' ? 'waiting_for_approval' : 'failed';
      if (result.error) tracker.finalError = result.error;
      emit(tracker, { event: 'done', status: tracker.finalStatus, error: result.error });
      if (result.status === 'waiting_for_approval' && result.approvalRequestId) {
        const approval = await getRuntimeApproval(pool, result.approvalRequestId);
        if (approval?.status === 'approved') dispatchRuntimeApprovalDecision(approval.id, 'approved');
        else if (approval?.status === 'rejected') dispatchRuntimeApprovalDecision(approval.id, 'rejected');
      } else {
        void notifySubscribers(pool, wfId, result.status === 'completed' ? 'completed' : 'failed', executionId, result.error);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: message, executionId, source }, 'workflow execution threw');
      await pool.query(
        `UPDATE mcp_workflow_executions SET status='failed', completed_at=now(), error_message=$2
          WHERE id=$1 AND tenant_key=$3 AND workspace_key=$4`,
        [executionId, message, scope.tenantKey, scope.workspaceKey],
      ).catch(() => {});
      tracker.finished = true;
      tracker.finalStatus = 'failed';
      tracker.finalError = message;
      emit(tracker, { event: 'done', status: 'failed', error: message });
    } finally {
      setTimeout(() => trackers.delete(executionId), 60_000);
    }
  })();

  return { executionId, traceId, replayed: false };
}

export function registerExecuteRoutes(
  app: Express,
  pool: pg.Pool,
  config: Config,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
  toolRunner: ToolRunner,
): void {
  // NOTE: the tool runner + step runners are now built PER REQUEST inside the
  // handler so they carry the calling user's identity (audit #1 hooks + #11
  // per-user policy). `toolRunner` here is the base (executeTool) runner that
  // gets wrapped by makeHookedToolRunner per execution.
  const requestScope = (req: Request, res: Response): WorkflowScope | null => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      return resolveAuthorizedWorkspaceScope(req, user);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return null;
      }
      throw error;
    }
  };

  const handleRuntimeDecision = async (
    approvalId: number,
    decision: 'approved' | 'rejected',
    attempt = 0,
  ): Promise<void> => {
    const approval = await getRuntimeApproval(pool, approvalId);
    if (!approval?.workflow_execution_id) return;
    const approvalScope = {
      tenantKey: approval.tenant_key ?? LEGACY_WORKFLOW_SCOPE.tenantKey,
      workspaceKey: approval.workspace_key ?? LEGACY_WORKFLOW_SCOPE.workspaceKey,
    };
    // PostgreSQL BIGINT values are returned as strings by node-postgres. Keep
    // the runtime identity canonical across the initial execution and resume:
    // approval grant keys include workflow_execution_id in their hashed args,
    // so `2` and `"2"` would otherwise create two distinct approval requests.
    const executionId = Number(approval.workflow_execution_id);
    if (!Number.isSafeInteger(executionId) || executionId <= 0) {
      logger.error(
        { approvalId, workflowExecutionId: approval.workflow_execution_id },
        'Runtime approval references an invalid workflow execution id',
      );
      return;
    }

    if (decision === 'rejected') {
      await pool.query(
        `UPDATE mcp_workflow_executions
         SET status = 'cancelled',
             completed_at = now(),
             error_message = $2,
             waiting_approval_id = NULL,
             waiting_step_id = NULL
         WHERE id = $1
           AND status = 'waiting_for_approval'
           AND waiting_approval_id = $3
           AND tenant_key = $4 AND workspace_key = $5`,
        [
          executionId,
          `Runtime approval #${approvalId} was rejected${approval.decision_comment ? `: ${approval.decision_comment}` : ''}`,
          approvalId,
          approvalScope.tenantKey,
          approvalScope.workspaceKey,
        ],
      );
      logger.info({ executionId, approvalId }, 'Waiting workflow cancelled after rejected approval');
      return;
    }

    const claimed = await pool.query<WorkflowExecutionRow>(
      `UPDATE mcp_workflow_executions
       SET status = 'running',
           completed_at = NULL,
           error_message = NULL,
           resume_count = resume_count + 1,
           resumed_at = now()
       WHERE id = $1
         AND status = 'waiting_for_approval'
         AND waiting_approval_id = $2
         AND tenant_key = $3 AND workspace_key = $4
       RETURNING *`,
      [executionId, approvalId, approvalScope.tenantKey, approvalScope.workspaceKey],
    );
    const execution = claimed.rows[0];
    if (!execution) {
      // A very fast reviewer can decide while the original parallel step group
      // is still settling. Retry briefly after its checkpoint is persisted.
      const state = await pool.query<{ status: string }>(
        `SELECT status FROM mcp_workflow_executions
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
        [executionId, approvalScope.tenantKey, approvalScope.workspaceKey],
      );
      if (state.rows[0]?.status === 'running' && attempt < 12) {
        setTimeout(() => {
          void handleRuntimeDecision(approvalId, decision, attempt + 1);
        }, 250).unref();
      }
      return;
    }

    const workflowResult = await pool.query<WorkflowRow>(
      `SELECT id, name, description, steps, input_params, enabled, human_oversight_required, agent_requirements
       FROM mcp_workflows
       WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
      [
        execution.workflow_id,
        execution.tenant_key ?? LEGACY_WORKFLOW_SCOPE.tenantKey,
        execution.workspace_key ?? LEGACY_WORKFLOW_SCOPE.workspaceKey,
      ],
    );
    const workflow = workflowResult.rows[0];
    if (!workflow || !workflow.enabled) {
      await pool.query(
        `UPDATE mcp_workflow_executions
         SET status = 'failed', completed_at = now(), error_message = $2
         WHERE id = $1 AND tenant_key = $3 AND workspace_key = $4`,
        [executionId, 'Workflow is missing or disabled; approval resume aborted', approvalScope.tenantKey, approvalScope.workspaceKey],
      );
      return;
    }

    const resolvedWorkflow = applyWorkflowAgentSnapshot(workflow, execution.execution_snapshot);

    const requestingUser = approval.requested_by_user_id == null
      ? null
      : (await pool.query<{
          id: number;
          username: string;
          role: string;
          allowed_bundles: number[] | null;
          entra_groups: string[];
        }>(
          `SELECT id, username, role, allowed_bundles, coalesce(entra_groups, ARRAY[]::text[]) AS entra_groups
           FROM mcp_users
           WHERE id = $1 AND enabled = true`,
          [approval.requested_by_user_id],
        )).rows[0] ?? null;
    const resumeUser: RbacUser = requestingUser ?? { allowed_bundles: null };
    const callingUser = requestingUser
      ? { id: requestingUser.id, entra_groups: requestingUser.entra_groups, role: requestingUser.role, allowed_bundles: requestingUser.allowed_bundles }
      : undefined;
    const resumeSession = `resume:${executionId}:${execution.resume_count ?? 1}`;
    const resumeToolRunner = makeHookedToolRunner(pool, config, {
      source: 'approval-resume',
      sessionId: resumeSession,
      userId: callingUser?.id,
      userGroups: callingUser?.entra_groups,
      workflowId: workflow.id,
      workflowExecutionId: executionId,
    }, toolRunner);
    const makeResumeWorkflowRunner = (workflowId: number, nestedExecutionId?: number) =>
      makeHookedToolRunner(pool, config, {
        source: 'approval-resume',
        sessionId: `resume:${nestedExecutionId ?? executionId}:wf${workflowId}`,
        userId: callingUser?.id,
        userGroups: callingUser?.entra_groups,
        workflowId,
        workflowExecutionId: nestedExecutionId ?? executionId,
      }, toolRunner);
    const resumeRunners = buildRealRunners(
      pool,
      config,
      resumeToolRunner,
      new Set([workflow.id]),
      0,
      callingUser,
      makeResumeWorkflowRunner,
    );
    const tracker: ExecutionTracker = { emitter: new EventEmitter(), buffer: [], finished: false };
    trackers.set(executionId, tracker);

    logger.info(
      { executionId, approvalId, waitingStepId: execution.waiting_step_id },
      'Resuming workflow from approval checkpoint',
    );
    const result = await executeWorkflow({
      workflow: { ...resolvedWorkflow, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
      inputs: execution.input_args ?? {},
      toolRunner: resumeToolRunner,
      runners: resumeRunners,
      executionId,
      triggeredBy: `approval:${approvalId}`,
      telemetryUserId: callingUser?.id,
      initialStepResults: execution.step_results ?? {},
      onStepEvent: (event: StepEvent) => emit(tracker, { event: 'step', ...event }),
      credResolver: makeExecutionCredResolver(pool, resumeUser),
    });
    await persistExecutionResult(pool, executionId, result);
    tracker.finished = true;
    tracker.finalStatus = result.status === 'completed'
      ? 'completed'
      : result.status === 'waiting_for_approval'
        ? 'waiting_for_approval'
        : 'failed';
    if (result.error) tracker.finalError = result.error;
    emit(tracker, { event: 'done', status: tracker.finalStatus, error: result.error });

    await pool.query(
      `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
       VALUES ('workflow_resume', 'workflow_resumed_after_approval', $1::jsonb, $2)`,
      [
        JSON.stringify({
          workflow_id: workflow.id,
          execution_id: executionId,
          approval_id: approvalId,
          status: result.status,
          waiting_step_id: result.waitingStepId ?? null,
        }),
        result.status === 'failed',
      ],
    ).catch(error => logger.warn({ err: error, executionId }, 'Failed to append workflow resume audit'));

    if (result.status === 'waiting_for_approval' && result.approvalRequestId) {
      const nextApproval = await getRuntimeApproval(pool, result.approvalRequestId);
      if (nextApproval?.status === 'approved') {
        dispatchRuntimeApprovalDecision(nextApproval.id, 'approved');
      } else if (nextApproval?.status === 'rejected') {
        dispatchRuntimeApprovalDecision(nextApproval.id, 'rejected');
      }
    } else {
      const subscriberStatus = result.status === 'completed' ? 'completed' : 'failed';
      void notifySubscribers(pool, workflow.id, subscriberStatus, executionId, result.error);
    }
  };

  registerRuntimeApprovalDecisionHandler((approvalId, decision) =>
    handleRuntimeDecision(approvalId, decision));

  // Crash recovery: an approval may have been recorded just before process
  // shutdown. Re-dispatch approved/rejected waiting executions on startup.
  void pool.query<{ approval_id: number; status: 'approved' | 'rejected' }>(
    `SELECT r.id AS approval_id, r.status
     FROM mcp_runtime_approvals r
     JOIN mcp_workflow_executions e ON e.waiting_approval_id = r.id
     WHERE e.status = 'waiting_for_approval'
       AND r.status IN ('approved', 'rejected')`,
  ).then(({ rows }) => {
    for (const row of rows) dispatchRuntimeApprovalDecision(row.approval_id, row.status);
  }).catch(error => logger.warn({ err: error }, 'Could not recover waiting workflow approvals'));

  // ── POST /api/workflows/:id/execute ────────────────────────────
  app.post('/api/workflows/:id/execute', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    if (!Number.isInteger(wfId) || wfId <= 0) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }
    const inputs = ((req.body as { input?: Record<string, unknown> })?.input) ?? {};
    const mockMode = Boolean((req.body as { mock?: boolean })?.mock);
    const user = getRbacUser(req);
    const scope = requestScope(req, res);
    if (!scope) return;

    let workflow: WorkflowRow | undefined;
    try {
      // RBAC: must be visible to the user (or admin).
      let sql = `SELECT id, name, description, steps, input_params, enabled, agent_requirements,
                        lifecycle_status, ai_act_governed, ai_system_id, ai_system_revision
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
      const params: unknown[] = [wfId, scope.tenantKey, scope.workspaceKey];
      if (!isAdmin(user)) {
        sql += ` AND (
          NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
          OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
        )`;
        params.push(user.allowed_bundles ?? []);
      }
      const { rows } = await pool.query<WorkflowRow>(sql, params);
      workflow = rows[0];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, wfId }, 'execute: failed to load workflow');
      res.status(500).json({ error: 'database error' });
      return;
    }
    if (!workflow) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    if (!workflow.enabled) {
      res.status(409).json({ error: 'workflow disabled' });
      return;
    }
    if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
      res.status(400).json({ error: 'workflow has no steps' });
      return;
    }

    const agentPreflight = await preflightWorkflowAgents(pool, workflow, { probeRuntime: !mockMode });
    if (!agentPreflight.ready) {
      res.status(409).json({ error: 'Workflow Agent contract is not ready', preflight: agentPreflight });
      return;
    }
    const resolvedWorkflow = applyWorkflowAgentAssignments(workflow, agentPreflight);

    // Pre-validate: every step's tool/agent/skill must be in the user's
    // allowed set. If any step references something they can't access, 403.
    if (!isAdmin(user)) {
      const denied = await findInaccessibleStepRefs(pool, workflow.steps, user);
      if (denied.length > 0) {
        res.status(403).json({
          error: 'workflow references resources you cannot access',
          inaccessible: denied,
        });
        return;
      }
    }

    // Persist execution row → get id
    let executionId: number;
    try {
      const triggeredBy = `builder:${user.username ?? 'anonymous'}`;
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO mcp_workflow_executions
           (workflow_id, status, triggered_by, input_args, execution_snapshot, tenant_key, workspace_key)
         VALUES ($1, 'running', $2, $3::jsonb, $4::jsonb, $5, $6) RETURNING id`,
        [
          wfId,
          triggeredBy,
          JSON.stringify(inputs),
          JSON.stringify(workflowExecutionSnapshot(agentPreflight)),
          scope.tenantKey,
          scope.workspaceKey,
        ]
      );
      executionId = rows[0]!.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, wfId }, 'execute: failed to persist execution');
      res.status(500).json({ error: 'database error' });
      return;
    }

    if (!mockMode && workflow.lifecycle_status === 'production' && workflow.ai_act_governed) {
      const gate = await enforceHumanAiActProductionGate(pool, {
        executionId,
        target: {
          aiSystemId: workflow.ai_system_id,
          aiSystemRevision: workflow.ai_system_revision,
        },
        user,
        source: 'builder',
      });
      if (!gate.authorized) {
        res.status(409).json({
          error: gate.message,
          code: 'AI_SYSTEM_PRODUCTION_GATE_BLOCKED',
          executionId,
          bindingId: gate.bindingId,
        });
        return;
      }
    }

    // Spin up event broker
    const tracker: ExecutionTracker = { emitter: new EventEmitter(), buffer: [], finished: false };
    trackers.set(executionId, tracker);

    // Audit: workflow_executed_via_builder (with user identity)
    try {
      await pool.query(
        `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
         VALUES ($1, $2, $3::jsonb, false)`,
        [
          `builder:${(user.username ?? '').slice(0, 8)}`,
          'workflow_executed_via_builder',
          JSON.stringify({ workflow_id: wfId, execution_id: executionId, user_id: user.id, username: user.username, role: user.role }),
        ]
      );
    } catch { /* audit failure shouldn't block execution */ }

    // Calling-user identity for this run (audit #11). undefined only if the
    // session somehow carries no id (then user-policy-gate allows, as before).
    const callingUser = user.id != null
      ? { id: user.id, entra_groups: user.entra_groups ?? [], role: user.role, allowed_bundles: user.allowed_bundles }
      : undefined;
    // Audit #1 + #11: per-execution hook-wrapped tool runner bound to this user,
    // wrapping the base executeTool runner; + per-request step runners carrying
    // the same identity into agent steps.
    const hookedToolRunner = makeHookedToolRunner(pool, config, {
      source: 'builder',
      sessionId: `builder:${executionId}`,
      userId: callingUser?.id,
      userGroups: callingUser?.entra_groups,
      workflowId: wfId,
      workflowExecutionId: executionId,
    }, toolRunner);
    // audit M4: per-workflow hooked-runner factory so sub-workflows carry their
    // own id into the human-approval-gate.
    const makeWfRunner = (wfid: number, nestedExecutionId?: number) => makeHookedToolRunner(pool, config, {
      source: 'builder',
      sessionId: `builder:${nestedExecutionId ?? executionId}:wf${wfid}`,
      userId: callingUser?.id,
      userGroups: callingUser?.entra_groups,
      workflowId: wfid,
      workflowExecutionId: nestedExecutionId ?? executionId,
    }, toolRunner);
    const reqRunners = buildRealRunners(
      pool,
      config,
      hookedToolRunner,
      new Set(),
      0,
      callingUser,
      makeWfRunner,
      scope,
    );

    // Fire-and-forget execution
    void (async () => {
      try {
        const result = await executeWorkflow({
          workflow: { ...resolvedWorkflow, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
          inputs,
          toolRunner: mockMode
            ? (async (name, args) => ({
                content: [{ type: 'text' as const, text: `[mock] tool=${name} args=${JSON.stringify(args).slice(0, 80)}` }],
              }))
            : hookedToolRunner,
          // Mock-mode: pass stub runners + stub toolRunner so no external
          // calls happen. Useful for branch/template validation without
          // burning tokens or hitting K8s/Jira/etc.
          runners: mockMode ? {
            agentRunner: async (id, prompt, args) => {
              const outputContract = args[AGENT_OUTPUT_CONTRACT_ARG];
              return isAgentOutputContractName(outputContract)
                ? mockAgentOutputForContract(outputContract, id)
                : `[mock] agent #${id} prompt-len=${prompt.length}`;
            },
            skillRunner: async (id) => `[mock] skill #${id}`,
            ragRunner:   async (idx, q) => `[mock] rag(${idx}, "${q.slice(0, 40)}…")`,
            memoryRunner: async (op) => `[mock] memory.${op}`,
            subWorkflowRunner: async (id) => `[mock] sub-workflow #${id}`,
          } : reqRunners,
          executionId,
          telemetryUserId: callingUser?.id,
          triggeredBy: `${mockMode ? 'mock-builder' : 'builder'}:${user.username ?? 'anonymous'}`,
          onStepEvent: (ev: StepEvent) => emit(tracker, { event: 'step', ...ev }),
          // Mock-mode uses stub creds (no real resolution); otherwise bind to the user.
          credResolver: mockMode ? undefined : makeExecutionCredResolver(pool, user),
        });
        await persistExecutionResult(pool, executionId, result);
        tracker.finished = true;
        tracker.finalStatus = result.status === 'completed'
          ? 'completed'
          : result.status === 'waiting_for_approval'
            ? 'waiting_for_approval'
            : 'failed';
        if (result.error) tracker.finalError = result.error;
        emit(tracker, { event: 'done', status: tracker.finalStatus, error: result.error });
        if (result.status === 'waiting_for_approval' && result.approvalRequestId) {
          const approval = await getRuntimeApproval(pool, result.approvalRequestId);
          if (approval?.status === 'approved') {
            dispatchRuntimeApprovalDecision(approval.id, 'approved');
          } else if (approval?.status === 'rejected') {
            dispatchRuntimeApprovalDecision(approval.id, 'rejected');
          }
        } else {
          // Notify subscribers only for terminal outcomes.
          const subscriberStatus = result.status === 'completed' ? 'completed' : 'failed';
          void notifySubscribers(pool, wfId, subscriberStatus, executionId, result.error);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err: msg, executionId }, 'execute: workflow threw');
        await pool.query(
          `UPDATE mcp_workflow_executions SET status='failed', completed_at=now(), error_message=$2
            WHERE id=$1 AND tenant_key=$3 AND workspace_key=$4`,
          [executionId, msg, scope.tenantKey, scope.workspaceKey]
        ).catch(() => {});
        tracker.finished = true;
        tracker.finalStatus = 'failed';
        tracker.finalError = msg;
        emit(tracker, { event: 'done', status: 'failed', error: msg });
      } finally {
        // Free the tracker 60 s after completion (gives late SSE clients time)
        setTimeout(() => trackers.delete(executionId), 60_000);
      }
    })();

    res.json({ executionId });
  });

  // Retries exactly one failed For Each child without re-running successful
  // siblings. The immutable parent result remains the original evidence; the
  // new child is linked through parent lineage + retry_of_execution_id.
  app.post('/api/workflows/:id/runs/:rid/steps/:stepId/items/:itemIndex/retry', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const parentExecutionId = Number(req.params['rid']);
    const stepId = String(req.params['stepId'] ?? '').trim();
    const itemIndex = Number(req.params['itemIndex']);
    if (!Number.isInteger(wfId) || wfId <= 0
      || !Number.isInteger(parentExecutionId) || parentExecutionId <= 0
      || !stepId || !Number.isInteger(itemIndex) || itemIndex < 0) {
      res.status(400).json({ error: 'invalid workflow, execution, step or item index' });
      return;
    }
    const user = getRbacUser(req);
    const scope = requestScope(req, res);
    if (!scope) return;

    let workflow: WorkflowRow | undefined;
    let parent: WorkflowExecutionRow | undefined;
    let sourceChild: ChildRetrySourceRow | undefined;
    let targetWorkflow: WorkflowRow | undefined;
    try {
      let workflowSql = `SELECT id, name, description, steps, input_params, enabled, agent_requirements
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
      const workflowParams: unknown[] = [wfId, scope.tenantKey, scope.workspaceKey];
      if (!isAdmin(user)) {
        workflowSql += ` AND (
          NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
          OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
        )`;
        workflowParams.push(user.allowed_bundles ?? []);
      }
      workflow = (await pool.query<WorkflowRow>(workflowSql, workflowParams)).rows[0];
      parent = (await pool.query<WorkflowExecutionRow>(
        `SELECT * FROM mcp_workflow_executions
          WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
        [parentExecutionId, wfId, scope.tenantKey, scope.workspaceKey],
      )).rows[0];
      sourceChild = (await pool.query<ChildRetrySourceRow>(
        `SELECT id, workflow_id, status, input_args
           FROM mcp_workflow_executions
          WHERE parent_execution_id = $1
            AND parent_step_id = $2
            AND parent_item_index = $3
            AND tenant_key = $4
            AND workspace_key = $5
          ORDER BY started_at DESC, id DESC
          LIMIT 1`,
        [parentExecutionId, stepId, itemIndex, scope.tenantKey, scope.workspaceKey],
      )).rows[0];
      if (sourceChild) {
        let targetSql = `SELECT id, name, description, steps, input_params, enabled, agent_requirements
           FROM mcp_workflows
           WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
        const targetParams: unknown[] = [sourceChild.workflow_id, scope.tenantKey, scope.workspaceKey];
        if (!isAdmin(user)) {
          targetSql += ` AND (
            NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
            OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
          )`;
          targetParams.push(user.allowed_bundles ?? []);
        }
        targetWorkflow = (await pool.query<WorkflowRow>(targetSql, targetParams)).rows[0];
      }
    } catch (error) {
      logger.error({ err: error, wfId, parentExecutionId, stepId, itemIndex }, 'child retry: failed to load checkpoint');
      res.status(500).json({ error: 'database error' });
      return;
    }

    if (!workflow || !parent) {
      res.status(404).json({ error: 'workflow or parent execution not found' });
      return;
    }
    if (!workflow.enabled) {
      res.status(409).json({ error: 'workflow disabled' });
      return;
    }
    if (parent.status !== 'completed') {
      res.status(409).json({ error: `item retry requires a completed parent execution; use checkpoint retry for '${parent.status}' runs` });
      return;
    }
    const parentStep = workflow.steps.find(step => step.id === stepId);
    if (!parentStep || parentStep.type !== 'logic.for_each') {
      res.status(409).json({ error: `step '${stepId}' is no longer a For Each step` });
      return;
    }
    try {
      resolveRetryableForEachItem(parent.step_results ?? {}, stepId, itemIndex);
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
    if (!sourceChild || !targetWorkflow) {
      res.status(404).json({ error: 'persisted child execution or accessible child workflow not found' });
      return;
    }
    if (sourceChild.status === 'running' || sourceChild.status === 'waiting_for_approval') {
      res.status(409).json({ error: `child execution #${sourceChild.id} is already active` });
      return;
    }
    if (sourceChild.status === 'completed') {
      res.status(409).json({ error: `For Each item ${itemIndex} has already been recovered by child execution #${sourceChild.id}` });
      return;
    }
    if (sourceChild.status !== 'failed' && sourceChild.status !== 'cancelled') {
      res.status(409).json({ error: `child execution #${sourceChild.id} cannot be retried from status '${sourceChild.status}'` });
      return;
    }
    if (!isAdmin(user)) {
      const denied = await findInaccessibleStepRefs(pool, targetWorkflow.steps, user);
      if (denied.length > 0) {
        res.status(403).json({ error: 'child workflow references resources you cannot access', inaccessible: denied });
        return;
      }
    }

    const sourceChildId = Number(sourceChild.id);
    if (!Number.isSafeInteger(sourceChildId) || sourceChildId <= 0) {
      res.status(500).json({ error: 'persisted child execution has an invalid id' });
      return;
    }
    const callingUser = user.id != null
      ? { id: user.id, entra_groups: user.entra_groups ?? [], role: user.role, allowed_bundles: user.allowed_bundles }
      : undefined;
    const makeChildToolRunner = (workflowId: number, nestedExecutionId?: number) => makeHookedToolRunner(pool, config, {
      source: 'builder-child-retry',
      sessionId: `child-retry:${sourceChildId}:${nestedExecutionId ?? 'pending'}:wf${workflowId}`,
      userId: callingUser?.id,
      userGroups: callingUser?.entra_groups,
      workflowId,
      workflowExecutionId: nestedExecutionId ?? parentExecutionId,
    }, toolRunner);
    const childRunners = buildRealRunners(
      pool,
      config,
      makeChildToolRunner(sourceChild.workflow_id),
      new Set([wfId]),
      0,
      callingUser,
      makeChildToolRunner,
      scope,
    );

    let resolveCreated!: (evidence: SubWorkflowExecutionEvidence) => void;
    let rejectCreated!: (error: unknown) => void;
    const created = new Promise<SubWorkflowExecutionEvidence>((resolve, reject) => {
      resolveCreated = resolve;
      rejectCreated = reject;
    });
    const task = childRunners.subWorkflowRunner!(sourceChild.workflow_id, sourceChild.input_args ?? {}, {
      parentWorkflowId: wfId,
      parentExecutionId,
      parentStepId: stepId,
      itemIndex,
      retryOfExecutionId: sourceChildId,
      onExecutionCreated: resolveCreated,
    });
    void task.catch(rejectCreated);

    let childEvidence: SubWorkflowExecutionEvidence;
    try {
      childEvidence = await created;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(409).json({ error: message });
      return;
    }

    await pool.query(
      `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
       VALUES ($1, 'workflow_for_each_child_retried', $2::jsonb, false)`,
      [
        `retry:${String(user.username ?? '').slice(0, 8)}`,
        JSON.stringify({
          workflow_id: wfId,
          parent_execution_id: parentExecutionId,
          parent_step_id: stepId,
          parent_item_index: itemIndex,
          source_child_execution_id: sourceChildId,
          retry_child_execution_id: childEvidence.execution_id,
          user_id: user.id,
        }),
      ],
    ).catch(error => logger.warn({ err: error, childExecutionId: childEvidence.execution_id }, 'Could not append child retry audit'));

    void task.then(
      () => logger.info({
        parentExecutionId,
        stepId,
        itemIndex,
        sourceChildId,
        childExecutionId: childEvidence.execution_id,
      }, 'For Each child retry completed'),
      error => logger.warn({
        err: error,
        parentExecutionId,
        stepId,
        itemIndex,
        sourceChildId,
        childExecutionId: childEvidence.execution_id,
      }, 'For Each child retry failed'),
    );

    res.status(202).json({
      executionId: childEvidence.execution_id,
      workflowId: childEvidence.workflow_id,
      traceId: childEvidence.trace_id,
      rootTraceId: childEvidence.root_trace_id,
      status: childEvidence.status,
      retryOfExecutionId: sourceChildId,
      parentExecutionId,
      parentStepId: stepId,
      parentItemIndex: itemIndex,
    });
  });

  // Creates a new execution from a failed checkpoint. The source run remains
  // immutable audit evidence; only failed/input-invalidated/downstream steps
  // are executed again.
  app.post('/api/workflows/:id/runs/:rid/retry', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const sourceExecutionId = Number(req.params['rid']);
    if (!Number.isInteger(wfId) || wfId <= 0 || !Number.isInteger(sourceExecutionId) || sourceExecutionId <= 0) {
      res.status(400).json({ error: 'invalid workflow or execution id' });
      return;
    }
    const user = getRbacUser(req);
    const scope = requestScope(req, res);
    if (!scope) return;

    let workflow: WorkflowRow | undefined;
    let source: WorkflowExecutionRow | undefined;
    let sourceAiSystemBinding: SourceAiSystemRunBindingRow | undefined;
    try {
      let workflowSql = `SELECT id, name, description, steps, input_params, enabled, agent_requirements,
                                lifecycle_status, ai_act_governed, ai_system_id, ai_system_revision
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
      const workflowParams: unknown[] = [wfId, scope.tenantKey, scope.workspaceKey];
      if (!isAdmin(user)) {
        workflowSql += ` AND (
          NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
          OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
        )`;
        workflowParams.push(user.allowed_bundles ?? []);
      }
      workflow = (await pool.query<WorkflowRow>(workflowSql, workflowParams)).rows[0];
      source = (await pool.query<WorkflowExecutionRow>(
        `SELECT * FROM mcp_workflow_executions
          WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
        [sourceExecutionId, wfId, scope.tenantKey, scope.workspaceKey],
      )).rows[0];
      sourceAiSystemBinding = (await pool.query<SourceAiSystemRunBindingRow>(
        `SELECT ai_system_id, ai_system_revision, production
           FROM mcp_ai_system_run_bindings
          WHERE workflow_execution_id=$1`,
        [sourceExecutionId],
      )).rows[0];
    } catch (error) {
      logger.error({ err: error, wfId, sourceExecutionId }, 'retry: failed to load workflow execution');
      res.status(500).json({ error: 'database error' });
      return;
    }

    if (!workflow || !source) {
      res.status(404).json({ error: 'workflow or source execution not found' });
      return;
    }
    if (!workflow.enabled) {
      res.status(409).json({ error: 'workflow disabled' });
      return;
    }
    if (source.status !== 'failed') {
      res.status(409).json({ error: `only failed executions can be retried; source status is '${source.status}'` });
      return;
    }

    const requestedInput = (req.body as { input?: unknown } | undefined)?.input;
    if (requestedInput != null && (typeof requestedInput !== 'object' || Array.isArray(requestedInput))) {
      res.status(400).json({ error: 'input must be a JSON object' });
      return;
    }
    const inputs = requestedInput == null
      ? (source.input_args ?? {})
      : requestedInput as Record<string, unknown>;

    const agentPreflight = await preflightWorkflowAgents(pool, workflow, { probeRuntime: true });
    if (!agentPreflight.ready) {
      res.status(409).json({ error: 'Workflow Agent contract is not ready', preflight: agentPreflight });
      return;
    }
    const resolvedWorkflow = applyWorkflowAgentAssignments(workflow, agentPreflight);

    if (!isAdmin(user)) {
      const denied = await findInaccessibleStepRefs(pool, workflow.steps, user);
      if (denied.length > 0) {
        res.status(403).json({
          error: 'workflow references resources you cannot access',
          inaccessible: denied,
        });
        return;
      }
    }

    let retryPlan;
    try {
      retryPlan = buildWorkflowRetryPlan(
        resolvedWorkflow.steps,
        source.step_results ?? {},
        source.input_args ?? {},
        inputs,
      );
    } catch (error) {
      res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let executionId: number;
    try {
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO mcp_workflow_executions (
           workflow_id, status, triggered_by, input_args, step_results,
           execution_snapshot, retry_of_execution_id, retry_from_step_ids
           , tenant_key, workspace_key
         )
         VALUES ($1, 'running', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7::text[], $8, $9)
         RETURNING id`,
        [
          wfId,
          `retry:${sourceExecutionId}:builder:${user.username ?? 'anonymous'}`,
          JSON.stringify(inputs),
          JSON.stringify(retryPlan.checkpoint),
          JSON.stringify(workflowExecutionSnapshot(agentPreflight)),
          sourceExecutionId,
          retryPlan.retryStepIds,
          scope.tenantKey,
          scope.workspaceKey,
        ],
      );
      executionId = inserted.rows[0]!.id;
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        res.status(409).json({ error: `execution #${sourceExecutionId} already has an active retry` });
        return;
      }
      logger.error({ err: error, wfId, sourceExecutionId }, 'retry: failed to persist execution');
      res.status(500).json({ error: 'database error' });
      return;
    }

    try {
      await markGoldenPathRetryStarted(pool, sourceExecutionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, executionId, sourceExecutionId }, 'retry: Golden Path evidence projection reset failed');
      await pool.query(
        `UPDATE mcp_workflow_executions
            SET status='failed', completed_at=now(), error_message=$2
          WHERE id=$1 AND status='running'`,
        [executionId, `Golden Path retry preparation failed: ${message}`],
      ).catch(() => undefined);
      res.status(500).json({ error: 'Golden Path retry evidence preparation failed' });
      return;
    }

    const retryGateTarget = sourceAiSystemBinding?.production
      ? {
          aiSystemId: sourceAiSystemBinding.ai_system_id,
          aiSystemRevision: sourceAiSystemBinding.ai_system_revision,
        }
      : workflow.lifecycle_status === 'production' && workflow.ai_act_governed
        ? {
            aiSystemId: workflow.ai_system_id,
            aiSystemRevision: workflow.ai_system_revision,
          }
        : null;
    if (retryGateTarget) {
      const gate = await enforceHumanAiActProductionGate(pool, {
        executionId,
        target: retryGateTarget,
        user,
        source: 'builder-retry',
      });
      if (!gate.authorized) {
        res.status(409).json({
          error: gate.message,
          code: 'AI_SYSTEM_PRODUCTION_GATE_BLOCKED',
          executionId,
          retryOfExecutionId: sourceExecutionId,
          bindingId: gate.bindingId,
        });
        return;
      }
    }

    const tracker: ExecutionTracker = { emitter: new EventEmitter(), buffer: [], finished: false };
    trackers.set(executionId, tracker);
    const callingUser = user.id != null
      ? { id: user.id, entra_groups: user.entra_groups ?? [], role: user.role, allowed_bundles: user.allowed_bundles }
      : undefined;
    const retryToolRunner = makeHookedToolRunner(pool, config, {
      source: 'builder-retry',
      sessionId: `retry:${sourceExecutionId}:${executionId}`,
      userId: callingUser?.id,
      userGroups: callingUser?.entra_groups,
      workflowId: wfId,
      workflowExecutionId: executionId,
    }, toolRunner);
    const makeRetryWorkflowRunner = (workflowId: number, nestedExecutionId?: number) =>
      makeHookedToolRunner(pool, config, {
        source: 'builder-retry',
        sessionId: `retry:${sourceExecutionId}:${nestedExecutionId ?? executionId}:wf${workflowId}`,
        userId: callingUser?.id,
        userGroups: callingUser?.entra_groups,
        workflowId,
        workflowExecutionId: nestedExecutionId ?? executionId,
      }, toolRunner);
    const retryRunners = buildRealRunners(
      pool,
      config,
      retryToolRunner,
      new Set([wfId]),
      0,
      callingUser,
      makeRetryWorkflowRunner,
      scope,
    );

    await pool.query(
      `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, is_error)
       VALUES ($1, 'workflow_failed_checkpoint_retried', $2::jsonb, false)`,
      [
        `retry:${String(user.username ?? '').slice(0, 8)}`,
        JSON.stringify({
          workflow_id: wfId,
          source_execution_id: sourceExecutionId,
          execution_id: executionId,
          failed_step_ids: retryPlan.failedStepIds,
          retry_step_ids: retryPlan.retryStepIds,
          reused_step_ids: retryPlan.reusedStepIds,
          changed_input_names: retryPlan.changedInputNames,
          user_id: user.id,
        }),
      ],
    ).catch(error => logger.warn({ err: error, executionId }, 'Could not append workflow retry audit'));

    void (async () => {
      try {
        const result = await executeWorkflow({
          workflow: { ...resolvedWorkflow, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
          inputs,
          toolRunner: retryToolRunner,
          runners: retryRunners,
          executionId,
          triggeredBy: `retry:${sourceExecutionId}`,
          telemetryUserId: callingUser?.id,
          initialStepResults: retryPlan.checkpoint,
          onStepEvent: (event: StepEvent) => emit(tracker, { event: 'step', ...event }),
          credResolver: makeExecutionCredResolver(pool, user),
        });
        await persistExecutionResult(pool, executionId, result);
        tracker.finished = true;
        tracker.finalStatus = result.status === 'completed'
          ? 'completed'
          : result.status === 'waiting_for_approval'
            ? 'waiting_for_approval'
            : 'failed';
        if (result.error) tracker.finalError = result.error;
        emit(tracker, { event: 'done', status: tracker.finalStatus, error: result.error });
        if (result.status === 'waiting_for_approval' && result.approvalRequestId) {
          const approval = await getRuntimeApproval(pool, result.approvalRequestId);
          if (approval?.status === 'approved') dispatchRuntimeApprovalDecision(approval.id, 'approved');
          else if (approval?.status === 'rejected') dispatchRuntimeApprovalDecision(approval.id, 'rejected');
        } else {
          void notifySubscribers(
            pool,
            wfId,
            result.status === 'completed' ? 'completed' : 'failed',
            executionId,
            result.error,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error({ err: error, executionId, sourceExecutionId }, 'retry: workflow threw');
        await pool.query(
          `UPDATE mcp_workflow_executions SET status='failed', completed_at=now(), error_message=$2
            WHERE id=$1 AND tenant_key=$3 AND workspace_key=$4`,
          [executionId, message, scope.tenantKey, scope.workspaceKey],
        ).catch(() => undefined);
        tracker.finished = true;
        tracker.finalStatus = 'failed';
        tracker.finalError = message;
        emit(tracker, { event: 'done', status: 'failed', error: message });
      } finally {
        setTimeout(() => trackers.delete(executionId), 60_000);
      }
    })();

    res.status(202).json({
      executionId,
      retryOfExecutionId: sourceExecutionId,
      failedStepIds: retryPlan.failedStepIds,
      retryStepIds: retryPlan.retryStepIds,
      reusedStepIds: retryPlan.reusedStepIds,
      changedInputNames: retryPlan.changedInputNames,
    });
  });

  // ── GET /api/workflows/:id/executions/:eid/stream  (SSE) ──────
  app.get('/api/workflows/:id/executions/:eid/stream', requireAuth, async (req, res) => {
    const workflowId = Number(req.params['id']);
    const executionId = Number(req.params['eid']);
    if (!Number.isInteger(workflowId) || workflowId <= 0 || !Number.isInteger(executionId) || executionId <= 0) {
      res.status(400).json({ error: 'invalid workflow or execution id' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    const visible = await pool.query<{ visible: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM mcp_workflow_executions
          WHERE id=$1 AND workflow_id=$2 AND tenant_key=$3 AND workspace_key=$4
       ) AS visible`,
      [executionId, workflowId, scope.tenantKey, scope.workspaceKey],
    ).catch(error => {
      logger.error({ err: error, workflowId, executionId }, 'execution stream scope check failed');
      return null;
    });
    if (!visible) {
      res.status(500).json({ error: 'database error' });
      return;
    }
    if (visible.rows[0]?.visible !== true) {
      res.status(404).json({ error: 'workflow execution not found' });
      return;
    }
    const tracker = trackers.get(executionId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // No tracker → run finished >60s ago (tracker evicted) or ran on another
    // replica. audit L6: recover the REAL terminal status from the execution
    // row so the client's spinner resolves instead of hanging on 'unknown'.
    if (!tracker) {
      let status: 'waiting_for_approval' | 'completed' | 'failed' | 'unknown' = 'unknown';
      let errMsg: string | undefined;
      try {
        const { rows } = await pool.query<{ status: string; error_message: string | null }>(
          `SELECT status, error_message FROM mcp_workflow_executions
            WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
          [executionId, workflowId, scope.tenantKey, scope.workspaceKey],
        );
        const s = rows[0]?.status;
        if (s === 'waiting_for_approval' || s === 'completed' || s === 'failed') status = s;
        if (rows[0]?.error_message) errMsg = rows[0].error_message;
      } catch { /* fall back to 'unknown' */ }
      res.write(`event: done\ndata: ${JSON.stringify({ status, ...(errMsg ? { error: errMsg } : {}) })}\n\n`);
      res.end();
      return;
    }

    // Replay buffered events first (covers late connections)
    for (const ev of tracker.buffer) {
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`);
    }

    // If execution already finished, close right away after replay
    if (tracker.finished) {
      res.end();
      return;
    }

    // Live: forward subsequent events
    const onEvent = (ev: BroadcastEvent) => {
      res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev)}\n\n`);
      if (ev.event === 'done') res.end();
    };
    tracker.emitter.on('event', onEvent);

    // Heartbeat every 20 s (some proxies time out idle SSE at 30 s)
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 20_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      tracker.emitter.off('event', onEvent);
    });
  });
}

interface WorkflowStepWithType extends WorkflowStep {
  _phantom?: undefined;
}
export type { WorkflowStepWithType };

/**
 * True when the executing identity may NOT use the bundle named in a cred_ref.
 * Admin (allowed_bundles === null) → never denied. A cred_ref without a
 * bundle_id is not denied here (backend_cred_id-only refs are validated when
 * resolved against the bundle topology). Pure — unit-testable, no DB.
 */
export function credRefBundleDenied(
  user: RbacUser,
  credRef: { bundle_id?: number; backend_cred_id?: number },
): boolean {
  if (isAdmin(user)) return false;
  if (typeof credRef.bundle_id !== 'number') return false;
  const allowed = user.allowed_bundles ?? [];
  return !allowed.includes(credRef.bundle_id);
}

/**
 * Walks the step list and returns the names/ids of tools, agents, skills, and
 * Knowledge Sources referenced by the workflow that the requesting user cannot
 * access (bundle-overlap check). Empty array = all OK.
 */
async function findInaccessibleStepRefs(
  pool: pg.Pool,
  steps: WorkflowStep[],
  user: RbacUser,
): Promise<Array<{ kind: 'tool' | 'agent' | 'skill' | 'knowledge' | 'cred_ref'; ref: string | number }>> {
  const toolNames = new Set<string>();
  const agentIds = new Set<number>();
  const skillIds = new Set<number>();
  const knowledgeNames = new Set<string>();
  const inaccessible: Array<{ kind: 'tool' | 'agent' | 'skill' | 'knowledge' | 'cred_ref'; ref: string | number }> = [];
  for (const s of steps) {
    const type = s.type ?? 'argus.tool';
    if ((type === 'argus.tool' || type === 'tool') && s.tool) toolNames.add(s.tool);
    if (type === 'argus.agent' && typeof s.agent_id === 'number') agentIds.add(s.agent_id);
    if (type === 'argus.skill' && typeof s.skill_id === 'number') skillIds.add(s.skill_id);
    if (type === 'argus.knowledge' && typeof s.args?.['index_name'] === 'string') {
      knowledgeNames.add(s.args['index_name']);
    }
    // cred_ref bundle access (only meaningful for tool steps, but cheap to check on all)
    if (s.cred_ref && credRefBundleDenied(user, s.cred_ref)) {
      inaccessible.push({ kind: 'cred_ref', ref: s.cred_ref.bundle_id! });
    }
  }

  const bundles = user.allowed_bundles ?? [];

  if (toolNames.size > 0) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT t.name
       FROM mcp_tools t
       WHERE t.name = ANY($1::text[])
         AND NOT (
           NOT EXISTS (SELECT 1 FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id)
           OR EXISTS (SELECT 1 FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id AND tb.bundle_id = ANY($2::int[]))
         )`,
      [[...toolNames], bundles]
    );
    for (const r of rows) inaccessible.push({ kind: 'tool', ref: r.name });
  }
  if (agentIds.size > 0) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM mcp_agents
       WHERE id = ANY($1::int[])
         AND NOT (bundle_ids IS NULL OR bundle_ids = '{}' OR bundle_ids && $2::int[])`,
      [[...agentIds], bundles]
    );
    for (const r of rows) inaccessible.push({ kind: 'agent', ref: r.id });
  }
  if (skillIds.size > 0) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT s.id FROM mcp_skills s
       WHERE s.id = ANY($1::int[])
         AND NOT (
           NOT EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id)
           OR EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id AND bs.bundle_id = ANY($2::int[]))
         )`,
      [[...skillIds], bundles]
    );
    for (const r of rows) inaccessible.push({ kind: 'skill', ref: r.id });
  }
  if (knowledgeNames.size > 0) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT r.name
       FROM mcp_rag_indexes r
       WHERE r.name = ANY($1::text[])
         AND NOT EXISTS (
           SELECT 1
           FROM mcp_agent_rag_indexes ar
           JOIN mcp_agents a ON a.id = ar.agent_id
           WHERE ar.rag_index_id = r.id
             AND r.enabled = true
             AND a.enabled = true
             AND (a.bundle_ids IS NULL OR a.bundle_ids = '{}' OR a.bundle_ids && $2::int[])
         )`,
      [[...knowledgeNames], bundles]
    );
    for (const r of rows) inaccessible.push({ kind: 'knowledge', ref: r.name });
  }
  return inaccessible;
}
