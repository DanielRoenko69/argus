import { logger } from '../lib/logger.js';
import { randomUUID } from 'node:crypto';
import { Agent } from 'undici';
import { assertLlmTargetConfigured, resolveLlmTarget } from './targets.js';
import { buildCodexRuntimePrompt } from './codexContextBudget.js';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatStreamChunk,
  EmbeddingResponse,
  LlmMessage,
  LlmTarget,
  LlmTool,
  LlmToolCall,
  LlmUsage,
} from './types.js';

interface CallOptions {
  /** Evaluations must not hide extra billable attempts or log raw error bodies. */
  maxRetries?: number;
  safeErrors?: boolean;
  apiKeyOverride?: string | null;
  targetOverride?: LlmTarget;
  signal?: AbortSignal;
  timeoutMs?: number;
}

// Subscription-runtime responses can legitimately take longer than Undici's
// default five-minute response-header timeout. The existing request signal is
// still the authoritative per-call deadline.
const subscriptionRuntimeDispatcher = new Agent({
  headersTimeout: 1_830_000,
  bodyTimeout: 1_830_000,
});

function boundedInt(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

function retryCount(): number {
  return boundedInt(process.env['LLM_MAX_RETRIES'], 2, 0, 4);
}

function retryDelayMs(attempt: number, response: Response): number {
  const retryAfter = Number(response.headers.get('retry-after') || 0);
  const configured = boundedInt(process.env['LLM_RETRY_BASE_MS'], 250, 1, 10_000);
  const maximum = boundedInt(process.env['LLM_RETRY_MAX_MS'], 4_000, configured, 30_000);
  const providerDelay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : configured * (2 ** attempt);
  return Math.min(maximum, Math.max(1, Math.round(providerDelay)));
}

function retryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function authHeaders(target: LlmTarget): Record<string, string> {
  if (target.authType === 'none') return {};
  if (target.provider === 'anthropic') {
    return {
      'x-api-key': target.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }
  if (target.authType === 'api-key') return target.apiKey ? { 'api-key': target.apiKey } : {};
  return target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {};
}

function requestSignal(target: LlmTarget, options?: CallOptions): AbortSignal {
  return options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? target.timeoutMs);
}

async function checkedFetch(url: string, init: RequestInit, provider: string, options?: CallOptions): Promise<Response> {
  const attempts = options?.maxRetries === undefined ? retryCount() : Math.max(0, Math.min(4, Math.floor(options.maxRetries)));
  for (let attempt = 0; attempt <= attempts; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok) return response;
    const errorText = await response.text().catch(() => '');
    if (retryableStatus(response.status) && attempt < attempts && !init.signal?.aborted) {
      const delayMs = retryDelayMs(attempt, response);
      logger.warn({ provider, status: response.status, attempt: attempt + 1, delayMs }, 'Transient LLM API error — retrying');
      await new Promise(resolve => setTimeout(resolve, delayMs));
      continue;
    }
    logger.warn({ provider, status: response.status, ...(options?.safeErrors ? {} : { error: errorText.slice(0, 1000) }) }, 'Direct LLM API error');
    throw new Error(`${provider} API error ${response.status}${options?.safeErrors ? '' : ': ' + errorText.slice(0, 500)}`);
  }
  throw new Error(`${provider} API request exhausted retries`);
}

async function* sseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  if (!response.body) throw new Error('LLM API returned an empty streaming response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const event of events) {
      const data = event.split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data) as Record<string, unknown>;
      } catch {
        logger.debug({ data: data.slice(0, 200) }, 'Skipping malformed LLM SSE event');
      }
    }
  }
}

function openAiBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.max_tokens !== undefined ? { max_tokens: request.max_tokens } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(request.tools?.length ? { tools: request.tools, tool_choice: request.tool_choice ?? 'auto' } : {}),
    ...(request.response_format ? { response_format: request.response_format } : {}),
    ...(request.user ? { user: request.user } : {}),
    ...(request.reasoning_effort ? { reasoning_effort: request.reasoning_effort } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
}

