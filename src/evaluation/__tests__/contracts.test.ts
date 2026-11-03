import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDatasetSchema, createCaseSchema, createExperimentSchema, evaluationDigest, evaluationRulesSchema, evaluationReadiness } from '../contracts.js';
import { datasetContentDigest, type EvaluationCase } from '../store.js';
import { boundedEvaluationJson } from '../snapshots.js';
import { evaluationContext } from '../context.js';
import type { Request } from 'express';
import { summarizeEvaluationResults } from '../regression.js';

const fixtures = JSON.parse(readFileSync(resolve('docs/specs/evaluation/curated-cases.v1.json'),'utf8'));
const c = { id:1,case_key:'case',input_redacted:'input',expected_output:'expected',context_redacted:{ a:1 },metadata:{},
  rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'expected' }] } } as EvaluationCase;
describe('evaluation foundation contracts',() => {
  it('keeps the synthetic corpus and three-case smoke bounded',() => {
    expect(fixtures.evidence_kind).toBe('fixture');
    expect(fixtures.cases).toHaveLength(12);
    expect(fixtures.cases.filter((row: { smoke:boolean }) => row.smoke)).toHaveLength(3);
    for (const row of fixtures.cases) {
      expect(evaluationRulesSchema.safeParse(row.rules).success).toBe(true);
      expect(row.fixture_responses.map((r: { expected_status:string }) => r.expected_status)).toEqual(['passed','failed','failed','error']);
      expect(row.fixture_responses[1].output.length).toBeGreaterThan(0);
      expect(row.fixture_responses[1].usage).toBeNull();
    }
  });
  it('rejects missing rules, unknown fields, invalid IDs and executable evaluators',() => {
    expect(createDatasetSchema.safeParse({ dataset_key:'x',name:'x',agent_id:'bad' }).success).toBe(false);
    expect(createCaseSchema.safeParse({ case_key:'x',input:'x' }).success).toBe(false);
    expect(createExperimentSchema.safeParse({ dataset_id:1,model_ref:'m',evaluator_config:{ code:'exec()' } }).success).toBe(false);
    expect(evaluationRulesSchema.safeParse({ version:'argus.deterministic.v1',assertions:[{ type:'javascript',code:'x' }] }).success).toBe(false);
    expect(evaluationRulesSchema.safeParse({ version:'argus.deterministic.v1',assertions:[{ type:'json_field_equals',path:['__proto__'],value:true }] }).success).toBe(false);
  });
  it('hashes content, expectations, context and rules, independently of key/case order',() => {
    expect(evaluationDigest({ a:1,b:2 })).toBe(evaluationDigest({ b:2,a:1 }));
    expect(evaluationDigest(new Date('2026-09-22T00:00:00Z'))).toBe(evaluationDigest('2026-09-22T00:00:00.000Z'));
    const other = { ...c,case_key:'other' };
    expect(datasetContentDigest([c,other])).toBe(datasetContentDigest([other,c]));
    for (const key of ['input_redacted','expected_output','context_redacted','rules','metadata']) {
      expect(datasetContentDigest([{ ...c,[key]:'changed' }])).not.toBe(datasetContentDigest([c]));
    }
    // Trace/user FK tombstones do not rewrite the semantic content digest.
    expect(datasetContentDigest([{ ...c,source_trace_id:null }])).toBe(datasetContentDigest([c]));
  });
  it('bounds and force-redacts secret-bearing JSON even with redaction disabled globally',() => {
    expect(boundedEvaluationJson({ nested:{ api_key:'not-a-known-pattern',password:'fixture-password',token:'plain-fixture',refreshToken:'fixture',input_tokens:5 } },2048,'test'))
      .toEqual({ nested:{ api_key:'[REDACTED]',password:'[REDACTED]',token:'[REDACTED]',refreshToken:'[REDACTED]',input_tokens:5 } });
    expect(() => boundedEvaluationJson('x'.repeat(100),20,'test')).toThrow('exceeds');
    expect(boundedEvaluationJson({ at:new Date('2026-09-22T00:00:00Z') },2048,'test')).toEqual({ at:'2026-09-22T00:00:00.000Z' });
    let deep: unknown = 'leaf'; for(let n=0;n<30;n++) deep={ child:deep };
    expect(() => boundedEvaluationJson(deep,2048,'test')).toThrow('nesting');
  });
  it('fails closed for malformed/foreign scopes and preserves the authenticated actor',() => {
    const user={ id:1,username:'oidc:alex',role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' };
    const req={ user,header:()=>undefined } as unknown as Request;
    expect(evaluationContext(req).user).toBe(user);
    expect(() => evaluationContext({ ...req,header:(name:string)=> name==='Idempotency-Key' ? undefined : 'foreign' } as unknown as Request)).toThrow('Workspace scope');
    expect(() => evaluationContext({ header:()=>undefined } as unknown as Request)).toThrow('Authentication');
  });
  it('never upgrades smoke evidence or enables unisolated execution',() => {
    expect(evaluationReadiness('legacy_smoke').code).toBe('EVALUATION_LEGACY_SMOKE');
    expect(evaluationReadiness('frozen_v1').startable).toBe(false);
  });
  it('does not coerce missing or partial costs to a complete zero',() => {
    const result={ status:'passed' as const,scores:{},latency_ms:1,cost_usd:null };
    expect(summarizeEvaluationResults(1,'completed',[result]).costUsd).toBeUndefined();
    expect(summarizeEvaluationResults(1,'completed',[result,{ ...result,cost_usd:0.2 }]).costUsd).toBeUndefined();
    expect(summarizeEvaluationResults(1,'completed',[{ ...result,cost_usd:0 }]).costUsd).toBe(0);
  });
});
