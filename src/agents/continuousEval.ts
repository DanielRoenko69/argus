/**
 * continuousEval.ts — LLM-as-a-Judge scoring for every agent response.
 *
 * Called fire-and-forget from agentRunner.ts after each turn.
 * Routes through the direct provider-neutral LLM client.
 * Pushes scores to Langfuse. Logs a warning when quality drops below threshold.
 *
 * Enable: CONTINUOUS_EVAL_ENABLED=true in .env
 * Threshold: EVAL_QUALITY_THRESHOLD=0.7 (0-1 scale)
 */

import { CONTINUOUS_EVAL_ENABLED, EVAL_QUALITY_THRESHOLD, EVAL_JUDGE_MODEL } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { currentTraceId, withTraceContext } from '../lib/langfuseTracing.js';
import { chatCompletion, firstText } from '../llm/client.js';
import { hasLlmCredentials } from '../llm/targets.js';
import { getSharedPool } from '../lib/sharedPool.js';
import { flushTelemetryWrites } from '../observability/telemetryStore.js';
import { upsertSystemFeedback } from '../observability/feedbackStore.js';

const LANGFUSE_PUB  = process.env['LANGFUSE_PUBLIC_KEY'] ?? '';
const LANGFUSE_SEC  = process.env['LANGFUSE_SECRET_KEY'] ?? '';
const LANGFUSE_HOST = (process.env['LANGFUSE_HOST'] ?? 'http://langfuse:3100').replace(/\/+$/, '');
const langfuseEnabled = !!(LANGFUSE_PUB && LANGFUSE_SEC && !LANGFUSE_PUB.includes('changeme'));

export interface EvalScores {
  helpfulness:   number;  // 0-1
  groundedness:  number;  // 0-1
  overall:       number;  // weighted average
}

const JUDGE_SYSTEM = `You are an AI quality evaluator. Score the assistant response strictly and objectively.
Return ONLY a JSON object with these fields:
- helpfulness (0.0-1.0): Does the response fully answer the user question?
- groundedness (0.0-1.0): Is every claim supported by the provided context? If no context given, set 1.0.
Do not add any text outside the JSON.`;

function buildJudgePrompt(userMessage: string, response: string, ragContext?: string): string {
  return [
    `User question: ${userMessage.slice(0, 500)}`,
    ragContext ? `Retrieved context:\n${ragContext.slice(0, 1000)}` : '',
    `Assistant response:\n${response.slice(0, 1000)}`,
  ].filter(Boolean).join('\n\n');
}

async function judgeViaProvider(userMessage: string, response: string, ragContext?: string): Promise<EvalScores | null> {
  if (!hasLlmCredentials(EVAL_JUDGE_MODEL)) return null;

  try {
    const data = await chatCompletion({
      model: EVAL_JUDGE_MODEL,
      max_tokens: 150,
      messages: [
        { role: 'system', content: JUDGE_SYSTEM },
        { role: 'user', content: buildJudgePrompt(userMessage, response, ragContext) },
      ],
    }, { timeoutMs: 15_000 });
    const text = firstText(data);

    const parsed = JSON.parse(text.trim()) as Record<string, number>;
    const helpfulness  = Math.max(0, Math.min(1, parsed['helpfulness']  ?? 0));
    const groundedness = Math.max(0, Math.min(1, parsed['groundedness'] ?? 1));
    const overall      = Math.round((helpfulness * 0.6 + groundedness * 0.4) * 100) / 100;

    return { helpfulness, groundedness, overall };
  } catch (err) {
    logger.debug({ err }, 'continuousEval: judge parse failed');
    return null;
  }
}