function contentBlocks(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];

  const blocks: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const item = part as Record<string, unknown>;
    if (item['type'] === 'text' && typeof item['text'] === 'string') {
      blocks.push({ type: 'text', text: item['text'] });
      continue;
    }
    if (item['type'] !== 'image_url') continue;
    const image = item['image_url'] as Record<string, unknown> | undefined;
    const url = typeof image?.['url'] === 'string' ? image['url'] : '';
    const dataMatch = /^data:([^;,]+);base64,(.+)$/s.exec(url);
    if (dataMatch) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: dataMatch[1], data: dataMatch[2] },
      });
    } else if (url) {
      blocks.push({ type: 'image', source: { type: 'url', url } });
    }
  }
  return blocks;
}

function safeToolInput(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mergeAnthropicMessage(
  messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }>,
  role: 'user' | 'assistant',
  blocks: Array<Record<string, unknown>>,
): void {
  if (blocks.length === 0) return;
  const previous = messages[messages.length - 1];
  if (previous?.role === role) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function anthropicBody(request: ChatCompletionRequest, stream: boolean): Record<string, unknown> {
  const systems: string[] = [];
  const messages: Array<{ role: 'user' | 'assistant'; content: Array<Record<string, unknown>> }> = [];

  for (const message of request.messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string') systems.push(message.content);
      continue;
    }
    if (message.role === 'tool') {
      mergeAnthropicMessage(messages, 'user', [{
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
      }]);
      continue;
    }

    const blocks = contentBlocks(message.content);
    if (message.role === 'assistant' && message.tool_calls?.length) {
      blocks.push(...message.tool_calls.map(call => ({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: safeToolInput(call.function.arguments),
      })));
    }
    mergeAnthropicMessage(messages, message.role, blocks);
  }

  const thinking = request.thinking?.budget_tokens
    ? { type: 'enabled', budget_tokens: request.thinking.budget_tokens }
    : undefined;
  const namedTool = request.tool_choice && typeof request.tool_choice === 'object'
    ? (request.tool_choice['function'] as { name?: unknown } | undefined)?.name
    : undefined;
  const anthropicToolChoice = typeof namedTool === 'string'
    ? { type: 'tool', name: namedTool }
    : request.tool_choice === 'required'
      ? { type: 'any' }
      : request.tool_choice === 'auto'
        ? { type: 'auto' }
        : undefined;

  return {
    model: request.model,
    messages,
    max_tokens: request.max_tokens ?? 4096,
    stream,
    ...(systems.length ? {
      system: [{ type: 'text', text: systems.join('\n\n'), cache_control: { type: 'ephemeral' } }],
    } : {}),
    ...(!thinking && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(!thinking && request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(thinking ? { thinking } : {}),
    ...(request.tools?.length ? {
      tools: request.tools.map(tool => ({
        name: tool.function.name,
        description: tool.function.description ?? '',
        input_schema: tool.function.parameters?.['type']
          ? tool.function.parameters
          : { type: 'object', properties: tool.function.parameters?.['properties'] ?? {} },
      })),
      ...(anthropicToolChoice ? { tool_choice: anthropicToolChoice } : {}),
    } : {}),
  };
}

function usageFromAnthropic(raw: Record<string, unknown>): LlmUsage {
  const prompt = Number(raw['input_tokens'] ?? 0);
  const completion = Number(raw['output_tokens'] ?? 0);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cache_creation_input_tokens: Number(raw['cache_creation_input_tokens'] ?? 0),
    cache_read_input_tokens: Number(raw['cache_read_input_tokens'] ?? 0),
  };
}

function anthropicResponse(data: Record<string, unknown>, model: string): ChatCompletionResponse {
  const blocks = Array.isArray(data['content']) ? data['content'] as Array<Record<string, unknown>> : [];
  const text = blocks
    .filter(block => block['type'] === 'text')
    .map(block => String(block['text'] ?? ''))
    .join('');
  const toolCalls: LlmToolCall[] = blocks
    .filter(block => block['type'] === 'tool_use')
    .map(block => ({
      id: String(block['id'] ?? ''),
      type: 'function',
      function: {
        name: String(block['name'] ?? ''),
        arguments: JSON.stringify(block['input'] ?? {}),
      },
    }));
  const stopReason = String(data['stop_reason'] ?? 'stop');

  return {
    id: String(data['id'] ?? ''),
    model: String(data['model'] ?? model),
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: stopReason === 'tool_use'
        ? 'tool_calls'
        : stopReason === 'end_turn'
          ? 'stop'
          : stopReason,
    }],
    usage: usageFromAnthropic((data['usage'] as Record<string, unknown>) ?? {}),
    usage_observed: data['usage'] && typeof data['usage'] === 'object'
      ? Object.fromEntries([
        ['prompt_tokens', (data['usage'] as Record<string, unknown>)['input_tokens']],
        ['completion_tokens', (data['usage'] as Record<string, unknown>)['output_tokens']],
        ['cache_creation_input_tokens', (data['usage'] as Record<string, unknown>)['cache_creation_input_tokens']],
        ['cache_read_input_tokens', (data['usage'] as Record<string, unknown>)['cache_read_input_tokens']],
      ].filter(([, value]) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) : null,
  };
}

