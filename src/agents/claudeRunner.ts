/**
 * Worker-mode agent runner using the provider-neutral direct LLM client.
 * OpenAI and Anthropic streams are normalized before entering the tool loop.
 */

import type { ChatMessage, ToolCall } from './types.js';
import { loadConfig } from '../config/env.js';
import { appendMessages } from './agentStore.js';
import { extractAndStoreMemories } from './memory.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { currentTraceId, withTraceContext } from '../lib/langfuseTracing.js';
import { runPreToolHooks, runPostToolHooks } from './hooks/index.js';
import { wrapToolOutput } from './toolOutputTagging.js';
import type { HookContext } from './hooks/index.js';
import { streamChatCompletion } from '../llm/client.js';
import { resolveLlmTarget } from '../llm/targets.js';
import type { ChatStreamChunk, LlmTarget, LlmTool } from '../llm/types.js';
import type pg from 'pg';

export type WorkerTermination =
  | 'completed'
  | 'tool_calls'
  | 'tool_required_retry'
  | 'token_limit'
  | 'empty_response'
  | 'iteration_limit'
  | 'timeout'
  | 'network_error'
  | 'provider_error'
  | 'content_filter'
  | 'unknown_error';

export interface WorkerIterationTelemetry {
  iteration: number;
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
  termination: WorkerTermination;
}

export interface ClaudeAgentChunk {
  delta?: string;
  tool_call?: { id: string; name: string; args: unknown };
  tool_result?: {
    id: string;
    name: string;
    preview: string;
    result?: string;
    traceId?: string;
    spanId?: string;
  };
  telemetry?: WorkerIterationTelemetry;
  terminal?: WorkerTermination;
  done?: true;
  error?: string;
}

export interface WorkerToolExecutionResult {
  result: string;
  traceId?: string;
  spanId?: string;
}

export type WorkerToolExecutor = (
  name: string,
  args: unknown,
  toolCallId?: string,
) => Promise<string | WorkerToolExecutionResult>;

export interface WorkerStreamObservation {
  inputTokens: number;
  outputTokens: number;
  finishReason: string | null;
}

function tokenCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

/**
 * Capture usage-only terminal chunks as well as normal choice deltas. LiteLLM
 * and OpenAI-compatible providers may send the final usage event with an empty
 * choices array, so usage must be observed before looking for a delta.
 */
export function observeWorkerStreamChunk(
  current: WorkerStreamObservation,
  chunk: ChatStreamChunk,
): WorkerStreamObservation {
  const usage = chunk.usage;
  const finishReason = chunk.choices.find(choice => choice.finish_reason)?.finish_reason ?? current.finishReason;
  return {
    // Usage is cumulative for one request. max() also prevents duplicate final
    // events from being double-counted by compatibility gateways.
    inputTokens: Math.max(current.inputTokens, tokenCount(usage?.prompt_tokens)),
    outputTokens: Math.max(current.outputTokens, tokenCount(usage?.completion_tokens)),
    finishReason,
  };
}

export function classifyWorkerTermination(input: {
  finishReason: string | null;
  hasText: boolean;
  toolCallCount: number;
  willRetryRequiredTool?: boolean;
}): WorkerTermination {
  const reason = input.finishReason?.trim().toLowerCase() ?? '';
  if (reason === 'length' || reason.includes('max_token') || reason.includes('model_length')) {
    return 'token_limit';
  }
  if (reason.includes('content_filter') || reason.includes('safety')) return 'content_filter';
  if (reason.includes('error') || reason.includes('failed')) return 'provider_error';
  if (input.toolCallCount > 0) return 'tool_calls';
  if (input.willRetryRequiredTool) return 'tool_required_retry';
  if (input.hasText) return 'completed';
  return 'empty_response';
}

export function classifyWorkerError(error: unknown): WorkerTermination {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  if (/timeout|timed out|aborterror|aborted/.test(message)) return 'timeout';
  if (/fetch failed|network|socket|econn|connection reset|connection refused/.test(message)) return 'network_error';
  if (/api error|provider|rate.?limit|overloaded|service unavailable/.test(message)) return 'provider_error';
  return 'unknown_error';
}