async function pushToLangfuse(
  agentId: number,
  sessionId: string,
  scores: EvalScores,
  userMessage: string,
): Promise<void> {
  if (!langfuseEnabled) return;
  const auth = 'Basic ' + Buffer.from(`${LANGFUSE_PUB}:${LANGFUSE_SEC}`).toString('base64');
  const h = { 'Content-Type': 'application/json', Authorization: auth };

  // Prefer attaching scores to the parent agent.chat / agent.worker trace
  // (so OPs see the quality score directly on the conversation trace).
  // Fall back to a dedicated agent_eval trace when no parent context is
  // available — e.g. when scoreAgentTurn is invoked from a non-traced
  // batch job.
  const parentTraceId = currentTraceId();
  const traceId = parentTraceId ?? `agent-eval-${agentId}-${sessionId}-${Date.now()}`;

  if (!parentTraceId) {
    await fetch(`${LANGFUSE_HOST}/api/public/traces`, {
      method: 'POST', headers: h,
      body: JSON.stringify({
        id: traceId, name: `agent_eval:${agentId}`,
        input:    { question: userMessage.slice(0, 200) },
        output:   { scores },
        metadata: { agentId, sessionId },
        tags:     [`agent-${agentId}`, 'continuous-eval'],
      }),
    }).catch(() => {});
  }

  for (const [name, value] of Object.entries(scores)) {
    await fetch(`${LANGFUSE_HOST}/api/public/scores`, {
      method: 'POST', headers: h,
      body: JSON.stringify({ traceId, name: `eval_${name}`, value, dataType: 'NUMERIC' }),
    }).catch(() => {});
  }
}

/**
 * Score one agent turn. Fire-and-forget — never throws, never blocks the caller.
 */
export function scoreAgentTurn(opts: {
  agentId:     number;
  sessionId:   string;
  userMessage: string;
  response:    string;
  ragContext?:  string;
  nativeTraceId?: string;
}): void {
  if (!CONTINUOUS_EVAL_ENABLED) return;

  // Capture the active trace id BEFORE detaching into fire-and-forget,
  // so the background task can re-enter the parent trace context.
  const parentTraceId = currentTraceId();

  const job = async (): Promise<void> => {
    const scores = await judgeViaProvider(opts.userMessage, opts.response, opts.ragContext);
    if (!scores) return;

    if (scores.overall < EVAL_QUALITY_THRESHOLD) {
      logger.warn({
        agentId:      opts.agentId,
        sessionId:    opts.sessionId,
        overall:      scores.overall,
        threshold:    EVAL_QUALITY_THRESHOLD,
        helpfulness:  scores.helpfulness,
        groundedness: scores.groundedness,
      }, 'continuousEval: quality below threshold');
    } else {
      logger.debug({ agentId: opts.agentId, overall: scores.overall }, 'continuousEval: OK');
    }

    const pool = getSharedPool();
    if (pool && opts.nativeTraceId) {
      try {
        // The trace insert is queued and non-blocking; wait for it before the
        // feedback FK write. Model feedback remains native even without Langfuse.
        await flushTelemetryWrites();
        await Promise.all(Object.entries(scores).map(([label, score]) =>
          upsertSystemFeedback(pool, {
            traceId: opts.nativeTraceId!,
            source: 'model',
            label,
            score,
            sentiment: score >= 0.8 ? 'positive' : score < EVAL_QUALITY_THRESHOLD ? 'negative' : 'neutral',
            tags: ['continuous-eval'],
            metadata: {
              judgeModel: EVAL_JUDGE_MODEL,
              sessionId: opts.sessionId,
              threshold: EVAL_QUALITY_THRESHOLD,
            },
            externalId: `continuous-eval:${opts.nativeTraceId}:${label}`,
          }),
        ));
      } catch (err) {
        // Native persistence and optional Langfuse export are independent
        // sinks. A temporary DB problem must not suppress the external score.
        logger.debug({ err }, 'continuousEval: native feedback persistence failed');
      }
    }

    await pushToLangfuse(opts.agentId, opts.sessionId, scores, opts.userMessage);
  };

  const run = parentTraceId
    ? () => withTraceContext({ traceId: parentTraceId }, job)
    : job;

  Promise.resolve().then(run).catch((err) =>
    logger.debug({ err }, 'continuousEval: background error (non-fatal)'));
}
