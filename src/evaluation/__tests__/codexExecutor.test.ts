import { buildCodexEvaluationRequest,executeCodexEvaluationCase,codexEvaluationTarget,codexRuntimeDigest,codexProfileSupported,codexEvaluationAvailable } from '../codexExecutor.js';
import { evaluationReadiness } from '../contracts.js';
import type { EvaluationCase } from '../store.js';
const snapshot={ context_mode:'isolated_reference',agent:{ system_prompt:'Frozen system',max_tokens:500,temperature:0.4 },skills:[{ content:'Frozen skill' }],
  execution:{ type:'codex',effective_model:'gpt-5.6-terra',reasoning_effort:'xhigh',isolation_verified:true,executor_version:'argus.codex-reference.v1' } };
const c={ input_redacted:'Return OK',context_redacted:'Reference',expected_output_redacted:'PRIVATE EXPECTATION',rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] } } as unknown as EvaluationCase;
const original=global.fetch;
beforeEach(()=>{ global.fetch=jest.fn() as typeof fetch; });
afterEach(()=>{ global.fetch=original;jest.restoreAllMocks(); });
it('builds only frozen prompt, skills, input and context; no expectations, tools or API output parameters',()=>{
  const req=buildCodexEvaluationRequest(snapshot,c);
  expect(req).toEqual({ model:'gpt-5.6-terra',reasoningEffort:'xhigh',instructions:'Frozen system\n\nFrozen skill',input:'{"input":"Return OK","reference_context":"Reference"}' });
  expect(()=>buildCodexEvaluationRequest({ ...snapshot,execution:{ ...snapshot.execution,isolation_verified:false } },c)).toThrow();
  expect(()=>buildCodexEvaluationRequest({ ...snapshot,execution:{ ...snapshot.execution,effective_model:'unknown' } },c)).toThrow();
  expect(()=>buildCodexEvaluationRequest({ ...snapshot,agent:{ system_prompt:'x'.repeat(200001) } },c)).toThrow(/bound/);
});
it('returns judged results, actual usage and UNKNOWN subscription price; dispatch once',async()=>{
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ executor_version:'argus.codex-reference.v1',output:'OK',model:'gpt-5.6-terra',requests:1,input_tokens:12,output_tokens:2 })));
  const result=await executeCodexEvaluationCase(snapshot,c,codexEvaluationTarget('gpt-5.6-terra'));
  expect(result.status).toBe('passed');expect(result.evidence.measurements).toMatchObject({ input_tokens:12,output_tokens:2,cost_usd:null,cost_source:'unknown',usage_source:'provider' });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(jest.mocked(fetch).mock.calls[0]![0]).toContain('/codex-evaluation/run');
});
it('keeps provider model and usage unknown when not reported',async()=>{
  jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ executor_version:'argus.codex-reference.v1',output:'OK',model:null,requests:1,input_tokens:null,output_tokens:null })));
  const result=await executeCodexEvaluationCase(snapshot,c,codexEvaluationTarget('gpt-5.6-terra'));
  expect(result.status).toBe('passed');
  expect(result.evidence.measurements).toMatchObject({ provider_model:null,input_tokens:null,output_tokens:null,cost_usd:null });
});
it.each(['http','invalid','tools','model','network'])('fails safely for %s without fallback or retry',async kind=>{
  const body={ executor_version:'argus.codex-reference.v1',output:'OK',model:'gpt-5.6-terra',requests:1 };
  if (kind==='network') jest.mocked(fetch).mockRejectedValue(new Error('SECRET'));
  else jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ...body,...(kind==='invalid' ? { requests:2 } : kind==='tools' ? { output:{ tool:'x' } } : kind==='model' ? { model:'other' } : {}) }),{ status:kind==='http' ? 503 : 200 }));
  const r=await executeCodexEvaluationCase(snapshot,c,codexEvaluationTarget('gpt-5.6-terra'));
  expect(r.status).toBe('error');expect(JSON.stringify(r)).not.toContain('SECRET');expect(r.evidence.measurements.cost_usd).toBeNull();expect(fetch).toHaveBeenCalledTimes(1);
});
it('does not dispatch when cancelled before start',async()=>{
  const controller=new AbortController();controller.abort();
  expect((await executeCodexEvaluationCase(snapshot,c,codexEvaluationTarget('gpt-5.6-terra'),controller.signal)).status).toBe('error');expect(fetch).not.toHaveBeenCalled();
});
it('only new verified Codex snapshots become ready; old/external snapshots stay blocked',()=>{
  expect(evaluationReadiness('frozen_v1',snapshot).startable).toBe(true);
  expect(evaluationReadiness('frozen_v1',{ ...snapshot,execution:{ ...snapshot.execution,executor_version:null } }).startable).toBe(false);
  expect(evaluationReadiness('legacy_smoke',snapshot).startable).toBe(false);
  expect(evaluationReadiness('frozen_v1',snapshot,'completed').startable).toBe(false);
});
it('pins runtime identity, model, reasoning and auth reference without exposing them',()=>{
  const r={ profile_enabled:true,profile_id:2,runtime_type:'codex',model:'gpt-5.6-terra',reasoning_effort:'xhigh',auth_mode:'chatgpt',auth_ref:'codex-auth' } as any;
  expect(codexProfileSupported(r)).toBe(true);expect(codexProfileSupported({ ...r,model:'other' })).toBe(false);
  expect(codexProfileSupported({ ...r,auth_mode:'api_key' })).toBe(false);
  expect(codexProfileSupported({ ...r,auth_ref:'other-account' })).toBe(false);
  expect(codexRuntimeDigest(r)).not.toContain('protected');expect(codexRuntimeDigest(r)).not.toBe(codexRuntimeDigest({ ...r,reasoning_effort:'high' }));
});
it('availability needs authenticated pinned bridge evidence, never just a configured model',async()=>{
  const old=process.env.WORKSPACE_SECRET;process.env.WORKSPACE_SECRET='fixture-only';
  try {
    jest.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ ready:true,executor_version:'old',cli_version:'codex-cli 0.146.0',models:['gpt-5.6-terra'] })));
    expect(await codexEvaluationAvailable()).toBe(false);
  } finally { if (old===undefined) delete process.env.WORKSPACE_SECRET;else process.env.WORKSPACE_SECRET=old; }
});
