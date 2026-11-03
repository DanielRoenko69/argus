/** Official Claude Code subscription runtime client for Argus.Dev. */

import { randomUUID } from 'node:crypto';
import { runtimeHttpFailure, runtimeHttpOptions } from './runtimeHttp.js';
import { assertWorkflowNotCanceled, confirmRuntimeStopped, registerWorkflowStop, stopWorkspaceRuntime, workflowCancellationRequested } from './workflowCancellation.js';

const ARGUS_URL = process.env['ARGUS_URL'] ?? 'http://localhost:3000';
const WORKSPACE_URL = process.env['AGENT_WORKSPACE_URL'] ?? 'http://localhost:3001';
const WORKSPACE_SECRET = process.env['WORKSPACE_SECRET'] ?? '';
const CLAUDE_MODEL = process.env['ARGUS_CLAUDE_MODEL']?.trim() || '';
const parsedTimeout = Number.parseInt(process.env['ARGUS_CLAUDE_TIMEOUT_SEC'] || '900', 10);
const CLAUDE_TIMEOUT_SEC = Number.isFinite(parsedTimeout) ? Math.max(30, Math.min(1_800, parsedTimeout)) : 900;

export type ClaudeRuntimeResponse = {
  response: string;
  runId?: string;
  threadId: string | null;
  model: string;
  usage: Record<string, unknown> | null;
  events: Array<Record<string, unknown>>;
  durationMs: number;
  traceId?: string;
};

export type ClaudeTaskType = 'implement_ticket' | 'run_tests' | 'plan' | 'knowledge' | 'review' | 'inspect_pr' | 'fix_pr' | 'inspect_ci' | 'fix_ci' | 'inspect_security' | 'fix_security' | 'inspect_release' | 'generate_release' | 'inspect_backlog' | 'decompose_backlog';

export function isClaudeCoderRuntime(): boolean {
  return ['claude', 'claude-code', 'claude-code-subscription'].includes((process.env['ARGUS_DEV_CODER_RUNTIME'] ?? 'argus').trim().toLowerCase());
}

async function postTelemetry(body: Record<string, unknown>): Promise<void> {
  if (!WORKSPACE_SECRET) return;
  try {
    await fetch(`${ARGUS_URL}/api/internal/telemetry/runtime`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
      body: JSON.stringify({ ...body, provider: 'anthropic', runtime: 'claude-code' }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Telemetry is evidence, not a reason to abandon a valid coding run.
  }
}

export async function getClaudeRuntimeStatus(): Promise<{
  enabled: boolean;
  authenticated: boolean;
  authMethod: string;
  activeRuns?: number;
  recentRuns?: number;
  maxConcurrentRuns?: number;
  runs?: Array<Record<string, unknown>>;
}> {
  const response = await fetch(`${WORKSPACE_URL}/claude/status`, { headers: { 'x-workspace-secret': WORKSPACE_SECRET } });
  if (!response.ok) throw new Error(`Claude Code status HTTP ${response.status}`);
  return response.json() as Promise<{ enabled: boolean; authenticated: boolean; authMethod: string }>;
}

export async function callClaudeWorker(input: {
  prompt: string;
  cwd: string;
  rootTraceId: string;
  agentId: number;
  threadId?: string;
  taskType: ClaudeTaskType;
  telemetryInput?: Record<string, unknown>;
  telemetryMetadata?: Record<string, unknown>;
}): Promise<ClaudeRuntimeResponse> {
  assertWorkflowNotCanceled();
  if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is required for the Claude Code runtime');
  const status = await getClaudeRuntimeStatus();
  if (!status.enabled) throw new Error('Claude Code runtime is disabled in agent-workspace');

  const traceId = randomUUID();
  const runtimeRunId = randomUUID();
  const model = CLAUDE_MODEL || 'claude-subscription';
  await postTelemetry({
    event: 'started', traceId, rootTraceId: input.rootTraceId, agentId: input.agentId, model,
    input: input.telemetryInput ?? { prompt: input.prompt, cwd: input.cwd, taskType: input.taskType },
    metadata: { task_type: input.taskType, claude_auth_method: status.authMethod, runtime_run_id: runtimeRunId, runtime_status: 'starting', ...(input.telemetryMetadata ?? {}) },
  });

  let unregisterStop = () => {};
  let dispatched = false;
  try {
    unregisterStop = registerWorkflowStop(() => stopWorkspaceRuntime(WORKSPACE_URL, WORKSPACE_SECRET, 'claude', runtimeRunId));
    assertWorkflowNotCanceled();
    let response: Response;
    let responseBody: string;
    try {
      dispatched = true;
      response = await fetch(`${WORKSPACE_URL}/claude/run`, {
        ...runtimeHttpOptions(CLAUDE_TIMEOUT_SEC),
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify({
          prompt: input.prompt,
          cwd: input.cwd,
          ...(CLAUDE_MODEL ? { model: CLAUDE_MODEL } : {}),
          timeoutSec: CLAUDE_TIMEOUT_SEC,
          runId: runtimeRunId,
          rootTraceId: input.rootTraceId,
          agentId: input.agentId,
          taskType: input.taskType,
          telemetryManaged: true,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }),
      });
      responseBody = await response.text();
    } catch (error) {
      throw new Error(`Claude Code runtime request failed (run ${runtimeRunId}, ${input.taskType}): ${runtimeHttpFailure(error, CLAUDE_TIMEOUT_SEC)}`);
    }
    if (!response.ok) {
      const body = responseBody;
      let detail = body.slice(0, 500);
      try {
        const parsed = JSON.parse(body) as { error?: string; code?: string; runId?: string };
        detail = [parsed.code, parsed.error, parsed.runId ? `runtimeRunId=${parsed.runId}` : ''].filter(Boolean).join(': ') || detail;
      } catch {
        // Preserve raw non-JSON sidecar errors.
      }
      throw new Error(`Claude Code runtime HTTP ${response.status} (run ${runtimeRunId}): ${detail}`);
    }
    const result = JSON.parse(responseBody) as ClaudeRuntimeResponse;
    assertWorkflowNotCanceled();
    if (!result.response?.trim()) throw new Error('Claude Code runtime returned an empty response');
    await postTelemetry({
      event: 'completed', traceId, rootTraceId: input.rootTraceId, agentId: input.agentId, model: result.model || model,
      output: result.response, usage: result.usage, events: result.events,
      metadata: { task_type: input.taskType, claude_session_id: result.threadId, runtime_run_id: result.runId || runtimeRunId, runtime_status: 'completed', duration_ms: result.durationMs, claude_auth_method: status.authMethod, ...(input.telemetryMetadata ?? {}) },
    });
    return { ...result, runId: result.runId || runtimeRunId, traceId };
  } catch (error) {
    if (workflowCancellationRequested() && dispatched) {
      await confirmRuntimeStopped(WORKSPACE_URL, WORKSPACE_SECRET, 'claude', runtimeRunId);
    }
    await postTelemetry({
      event: workflowCancellationRequested() ? 'cancelled' : 'failed', traceId, rootTraceId: input.rootTraceId, agentId: input.agentId, model,
      error: error instanceof Error ? error.message : String(error),
      metadata: { task_type: input.taskType, claude_auth_method: status.authMethod, runtime_run_id: runtimeRunId, runtime_status: workflowCancellationRequested() ? 'canceled' : 'failed', ...(input.telemetryMetadata ?? {}) },
    });
    throw error;
  } finally {
    unregisterStop();
  }
}