type CodexRuntimeResponse = {
  response?: unknown;
  model?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cached_input_tokens?: unknown;
  } | null;
};

function balancedJsonObjects(value: string): string[] {
  const objects: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (start < 0) {
      if (char === '{') { start = index; depth = 1; }
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
        objects.push(value.slice(start, index + 1));
        start = -1;
        if (objects.length >= 8) break;
      }
    }
  }
  return objects;
}

export function parseCodexRuntimeToolCalls(
  response: string,
  tools: LlmTool[] = [],
): LlmToolCall[] {
  const allowed = new Set(tools.map(tool => tool.function.name));
  if (allowed.size === 0) return [];
  const calls: LlmToolCall[] = [];
  for (const candidate of balancedJsonObjects(response)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const name = parsed['name'];
      if (typeof name !== 'string' || !allowed.has(name)) continue;
      const rawArgs = parsed['arguments'] ?? parsed['args'] ?? {};
      let args: Record<string, unknown>;
      if (typeof rawArgs === 'string') {
        const decoded = JSON.parse(rawArgs) as unknown;
        args = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
          ? decoded as Record<string, unknown>
          : {};
      } else {
        args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
          ? rawArgs as Record<string, unknown>
          : {};
      }
      calls.push({
        id: `codex_${randomUUID()}`,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      });
    } catch {
      // Model text is untrusted. Only strict JSON objects enter the Core loop.
    }
  }
  return calls;
}