/**
 * A few OpenAI-compatible streaming adapters repeat the complete JSON tool
 * arguments in more than one delta. Concatenating those deltas produces
 * `{"path":"..."}{"path":"..."}`, which LiteLLM cannot replay on the next
 * turn. Keep the first complete JSON object and emit one canonical value.
 */
export function normalizeToolArguments(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '{}';
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? JSON.stringify(parsed)
      : '{}';
  } catch {
    let start = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index]!;
      if (start < 0) {
        if (char !== '{') continue;
        start = index;
        depth = 1;
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(value.slice(start, index + 1)) as unknown;
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              ? JSON.stringify(parsed)
              : '{}';
          } catch {
            return '{}';
          }
        }
      }
    }
    return '{}';
  }
}

/**
 * Some local Ollama templates return a requested function call as the entire
 * assistant text instead of populating the OpenAI `tool_calls` field. Recover
 * common JSON wrappers from that text, but only when the named tool was
 * advertised for this exact iteration. The normal executor authorization,
 * hooks and path policy still run afterwards.
 */
function decodeLooseJsonString(value: string): string {
  const escapedControls = value
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
  try {
    return JSON.parse(`"${escapedControls}"`) as string;
  } catch {
    // Preserve code even if the model forgot to escape an inner quote. This
    // fallback only feeds the normal workspace executor; its size/path policy
    // and hooks remain authoritative.
    return value
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
}

function parseLooseWorkspaceWriteCandidate(
  candidate: string,
  allowedToolNames: readonly string[],
): ToolCall | null {
  const nameMatch = /"(?:name|tool|tool_name)"\s*:\s*"([^"]+)"/.exec(candidate);
  const name = nameMatch?.[1];
  if (name !== 'workspace_write' || !allowedToolNames.includes(name)) return null;
  const pathMatch = /"path"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(candidate);
  // Greedy content capture is intentional: source code may contain quotes and
  // braces; the final quote followed by both closing objects is the delimiter.
  const contentMatch = /"content"\s*:\s*"([\s\S]*)"\s*}\s*}\s*$/.exec(candidate);
  if (!pathMatch || !contentMatch) return null;
  const path = decodeLooseJsonString(pathMatch[1]!);
  const content = decodeLooseJsonString(contentMatch[1]!);
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify({ path, content }) },
  };
}

function parseTextToolCallCandidate(
  candidate: string,
  allowedToolNames: readonly string[],
): ToolCall | null {
  try {
    const parsed = JSON.parse(candidate) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const nestedFunction = parsed.function && typeof parsed.function === 'object' && !Array.isArray(parsed.function)
      ? parsed.function as Record<string, unknown>
      : undefined;
    const name = parsed.name ?? parsed.tool ?? parsed.tool_name ?? nestedFunction?.name;
    if (typeof name !== 'string' || !allowedToolNames.includes(name)) return null;
    const rawArguments = parsed.arguments
      ?? parsed.args
      ?? parsed.parameters
      ?? parsed.input
      ?? nestedFunction?.arguments;
    const args = typeof rawArguments === 'string'
      ? normalizeToolArguments(rawArguments)
      : rawArguments && typeof rawArguments === 'object' && !Array.isArray(rawArguments)
        ? JSON.stringify(rawArguments)
        : '{}';
    return {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name, arguments: args },
    };
  } catch {
    // Qwen/Ollama occasionally emits literal newlines inside a JSON `content`
    // string. Recover only the narrow workspace_write shape; never apply a
    // generic eval/JSON5 parser to model output.
    return parseLooseWorkspaceWriteCandidate(candidate, allowedToolNames);
  }
}

