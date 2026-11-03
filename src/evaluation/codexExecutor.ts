import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { AgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import type { LlmTarget } from '../llm/types.js';
import { evaluationDigest, EvaluationError, stableJson } from './contracts.js';
import { boundedEvaluationJson } from './snapshots.js';
import { measureEvaluationResponse } from './measurements.js';
import { scoreEvaluationOutput } from './scoring.js';
import type { EvaluationCase } from './store.js';

export const CODEX_EVALUATION_EXECUTOR='argus.codex-reference.v1';
export function codexProfileSupported(runtime:AgentRuntimeAssignment|null) {
  return runtime?.profile_enabled===true && runtime.runtime_type==='codex' && runtime.model==='gpt-5.6-terra'
    && runtime.auth_mode==='chatgpt' && (runtime.auth_ref==null || runtime.auth_ref==='codex-auth')
    && ['minimal','low','medium','high','xhigh'].includes(runtime.reasoning_effort ?? '');
}
export function codexRuntimeDigest(runtime:AgentRuntimeAssignment) {
  return evaluationDigest({ profile_id:runtime.profile_id,type:runtime.runtime_type,model:runtime.model,
    reasoning:runtime.reasoning_effort,auth_mode:runtime.auth_mode,auth_ref:runtime.auth_ref });
}
export function codexEvaluationTarget(model:string):LlmTarget {
  return { provider:'openai',model,baseUrl:(process.env['AGENT_WORKSPACE_URL'] || 'http://agent-workspace:3001').replace(/\/+$/,''),
    apiKey:'',authType:'none',runtimeType:'codex-subscription',timeoutMs:180000,supportsReasoning:true };
}
function bridgeHeaders() { return { 'content-type':'application/json','x-workspace-secret':process.env['WORKSPACE_SECRET'] || '' }; }
export async function codexEvaluationAvailable():Promise<boolean> {
  if (!process.env['WORKSPACE_SECRET']) return false;
  try {
    const response=await fetch(codexEvaluationTarget('').baseUrl+'/codex-evaluation/status',
      { headers:bridgeHeaders(),signal:AbortSignal.timeout(22000),redirect:'error' });
    if (!response.ok) return false;
    const b=await response.json() as Record<string,unknown>;
    return b['ready']===true && b['executor_version']===CODEX_EVALUATION_EXECUTOR
      && b['cli_version']==='codex-cli 0.146.0' && Array.isArray(b['models']) && b['models'].includes('gpt-5.6-terra');
  } catch { return false; }
}
export function buildCodexEvaluationRequest(snapshot:Record<string,unknown>,c:EvaluationCase) {
  const execution=snapshot['execution'] as Record<string,unknown>,agent=snapshot['agent'] as Record<string,unknown>;
  if (snapshot['context_mode']!=='isolated_reference' || execution?.['type']!=='codex'
    || execution['executor_version']!==CODEX_EVALUATION_EXECUTOR || execution['isolation_verified']!==true
    || execution['effective_model']!=='gpt-5.6-terra'
    || !['minimal','low','medium','high','xhigh'].includes(String(execution['reasoning_effort']))) {
    throw new EvaluationError('EVALUATION_ISOLATION_UNSUPPORTED','This snapshot has no verified Codex evaluation boundary',409);
  }
  const request={ model:String(execution['effective_model']),reasoningEffort:String(execution['reasoning_effort']),
    instructions:[String(agent['system_prompt'] ?? ''),...(snapshot['skills'] as Array<{content:string}>).map(s=>s.content)].filter(Boolean).join('\n\n'),
    input:stableJson({ input:c.input_redacted,reference_context:c.context_redacted }) };
  if (Buffer.byteLength(JSON.stringify(request))>200000) throw new EvaluationError('EVALUATION_TOO_LARGE','Frozen Codex input exceeds the transport bound; no clipping is performed');
  return request;
}
export async function executeCodexEvaluationCase(snapshot:Record<string,unknown>,c:EvaluationCase,target:LlmTarget,signal?:AbortSignal,attemptId=randomUUID()) {
  const request=buildCodexEvaluationRequest(snapshot,c),start=performance.now();
  let response:Parameters<typeof measureEvaluationResponse>[0];
  const controller=new AbortController(),abort=()=>controller.abort();
  const timer=setTimeout(abort,target.timeoutMs);timer.unref();signal?.addEventListener('abort',abort,{ once:true });
  if (signal?.aborted) abort();
  try {
    controller.signal.throwIfAborted();
    const result=await fetch(target.baseUrl+'/codex-evaluation/run',{ method:'POST',headers:{ ...bridgeHeaders(),'x-evaluation-attempt-id':attemptId },
      body:JSON.stringify(request),signal:controller.signal,redirect:'error' });
    if (!result.ok) throw new Error('bridge_failed');
    // Bound response before parsing or persisting it. No raw bridge errors escape.
    const chunks:Buffer[]=[];let bytes=0;
    if (!result.body) throw new Error('no_body');
    for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) {
      bytes+=chunk.length;if (bytes>1048576) throw new Error('response_too_large');chunks.push(Buffer.from(chunk));
    }
    const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    controller.signal.throwIfAborted();
    if (b.executor_version!==CODEX_EVALUATION_EXECUTOR || b.requests!==1 || typeof b.output!=='string'
      || Buffer.byteLength(b.output)>262144 || b.model!==null && b.model!==request.model) throw new Error('invalid_evidence');
    // The configured model is already pinned in the snapshot. Do not present it
    // as an observed provider model when the provider omitted that measurement.
    response={ model:b.model,usage_observed:{ prompt_tokens:b.input_tokens,completion_tokens:b.output_tokens } };
    const judgement=scoreEvaluationOutput(b.output,c.rules);
    return { status:judgement.status,output_redacted:boundedEvaluationJson(b.output,1048576,'output'),scores:judgement.scores,error_message:null,
      evidence:{ executor_version:CODEX_EVALUATION_EXECUTOR,judgement,
        measurements:measureEvaluationResponse(response,performance.now()-start,{}) } };
  } catch {
    return { status:'error' as const,output_redacted:null,scores:{ overall:0 },
      error_message:signal?.aborted ? 'Codex evaluation cancelled; subscription usage may be incomplete.'
        : 'Isolated Codex evaluation stopped; no API fallback or automatic retry. Subscription usage may be unknown.',
      evidence:{ executor_version:CODEX_EVALUATION_EXECUTOR,judgement:null,measurements:measureEvaluationResponse(response,performance.now()-start,{}) } };
  } finally { clearTimeout(timer);signal?.removeEventListener('abort',abort); }
}