async function codexRuntimeCompletion(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): Promise<ChatCompletionResponse> {
  const context = buildCodexRuntimePrompt(request);
  if (context.report.compacted) {
    logger.info({
      event: 'codex_context_compacted',
      rootTraceId: target.runtimeRootTraceId,
      agentId: target.runtimeAgentId,
      ...context.report,
    }, 'Codex runtime context compacted before execution');
  }
  const requestInit: RequestInit & { dispatcher: Agent } = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-secret': target.apiKey,
    },
    body: JSON.stringify({
      prompt: context.prompt,
      cwd: target.runtimeWorkingDirectory ?? '/runtime',
      executionMode: 'core-agent',
      model: target.model,
      reasoningEffort: target.runtimeReasoningEffort ?? 'high',
      // The HTTP caller keeps ten seconds of transport margin beyond the
      // runtime's own deadline so the bridge can return structured evidence.
      timeoutSec: Math.max(30, Math.min(1_800, Math.ceil((target.timeoutMs - 10_000) / 1_000))),
      ...(target.runtimeRootTraceId ? { rootTraceId: target.runtimeRootTraceId } : {}),
      ...(target.runtimeAgentId ? { agentId: target.runtimeAgentId } : {}),
      taskType: 'agent_turn',
      telemetryManaged: true,
    }),
    signal: requestSignal(target, options),
    dispatcher: subscriptionRuntimeDispatcher,
  };
  const response = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/codex/run`, requestInit as RequestInit);
  const raw = await response.text();
  let data: CodexRuntimeResponse & { error?: unknown; code?: unknown };
  try { data = JSON.parse(raw) as typeof data; } catch { data = {}; }
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : raw.slice(0, 500);
    throw new Error(`Codex subscription runtime error ${response.status}: ${detail}`);
  }
  const text = typeof data.response === 'string' ? data.response.trim() : '';
  if (!text) throw new Error('Codex subscription runtime returned an empty response');
  const toolCalls = parseCodexRuntimeToolCalls(text, request.tools);
  const inputTokens = Number(data.usage?.input_tokens ?? 0);
  const outputTokens = Number(data.usage?.output_tokens ?? 0);
  return {
    id: randomUUID(),
    model: typeof data.model === 'string' ? data.model : target.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      total_tokens: (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0),
      cache_read_input_tokens: Number(data.usage?.cached_input_tokens ?? 0),
    },
  };
}

async function claudeCodeRuntimeCompletion(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): Promise<ChatCompletionResponse> {
  const context = buildCodexRuntimePrompt(request);
  if (context.report.compacted) {
    logger.info({
      event: 'claude_code_context_compacted',
      rootTraceId: target.runtimeRootTraceId,
      agentId: target.runtimeAgentId,
      ...context.report,
    }, 'Claude Code runtime context compacted before execution');
  }
  const response = await fetch(`${target.baseUrl.replace(/\/+$/, '')}/claude/run`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-workspace-secret': target.apiKey,
    },
    body: JSON.stringify({
      prompt: context.prompt,
      cwd: target.runtimeWorkingDirectory ?? '/runtime',
      ...(target.model && target.model !== 'claude-subscription' ? { model: target.model } : {}),
      timeoutSec: Math.max(30, Math.min(1_800, Math.ceil((target.timeoutMs - 10_000) / 1_000))),
      ...(target.runtimeRootTraceId ? { rootTraceId: target.runtimeRootTraceId } : {}),
      ...(target.runtimeAgentId ? { agentId: target.runtimeAgentId } : {}),
      taskType: 'agent_turn',
      telemetryManaged: true,
    }),
    signal: requestSignal(target, options),
    dispatcher: subscriptionRuntimeDispatcher,
  } as RequestInit & { dispatcher: Agent });
  const raw = await response.text();
  let data: CodexRuntimeResponse & { error?: unknown; code?: unknown };
  try { data = JSON.parse(raw) as typeof data; } catch { data = {}; }
  if (!response.ok) {
    const detail = typeof data.error === 'string' ? data.error : raw.slice(0, 500);
    throw new Error(`Claude Code subscription runtime error ${response.status}: ${detail}`);
  }
  const text = typeof data.response === 'string' ? data.response.trim() : '';
  if (!text) throw new Error('Claude Code subscription runtime returned an empty response');
  const toolCalls = parseCodexRuntimeToolCalls(text, request.tools);
  const inputTokens = Number(data.usage?.input_tokens ?? 0);
  const outputTokens = Number(data.usage?.output_tokens ?? 0);
  return {
    id: randomUUID(),
    model: typeof data.model === 'string' ? data.model : target.model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 ? null : text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: Number.isFinite(inputTokens) ? inputTokens : 0,
      completion_tokens: Number.isFinite(outputTokens) ? outputTokens : 0,
      total_tokens: (Number.isFinite(inputTokens) ? inputTokens : 0) + (Number.isFinite(outputTokens) ? outputTokens : 0),
    },
  };
}

async function openAiCompletion(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): Promise<ChatCompletionResponse> {
  const response = await checkedFetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(target) },
    body: JSON.stringify(openAiBody(request, false)),
    signal: requestSignal(target, options),
  }, target.provider, options);
  return await response.json() as ChatCompletionResponse;
}

async function anthropicCompletion(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): Promise<ChatCompletionResponse> {
  const response = await checkedFetch(`${target.baseUrl}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(target) },
    body: JSON.stringify(anthropicBody(request, false)),
    signal: requestSignal(target, options),
  }, target.provider, options);
  return anthropicResponse(await response.json() as Record<string, unknown>, request.model);
}