function reconcileRecoveredWorkspacePaths(calls: ToolCall[]): ToolCall[] {
  const readPaths = calls
    .filter(call => call.function.name === 'workspace_read')
    .map(call => normalizeToolArguments(call.function.arguments))
    .map(raw => JSON.parse(raw) as Record<string, unknown>)
    .map(args => typeof args.path === 'string' ? args.path : '')
    .filter(path => path.startsWith('/workspace/'));
  if (readPaths.length === 0) return calls;

  return calls.map(call => {
    if (call.function.name !== 'workspace_write') return call;
    const args = JSON.parse(normalizeToolArguments(call.function.arguments)) as Record<string, unknown>;
    const writePath = typeof args.path === 'string' ? args.path : '';
    if (!writePath.startsWith('/workspace/') || readPaths.includes(writePath)) return call;
    const relativePath = writePath.slice('/workspace/'.length);
    const matchingReads = readPaths.filter(path => path.endsWith(`/${relativePath}`));
    if (matchingReads.length !== 1) return call;
    return {
      ...call,
      function: {
        ...call.function,
        // A local coder sometimes drops the ticket directory between a read
        // and write. Rebind only to the one exact file it already read; never
        // infer a new or broader writable path.
        arguments: JSON.stringify({ ...args, path: matchingReads[0] }),
      },
    };
  });
}

/**
 * Recover all complete, authorized tool calls from a local model's text turn.
 * Some Ollama templates emit a short sequence (list, read, write) as adjacent
 * JSON objects instead of using OpenAI's native `tool_calls` array. Preserve
 * that order and cap the batch so one malformed model turn cannot bypass the
 * worker iteration budget with an unbounded number of calls.
 */
export function parseTextToolCalls(
  text: string,
  allowedToolNames: readonly string[],
): ToolCall[] {
  if (allowedToolNames.length === 0) return [];
  const source = text.trim();
  const fencedPattern = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  const fencedCandidates = [...source.matchAll(fencedPattern)].map(match => match[1]!.trim());
  const objectCandidates: string[] = [];
  let objectStart = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (objectStart < 0) {
      if (char === '{') {
        objectStart = index;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        objectCandidates.push(source.slice(objectStart, index + 1));
        objectStart = -1;
      }
    }
  }

  // Balanced objects are the canonical source because they also survive
  // malformed/adjacent Markdown fences without duplicating fenced candidates.
  const candidates = objectCandidates.length > 0
    ? objectCandidates
    : fencedCandidates.length > 0
      ? fencedCandidates
      : [source];
  const calls: ToolCall[] = [];
  for (const candidate of candidates) {
    const call = parseTextToolCallCandidate(candidate, allowedToolNames);
    if (call) calls.push(call);
    if (calls.length >= 8) break;
  }
  return reconcileRecoveredWorkspacePaths(calls);
}

export function parseTextToolCall(
  text: string,
  allowedToolNames: readonly string[],
): ToolCall | null {
  const calls = parseTextToolCalls(text, allowedToolNames);
  return calls.at(-1) ?? null;
}

/**
 * Worker turns must begin by grounding themselves in the real workspace.
 * Requiring one tool call prevents smaller local models from merely describing
 * the edit they intend to make. Later turns return to `auto`, so the model can
 * finish normally after it has read or changed the repository.
 */
export function workerToolChoice(
  iteration: number,
  toolNames: readonly string[],
  requiredSequence: readonly string[] = [],
): 'required' | 'auto' | Record<string, unknown> | undefined {
  if (toolNames.length === 0) return undefined;
  const requiredTool = requiredSequence[iteration];
  // `required` is supported consistently across LiteLLM/Ollama targets. Some
  // local providers accept an exact function selector but then stall or emit
  // empty arguments, so the sequence remains a prompt/retry aid rather than a
  // provider-specific hard selector.
  if (requiredTool && toolNames.includes(requiredTool)) return 'required';
  return iteration === 0 ? 'required' : 'auto';
}

