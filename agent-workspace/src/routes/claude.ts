/**
 * Official Claude Code subscription runtime bridge for Argus.Dev.
 *
 * Claude Code is invoked through Anthropic's supported CLI in the isolated
 * workspace container. OAuth credentials stay in /home/node/.claude and are
 * never returned through this HTTP boundary.
 */

import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { completeRuntimeResult } from './runtimeResult.js';

export const claudeRouter = Router();

const execFileAsync = promisify(execFile);
const CLAUDE_ENABLED = process.env['ARGUS_CLAUDE_ENABLED'] === 'true';
const CLAUDE_BINARY = process.env['ARGUS_CLAUDE_BINARY'] || '/usr/local/bin/claude';
const CLAUDE_HOME = process.env['CLAUDE_HOME'] || '/home/node/.claude';
const ARGUS_URL = (process.env['ARGUS_URL'] || '').replace(/\/+$/, '');
const MAX_PROMPT_CHARS = 160_000;
const MAX_OUTPUT_CHARS = 32_000;
const MAX_CLI_OUTPUT_CHARS = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 1_800;
const RECENT_RUN_RETENTION_MS = 15 * 60_000;
const MAX_CONCURRENT_RUNS = Math.max(
  1,
  Math.min(4, Number.parseInt(process.env['ARGUS_CLAUDE_MAX_CONCURRENT_RUNS'] || '1', 10) || 1),
);
const DEFAULT_MAX_TURNS = Math.max(1, Math.min(64, Number.parseInt(process.env['ARGUS_CLAUDE_MAX_TURNS'] || '25', 10) || 25));
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type ClaudeRunState = 'starting' | 'running' | 'completed' | 'failed' | 'canceled';

type ClaudeRunRecord = {
  id: string;
  telemetryTraceId: string;
  telemetryRootTraceId: string;
  telemetryManagedExternally: boolean;
  state: ClaudeRunState;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  cwd: string;
  model: string | null;
  maxTurns: number;
  timeoutSec: number;
  threadId: string | null;
  rootTraceId: string | null;
  agentId: number | null;
  taskType: string | null;
  output?: string;
  errorCode?: string;
  error?: string;
  cancelReason?: 'operator' | 'request_disconnected' | 'timeout';
  controller: AbortController;
};

type PublicClaudeRun = Omit<ClaudeRunRecord, 'controller' | 'telemetryManagedExternally' | 'telemetryTraceId' | 'telemetryRootTraceId' | 'output'> & {
  telemetryTraceId?: string;
  telemetryRootTraceId?: string;
};

const activeRuns = new Map<string, ClaudeRunRecord>();
const recentRuns = new Map<string, ClaudeRunRecord>();

function nowIso(): string { return new Date().toISOString(); }

function clipped(value: string | undefined): string {
  if (!value) return '';
  return value.length <= MAX_OUTPUT_CHARS ? value : `${value.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated]`;
}

function publicRun(record: ClaudeRunRecord): PublicClaudeRun {
  const {
    controller: _controller,
    telemetryManagedExternally: _telemetryManagedExternally,
    telemetryTraceId: _telemetryTraceId,
    telemetryRootTraceId: _telemetryRootTraceId,
    output: _output,
    ...safe
  } = record;
  if (record.telemetryManagedExternally) {
    return safe;
  }
  return safe;
}

function insideWorkspace(value: string): string | null {
  const resolved = path.resolve(value);
  return resolved === '/workspace' || resolved.startsWith('/workspace/') ? resolved : null;
}

function runtimeEnvironment(): Record<string, string> {
  // Never inherit WORKSPACE_SECRET, provider credentials or unrelated host
  // environment values into a model process.
  return {
    HOME: process.env['HOME'] || '/home/node',
    CLAUDE_HOME,
    PATH: process.env['PATH'] || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    LANG: process.env['LANG'] || 'C.UTF-8',
    TERM: 'dumb',
    DISABLE_AUTOUPDATER: '1',
    GIT_AUTHOR_NAME: process.env['GIT_AUTHOR_NAME'] || 'Argus Dev Agent',
    GIT_AUTHOR_EMAIL: process.env['GIT_AUTHOR_EMAIL'] || 'argus-dev-agent@example.com',
    GIT_COMMITTER_NAME: process.env['GIT_COMMITTER_NAME'] || 'Argus Dev Agent',
    GIT_COMMITTER_EMAIL: process.env['GIT_COMMITTER_EMAIL'] || 'argus-dev-agent@example.com',
  };
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|timeout|aborted/i.test(message)) return 'runtime_timeout';
  if (/login|auth|credential|subscription/i.test(message)) return 'runtime_authentication';
  if (/disconnect|socket|closed|terminated|network|fetch failed/i.test(message)) return 'runtime_connection';
  return 'runtime_error';
}

