import type { ChatCompletionRequest, LlmMessage, LlmTool } from './types.js';

const DEFAULT_TARGET_CHARS = 145_000;
const HARD_LIMIT_CHARS = 155_000;
const MIN_TARGET_CHARS = 32_000;
const MAX_TARGET_CHARS = 150_000;

type ToolCatalogMode = 'full' | 'compact' | 'minimal';
type MessageBudgetMode = 'full' | 'compact' | 'strict';

export interface CodexContextBudgetReport {
  compacted: boolean;
  originalChars: number;
  finalChars: number;
  targetChars: number;
  estimatedOriginalTokens: number;
  estimatedFinalTokens: number;
  toolCount: number;
  originalToolChars: number;
  finalToolChars: number;
  originalMessageChars: number;
  finalMessageChars: number;
  truncatedMessages: number;
  omittedMessages: number;
  strategies: string[];
}

export interface CodexContextBudgetResult {
  prompt: string;
  report: CodexContextBudgetReport;
}

function boundedConfiguredTarget(): number {
  const configured = Number(process.env['CODEX_CONTEXT_TARGET_CHARS']);
  if (!Number.isFinite(configured)) return DEFAULT_TARGET_CHARS;
  return Math.min(MAX_TARGET_CHARS, Math.max(MIN_TARGET_CHARS, Math.round(configured)));
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '[unserializable content]';
  }
}

function boundedText(value: string, maximum: number, label: string): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  const marker = `\n...[${label} compacted; ${value.length - maximum} characters omitted]...\n`;
  const available = Math.max(0, maximum - marker.length);
  const head = Math.ceil(available * 0.7);
  const tail = Math.max(0, available - head);
  return {
    text: `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ''}`,
    truncated: true,
  };
}

function compactSchema(value: unknown, mode: Exclude<ToolCatalogMode, 'full'>, depth = 0): unknown {
  if (depth > 10) return {};
  if (Array.isArray(value)) {
    const maximum = mode === 'minimal' ? 20 : 50;
    return value.slice(0, maximum).map(item => compactSchema(item, mode, depth + 1));
  }
  if (!value || typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  const structuralKeys = new Set([
    '$ref', '$defs', 'definitions', 'type', 'properties', 'patternProperties',
    'required', 'items', 'additionalProperties', 'oneOf', 'anyOf', 'allOf',
    'enum', 'const', 'format', 'pattern', 'minimum', 'maximum',
    'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength',
    'minItems', 'maxItems', 'uniqueItems',
  ]);

  for (const [key, child] of Object.entries(input)) {
    if (key === 'description') {
      if (mode === 'compact' && typeof child === 'string') {
        output[key] = boundedText(child, 160, 'schema description').text;
      }
      continue;
    }
    if (!structuralKeys.has(key)) continue;
    if (key === 'properties' || key === 'patternProperties' || key === '$defs' || key === 'definitions') {
      if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
      output[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>)
          .map(([name, schema]) => [name, compactSchema(schema, mode, depth + 1)]),
      );
      continue;
    }
    output[key] = compactSchema(child, mode, depth + 1);
  }
  return output;
}

function toolCatalog(tools: LlmTool[], mode: ToolCatalogMode): string {
  if (tools.length === 0) return '(no tools authorized)';
  return tools.map(tool => {
    if (mode === 'full') {
      return JSON.stringify({
        name: tool.function.name,
        description: tool.function.description ?? '',
        parameters: tool.function.parameters ?? { type: 'object', properties: {} },
      });
    }
    return JSON.stringify({
      name: tool.function.name,
      ...(mode === 'compact' && tool.function.description
        ? { description: boundedText(tool.function.description, 240, 'tool description').text }
        : {}),
      parameters: compactSchema(
        tool.function.parameters ?? { type: 'object', properties: {} },
        mode,
      ),
    });
  }).join('\n');
}

function rawMessageText(message: LlmMessage): string {
  const content = safeString(message.content);
  const calls = message.tool_calls?.map(call =>
    `\nTOOL_CALL ${call.function.name} ${call.function.arguments}`,
  ).join('') ?? '';
  return `[${message.role.toUpperCase()}${message.name ? `:${message.name}` : ''}]\n${content}${calls}`;
}

