// Explicit operator action only. One or two short subscription calls, no retry.
// Run in the configured workspace sidecar; auth is read only by the official CLI.
import { codexEvaluationPrerequisites,runCodexEvaluation } from '../dist/routes/codexEvaluation.js';
const one=process.argv.includes('--one');
if (process.argv.slice(2).some(a=>a!=='--one')) throw new Error('Unknown live smoke option; zero model calls');
if (process.env.ARGUS_CODEX_EVALUATION_LIVE_CONFIRM!==(one ? 'one-subscription-request' : 'two-subscription-requests')) throw new Error('Explicit matching request-count acknowledgement required');
if (!(await codexEvaluationPrerequisites())) throw new Error('Pinned CLI / ChatGPT authentication unavailable; zero model calls');
for (const variant of (one ? ['single'] : ['A','B'])) {
  const started=Date.now();
  try {
    const r=await runCodexEvaluation({ model:'gpt-5.6-terra',reasoningEffort:'xhigh',
      instructions:'You are a deterministic evaluation fixture. Follow the supplied format exactly.',input:'Return exactly the single word OK, with no additional text.' },AbortSignal.timeout(180000));
    console.log(JSON.stringify({ variant,passed:r.output.trim()==='OK',model:r.model,requests:r.requests,
      input_tokens:r.input_tokens,output_tokens:r.output_tokens,elapsed_ms:Date.now()-started,cost_usd:null,kind:'live_subscription_adapter_smoke' }));
    if (r.output.trim()!=='OK') { process.exitCode=1;break; }
  } catch(error) {
    // Only our fixed codes; never arbitrary CLI/provider error text or auth.
    const code=/^evaluation_[a-z0-9_]+$/.test(error.message) ? error.message : 'evaluation_stopped';
    console.log(JSON.stringify({ variant,passed:false,code,elapsed_ms:Date.now()-started,kind:'live_subscription_adapter_smoke' }));
    process.exitCode=1;break;
  }
}