export async function chatCompletion(
  request: ChatCompletionRequest,
  options?: CallOptions,
): Promise<ChatCompletionResponse> {
  const target = options?.targetOverride ?? resolveLlmTarget(request.model, options?.apiKeyOverride);
  if (target.authType !== 'none') assertLlmTargetConfigured(target);
  const effectiveRequest = {
    ...request,
    ...(target.model === request.model ? {} : { model: target.model }),
    ...(target.provider === 'openai-compatible' && target.supportsReasoning === false
      ? { reasoning_effort: 'none' as const }
      : {}),
  };
  if (target.runtimeType === 'codex-subscription') {
    return codexRuntimeCompletion(target, effectiveRequest, options);
  }
  if (target.runtimeType === 'claude-code-subscription') {
    return claudeCodeRuntimeCompletion(target, effectiveRequest, options);
  }
  return target.provider === 'anthropic'
    ? anthropicCompletion(target, effectiveRequest, options)
    : openAiCompletion(target, effectiveRequest, options);
}

async function* openAiStream(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): AsyncGenerator<ChatStreamChunk> {
  const response = await checkedFetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(target) },
    body: JSON.stringify(openAiBody(request, true)),
    signal: requestSignal(target, options),
  }, target.provider);

  for await (const event of sseJson(response)) {
    if (Array.isArray(event['choices'])) yield event as unknown as ChatStreamChunk;
  }
}