function compactMessageText(
  message: LlmMessage,
  mode: Exclude<MessageBudgetMode, 'full'>,
  protectedUser: boolean,
): { text: string; truncated: boolean } {
  const rawContent = safeString(message.content);
  const contentLimit = protectedUser
    ? Number.POSITIVE_INFINITY
    : message.role === 'system'
      ? mode === 'compact' ? 40_000 : 22_000
      : message.role === 'user'
        ? mode === 'compact' ? 8_000 : 3_000
        : message.role === 'tool'
          ? mode === 'compact' ? 8_000 : 3_000
          : mode === 'compact' ? 6_000 : 3_000;
  const boundedContent = Number.isFinite(contentLimit)
    ? boundedText(rawContent, contentLimit, `${message.role} content`)
    : { text: rawContent, truncated: false };

  let calls = '';
  let callsTruncated = false;
  for (const call of message.tool_calls ?? []) {
    const boundedArguments = boundedText(
      call.function.arguments,
      mode === 'compact' ? 3_000 : 1_500,
      'tool arguments',
    );
    calls += `\nTOOL_CALL ${call.function.name} ${boundedArguments.text}`;
    callsTruncated ||= boundedArguments.truncated;
  }
  return {
    text: `[${message.role.toUpperCase()}${message.name ? `:${message.name}` : ''}]\n${boundedContent.text}${calls}`,
    truncated: boundedContent.truncated || callsTruncated,
  };
}

function instructions(tools: LlmTool[], toolChoice: ChatCompletionRequest['tool_choice']): string[] {
  const toolInstruction = tools.length > 0
    ? [
        'When an authorized tool is needed, return only one JSON object and no Markdown:',
        '{"name":"EXACT_TOOL_NAME","arguments":{"parameter":"value"}}',
        'The JSON is a request to Argus Core. Never claim the tool ran until its TOOL result appears in the conversation.',
      ].join('\n')
    : 'No tools are authorized. Answer from the supplied conversation only.';
  const required = toolChoice === 'required'
    ? 'A tool call is required for this turn; do not return a final answer yet.'
    : '';
  return [
    'ARGUS CORE CONTROLLED AGENT TURN',
    'Act only as the reasoning engine. Do not use built-in shell, filesystem, web search, or network tools. External actions are executed by Argus Core after policy checks.',
    toolInstruction,
    required,
  ].filter(Boolean);
}

function composePrompt(
  request: ChatCompletionRequest,
  catalog: string,
  messageTexts: Array<string | null>,
  omittedMessages: number,
): string {
  const conversation = messageTexts.filter((value): value is string => value !== null);
  if (omittedMessages > 0) {
    conversation.unshift(`[CONTEXT COMPACTION]\n${omittedMessages} older assistant/tool messages were omitted after their durable results were retained by Argus.`);
  }
  return [
    ...instructions(request.tools ?? [], request.tool_choice),
    'AUTHORIZED ARGUS TOOLS',
    catalog,
    'CONVERSATION',
    conversation.join('\n\n'),
  ].join('\n\n');
}

/**
 * Build the text-only prompt consumed by the protected Codex SDK bridge.
 *
 * The latest human instruction is never truncated. When a large MCP catalog,
 * accumulated tool output or old assistant history would exceed the bridge's
 * hard boundary, verbose schema metadata is removed first, followed by
 * bounded old machine-generated messages. Only then are old human turns or
 * the system prompt compacted, and both retain their beginning and tail.
 */
