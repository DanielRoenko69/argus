import type pg from 'pg';
import { getTelemetryTrace } from '../../observability/telemetryStore.js';
import { previewEvaluationTrace, traceCaseSchema, starterImportSchema, createEvaluationCaseFromTrace } from '../curation.js';
import { evaluationStarterSets } from '../starterSets.js';
import { evaluationDigest, evaluationRulesSchema } from '../contracts.js';
import { scoreEvaluationOutput } from '../scoring.js';
import { boundedEvaluationJson } from '../snapshots.js';
import type { EvaluationContext } from '../context.js';

jest.mock('../../observability/telemetryStore.js',() => ({ getTelemetryTrace:jest.fn() }));
const telemetry=jest.mocked(getTelemetryTrace);
const trace='11111111-1111-4111-8111-111111111111',span='22222222-2222-4222-8222-222222222222';
const source={ trace_id:trace,span_id:null };
const context={ user:{ id:7,allowed_bundles:[4] },tenantKey:'tenant',workspaceKey:'workspace',requestId:'curation-test' } as EvaluationContext;
const pool={} as pg.Pool;
beforeEach(() => { telemetry.mockReset(); telemetry.mockResolvedValue({ trace:{ id:trace,name:'Review',status:'failed',input_preview:{ task:'Analyze',password:'fixture-password',nested:{ api_key:'fixture-key' } },output_preview:{ message:'Wrong answer',authorization:'Bearer fixture-value' },metadata:{ secret:'never copy me' } },spans:[] } as never); });

describe('curated starter sets',() => {
  it('contains 24 unique, meaningful Dev/AIOps tasks with stable digests',() => {
    expect(evaluationStarterSets.map(s => s.cases.length)).toEqual([12,12]);
    const cases=evaluationStarterSets.flatMap(s => s.cases);
    expect(new Set(cases.map(c => c.caseKey)).size).toBe(24);
    for (const set of evaluationStarterSets) expect(set.content_sha256).toBe(evaluationDigest(set.cases));
    for (const c of cases) {
      expect(evaluationRulesSchema.safeParse(c.rules).success).toBe(true);
      expect(scoreEvaluationOutput(JSON.stringify(c.expectedOutput),c.rules).status).toBe('passed');
      expect(boundedEvaluationJson(c.expectedOutput,32768,'expected')).toEqual(c.expectedOutput);
      expect(c.metadata?.['evidence_kind']).toBe('synthetic');
      expect(String(c.context).length).toBeGreaterThan(90);
      expect(String(c.input)).not.toContain(JSON.stringify(c.expectedOutput));
      expect(scoreEvaluationOutput('{}',c.rules).status).toBe('failed');
      expect(scoreEvaluationOutput('A confident but unsupported answer.',c.rules).status).toBe('failed');
      const wrong={ ...c.expectedOutput as Record<string,unknown> },key=Object.keys(wrong)[0]!;
      wrong[key]=typeof wrong[key]==='boolean' ? !wrong[key] : 'incorrect';
      expect(scoreEvaluationOutput(JSON.stringify(wrong),c.rules).status).toBe('failed');
    }
  });
});
describe('trace curation boundary',() => {
  it('force-redacts and allowlists preview; never supplies ground truth',async() => {
    const result=await previewEvaluationTrace(pool,source,context);
    expect(result.input).toEqual({ task:'Analyze',password:'[REDACTED]',nested:{ api_key:'[REDACTED]' } });
    expect(result.observed_output).toEqual({ message:'Wrong answer',authorization:'[REDACTED]' });
    expect(result).not.toHaveProperty('expected_output');
    expect(JSON.stringify(result)).not.toMatch(/fixture-password|fixture-key|fixture-value|never copy me/);
    expect(telemetry).toHaveBeenCalledWith(pool,trace,expect.objectContaining({ tenantKey:'tenant',workspaceKey:'workspace',userId:7,allowedBundleIds:[4] }));
    expect(result.preview_sha256).toBe((await previewEvaluationTrace(pool,source,context)).preview_sha256);
  });
  it('scopes spans to the exact trace, opaque on missing/inaccessible sources',async() => {
    await expect(previewEvaluationTrace(pool,{ trace_id:trace,span_id:span },context)).rejects.toMatchObject({ code:'EVALUATION_REFERENCE_NOT_FOUND' });
    telemetry.mockResolvedValue(null);
    await expect(previewEvaluationTrace(pool,source,context)).rejects.toMatchObject({ status:404 });
    telemetry.mockResolvedValue({ trace:{ id:span },spans:[] } as never);
    await expect(previewEvaluationTrace(pool,source,context)).rejects.toMatchObject({ status:404 });
  });
  it('selects only the requested span and rejects oversized content instead of silent truncation',async() => {
    telemetry.mockResolvedValue({ trace:{ id:trace },spans:[{ id:span,name:'LLM',status:'completed',input_preview:'Span input',output_preview:'Span output' }] } as never);
    expect((await previewEvaluationTrace(pool,{ trace_id:trace,span_id:span },context)).input).toBe('Span input');
    telemetry.mockResolvedValue({ trace:{ id:trace,input_preview:'x'.repeat(32769) },spans:[] } as never);
    await expect(previewEvaluationTrace(pool,source,context)).rejects.toMatchObject({ code:'EVALUATION_TOO_LARGE' });
  });
  it('requires human review, strict server provenance and a stable idempotency key',async() => {
    expect(traceCaseSchema.safeParse({ reviewed:false }).success).toBe(false);
    expect(starterImportSchema.safeParse({ reviewed:true,reviewed_content_sha256:'invalid' }).success).toBe(false);
    const body={ source,reviewed:true as const,reviewed_preview_sha256:'a'.repeat(64),case:{ case_key:'x',input:'task',rules:evaluationStarterSets[0]!.cases[0]!.rules } };
    expect(traceCaseSchema.safeParse({ ...body,case:{ ...body.case,metadata:{ curation:'forged' } } }).success).toBe(false);
    await expect(createEvaluationCaseFromTrace(pool,1,body,{ ...context,requestId:'' })).rejects.toMatchObject({ code:'EVALUATION_IDEMPOTENCY_REQUIRED' });
    await expect(createEvaluationCaseFromTrace(pool,1,body,context)).rejects.toMatchObject({ code:'EVALUATION_SOURCE_CHANGED' });
  });
});
