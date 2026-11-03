/**
 * activeSessions — In-memory registry of currently-running agent sessions.
 *
 * Powers the /admin/activity-live dashboard. Process-local (lives only on
 * the Argus-Pod that's handling the session) — when Argus scales out
 * horizontally each pod has its own view. For Argus's single-pod-AKS
 * setup this is fine; multi-pod would need a Redis-pub/sub fan-out.
 *
 * NOT a replacement for the immutable audit log — purely for real-time
 * UI. Entries are dropped on session-complete; long-term history lives in
 * mcp_audit_log + Langfuse.
 */

export interface ActiveToolCall {
  id: string;
  name: string;
  args: unknown;
  startedAt: number;    // epoch ms
  finishedAt?: number;
  isError?: boolean;
  previewTrunc?: string; // first 120 chars of result
}

export interface ActiveSession {
  sessionId: string;
  agentId: number;
  agentName: string;
  agentMode: 'chat' | 'worker' | 'reviewer' | string;
  callingUserId?: number;
  tenantKey?: string;
  workspaceKey?: string;
  startedAt: number;
  lastActivityAt: number;
  iteration: number;
  status: 'thinking' | 'tool-call' | 'streaming' | 'done' | 'error';
  toolCalls: ActiveToolCall[];      // current iteration's tool calls
  toolCallCount: number;             // cumulative across all iterations
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  lastMessage?: string;              // first 200 chars of user message
  errorMessage?: string;
}

const registry = new Map<string, ActiveSession>();

// Old session cleanup — Defense gegen Memory-Leak wenn unregister
// vergessen wird. Sessions die >30 min idle sind werden ausgekehrt.
const MAX_IDLE_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - MAX_IDLE_MS;
  for (const [id, sess] of registry) {
    if (sess.lastActivityAt < cutoff) registry.delete(id);
  }
}, 5 * 60 * 1000).unref();

export interface RegisterInput {
  sessionId: string;
  agentId: number;
  agentName: string;
  agentMode: ActiveSession['agentMode'];
  callingUserId?: number;
  tenantKey?: string;
  workspaceKey?: string;
  userMessage?: string;
}

export function registerSessionStart(input: RegisterInput): void {
  const now = Date.now();
  registry.set(input.sessionId, {
    sessionId: input.sessionId,
    agentId: input.agentId,
    agentName: input.agentName,
    agentMode: input.agentMode,
    callingUserId: input.callingUserId,
    tenantKey: input.tenantKey,
    workspaceKey: input.workspaceKey,
    startedAt: now,
    lastActivityAt: now,
    iteration: 0,
    status: 'thinking',
    toolCalls: [],
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    lastMessage: input.userMessage?.slice(0, 200),
  });
}

export function recordIterationStart(sessionId: string, iteration: number): void {
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.iteration = iteration;
  sess.lastActivityAt = Date.now();
  sess.status = 'thinking';
  sess.toolCalls = [];   // reset per iteration
}

export function recordToolCallStart(sessionId: string, call: { id: string; name: string; args: unknown }): void {
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.lastActivityAt = Date.now();
  sess.status = 'tool-call';
  sess.toolCalls.push({
    id: call.id,
    name: call.name,
    args: call.args,
    startedAt: Date.now(),
  });
  sess.toolCallCount++;
}

export function recordToolCallEnd(sessionId: string, callId: string, result: { isError?: boolean; preview?: string }): void {
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.lastActivityAt = Date.now();
  const tc = sess.toolCalls.find(t => t.id === callId);
  if (tc) {
    tc.finishedAt = Date.now();
    tc.isError = result.isError;
    tc.previewTrunc = result.preview?.slice(0, 120);
  }
}

export function recordTokenUsage(sessionId: string, usage: { input?: number; output?: number; costUsd?: number }): void {
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.lastActivityAt = Date.now();
  if (usage.input)  sess.inputTokens  += usage.input;
  if (usage.output) sess.outputTokens += usage.output;
  if (usage.costUsd) sess.estimatedCostUsd += usage.costUsd;
}

export function recordStreaming(sessionId: string): void {
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.lastActivityAt = Date.now();
  sess.status = 'streaming';
}

export function unregisterSession(sessionId: string, finalStatus: 'done' | 'error' = 'done', errorMessage?: string): void {
  // Two-phase cleanup: mark final status visible for 5s, then drop from
  // registry. Lets dashboard show "just finished" briefly.
  const sess = registry.get(sessionId);
  if (!sess) return;
  sess.status = finalStatus;
  sess.lastActivityAt = Date.now();
  if (errorMessage) sess.errorMessage = errorMessage.slice(0, 300);
  setTimeout(() => registry.delete(sessionId), 5_000).unref();
}

/** Snapshot of all currently-tracked sessions, newest-first. */
export function listActive(): ActiveSession[] {
  return [...registry.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Live counts for at-a-glance metrics. */
export function summaryCounts(): { total: number; thinking: number; tool: number; streaming: number; done: number; error: number } {
  const out = { total: 0, thinking: 0, tool: 0, streaming: 0, done: 0, error: 0 };
  for (const s of registry.values()) {
    out.total++;
    if (s.status === 'thinking')   out.thinking++;
    else if (s.status === 'tool-call') out.tool++;
    else if (s.status === 'streaming') out.streaming++;
    else if (s.status === 'done')      out.done++;
    else if (s.status === 'error')     out.error++;
  }
  return out;
}