async function* anthropicStream(
  target: LlmTarget,
  request: ChatCompletionRequest,
  options?: CallOptions,
): AsyncGenerator<ChatStreamChunk> {
  const response = await checkedFetch(`${target.baseUrl}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...authHeaders(target) },
    body: JSON.stringify(anthropicBody(request, true)),
    signal: requestSignal(target, options),
  }, target.provider);

  let id = '';
  let model = request.model;
  let inputTokens = 0;
  let cacheCreationTokens = 0;
  let cacheReadTokens = 0;
  let toolIndex = 0;
  const blockToTool = new Map<number, number>();

  for await (const event of sseJson(response)) {
    const type = String(event['type'] ?? '');
    if (type === 'message_start') {
      const message = (event['message'] as Record<string, unknown>) ?? {};
      const usage = (message['usage'] as Record<string, unknown>) ?? {};
      id = String(message['id'] ?? '');
      model = String(message['model'] ?? request.model);
      inputTokens = Number(usage['input_tokens'] ?? 0);
      cacheCreationTokens = Number(usage['cache_creation_input_tokens'] ?? 0);
      cacheReadTokens = Number(usage['cache_read_input_tokens'] ?? 0);
      yield {
        id, model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      };
      continue;
    }

    if (type === 'content_block_start') {
      const block = (event['content_block'] as Record<string, unknown>) ?? {};
      if (block['type'] !== 'tool_use') continue;
      const blockIndex = Number(event['index'] ?? 0);
      const currentToolIndex = toolIndex++;
      blockToTool.set(blockIndex, currentToolIndex);
      yield {
        id, model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: currentToolIndex,
              id: String(block['id'] ?? `toolu_${blockIndex}`),
              type: 'function',
              function: { name: String(block['name'] ?? ''), arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      };
      continue;
    }

    if (type === 'content_block_delta') {
      const delta = (event['delta'] as Record<string, unknown>) ?? {};
      const blockIndex = Number(event['index'] ?? 0);
      if (delta['type'] === 'text_delta') {
        yield {
          id, model,
          choices: [{ index: 0, delta: { content: String(delta['text'] ?? '') }, finish_reason: null }],
        };
      } else if (delta['type'] === 'input_json_delta') {
        yield {
          id, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: blockToTool.get(blockIndex) ?? 0,
                function: { arguments: String(delta['partial_json'] ?? '') },
              }],
            },
            finish_reason: null,
          }],
        };
      }
      continue;
    }

    if (type === 'message_delta') {
      const delta = (event['delta'] as Record<string, unknown>) ?? {};
      const usage = (event['usage'] as Record<string, unknown>) ?? {};
      const completionTokens = Number(usage['output_tokens'] ?? 0);
      const stop = String(delta['stop_reason'] ?? 'stop');
      yield {
        id, model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: stop === 'tool_use' ? 'tool_calls' : stop === 'end_turn' ? 'stop' : stop,
        }],
        usage: {
          prompt_tokens: inputTokens,
          completion_tokens: completionTokens,
          total_tokens: inputTokens + completionTokens,
          cache_creation_input_tokens: cacheCreationTokens,
          cache_read_input_tokens: cacheReadTokens,
        },
      };
    }
  }
}

export async function* streamChatCompletion(
  request: ChatCompletionRequest,
  options?: CallOptions,
): AsyncGenerator<ChatStreamChunk> {
  const target = options?.targetOverride ?? resolveLlmTarget(request.model, options?.apiKeyOverride);
  if (target.authType !== 'none') assertLlmTargetConfigured(target);
  const effectiveRequest = {
    ...request,
    ...(target.model === request.model ? {} : { model: target.model }),
    ...(target.provider === 'openai-compatible' && target.supportsReasoning === false
      ? { reasoning_effort: 'none' as const }
      : {}),
  };
  if (target.runtimeType === 'codex-subscription') {
    const result = await codexRuntimeCompletion(target, effectiveRequest, options);
    const choice = result.choices[0];
    if (!choice) throw new Error('Codex subscription runtime returned no completion choice');
    if (choice.message.tool_calls?.length) {
      for (let index = 0; index < choice.message.tool_calls.length; index += 1) {
        const call = choice.message.tool_calls[index]!;
        yield {
          id: result.id,
          model: result.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: call.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        };
      }
    } else if (choice.message.content) {
      yield {
        id: result.id,
        model: result.model,
        choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
      };
    }
    yield {
      id: result.id,
      model: result.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
      usage: result.usage,
    };
  } else if (target.runtimeType === 'claude-code-subscription') {
    const result = await claudeCodeRuntimeCompletion(target, effectiveRequest, options);
    const choice = result.choices[0];
    if (!choice) throw new Error('Claude Code subscription runtime returned no completion choice');
    if (choice.message.tool_calls?.length) {
      for (let index = 0; index < choice.message.tool_calls.length; index += 1) {
        const call = choice.message.tool_calls[index]!;
        yield {
          id: result.id,
          model: result.model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index,
                id: call.id,
                type: 'function',
                function: { name: call.function.name, arguments: call.function.arguments },
              }],
            },
            finish_reason: null,
          }],
        };
      }
    } else if (choice.message.content) {
      yield {
        id: result.id,
        model: result.model,
        choices: [{ index: 0, delta: { content: choice.message.content }, finish_reason: null }],
      };
    }
    yield {
      id: result.id,
      model: result.model,
      choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }],
      usage: result.usage,
    };
  } else if (target.provider === 'anthropic') {
    yield* anthropicStream(target, effectiveRequest, options);
  } else {
    yield* openAiStream(target, effectiveRequest, options);
  }
}

export async function createEmbedding(
  model: string,
  input: string | string[],
  options?: CallOptions,
): Promise<EmbeddingResponse> {
  const target = resolveLlmTarget(model, options?.apiKeyOverride);
  if (target.provider === 'anthropic') {
    throw new Error(`Anthropic does not provide embeddings for model "${model}"; configure an OpenAI embedding model`);
  }
  assertLlmTargetConfigured(target);
  const response = await checkedFetch(`${target.baseUrl}/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(target) },
    body: JSON.stringify({ model, input }),
    signal: requestSignal(target, options),
  }, target.provider);
  return await response.json() as EmbeddingResponse;
}

export function firstText(response: ChatCompletionResponse): string {
  return response.choices[0]?.message.content ?? '';
}
