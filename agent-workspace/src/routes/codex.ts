/**
 * Official Codex runtime bridge for Argus.Dev.
 *
 * Codex runs inside the isolated workspace container so it sees the same
 * repository as the deterministic test runner. Authentication is kept in a
 * dedicated CODEX_HOME volume and never crosses this HTTP boundary.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { compactRuntimePrompt } from './codexPrompt.js';
import { completeRuntimeResult } from './runtimeResult.js';
import { assertCodexSandboxHelper, codexSandboxPath } from './codexSandbox.js';
import {
  Codex,
  type ModelReasoningEffort,
  type ThreadEvent,
  type ThreadItem,
  type Usage,
} from '@openai/codex-sdk';

export const codexRouter = Router();

const execFileAsync = promisify(execFile);
const CODEX_ENABLED = process.env['ARGUS_CODEX_ENABLED'] === 'true';
const CODEX_HOME = process.env['CODEX_HOME'] || '/home/node/.codex';
const CODEX_BINARY = process.env['ARGUS_CODEX_BINARY'] || '/app/node_modules/.bin/codex';
const ARGUS_URL = (process.env['ARGUS_URL'] || '').replace(/\/+$/, '');
const MAX_PROMPT_CHARS = 160_000;
const MAX_RAW_PROMPT_CHARS = 1_000_000;
const MAX_EVENT_CHARS = 16_000;
const MAX_EVENTS = 250;
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 1_800;
const RECENT_RUN_RETENTION_MS = 15 * 60_000;
const MAX_CONCURRENT_RUNS = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env['ARGUS_CODEX_MAX_CONCURRENT_RUNS'] || '1', 10) || 1),
);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THREAD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const REASONING_EFFORTS = new Set<ModelReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh']);

type CodexRunState = 'starting' | 'running' | 'completed' | 'failed' | 'canceled';

type CodexRunRecord = {
  id: string;
  telemetryTraceId: string;
  telemetryRootTraceId: string;
  telemetryStarted: boolean;
  telemetryManagedExternally: boolean;
  telemetryEvents: CodexBridgeEvent[];
  telemetryUsage: Usage | null;
  telemetryOutput?: string;
  state: CodexRunState;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  cwd: string;
  model: string | null;
  reasoningEffort: string | null;
  timeoutSec: number;
  threadId: string | null;
  rootTraceId: string | null;
  agentId: number | null;
  taskType: string | null;
  errorCode?: string;
  error?: string;
  cancelReason?: 'operator' | 'request_disconnected' | 'timeout';
  controller: AbortController;
};

type PublicCodexRun = Omit<CodexRunRecord, 'controller' | 'telemetryStarted' | 'telemetryManagedExternally' | 'telemetryTraceId' | 'telemetryRootTraceId' | 'telemetryEvents' | 'telemetryUsage' | 'telemetryOutput'> & {
  /** Only present when this bridge created and persisted the native telemetry trace. */
  telemetryTraceId?: string;
  telemetryRootTraceId?: string;
};

const activeRuns = new Map<string, CodexRunRecord>();
const recentRuns = new Map<string, CodexRunRecord>();

function publicRun(record: CodexRunRecord): PublicCodexRun {
  const {
    controller: _controller,
    telemetryStarted: _telemetryStarted,
    telemetryManagedExternally: _telemetryManagedExternally,
    telemetryEvents: _telemetryEvents,
    telemetryUsage: _telemetryUsage,
    telemetryOutput: _telemetryOutput,
    ...safe
  } = record;
  if (record.telemetryManagedExternally || !record.telemetryStarted) {
    // LangGraph owns its native telemetry lifecycle. The UUID allocated by
    // this bridge is only an internal placeholder in that mode and must never
    // become a clickable UI link to a trace that does not exist in Argus.
    const { telemetryTraceId: _telemetryTraceId, telemetryRootTraceId: _telemetryRootTraceId, ...withoutTelemetry } = safe;
    return withoutTelemetry;
  }
  return safe;
}

function nowIso(): string {
  return new Date().toISOString();
}

function pruneRecentRuns(): void {
  const cutoff = Date.now() - RECENT_RUN_RETENTION_MS;
  for (const [id, run] of recentRuns) {
    const finishedAt = run.finishedAt ? Date.parse(run.finishedAt) : 0;
    if (!finishedAt || finishedAt < cutoff) recentRuns.delete(id);
  }
}

