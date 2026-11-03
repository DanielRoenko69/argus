/** Official Codex subscription runtime client for Argus.Dev. */

import { randomUUID } from 'node:crypto';
import { runtimeHttpFailure, runtimeHttpOptions } from './runtimeHttp.js';
import { assertWorkflowNotCanceled, confirmRuntimeStopped, registerWorkflowStop, stopWorkspaceRuntime, workflowCancellationRequested } from './workflowCancellation.js';

const ARGUS_URL = process.env['ARGUS_URL'] ?? 'http://localhost:3000';
const WORKSPACE_URL = process.env['AGENT_WORKSPACE_URL'] ?? 'http://localhost:3001';
const WORKSPACE_SECRET = process.env['WORKSPACE_SECRET'] ?? '';
const CODEX_MODEL = process.env['ARGUS_CODEX_MODEL']?.trim() || '';
const CODEX_REASONING = process.env['ARGUS_CODEX_REASONING_EFFORT']?.trim() || 'high';
const parsedTimeout = Number.parseInt(process.env['ARGUS_CODEX_TIMEOUT_SEC'] || '900', 10);
const CODEX_TIMEOUT_SEC = Number.isFinite(parsedTimeout) ? Math.max(30, Math.min(1_800, parsedTimeout)) : 900;

export type CodexRuntimeEvent = {
  type: string;
  status?: string;
  text?: string;
  command?: string;
  output?: string;
  exitCode?: number;
  changes?: Array<{ path: string; kind: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: string;
};

export type CodexRuntimeResponse = {
  response: string;
  runId?: string;
  threadId: string | null;
  model: string;
  usage: {
    input_tokens: number;
    cached_input_tokens: number;
    cache_write_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
  } | null;
  events: CodexRuntimeEvent[];
  durationMs: number;
  traceId?: string;
};

/** Workflow roles that may be executed through the Codex subscription runtime. */
export type CodexTaskType =
  | 'implement_ticket'
  | 'run_tests'
  | 'plan'
  | 'knowledge'
  | 'review'
  | 'inspect_pr'
  | 'fix_pr'
  | 'inspect_ci'
  | 'fix_ci'
  | 'inspect_security'
  | 'fix_security'
  | 'inspect_release'
  | 'generate_release'
  | 'inspect_backlog'
  | 'decompose_backlog';

const CODEX_SOFT_TOOL_BUDGETS: Record<CodexTaskType, number> = {
  implement_ticket: 25,
  run_tests: 8,
  plan: 8,
  knowledge: 10,
  review: 6,
  inspect_pr: 8,
  fix_pr: 25,
  inspect_ci: 8,
  fix_ci: 25,
  inspect_security: 10,
  fix_security: 25,
  inspect_release: 8,
  generate_release: 12,
  inspect_backlog: 8,
  decompose_backlog: 12,
};

/**
 * Role-specific guidance trims repeated exploration without creating a hard
 * failure boundary. The runtime may exceed it when another grounded read is
 * needed for correctness.
 */
export function applyCodexTaskPolicy(prompt: string, taskType: CodexTaskType): string {
  const budget = CODEX_SOFT_TOOL_BUDGETS[taskType];
  return `${prompt}\n\n# Argus phase efficiency policy\n` +
    `Aim to finish this ${taskType} phase within about ${budget} tool calls. ` +
    `Reuse evidence already present in the prompt, do not reread unchanged files, and stop exploring once the requested decision or change is grounded. ` +
    `This is a soft budget: exceed it when one more targeted tool call is necessary for correctness.`;
}

export function isCodexCoderRuntime(): boolean {
  return (process.env['ARGUS_DEV_CODER_RUNTIME'] ?? 'argus').trim().toLowerCase() === 'codex';
}

export function resolveCodexRuntimeConfig(input: {
  model?: string | null;
  reasoningEffort?: string | null;
}): { configuredModel: string; reasoningEffort: string; telemetryModel: string } {
  const configuredModel = input.model?.trim() || CODEX_MODEL;
  const reasoningEffort = input.reasoningEffort?.trim() || CODEX_REASONING;
  return { configuredModel, reasoningEffort, telemetryModel: configuredModel || 'codex-default' };
}

async function postTelemetry(body: Record<string, unknown>): Promise<void> {
  if (!WORKSPACE_SECRET) return;
  try {
    await fetch(`${ARGUS_URL}/api/internal/telemetry/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Telemetry is evidence, not a reason to abandon a valid coding run.
  }
}

export async function getCodexRuntimeStatus(): Promise<{
  enabled: boolean;
  authenticated: boolean;
  authMethod: string;
  activeRuns?: number;
  recentRuns?: number;
  maxConcurrentRuns?: number;
  runs?: Array<Record<string, unknown>>;
}> {
  const response = await fetch(`${WORKSPACE_URL}/codex/status`, {
    headers: { 'x-workspace-secret': WORKSPACE_SECRET },
  });
  if (!response.ok) throw new Error(`Codex status HTTP ${response.status}`);
  return response.json() as Promise<{ enabled: boolean; authenticated: boolean; authMethod: string }>;
}

export async function callCodexWorker(input: {
  prompt: string;
  cwd: string;
  rootTraceId: string;
  agentId: number;
  threadId?: string;
  taskType: CodexTaskType;
  model?: string | null;
  reasoningEffort?: string | null;
  telemetryInput?: Record<string, unknown>;
  telemetryMetadata?: Record<string, unknown>;
  readOnly?: boolean;
}): Promise<CodexRuntimeResponse> {
  assertWorkflowNotCanceled();
  if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for the Codex runtime');
  const status = await getCodexRuntimeStatus();
  if (!status.enabled) throw new Error('Codex runtime is disabled in agent-workspace');
  if (!status.authenticated) {
    throw new Error(
      'Codex is not authenticated. Run: docker compose exec agent-workspace codex login --device-auth',
    );
  }

  const traceId = randomUUID();
  const runtimeRunId = randomUUID();
  const { configuredModel, reasoningEffort, telemetryModel: model } = resolveCodexRuntimeConfig(input);
  const softToolBudget = CODEX_SOFT_TOOL_BUDGETS[input.taskType];
  const runtimePrompt = applyCodexTaskPolicy(input.prompt, input.taskType);
  await postTelemetry({
    event: 'started',
    traceId,
    rootTraceId: input.rootTraceId,
    agentId: input.agentId,
    model,
    input: input.telemetryInput ?? { prompt: input.prompt, cwd: input.cwd, taskType: input.taskType },
    metadata: {
      task_type: input.taskType,
      soft_tool_budget: softToolBudget,
      codex_auth_method: status.authMethod,
      runtime_run_id: runtimeRunId,
      runtime_status: 'starting',
      ...(input.telemetryMetadata ?? {}),
    },
  });

  let unregisterStop = () => {};
  let dispatched = false;
  try {
    unregisterStop = registerWorkflowStop(() => stopWorkspaceRuntime(WORKSPACE_URL, WORKSPACE_SECRET, 'codex', runtimeRunId));
    assertWorkflowNotCanceled();
    let response: Response;
    let responseBody: string;
    try {
      dispatched = true;
      response = await fetch(`${WORKSPACE_URL}/codex/run`, {
        ...runtimeHttpOptions(CODEX_TIMEOUT_SEC),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify({
          prompt: runtimePrompt,
          cwd: input.cwd,
          ...(configuredModel ? { model: configuredModel } : {}),
          reasoningEffort,
          timeoutSec: CODEX_TIMEOUT_SEC,
          runId: runtimeRunId,
          rootTraceId: input.rootTraceId,
          agentId: input.agentId,
          taskType: input.taskType,
          ...(input.readOnly ? { executionMode: 'workspace-read-only' } : {}),
          telemetryManaged: true,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }),
      });
      responseBody = await response.text();
    } catch (error) {
      const reason = runtimeHttpFailure(error, CODEX_TIMEOUT_SEC);
      throw new Error(`Codex runtime request failed (run ${runtimeRunId}, ${input.taskType}): ${reason}`);
    }
    if (!response.ok) {
      const body = responseBody;
      let detail = body.slice(0, 500);
      try {
        const parsed = JSON.parse(body) as { error?: string; code?: string; runId?: string };
        detail = [parsed.code, parsed.error, parsed.runId ? `runtimeRunId=${parsed.runId}` : '']
          .filter(Boolean)
          .join(': ') || detail;
      } catch {
        // Preserve the raw response for non-JSON sidecars/proxies.
      }
      throw new Error(`Codex runtime HTTP ${response.status} (run ${runtimeRunId}): ${detail}`);
    }
    const result = JSON.parse(responseBody) as CodexRuntimeResponse;
    assertWorkflowNotCanceled();
    if (!result.response?.trim()) throw new Error('Codex runtime returned an empty response');
    await postTelemetry({
      event: 'completed',
      traceId,
      rootTraceId: input.rootTraceId,
      agentId: input.agentId,
      model: result.model || model,
      output: result.response,
      usage: result.usage,
      events: result.events,
      metadata: {
        task_type: input.taskType,
        soft_tool_budget: softToolBudget,
        codex_cached_input_tokens: result.usage?.cached_input_tokens ?? 0,
        codex_cache_write_input_tokens: result.usage?.cache_write_input_tokens ?? 0,
        codex_reasoning_output_tokens: result.usage?.reasoning_output_tokens ?? 0,
        codex_thread_id: result.threadId,
        runtime_run_id: result.runId || runtimeRunId,
        runtime_status: 'completed',
        duration_ms: result.durationMs,
        codex_auth_method: status.authMethod,
        ...(input.telemetryMetadata ?? {}),
      },
    });
    return { ...result, runId: result.runId || runtimeRunId, traceId };
  } catch (error) {
    if (workflowCancellationRequested() && dispatched) {
      await confirmRuntimeStopped(WORKSPACE_URL, WORKSPACE_SECRET, 'codex', runtimeRunId);
    }
    await postTelemetry({
      event: workflowCancellationRequested() ? 'cancelled' : 'failed',
      traceId,
      rootTraceId: input.rootTraceId,
      agentId: input.agentId,
      model,
      error: error instanceof Error ? error.message : String(error),
      metadata: {
        task_type: input.taskType,
        soft_tool_budget: softToolBudget,
        codex_auth_method: status.authMethod,
        runtime_run_id: runtimeRunId,
        runtime_status: workflowCancellationRequested() ? 'canceled' : 'failed',
        ...(input.telemetryMetadata ?? {}),
      },
    });
    throw error;
  } finally {
    unregisterStop();
  }
}