async function postRuntimeTelemetry(run: ClaudeRunRecord, event: 'started' | 'completed' | 'failed' | 'cancelled', extra: Record<string, unknown> = {}): Promise<void> {
  if (!ARGUS_URL || run.telemetryManagedExternally) return;
  try {
    await fetch(`${ARGUS_URL}/api/internal/telemetry/runtime`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-secret': process.env['WORKSPACE_SECRET'] || '' },
      body: JSON.stringify({
        event,
        traceId: run.telemetryTraceId,
        rootTraceId: run.telemetryRootTraceId,
        provider: 'anthropic',
        runtime: 'claude-code',
        agentId: run.agentId,
        model: run.model || 'claude-subscription',
        input: { cwd: run.cwd, taskType: run.taskType, runId: run.id },
        ...extra,
        metadata: {
          runtime_run_id: run.id,
          task_type: run.taskType,
          runtime_cwd: run.cwd,
          max_turns: run.maxTurns,
          timeout_sec: run.timeoutSec,
          ...((extra['metadata'] && typeof extra['metadata'] === 'object') ? extra['metadata'] : {}),
        },
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Telemetry must never prevent a valid workspace run from completing.
  }
}

async function authStatus(): Promise<{ authenticated: boolean; method: 'claude_subscription' | 'api' | 'unknown' }> {
  if (process.env['ARGUS_CLAUDE_ASSUME_AUTHENTICATED'] === 'true') {
    return { authenticated: true, method: 'claude_subscription' };
  }
  try {
    const { stdout, stderr } = await execFileAsync(CLAUDE_BINARY, ['auth', 'status'], {
      env: runtimeEnvironment(),
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    const text = `${stdout}\n${stderr}`;
    try {
      const status = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown };
      if (status.loggedIn === true && status.authMethod === 'claude.ai') return { authenticated: true, method: 'claude_subscription' };
      if (status.loggedIn === true) return { authenticated: true, method: 'api' };
    } catch {
      // Older CLI versions return human-readable auth status.
    }
    if (/claude\.ai|subscription|logged in|authenticated/i.test(text)) return { authenticated: true, method: 'claude_subscription' };
    if (/api key|console\.anthropic/i.test(text)) return { authenticated: true, method: 'api' };
  } catch {
    // The actual run will return a precise CLI authentication error.
  }
  return { authenticated: false, method: 'unknown' };
}

function runClaudeProcess(args: string[], cwd: string, prompt: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BINARY, args, { cwd, env: runtimeEnvironment(), signal });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const append = (target: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const text = chunk.toString();
      if (target === 'stdout') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > MAX_CLI_OUTPUT_CHARS) {
        child.kill('SIGTERM');
        fail(new Error(`Claude Code output exceeded ${MAX_CLI_OUTPUT_CHARS} characters`));
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    child.once('error', error => fail(error instanceof Error ? error : new Error(String(error))));
    child.once('close', (code, signalName) => {
      if (settled) return;
      if (code === 0) {
        settled = true;
        resolve({ stdout, stderr });
        return;
      }
      fail(new Error(`Claude Code exited with ${signalName ? `signal ${signalName}` : `code ${code}`}${stderr.trim() ? `: ${stderr.trim().slice(0, 2_000)}` : ''}`));
    });
    child.stdin.once('error', error => fail(error instanceof Error ? error : new Error(String(error))));
    child.stdin.end(prompt);
  });
}

function parseClaudeOutput(stdout: string): { response: string; threadId: string | null } {
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const response = typeof parsed['result'] === 'string'
      ? parsed['result']
      : typeof parsed['response'] === 'string' ? parsed['response'] : '';
    const threadId = typeof parsed['session_id'] === 'string'
      ? parsed['session_id']
      : typeof parsed['sessionId'] === 'string' ? parsed['sessionId'] : null;
    if (response.trim()) return { response, threadId };
  } catch {
    // Some CLI versions return plain text even when JSON output is requested.
  }
  return { response: stdout.trim(), threadId: null };
}

function pruneRecentRuns(): void {
  const cutoff = Date.now() - RECENT_RUN_RETENTION_MS;
  for (const [id, run] of recentRuns) {
    if (!run.finishedAt || Date.parse(run.finishedAt) < cutoff) recentRuns.delete(id);
  }
}

function publicRuns(): PublicClaudeRun[] {
  pruneRecentRuns();
  return [...activeRuns.values(), ...recentRuns.values()]
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(publicRun);
}

claudeRouter.get('/status', async (_req: Request, res: Response) => {
  pruneRecentRuns();
  const auth = CLAUDE_ENABLED ? await authStatus() : { authenticated: false, method: 'unknown' as const };
  res.json({
    enabled: CLAUDE_ENABLED,
    authenticated: auth.authenticated,
    authMethod: auth.method,
    activeRuns: activeRuns.size,
    maxConcurrentRuns: MAX_CONCURRENT_RUNS,
    recentRuns: recentRuns.size,
    runs: publicRuns(),
  });
});

claudeRouter.post('/runs/:runId/cancel', (req: Request, res: Response) => {
  const runId = String(req.params['runId'] ?? '');
  const run = activeRuns.get(runId);
  if (!run) {
    res.status(404).json({ error: 'Claude runtime run not found', code: 'run_not_found', runId });
    return;
  }
  run.cancelReason = 'operator';
  run.state = 'canceled';
  run.errorCode = 'runtime_canceled';
  run.error = 'Claude Code run canceled by operator';
  run.updatedAt = nowIso();
  run.controller.abort('operator');
  res.status(202).json({ ok: true, run: publicRun(run) });
});

type ClaudeRunBody = {
  prompt?: unknown;
  cwd?: unknown;
  model?: unknown;
  maxTurns?: unknown;
  timeoutSec?: unknown;
  threadId?: unknown;
  runId?: unknown;
  rootTraceId?: unknown;
  agentId?: unknown;
  taskType?: unknown;
  telemetryManaged?: unknown;
};

claudeRouter.post('/run', async (req: Request, res: Response) => {
  if (!CLAUDE_ENABLED) {
    res.status(503).json({ error: 'Claude Code runtime is disabled' });
    return;
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    res.status(429).json({ error: 'Claude runtime concurrency limit reached', code: 'runtime_concurrency_limit', activeRuns: [...activeRuns.values()].map(publicRun) });
    return;
  }
  const body = (req.body ?? {}) as ClaudeRunBody;
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > MAX_PROMPT_CHARS) {
    res.status(400).json({ error: `prompt must contain 1-${MAX_PROMPT_CHARS} characters` });
    return;
  }
  if (typeof body.cwd !== 'string') {
    res.status(400).json({ error: 'cwd is required' });
    return;
  }
  const cwd = insideWorkspace(body.cwd);
  if (!cwd) {
    res.status(400).json({ error: 'cwd must be inside /workspace' });
    return;
  }
  try {
    if (!(await stat(cwd)).isDirectory()) throw new Error('not a directory');
  } catch {
    res.status(400).json({ error: 'cwd does not exist or is not a directory' });
    return;
  }
  const model = body.model === undefined || body.model === '' ? null : body.model;
  if (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    res.status(400).json({ error: 'model contains unsupported characters' });
    return;
  }
  const maxTurnsRaw = typeof body.maxTurns === 'number' && Number.isFinite(body.maxTurns) ? Math.floor(body.maxTurns) : DEFAULT_MAX_TURNS;
  const maxTurns = Math.max(1, Math.min(64, maxTurnsRaw));
  const timeoutRaw = typeof body.timeoutSec === 'number' && Number.isFinite(body.timeoutSec) ? Math.floor(body.timeoutSec) : DEFAULT_TIMEOUT_SEC;
  const timeoutSec = Math.max(30, Math.min(MAX_TIMEOUT_SEC, timeoutRaw));
  const requestedRunId = body.runId === undefined || body.runId === '' ? undefined : body.runId;
  if (requestedRunId !== undefined && (typeof requestedRunId !== 'string' || !RUN_ID_PATTERN.test(requestedRunId))) {
    res.status(400).json({ error: 'invalid runId' });
    return;
  }
  if (typeof requestedRunId === 'string' && (activeRuns.has(requestedRunId) || recentRuns.has(requestedRunId))) {
    res.status(409).json({ error: 'A Claude run with this id is already active', code: 'runtime_run_id_conflict', runId: requestedRunId });
    return;
  }
  const rootTraceId = body.rootTraceId === undefined || body.rootTraceId === '' ? null : body.rootTraceId;
  if (rootTraceId !== null && (typeof rootTraceId !== 'string' || !RUN_ID_PATTERN.test(rootTraceId))) {
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1_000);
  const run: ClaudeRunRecord = {
    id: typeof requestedRunId === 'string' ? requestedRunId : randomUUID(),
    telemetryTraceId: randomUUID(),
    telemetryRootTraceId: typeof rootTraceId === 'string' ? rootTraceId : '',
    telemetryManagedExternally: body.telemetryManaged === true,
    state: 'starting',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    cwd,
    model: model as string | null,
    maxTurns,
    timeoutSec,
    threadId: typeof body.threadId === 'string' ? body.threadId : null,
    rootTraceId: typeof rootTraceId === 'string' ? rootTraceId : null,
    agentId: typeof agentId === 'number' ? agentId : null,
    taskType: typeof taskType === 'string' ? taskType : null,
    controller,
  };
  if (!run.telemetryRootTraceId) run.telemetryRootTraceId = run.telemetryTraceId;
  activeRuns.set(run.id, run);
  let responseFinished = false;
  const cancelOnDisconnect = () => {
    if (responseFinished || res.writableEnded || controller.signal.aborted) return;
    run.cancelReason = 'request_disconnected';
    run.state = 'canceled';
    run.errorCode = 'request_disconnected';
    run.error = 'Claude Code request disconnected before the runtime completed';
    run.updatedAt = nowIso();
    controller.abort('request_disconnected');
  };
  req.once('aborted', cancelOnDisconnect);
  req.once('close', cancelOnDisconnect);
  res.once('finish', () => { responseFinished = true; });
  try {
    run.state = 'running';
    run.updatedAt = nowIso();
    await postRuntimeTelemetry(run, 'started');
    // Claude Code's current CLI reads print-mode prompts from stdin. Passing a
    // multi-word prompt as a positional argument is lossy in some CLI builds.
    const args = ['--print', '--output-format', 'json', '--permission-mode', process.env['ARGUS_CLAUDE_PERMISSION_MODE'] || 'acceptEdits'];
    if (model) args.push('--model', model);
    const allowedTools = (process.env['ARGUS_CLAUDE_ALLOWED_TOOLS'] || 'Read,Write,Edit,Bash').split(',').map(value => value.trim()).filter(Boolean);
    for (const tool of allowedTools) args.push('--allowedTools', tool);
    if (process.env['ARGUS_CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS'] === 'true') args.push('--dangerously-skip-permissions');
    const result = await runClaudeProcess(args, cwd, body.prompt, controller.signal);
    const parsed = parseClaudeOutput(result.stdout);
    if (!parsed.response.trim()) throw new Error('Claude Code returned no final response');
    completeRuntimeResult(parsed.response);
    run.state = 'completed';
    run.threadId = parsed.threadId || run.threadId;
    run.output = parsed.response;
    run.updatedAt = nowIso();
    run.finishedAt = nowIso();
    await postRuntimeTelemetry(run, 'completed', { output: parsed.response, metadata: { claude_session_id: run.threadId, runtime_status: 'completed' } });
    res.json({ response: parsed.response, runId: run.id, threadId: run.threadId, model: model || 'claude-subscription', usage: null, events: [], durationMs: Date.now() - Date.parse(run.startedAt) });
  } catch (error) {
    const timedOut = controller.signal.aborted && !run.cancelReason;
    if (timedOut) { run.cancelReason = 'timeout'; run.errorCode = 'runtime_timeout'; }
    const message = timedOut ? `Claude Code run timed out after ${timeoutSec}s` : run.error ?? (error instanceof Error ? error.message : String(error));
    run.state = run.cancelReason ? 'canceled' : 'failed';
    run.errorCode ??= errorCode(error);
    run.error = clipped(message);
    run.updatedAt = nowIso();
    run.finishedAt = nowIso();
    await postRuntimeTelemetry(run, run.state === 'canceled' ? 'cancelled' : 'failed', { error: run.error, metadata: { runtime_status: run.state, error_code: run.errorCode, cancel_reason: run.cancelReason } });
    if (!responseFinished && !res.headersSent && !res.writableEnded) res.status(timedOut ? 504 : run.cancelReason ? 499 : 502).json({ error: run.error, code: run.errorCode, runId: run.id, retryable: run.errorCode === 'runtime_connection' || run.errorCode === 'runtime_timeout' });
  } finally {
    clearTimeout(timer);
    recentRuns.set(run.id, run);
    activeRuns.delete(run.id);
  }
});