function publicRuns(): PublicCodexRun[] {
  pruneRecentRuns();
  return [...activeRuns.values(), ...recentRuns.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(publicRun);
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout|aborted/i.test(message)) return 'runtime_timeout';
  if (/disconnect|socket|closed|terminated|fetch failed|network/i.test(message)) return 'runtime_connection';
  return 'runtime_error';
}

function codexEnvironment(): Record<string, string> {
  // Do not inherit the sidecar's environment: it contains WORKSPACE_SECRET and
  // git-provider credentials. Codex and repository commands receive only this
  // deliberately small, non-secret runtime environment.
  return {
    HOME: process.env['HOME'] || '/home/node',
    CODEX_HOME,
    PATH: codexSandboxPath(process.env['PATH']),
    LANG: process.env['LANG'] || 'C.UTF-8',
    TERM: 'dumb',
    GIT_AUTHOR_NAME: process.env['GIT_AUTHOR_NAME'] || 'Argus Dev Agent',
    GIT_AUTHOR_EMAIL: process.env['GIT_AUTHOR_EMAIL'] || 'argus-dev-agent@example.com',
    GIT_COMMITTER_NAME: process.env['GIT_COMMITTER_NAME'] || 'Argus Dev Agent',
    GIT_COMMITTER_EMAIL: process.env['GIT_COMMITTER_EMAIL'] || 'argus-dev-agent@example.com',
  };
}

function insideWorkspace(value: string): string | null {
  const resolved = path.resolve(value);
  return resolved === '/workspace' || resolved.startsWith('/workspace/') ? resolved : null;
}

function clipped(value: string | undefined): string {
  if (!value) return '';
  return value.length <= MAX_EVENT_CHARS
    ? value
    : `${value.slice(0, MAX_EVENT_CHARS)}\n...[truncated]`;
}

type RuntimeTelemetryEvent = 'started' | 'completed' | 'failed' | 'cancelled';