export function buildCodexRuntimePrompt(request: ChatCompletionRequest): CodexContextBudgetResult {
  const tools = request.tools ?? [];
  const targetChars = boundedConfiguredTarget();
  const fullCatalog = toolCatalog(tools, 'full');
  const rawMessages = request.messages.map(rawMessageText);
  const originalPrompt = composePrompt(request, fullCatalog, rawMessages, 0);
  const originalMessageChars = rawMessages.reduce((sum, value) => sum + value.length, 0);

  if (originalPrompt.length <= targetChars) {
    return {
      prompt: originalPrompt,
      report: {
        compacted: false,
        originalChars: originalPrompt.length,
        finalChars: originalPrompt.length,
        targetChars,
        estimatedOriginalTokens: Math.ceil(originalPrompt.length / 4),
        estimatedFinalTokens: Math.ceil(originalPrompt.length / 4),
        toolCount: tools.length,
        originalToolChars: fullCatalog.length,
        finalToolChars: fullCatalog.length,
        originalMessageChars,
        finalMessageChars: originalMessageChars,
        truncatedMessages: 0,
        omittedMessages: 0,
        strategies: [],
      },
    };
  }

  const strategies: string[] = ['compact_tool_schemas', 'bound_machine_messages'];
  const userIndexes = request.messages
    .map((message, index) => message.role === 'user' ? index : -1)
    .filter(index => index >= 0);
  const protectedUserIndex = userIndexes.at(-1) ?? -1;
  let catalogMode: ToolCatalogMode = 'compact';
  let catalog = toolCatalog(tools, catalogMode);
  let messageMode: Exclude<MessageBudgetMode, 'full'> = 'compact';
  let formatted = request.messages.map((message, index) =>
    compactMessageText(message, messageMode, index === protectedUserIndex),
  );
  let omittedMessages = 0;
  const omittedIndexes = new Set<number>();
  let prompt = composePrompt(request, catalog, formatted.map(item => item.text), omittedMessages);

  if (prompt.length > targetChars) {
    catalogMode = 'minimal';
    catalog = toolCatalog(tools, catalogMode);
    strategies.push('minimal_tool_schemas');
    prompt = composePrompt(request, catalog, formatted.map(item => item.text), omittedMessages);
  }

  if (prompt.length > targetChars) {
    const protectedTailStart = Math.max(0, request.messages.length - 4);
    const machineCandidates = request.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) =>
        index < protectedTailStart && (message.role === 'assistant' || message.role === 'tool'),
      );
    for (const { index } of machineCandidates) {
      omittedIndexes.add(index);
      omittedMessages += 1;
      const texts = formatted.map((item, itemIndex) => omittedIndexes.has(itemIndex) ? null : item.text);
      prompt = composePrompt(request, catalog, texts, omittedMessages);
      if (prompt.length <= targetChars) break;
    }
    if (omittedMessages > 0) strategies.push('omit_old_machine_messages');
  }

  if (prompt.length > targetChars) {
    messageMode = 'strict';
    formatted = request.messages.map((message, index) =>
      compactMessageText(message, messageMode, index === protectedUserIndex),
    );
    strategies.push('strict_message_bounds');
    prompt = composePrompt(
      request,
      catalog,
      formatted.map((item, index) => omittedIndexes.has(index) ? null : item.text),
      omittedMessages,
    );
  }

  if (prompt.length > targetChars) {
    const remainingMachineCandidates = request.messages
      .map((message, index) => ({ message, index }))
      .filter(({ message, index }) =>
        !omittedIndexes.has(index)
        && index !== protectedUserIndex
        && (message.role === 'assistant' || message.role === 'tool'),
      );
    for (const { index } of remainingMachineCandidates) {
      omittedIndexes.add(index);
      omittedMessages += 1;
      const texts = formatted.map((item, itemIndex) => omittedIndexes.has(itemIndex) ? null : item.text);
      prompt = composePrompt(request, catalog, texts, omittedMessages);
      if (prompt.length <= targetChars) break;
    }
    if (remainingMachineCandidates.length > 0 && !strategies.includes('omit_old_machine_messages')) {
      strategies.push('omit_old_machine_messages');
    }
  }

  if (prompt.length > HARD_LIMIT_CHARS) {
    throw new Error(
      `Codex context cannot be compacted safely (${prompt.length} characters; hard limit ${HARD_LIMIT_CHARS}). `
      + 'Narrow the MCP bundle or shorten the current human instruction.',
    );
  }

  const finalTexts = formatted.map((item, index) => omittedIndexes.has(index) ? null : item.text);
  const finalMessageChars = finalTexts.reduce((sum, value) => sum + (value?.length ?? 0), 0);
  return {
    prompt,
    report: {
      compacted: true,
      originalChars: originalPrompt.length,
      finalChars: prompt.length,
      targetChars,
      estimatedOriginalTokens: Math.ceil(originalPrompt.length / 4),
      estimatedFinalTokens: Math.ceil(prompt.length / 4),
      toolCount: tools.length,
      originalToolChars: fullCatalog.length,
      finalToolChars: catalog.length,
      originalMessageChars,
      finalMessageChars,
      truncatedMessages: formatted.filter(item => item.truncated).length,
      omittedMessages,
      strategies,
    },
  };
}
