import { readFileSync } from 'node:fs';
import { chatCompletion } from '../../llm/client.js';
import { scoreEvaluationOutput } from '../scoring.js';
import { executeNativeEvaluationCase, buildEvaluationRequest } from '../nativeExecutor.js';
import { measureEvaluationResponse } from '../measurements.js';
import type { EvaluationCase } from '../store.js';
import type { ChatCompletionResponse, LlmTarget } from '../../llm/types.js';
jest.mock('../../llm/client.js', () => ({ chatCompletion:jest.fn() }));
const completion = jest.mocked(chatCompletion);
const fixtures = JSON.parse(readFileSync('docs/specs/evaluation/curated-cases.v1.json','utf8')).cases;
const target: LlmTarget = { provider:'openai-compatible',model:'fixture',baseUrl:'http://fixture.invalid',apiKey:'',authType:'none',timeoutMs:1000 };
const snapshot = { context_mode:'isolated_reference',agent:{ system_prompt:'Frozen prompt',temperature:0.2,max_tokens:8192 },
  skills:[{ content:'Frozen skill' }],execution:{ type:'argus',executor_version:'argus.native-reference.v1',isolation_verified:true,model_catalog:{ input_cost_per_1k:0.01,output_cost_per_1k:0.02 } } };
const row = (f: any): EvaluationCase => ({ input_redacted:f.input,context_redacted:f.context,rules:f.rules,expected_output:f.expected_output } as EvaluationCase);
const response = (content: string, extras = {}): ChatCompletionResponse => ({ id:'fixture',model:'fixture',choices:[{ index:0,message:{ role:'assistant',content },finish_reason:'stop' }],...extras });
beforeEach(() => completion.mockReset());

describe('isolated native evaluator', () => {
  for (const f of fixtures) for (const answer of f.fixture_responses) {
    it(f.case_key+' / '+answer.label, async () => {
      if (answer.error_code) completion.mockRejectedValue(new Error('Secret provider body'));
      else completion.mockResolvedValue(response(answer.output));
      const result = await executeNativeEvaluationCase(snapshot,row(f),target);
      expect(result.status).toBe(answer.expected_status);
      expect(JSON.stringify(result)).not.toContain('Secret provider body');
      expect(completion).toHaveBeenCalledTimes(1);
      expect(completion.mock.calls[0]![1]).toMatchObject({ maxRetries:0,safeErrors:true });
    });
  }
  it('uses only pinned prompt/skills plus user-level input/context, never answers or rules', () => {
    const request = buildEvaluationRequest(snapshot,row(fixtures[0]),target);
    expect(request.tools).toEqual([]);
    expect(request.messages).toEqual([{ role:'system',content:'Frozen prompt\n\nFrozen skill' },
      { role:'user',content:JSON.stringify({ input:fixtures[0].input,reference_context:{} }) }]);
    expect(request.max_tokens).toBe(8192);
    expect(JSON.stringify(request)).not.toContain('expected_output');
  });
  it('fails closed for external runtimes and old snapshots before dispatch', async () => {
    await expect(executeNativeEvaluationCase({ ...snapshot,execution:{ type:'codex' } },row(fixtures[0]),target)).rejects.toThrow('isolation');
    expect(completion).not.toHaveBeenCalled();
  });
  it('retains observed usage when a response is unusable and does not execute requested tools', async () => {
    completion.mockResolvedValue(response('partial', { usage:{ prompt_tokens:10,completion_tokens:5,total_tokens:15 },
      choices:[{ index:0,message:{ content:'partial',tool_calls:[{ function:{ name:'delete_all' } }] },finish_reason:'tool_calls' }] }));
    const result = await executeNativeEvaluationCase(snapshot,row(fixtures[0]),target);
    expect(result.status).toBe('error');
    expect(result.evidence.measurements).toMatchObject({ input_tokens:10,output_tokens:5,cost_source:'catalog_estimate' });
  });
  it('does not invoke a model-based judge', async () => {
    completion.mockResolvedValue(response('null guard'));
    await executeNativeEvaluationCase(snapshot,row(fixtures[0]),target);
    expect(completion).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch an already cancelled request',async () => {
    const controller=new AbortController(); controller.abort();
    const result=await executeNativeEvaluationCase(snapshot,row(fixtures[0]),target,controller.signal);
    expect(result.status).toBe('error'); expect(completion).not.toHaveBeenCalled();
  });
  it('retains the provider deadline when a cancellation signal is supplied',async () => {
    jest.useFakeTimers();
    try {
      const controller=new AbortController();
      completion.mockImplementation((_request,options) => new Promise((_resolve,reject) => options!.signal!.addEventListener('abort',()=>reject(new Error('timeout')),{ once:true })));
      const result=executeNativeEvaluationCase(snapshot,row(fixtures[0]),target,controller.signal);
      await jest.advanceTimersByTimeAsync(target.timeoutMs);
      expect((await result).status).toBe('error');
      expect(controller.signal.aborted).toBe(false);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
});
describe('strict assertion semantics', () => {
  const score = (output: string, assertion: unknown) => scoreEvaluationOutput(output,{ version:'argus.deterministic.v1',assertions:[assertion] });
  it.each(['',' ','\n'])('fails empty output even for exclusion: %j', value => expect(score(value,{ type:'text_excludes',value:'bad' }).status).toBe('failed'));
  it.each(['[]','null','```json\n{"a":1}\n```','{"a":"1"}','{"a":null}'])('rejects non-object, fences and type mismatches: %s', output => {
    expect(score(output,{ type:'json_field_equals',path:['a'],value:1 }).status).toBe('failed');
  });
  it('requires own properties and refuses prototype paths', () => {
    expect(score('{}',{ type:'json_object',required:['toString'] }).status).toBe('failed');
    expect(() => score('{}',{ type:'json_field_equals',path:['__proto__'],value:null })).toThrow();
    expect(score('{"a":{"b":null}}',{ type:'json_field_equals',path:['a','b'],value:null }).status).toBe('passed');
  });
  it('does not normalize exact text and retains per-assertion reasons', () => {
    expect(score(' OK ',{ type:'text_equals',value:'OK' }).status).toBe('failed');
    expect(score('ok',{ type:'text_equals',value:'OK' }).assertions[0]?.reason).toBe('not_matched');
  });
});
describe('honest measurements', () => {
  it('distinguishes missing, partial and measured-zero usage/cost', () => {
    expect(measureEvaluationResponse(response('ok'),1,{})).toMatchObject({ input_tokens:null,output_tokens:null,cost_usd:null,usage_source:'unknown' });
    expect(measureEvaluationResponse(response('ok',{ usage:{ prompt_tokens:0 } }),1,{})).toMatchObject({ input_tokens:0,output_tokens:null,usage_source:'partial_provider' });
    expect(measureEvaluationResponse(response('ok',{ usage:{ prompt_tokens:0,completion_tokens:0 } }),1,{ input_cost_per_1k:0,output_cost_per_1k:0 })).toMatchObject({ cost_usd:0,cost_source:'catalog_estimate' });
  });
  it('does not turn compatibility defaults or unknown cache pricing into costs', () => {
    expect(measureEvaluationResponse(response('ok',{ usage:{ prompt_tokens:0,completion_tokens:0 },usage_observed:null }),1,{}).input_tokens).toBeNull();
    expect(measureEvaluationResponse(response('ok',{ usage:{ prompt_tokens:10,completion_tokens:5,cache_read_input_tokens:10 } }),1,{ input_cost_per_1k:1,output_cost_per_1k:1 }).cost_usd).toBeNull();
  });
});