async function postRuntimeTelemetry(
  run: CodexRunRecord,
  event: RuntimeTelemetryEvent,
  extra: Record<string, unknown> = {},
): Promise<Record<string, unknown> | null> {
  if (!ARGUS_URL) return null;
  try {
    const extraMetadata = extra['metadata'] && typeof extra['metadata'] === 'object' && !Array.isArray(extra['metadata'])
      ? extra['metadata'] as Record<string, unknown>
      : {};
    const response = await fetch(`${ARGUS_URL}/api/internal/telemetry/codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': process.env['WORKSPACE_SECRET'] || '' },
      body: JSON.stringify({
        event,
        traceId: run.telemetryTraceId,
        rootTraceId: run.telemetryRootTraceId,
        agentId: run.agentId,
        model: run.model || 'codex-default',
        input: { cwd: run.cwd, taskType: run.taskType, runId: run.id },
        ...extra,
        metadata: {
          runtime_run_id: run.id,
          task_type: run.taskType,
          runtime_cwd: run.cwd,
          reasoning_effort: run.reasoningEffort,
          timeout_sec: run.timeoutSec,
          ...extraMetadata,
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) return null;
    return body;
  } catch {
    // Telemetry must never prevent a workspace run from completing.
    return null;
  }
}

export type CodexBridgeEvent = {
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

function compactItem(item: ThreadItem): CodexBridgeEvent {
  switch (item.type) {
    case 'agent_message':
      return { type: item.type, text: clipped(item.text) };
    case 'reasoning':
      return { type: item.type, text: clipped(item.text) };
    case 'command_execution':
      return {
        type: item.type,
        status: item.status,
        command: clipped(item.command),
        output: clipped(item.aggregated_output),
        ...(item.exit_code === undefined ? {} : { exitCode: item.exit_code }),
      };
    case 'file_change':
      return { type: item.type, status: item.status, changes: item.changes };
    case 'mcp_tool_call':
      return {
        type: item.type,
        status: item.status,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        result: item.result,
        error: item.error?.message,
      };
    case 'web_search':
      return { type: item.type, text: clipped(item.query) };
    case 'todo_list':
      return { type: item.type, result: item.items };
    case 'error':
      return { type: item.type, error: clipped(item.message) };
  }
}

function compactEvent(event: ThreadEvent): CodexBridgeEvent | null {
  if (event.type === 'item.completed') return compactItem(event.item);
  if (event.type === 'turn.failed') return { type: event.type, status: 'failed', error: event.error.message };
  if (event.type === 'error') return { type: event.type, status: 'failed', error: event.message };
  return null;
}

async function authStatus(): Promise<{ authenticated: boolean; method: 'chatgpt' | 'api' | 'unknown' }> {
  try {
    const { stdout, stderr } = await execFileAsync(CODEX_BINARY, ['login', 'status'], {
      env: codexEnvironment(),
      timeout: 10_000,
      maxBuffer: 32 * 1024,
    });
    const text = `${stdout}\n${stderr}`;
    if (/logged in using chatgpt/i.test(text)) return { authenticated: true, method: 'chatgpt' };
    if (/logged in using (?:an )?api key/i.test(text)) return { authenticated: true, method: 'api' };
    return { authenticated: /logged in/i.test(text), method: 'unknown' };
  } catch {
    return { authenticated: false, method: 'unknown' };
  }
}

codexRouter.get('/status', async (_req: Request, res: Response) => {
  pruneRecentRuns();
  const auth = CODEX_ENABLED ? await authStatus() : { authenticated: false, method: 'unknown' as const };
  res.json({
    enabled: CODEX_ENABLED,
    authenticated: auth.authenticated,
    authMethod: auth.method,
    activeRuns: activeRuns.size,
    maxConcurrentRuns: MAX_CONCURRENT_RUNS,
    recentRuns: recentRuns.size,
    runs: publicRuns(),
  });
});

codexRouter.post('/runs/:runId/cancel', (req: Request, res: Response) => {
  const runId = String(req.params['runId'] ?? '');
  const run = activeRuns.get(runId);
  if (!run) {
    res.status(404).json({ error: 'Codex run not found', code: 'run_not_found', runId });
    return;
  }
  run.cancelReason = 'operator';
  run.state = 'canceled';
  run.errorCode = 'runtime_canceled';
  run.error = 'Codex run canceled by operator';
  run.updatedAt = nowIso();
  run.controller.abort('operator');
  res.status(202).json({ ok: true, run: publicRun(run) });
});

type CodexRunBody = {
  prompt?: unknown;
  cwd?: unknown;
  model?: unknown;
  reasoningEffort?: unknown;
  timeoutSec?: unknown;
  threadId?: unknown;
  runId?: unknown;
  rootTraceId?: unknown;
  agentId?: unknown;
  taskType?: unknown;
  telemetryManaged?: unknown;
  executionMode?: unknown;
};

type CodexExecutionMode = 'workspace' | 'workspace-read-only' | 'core-agent';

/** Keep the sandbox decision server-side; callers cannot request write access through prompts. */
export function codexSandboxMode(executionMode: CodexExecutionMode): 'read-only' | 'workspace-write' {
  return executionMode === 'workspace' ? 'workspace-write' : 'read-only';
}

codexRouter.post('/run', async (req: Request, res: Response) => {
  if (!CODEX_ENABLED) {
    res.status(503).json({ error: 'Codex runtime is disabled' });
    return;
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    res.status(429).json({
      error: 'Codex runtime concurrency limit reached',
      code: 'runtime_concurrency_limit',
      activeRuns: [...activeRuns.values()].map(publicRun),
    });
    return;
  }

  const body = (req.body ?? {}) as CodexRunBody;
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_RAW_PROMPT_CHARS) {
    res.status(400).json({ error: `prompt must contain 1-${MAX_RAW_PROMPT_CHARS} characters` });
    return;
  }
  const runtimePrompt = compactRuntimePrompt(body.prompt, MAX_PROMPT_CHARS);
  if (runtimePrompt.compacted) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      audit: 'codex_prompt_compacted',
      original_chars: runtimePrompt.originalChars,
      final_chars: runtimePrompt.finalChars,
      omitted_chars: runtimePrompt.omittedChars,
    }));
  }
  if (typeof body.cwd !== 'string') {
    res.status(400).json({ error: 'cwd is required' });
    return;
  }
  const executionMode = body.executionMode === undefined ? 'workspace' : body.executionMode;
  if (executionMode !== 'workspace' && executionMode !== 'workspace-read-only' && executionMode !== 'core-agent') {
    res.status(400).json({ error: 'invalid executionMode' });
    return;
  }
  const cwd = executionMode === 'core-agent'
    ? path.resolve(body.cwd) === '/runtime' ? '/runtime' : null
    : insideWorkspace(body.cwd);
  if (!cwd) {
    res.status(400).json({ error: executionMode === 'core-agent' ? 'core-agent cwd must be /runtime' : 'cwd must be inside /workspace' });
    return;
  }
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
  } catch {
    res.status(400).json({ error: 'cwd does not exist or is not a directory' });
    return;
  }

  const model = body.model === undefined || body.model === '' ? undefined : body.model;
  if (model !== undefined && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    res.status(400).json({ error: 'model contains unsupported characters' });
    return;
  }
  const reasoningEffort = body.reasoningEffort === undefined || body.reasoningEffort === ''
    ? undefined
    : body.reasoningEffort;
  if (reasoningEffort !== undefined && (
    typeof reasoningEffort !== 'string'
    || !REASONING_EFFORTS.has(reasoningEffort as ModelReasoningEffort)
  )) {
    res.status(400).json({ error: 'invalid reasoningEffort' });
    return;
  }
  const threadId = body.threadId === undefined || body.threadId === '' ? undefined : body.threadId;
  if (threadId !== undefined && (typeof threadId !== 'string' || !THREAD_PATTERN.test(threadId))) {
    res.status(400).json({ error: 'invalid threadId' });
    return;
  }
  const requestedRunId = body.runId === undefined || body.runId === '' ? undefined : body.runId;
  if (requestedRunId !== undefined && (typeof requestedRunId !== 'string' || !THREAD_PATTERN.test(requestedRunId))) {
    res.status(400).json({ error: 'invalid runId' });
    return;
  }
  if (typeof requestedRunId === 'string' && (activeRuns.has(requestedRunId) || recentRuns.has(requestedRunId))) {
    res.status(409).json({
      error: 'A Codex run with this id is already active',
      code: 'runtime_run_id_conflict',
      runId: requestedRunId,
    });
    return;
  }
  const rootTraceId = body.rootTraceId === undefined || body.rootTraceId === '' ? null : body.rootTraceId;
  if (rootTraceId !== null && (typeof rootTraceId !== 'string' || !THREAD_PATTERN.test(rootTraceId))) {
    res.status(400).json({ error: 'invalid rootTraceId' });
    return;
  }
  const agentId = body.agentId === undefined || body.agentId === null || body.agentId === '' ? null : body.agentId;
  if (agentId !== null && (!Number.isSafeInteger(agentId) || Number(agentId) <= 0)) {
    res.status(400).json({ error: 'agentId must be a positive integer' });
    return;
  }
  const taskType = body.taskType === undefined || body.taskType === '' ? null : body.taskType;
  if (taskType !== null && (typeof taskType !== 'string' || taskType.length > 64)) {
    res.status(400).json({ error: 'invalid taskType' });
    return;
  }
  const requestedTimeout = typeof body.timeoutSec === 'number' && Number.isFinite(body.timeoutSec)
    ? Math.floor(body.timeoutSec)
    : DEFAULT_TIMEOUT_SEC;
  const timeoutSec = Math.max(30, Math.min(MAX_TIMEOUT_SEC, requestedTimeout));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1_000);
  const startedAt = Date.now();
  const run: CodexRunRecord = {
    id: typeof requestedRunId === 'string' ? requestedRunId : randomUUID(),
    telemetryTraceId: randomUUID(),
    telemetryRootTraceId: typeof rootTraceId === 'string' ? rootTraceId : '',
    telemetryStarted: false,
    telemetryManagedExternally: body.telemetryManaged === true,
    telemetryEvents: [],
    telemetryUsage: null,
    state: 'starting',
    startedAt: new Date(startedAt).toISOString(),
    updatedAt: nowIso(),
    cwd,
    model: model as string | null ?? null,
    reasoningEffort: reasoningEffort as string | null ?? null,
    timeoutSec,
    threadId: typeof threadId === 'string' ? threadId : null,
    rootTraceId: typeof rootTraceId === 'string' ? rootTraceId : null,
    agentId: typeof agentId === 'number' ? agentId : null,
    taskType: typeof taskType === 'string' ? taskType : null,
    controller,
  };
  activeRuns.set(run.id, run);
  if (!run.telemetryRootTraceId) run.telemetryRootTraceId = run.telemetryTraceId;
  let responseFinished = false;
  const cancelOnDisconnect = () => {
    if (responseFinished || res.writableEnded || controller.signal.aborted) return;
    run.cancelReason = 'request_disconnected';
    run.state = 'canceled';
    run.errorCode = 'request_disconnected';
    run.error = 'Codex request disconnected before the runtime completed';
    run.updatedAt = nowIso();
    controller.abort('request_disconnected');
  };
  req.once('aborted', cancelOnDisconnect);
  res.once('close', cancelOnDisconnect);
  res.once('finish', () => { responseFinished = true; });
  try {
    run.state = 'running';
    run.updatedAt = nowIso();
    if (!run.telemetryManagedExternally) {
      const telemetryStart = await postRuntimeTelemetry(run, 'started');
      if (typeof telemetryStart?.['rootTraceId'] === 'string' && THREAD_PATTERN.test(telemetryStart['rootTraceId'])) {
        run.telemetryRootTraceId = telemetryStart['rootTraceId'];
      } else if (!run.telemetryRootTraceId) {
        run.telemetryRootTraceId = run.telemetryTraceId;
      }
      run.telemetryStarted = telemetryStart != null;
    }
    await assertCodexSandboxHelper();
    const codex = new Codex({
      env: codexEnvironment(),
      config: { cli_auth_credentials_store: 'file' },
    });
    const threadOptions = {
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { modelReasoningEffort: reasoningEffort as ModelReasoningEffort } : {}),
      workingDirectory: cwd,
      sandboxMode: codexSandboxMode(executionMode),
      approvalPolicy: 'never' as const,
      networkAccessEnabled: false,
      webSearchMode: 'disabled' as const,
      skipGitRepoCheck: executionMode === 'core-agent',
    };
    const thread = threadId
      ? codex.resumeThread(threadId, threadOptions)
      : codex.startThread(threadOptions);
    const streamed = await thread.runStreamed(runtimePrompt.prompt, { signal: controller.signal });
    const events: CodexBridgeEvent[] = [];
    let finalResponse = '';
    let usage: Usage | null = null;
    for await (const event of streamed.events) {
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type === 'item.completed' && event.item.type === 'agent_message') {
        finalResponse = event.item.text;
      }
      const compact = compactEvent(event);
      if (compact && events.length < MAX_EVENTS) events.push(compact);
    }
    if (!finalResponse.trim()) throw new Error('Codex returned no final agent response');
    completeRuntimeResult(finalResponse);

    run.state = 'completed';
    run.threadId = thread.id;
    run.telemetryEvents = events;
    run.telemetryUsage = usage;
    run.telemetryOutput = finalResponse;
    run.updatedAt = nowIso();
    run.finishedAt = nowIso();

    res.json({
      response: finalResponse,
      runId: run.id,
      threadId: thread.id,
      model: model || 'codex-default',
      usage,
      events,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    const timedOut = controller.signal.aborted && !run.cancelReason;
    if (timedOut) {
      run.cancelReason = 'timeout';
      run.errorCode = 'runtime_timeout';
    }
    const message = timedOut
      ? `Codex run timed out after ${timeoutSec}s`
      : run.error ?? (error instanceof Error ? error.message : String(error));
    run.state = run.cancelReason ? 'canceled' : 'failed';
    run.errorCode ??= errorCode(error);
    run.error = clipped(message);
    run.updatedAt = nowIso();
    run.finishedAt = nowIso();
    if (!responseFinished && !res.headersSent && !res.writableEnded) {
      res.status(timedOut ? 504 : run.cancelReason ? 499 : 502).json({
        error: clipped(message),
        code: run.errorCode,
        runId: run.id,
        retryable: run.errorCode === 'runtime_connection' || run.errorCode === 'runtime_timeout',
      });
    }
  } finally {
    clearTimeout(timer);
    if (run.telemetryStarted && !run.telemetryManagedExternally) {
      const event: RuntimeTelemetryEvent = run.state === 'completed'
        ? 'completed'
        : run.state === 'canceled' ? 'cancelled' : 'failed';
      await postRuntimeTelemetry(run, event, {
        output: run.telemetryOutput,
        usage: run.telemetryUsage,
        events: run.telemetryEvents,
        error: run.error,
        metadata: {
          codex_thread_id: run.threadId,
          runtime_status: run.state,
          error_code: run.errorCode,
          cancel_reason: run.cancelReason,
        },
      });
    }
    recentRuns.set(run.id, run);
    activeRuns.delete(run.id);
  }
});