export function requiredToolCorrection(
  toolName: string,
  userMessage: string,
  requiredPath?: string,
): string {
  const root = /Workspace directory:\s*(\/workspace\/[A-Za-z0-9-]+)/i.exec(userMessage)?.[1];
  const relativePaths = [...userMessage.matchAll(
    /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),.:;])/g,
  )].map(match => match[1]!);
  const absoluteTargets = root
    ? [...new Set(relativePaths.map(path => `${root}/${path}`))]
    : [];

  if (toolName === 'workspace_write') {
    const exactTarget = requiredPath && root ? `${root}/${requiredPath}` : requiredPath;
    const targets = exactTarget
      ? ` The still-missing required ticket file is ${exactTarget}. Write that exact existing repository file now.`
      : absoluteTargets.length > 0
      ? ` Required ticket files: ${absoluteTargets.join(', ')}.`
      : '';
    return `Your previous prose or diff was not executed. Invoke workspace_write now.${targets} ` +
      'Return only valid tool-call JSON, not Markdown and not a unified diff. Use this shape for every changed file: ' +
      '{"name":"workspace_write","arguments":{"path":"ABSOLUTE_FILE_PATH","content":"COMPLETE_UPDATED_FILE_CONTENT"}}';
  }
  if (toolName === 'workspace_ls' && root) {
    return `No tool was invoked. Invoke workspace_ls now with path ${root}; do not describe or simulate it.`;
  }
  return `No tool was invoked. Invoke ${toolName} now; do not describe or simulate it.`;
}

// ── Main runner ───────────────────────────────────────────────────

