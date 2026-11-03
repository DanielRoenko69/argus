/**
 * sdkRunner.ts — Compacting wrapper around runClaudeWorkerAgent.
 *
 * When USE_SDK_RUNNER=true in env, agentRunner routes worker agents
 * through this module instead of calling claudeRunner directly.
 *
 * Compaction: if accumulated history exceeds SDK_COMPACT_THRESHOLD_TOKENS
 * estimated tokens, older turns are summarized through the direct LLM client and
 * replaced with a single summary message. The most recent 4 messages are
 * always kept verbatim to preserve immediate context.
 *
 * All Argus governance (RBAC, memory, Langfuse, session persistence) is
 * handled by agentRunner.ts — this module only manages the LLM loop.
 */

import { SDK_COMPACT_THRESHOLD_TOKENS } from '../config/env.js';
import {
  runClaudeWorkerAgent,
  type ClaudeAgentChunk,
  type WorkerToolExecutor,
} from './claudeRunner.js';
import { chatCompletion, firstText } from '../llm/client.js';
import type { ChatMessage } from './types.js';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type { LlmTarget } from '../llm/types.js';
import { resolveRegisteredLlmTarget } from '../llm/modelRegistry.js';

// ── Token estimation ──────────────────────────────────────────────

/**
 * Rough token count for a list of messages.
 * Uses chars/4 heuristic — accurate to within ±20% for English/code.
 */
function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? '').length;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

// ── History Compaction ────────────────────────────────────────────

const RECENT_MESSAGES_TO_KEEP = 4;

/**
 * Summarize a slice of chat history through the direct provider client
 * (claude-haiku-4-5 by default, cheap + fast).
 * Returns a synthetic "assistant" summary message.
 */
async function compactHistory(
  messages: ChatMessage[],
  systemPrompt: string,
  llmUrl: string,
  llmKey: string,
  pool: pg.Pool,
  llmTargetOverride?: LlmTarget,
): Promise<ChatMessage> {
  const compactionModel = process.env['HISTORY_COMPACTION_MODEL'] ?? 'claude-haiku-4-5';
  const compactionTarget = llmTargetOverride
    ? { ...llmTargetOverride, model: llmTargetOverride.model || compactionModel }
    : await resolveRegisteredLlmTarget(pool, compactionModel, llmKey || undefined);
  const transcript = messages
    .map(m => {
      if (m.role === 'tool') {
        return `[tool_result for ${m.name ?? 'unknown'}]: ${(m.content ?? '').slice(0, 500)}`;
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        const calls = m.tool_calls.map(tc => `${tc.function.name}(${tc.function.arguments.slice(0, 200)})`).join(', ');
        return `assistant (called tools): ${calls}`;
      }
      return `${m.role}: ${(m.content ?? '').slice(0, 800)}`;
    })
    .join('\n\n');

  const data = await chatCompletion({
    model: compactionTarget.model,
    max_tokens: 1024,
    messages: [
      {
        role: 'system',
        content:
          'You are a conversation summarizer. Produce a concise but complete summary of the conversation excerpt below. ' +
          'Preserve: what task was being worked on, which files were modified, what commands were run, what the outcomes were, and any open questions. ' +
          'Format as a dense paragraph. Do not add commentary. Do not omit file paths or command outputs.',
      },
      {
        role: 'user',
        content: `Task context (system prompt excerpt):\n${systemPrompt.slice(0, 500)}\n\n---\nConversation to summarize:\n${transcript}`,
      },
    ],
  }, {
    apiKeyOverride: llmKey || undefined,
    timeoutMs: 30_000,
    targetOverride: compactionTarget,
  });
  const summaryText = firstText(data);

  return {
    role: 'assistant',
    content: `[Compacted history summary]\n${summaryText}`,
  };
}

async function maybeCompact(
  historyMessages: ChatMessage[],
  systemPrompt: string,
  llmUrl: string,
  llmKey: string,
  pool: pg.Pool,
  llmTargetOverride?: LlmTarget,
): Promise<ChatMessage[]> {
  const estimated = estimateTokens(historyMessages);
  if (estimated <= SDK_COMPACT_THRESHOLD_TOKENS) {
    return historyMessages;
  }

  logger.info(
    { estimatedTokens: estimated, threshold: SDK_COMPACT_THRESHOLD_TOKENS, messageCount: historyMessages.length },
    'sdkRunner: compacting history',
  );

  const keepCount = Math.min(RECENT_MESSAGES_TO_KEEP, historyMessages.length);
  const toCompact = historyMessages.slice(0, historyMessages.length - keepCount);
  const toKeep    = historyMessages.slice(historyMessages.length - keepCount);

  if (toCompact.length === 0) return historyMessages;

  try {
    const summary = await compactHistory(toCompact, systemPrompt, llmUrl, llmKey, pool, llmTargetOverride);
    return [summary, ...toKeep];
  } catch (err) {
    logger.warn({ err }, 'sdkRunner: compaction failed, using full history');
    return historyMessages;
  }
}

// ── Main entry point ──────────────────────────────────────────────

/**
 * Drop-in replacement for runClaudeWorkerAgent with automatic history compaction.
 * Signature is identical to runClaudeWorkerAgent.
 */
export async function* runCompactingWorkerAgent(
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
  llmUrl: string,
  llmKey: string,
  modelName?: string,
  thinkingBudget?: number,
  untrustedToolEnforcement?: boolean,
  callingUser?: { id: number; entra_groups: string[] },
  llmTargetOverride?: LlmTarget,
  requiredToolSequence: readonly string[] = [],
  requiredWorkspaceWritePaths: readonly string[] = [],
  automaticMemoryEnabled = false,
): AsyncGenerator<ClaudeAgentChunk> {
  const compactedHistory = await maybeCompact(
    historyMessages,
    systemPrompt,
    llmUrl,
    llmKey,
    pool,
    llmTargetOverride,
  );

  yield* runClaudeWorkerAgent(
    agentId,
    sessionId,
    systemPrompt,
    compactedHistory,
    userMessage,
    oaiTools,
    executeTool,
    maxIterations,
    maxTokens,
    pool,
    llmUrl,
    llmKey,
    modelName,
    thinkingBudget,
    untrustedToolEnforcement,
    callingUser,
    llmTargetOverride,
    requiredToolSequence,
    requiredWorkspaceWritePaths,
    automaticMemoryEnabled,
  );
}
