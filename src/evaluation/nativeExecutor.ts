import { performance } from 'node:perf_hooks';
import { chatCompletion } from '../llm/client.js';
import type { ChatCompletionRequest, ChatCompletionResponse, LlmTarget } from '../llm/types.js';
import { EvaluationError, stableJson } from './contracts.js';
import { measureEvaluationResponse } from './measurements.js';
import { scoreEvaluationOutput } from './scoring.js';
import { boundedEvaluationJson, NATIVE_EVALUATION_EXECUTOR } from './snapshots.js';
import type { EvaluationCase } from './store.js';

export function buildEvaluationRequest(snapshot: Record<string, unknown>, c: EvaluationCase, target: LlmTarget): ChatCompletionRequest {
  const execution = snapshot['execution'] as Record<string, unknown>;
  if (snapshot['context_mode'] !== 'isolated_reference' || execution?.['type'] !== 'argus'
      || execution['executor_version'] !== NATIVE_EVALUATION_EXECUTOR || execution['isolation_verified'] !== true || target.runtimeType) {
    throw new EvaluationError('EVALUATION_ISOLATION_UNSUPPORTED', 'This snapshot has no certified native isolation boundary', 409);
  }
  const agent = snapshot['agent'] as Record<string, unknown>;
  const skills = snapshot['skills'] as Array<{ content: string }>;
  const temperature = Number(agent['temperature']);
  const maxTokens = Number(agent['max_tokens']);
  const thinking = Number(agent['thinking_budget']);
  if (!Number.isFinite(temperature) || !Number.isSafeInteger(maxTokens) || maxTokens < 1) {
    throw new EvaluationError('EVALUATION_CONFIGURATION_INVALID', 'Snapshot generation parameters are invalid', 409);
  }
  return { model:target.model,
    messages:[
      { role:'system',content:[String(agent['system_prompt'] ?? ''),...skills.map(s => s.content)].filter(Boolean).join('\n\n') },
      // Context remains user-level data. No histories, retrieval, hooks or live skill reload.
      { role:'user',content:stableJson({ input:c.input_redacted,reference_context:c.context_redacted }) },
    ],
    max_tokens:maxTokens, // Existing frozen Agent setting, not a new evaluation token cap.
    ...(target.supportsReasoning ? {} : { temperature }),
    ...(target.supportsReasoning && ['none','minimal','low','medium','high'].includes(String(execution['reasoning_effort']))
      ? { reasoning_effort:execution['reasoning_effort'] as ChatCompletionRequest['reasoning_effort'] } : {}),
    ...(target.provider === 'anthropic' && thinking > 0 ? { thinking:{ type:'enabled' as const,budget_tokens:thinking } } : {}),
    tools:[],tool_choice:'none',
  };
}

/** One request per case. No sessions, tools, retrieval, embeddings, LLM judge or retries. */
export async function executeNativeEvaluationCase(snapshot: Record<string, unknown>, c: EvaluationCase, target: LlmTarget, signal?: AbortSignal) {
  const request = buildEvaluationRequest(snapshot, c, target);
  const start = performance.now();
  let response: ChatCompletionResponse | undefined;
  const pricing = ((snapshot['execution'] as Record<string, unknown>)['model_catalog'] ?? {}) as Record<string, unknown>;
  const requestController=new AbortController();
  const abort=() => requestController.abort();
  const timer=setTimeout(abort,target.timeoutMs);
  timer.unref();
  signal?.addEventListener('abort',abort,{ once:true });
  if (signal?.aborted) abort();
  try {
    // Cancellation must not replace the provider's existing request deadline.
    const requestSignal=requestController.signal;
    requestSignal.throwIfAborted();
    response = await chatCompletion(request, { targetOverride:target, signal:requestSignal, maxRetries:0, safeErrors:true });
    requestSignal.throwIfAborted();
    const choice = response.choices?.[0];
    if (response.choices?.length !== 1 || !choice || choice.message?.tool_calls?.length
        || !['stop','end_turn'].includes(choice.finish_reason ?? '')) throw new Error('incomplete_response');
    const output = choice.message?.content ?? '';
    if (typeof output !== 'string' || Buffer.byteLength(output,'utf8') > 262144) throw new Error('invalid_output');
    // Score the bounded original answer, then redact for persistence; no raw answer in audit.
    const judgement = scoreEvaluationOutput(output, c.rules);
    return { status:judgement.status, output_redacted:boundedEvaluationJson(output,1048576,'output'),
      scores:judgement.scores, error_message:null,
      evidence:{ executor_version:NATIVE_EVALUATION_EXECUTOR,judgement,
        measurements:measureEvaluationResponse(response,performance.now()-start,pricing) } };
  } catch {
    return { status:'error' as const,output_redacted:null,scores:{ overall:0 },
      error_message:signal?.aborted ? 'Evaluation request cancelled; provider usage may be incomplete.'
        : 'Provider request failed or returned incomplete/unsupported output; no automatic retry.',
      evidence:{ executor_version:NATIVE_EVALUATION_EXECUTOR,judgement:null,
        measurements:measureEvaluationResponse(response,performance.now()-start,pricing) } };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