export async function* runClaudeWorkerAgent(
  agentId: number,
  sessionId: string,
  systemPrompt: string,
  historyMessages: ChatMessage[],
  userMessage: string,
  oaiTools: unknown[],
  executeTool: WorkerToolExecutor,
  maxIterations: number,
  maxTokens: number,
  pool: pg.Pool,
  llmUrl: string,   // compatibility argument; direct targets resolve in src/llm
  llmKey: string,   // optional per-agent provider key (DIRECT_AGENT_API_KEYS=true)
  modelName = 'claude-opus-4-6',
  thinkingBudget = 0,  // Anthropic extended-thinking budget (tokens); 0 = disabled (mig 078)
  untrustedToolEnforcement = true,  // A2AS tool-output tagging; default on (mig 080)
  callingUser?: { id: number; entra_groups: string[] }, // SSO user context; undefined for API-key callers
  llmTargetOverride?: LlmTarget,
  requiredToolSequence: readonly string[] = [],
  requiredWorkspaceWritePaths: readonly string[] = [],
  automaticMemoryEnabled = false,
): AsyncGenerator<ClaudeAgentChunk> {
  // Build message history in OpenAI format (same format as DB storage)
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...historyMessages.filter(m => m.role !== 'system'),
    { role: 'user', content: userMessage },
  ];

  const newMessages: ChatMessage[] = [{ role: 'user', content: userMessage }];
  let requiredToolCursor = 0;
  let requiredToolMisses = 0;
  const completedWorkspaceWritePaths = new Set<string>();

  const normalizeWritePath = (value: string): string => value
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  const missingWorkspaceWritePaths = (): string[] => requiredWorkspaceWritePaths.filter(
    requiredPath => !completedWorkspaceWritePaths.has(normalizeWritePath(requiredPath)),
  );
  const pendingRequirement = (): { toolName: string; path?: string } | null => {
    const sequencedTool = requiredToolSequence[requiredToolCursor];
    if (sequencedTool) return { toolName: sequencedTool };
    const missingPath = missingWorkspaceWritePaths()[0];
    return missingPath ? { toolName: 'workspace_write', path: missingPath } : null;
  };

  // ── Wall-clock session timeout (T4) ────────────────────────────────
  const sessionStartMs = Date.now();
  const maxSessionSeconds = loadConfig().maxAgentSessionSeconds || 0;
  const maxSessionMs = maxSessionSeconds * 1000;
  let completedNormally = false;
  let terminalFailure = false;

  for (let i = 0; i < maxIterations; i++) {
    if (maxSessionMs > 0 && (Date.now() - sessionStartMs) > maxSessionMs) {
      terminalFailure = true;
      yield {
        error: `Session-Timeout nach ${maxSessionSeconds}s erreicht — Abbruch.`,
        terminal: 'timeout',
      };
      break;
    }

    let assistantText = '';
    let streamObservation: WorkerStreamObservation = {
      inputTokens: 0,
      outputTokens: 0,
      finishReason: null,
    };
    const tcMap = new Map<number, { id: string; name: string; args: string }>();
    const availableTools = oaiTools as LlmTool[];
    // Keep the complete grant-scoped catalog visible. Local coder templates
    // often emit a list/read/write sequence in a single text turn; hiding all
    // but one tool made us discard valid later writes from that sequence.
    const iterationTools = availableTools;
    const iterationRequirement = pendingRequirement();

    try {
      for await (const chunk of streamChatCompletion({
        model: modelName,
        max_tokens: maxTokens,
        messages,
        ...(iterationTools.length > 0 ? {
          tools: iterationTools,
          tool_choice: workerToolChoice(
            iterationRequirement ? 0 : i,
            iterationTools.map(tool => tool.function.name),
            iterationRequirement ? [iterationRequirement.toolName] : [],
          ),
        } : {}),
        ...(thinkingBudget > 0
          ? { thinking: { type: 'enabled' as const, budget_tokens: thinkingBudget } }
          : {}),
      }, { apiKeyOverride: llmKey || undefined, targetOverride: llmTargetOverride })) {
        // Observe usage before checking the choice delta: LiteLLM can send a
        // usage-only final event with choices: [].
        streamObservation = observeWorkerStreamChunk(streamObservation, chunk);
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          assistantText += delta.content;
          yield { delta: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const isNew = !tcMap.has(tc.index);
            if (isNew) {
              tcMap.set(tc.index, { id: tc.id ?? `tc_${tc.index}`, name: tc.function?.name ?? '', args: '' });
            }
            const entry = tcMap.get(tc.index)!;
            if (tc.id) entry.id = tc.id;
            // Append name only on subsequent deltas — the first delta already set it
            // in the init line above. Without this guard, the name gets duplicated
            // (e.g. "workspace_lsworkspace_ls") because both branches fire for the
            // first delta of a tool_use block.
            if (!isNew && tc.function?.name) entry.name += tc.function.name;
            if (tc.function?.arguments) entry.args += tc.function.arguments;
          }
        }
      }
    } catch (error) {
      const termination = classifyWorkerError(error);
      yield {
        telemetry: {
          iteration: i + 1,
          inputTokens: streamObservation.inputTokens,
          outputTokens: streamObservation.outputTokens,
          finishReason: streamObservation.finishReason,
          termination,
        },
        terminal: termination,
      };
      throw error;
    }

    const toolCalls: ToolCall[] = [...tcMap.values()].map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: { name: tc.name, arguments: normalizeToolArguments(tc.args) },
    }));
    let recoveredTextToolCalls = false;
    if (toolCalls.length === 0 && assistantText) {
      const parsedTextToolCalls = parseTextToolCalls(
        assistantText,
        availableTools.map(tool => tool.function.name),
      );
      // The sequence is a prompting aid, not an authorization boundary. Local
      // coders legitimately skip redundant discovery (for example, reading a
      // known file without listing its parent first). Every recovered call is
      // still constrained by the effective Agent x Bundle tool catalog here
      // and by hooks, execution grants and path policy in the executor below.
      if (parsedTextToolCalls.length > 0) {
        toolCalls.push(...parsedTextToolCalls);
        assistantText = '';
        recoveredTextToolCalls = true;
      }
    }

    const pending = pendingRequirement();
    const pendingTool = pending?.toolName;
    const willRetryRequiredTool = Boolean(
      toolCalls.length === 0
      && pendingTool
      && requiredToolMisses < (pendingTool === 'workspace_write' ? 4 : 2)
      && iterationTools.some(tool => tool.function.name === pendingTool),
    );
    const termination = classifyWorkerTermination({
      finishReason: streamObservation.finishReason,
      hasText: Boolean(assistantText.trim()),
      toolCallCount: toolCalls.length,
      willRetryRequiredTool,
    });
    yield {
      telemetry: {
        iteration: i + 1,
        inputTokens: streamObservation.inputTokens,
        outputTokens: streamObservation.outputTokens,
        finishReason: streamObservation.finishReason,
        termination,
      },
    };

    const assistantMsg: ChatMessage = {
      role: 'assistant',
      content: assistantText || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
    newMessages.push(assistantMsg);
    messages.push(assistantMsg);

    if (termination === 'token_limit' || termination === 'content_filter' || termination === 'provider_error') {
      const message = termination === 'token_limit'
        ? `LLM output truncated at the configured token limit (${maxTokens}; finish_reason=${streamObservation.finishReason ?? 'unknown'}).`
        : termination === 'content_filter'
          ? `LLM response blocked by the provider content filter (finish_reason=${streamObservation.finishReason ?? 'unknown'}).`
          : `LLM provider ended the worker turn with finish_reason=${streamObservation.finishReason ?? 'unknown'}.`;
      terminalFailure = true;
      yield { error: message, terminal: termination };
      break;
    }

    if (toolCalls.length === 0) {
      if (pendingTool && willRetryRequiredTool) {
        // Some local OpenAI-compatible runtimes ignore tool_choice and return
        // a narrated "done" response. Keep the same required-tool cursor and
        // explicitly retry inside this worker turn instead of consuming a
        // whole LangGraph review retry with an empty workspace.
        const correction: ChatMessage = {
          role: 'user',
          content: requiredToolCorrection(pendingTool, userMessage, pending?.path),
        };
        newMessages.push(correction);
        messages.push(correction);
        requiredToolMisses += 1;
        continue;
      }
      if (pendingTool) {
        terminalFailure = true;
        yield {
          error: `Required worker tool '${pendingTool}' was not completed successfully.`,
          terminal: 'provider_error',
        };
        break;
      }
      if (!assistantText.trim()) {
        terminalFailure = true;
        yield {
          error: `LLM returned an empty terminal response (finish_reason=${streamObservation.finishReason ?? 'unknown'}).`,
          terminal: 'empty_response',
        };
        break;
      }
      completedNormally = true;
      break;
    }
    requiredToolMisses = 0;

    // Timeout check before launching tool round — prevents runaway tool loops.
    if (maxSessionMs > 0 && (Date.now() - sessionStartMs) > maxSessionMs) {
      terminalFailure = true;
      yield {
        error: `Session-Timeout nach ${maxSessionSeconds}s erreicht — Tool-Calls abgebrochen.`,
        terminal: 'timeout',
      };
      break;
    }

    // audit A2: tolerate malformed/truncated tool-arg JSON (a known Anthropic
    // emission bug). `|| '{}'` only covers the empty-string case; an unguarded
    // JSON.parse on a truncated fragment would reject this async generator and
    // crash the whole worker turn with no tool result recorded.
    const safeArgs = (raw: string | undefined): Record<string, unknown> => {
      try {
        const v = JSON.parse(normalizeToolArguments(raw));
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
      } catch {
        // malformed/truncated tool-call args → default to {} instead of crashing
        return {};
      }
    };

    for (const tc of toolCalls) {
      yield { tool_call: { id: tc.id, name: tc.function.name, args: safeArgs(tc.function.arguments) } };
    }

    const executeSingleTool = async (tc: ToolCall) => {
        const parsedArgs = safeArgs(tc.function.arguments);
        const hookCtxBase: HookContext = {
          agentId, agentName: `agent_${agentId}`, sessionId,
          toolName: tc.function.name, toolArgs: parsedArgs,
          iteration: i + 1, agentDepth: 0,
          userId: callingUser?.id,
          userGroups: callingUser?.entra_groups,
        };

        // Pre-tool-use hooks — may block or modify args
        const preOutcome = await runPreToolHooks(pool, hookCtxBase);
        if (preOutcome.decision === 'block') {
          const reason = `[hook:${preOutcome.hookName}] ${preOutcome.reason}`;
          return { id: tc.id, name: tc.function.name, result: reason, isError: true, args: parsedArgs };
        }
        const finalArgs = preOutcome.decision === 'modify' && preOutcome.modifiedArgs
          ? preOutcome.modifiedArgs
          : parsedArgs;

        let result: string;
        let traceId: string | undefined;
        let spanId: string | undefined;
        let isError = false;
        try {
          const execution = await executeTool(tc.function.name, finalArgs, tc.id);
          if (typeof execution === 'string') {
            result = execution;
          } else {
            result = execution.result;
            traceId = execution.traceId;
            spanId = execution.spanId;
          }
          isError = /^(?:Error:|Tool execution failed:|\[hook:)/.test(result);
        } catch (err) {
          isError = true;
          result = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Post-tool-use hooks — observability only, never blocks
        await runPostToolHooks(pool, {
          ...hookCtxBase, toolArgs: finalArgs, toolResult: result, toolIsError: isError,
        });

        return { id: tc.id, name: tc.function.name, result, isError, args: finalArgs, traceId, spanId };
    };
    const toolResults: Array<{
      id: string;
      name: string;
      result: string;
      isError: boolean;
      args: Record<string, unknown>;
      traceId?: string;
      spanId?: string;
    }> = [];
    if (recoveredTextToolCalls) {
      // Text-encoded call batches express an ordered plan (for example, read
      // before write), so do not race them through Promise.all.
      for (const tc of toolCalls) toolResults.push(await executeSingleTool(tc));
    } else {
      toolResults.push(...await Promise.all(toolCalls.map(executeSingleTool)));
    }

    // Required grounding advances only after the executor confirmed success.
    // Merely emitting a tool-shaped JSON object (or a denied write) is not work.
    for (const result of toolResults) {
      if (result.isError) continue;
      if (result.name === requiredToolSequence[requiredToolCursor]) {
        requiredToolCursor += 1;
      }
      if (result.name === 'workspace_write' && typeof result.args['path'] === 'string') {
        const actualPath = normalizeWritePath(result.args['path']);
        for (const requiredPath of requiredWorkspaceWritePaths) {
          const normalizedRequired = normalizeWritePath(requiredPath);
          if (actualPath === normalizedRequired || actualPath.endsWith(`/${normalizedRequired}`)) {
            completedWorkspaceWritePaths.add(normalizedRequired);
          }
        }
      }
    }

    for (const r of toolResults) {
      yield {
        tool_result: {
          id: r.id,
          name: r.name,
          preview: r.result.slice(0, 200),
          result: r.result,
          ...(r.traceId ? { traceId: r.traceId } : {}),
          ...(r.spanId ? { spanId: r.spanId } : {}),
        },
      };
    }

    const toolResultMsgs: ChatMessage[] = toolResults.map(r => ({
      role: 'tool' as const,
      content: untrustedToolEnforcement ? wrapToolOutput(r.name, r.id, r.result) : r.result,
      tool_call_id: r.id,
      name: r.name,
    }));
    newMessages.push(...toolResultMsgs);
    messages.push(...toolResultMsgs);
  }

  if (!completedNormally && !terminalFailure) {
    yield {
      error: `Worker reached the iteration limit (${maxIterations}) before producing a terminal response.`,
      terminal: 'iteration_limit',
    };
  }

  await appendMessages(pool, sessionId, newMessages);
  // Re-enter trace context for fire-and-forget memory extraction so the
  // gpt-5.1 + embedding calls nest under the parent agent.worker trace.
  if (automaticMemoryEnabled) {
    const memTraceId = currentTraceId();
    Promise.resolve().then(() => {
      const fn = () => extractAndStoreMemories(
        pool,
        agentId,
        sessionId,
        newMessages,
        llmUrl,
        llmKey,
        modelName,
        llmTargetOverride,
      );
      return memTraceId ? withTraceContext({ traceId: memTraceId }, fn) : fn();
    }).catch(() => {});
  }
  writeImmutableAudit(pool, {
    eventType: 'request_success',
    apiKeyPrefix: `agent__${agentId}`,
    model: modelName,
    provider: llmTargetOverride?.runtimeType
      ?? llmTargetOverride?.provider
      ?? resolveLlmTarget(modelName, llmKey || undefined).provider,
    sessionId,
  });

  yield { done: true };
}
