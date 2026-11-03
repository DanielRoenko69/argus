import { compareEvaluationEvidence, summarizeEvaluationResults } from '../regression.js';
import { evaluationDigest } from '../contracts.js';
import { scoreEvaluationOutput } from '../scoring.js';
import type { EvaluationExperiment, EvaluationResult, EvaluationAttempt } from '../store.js';
const rules = { version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] };
function evidence(id:number, answer='OK') {
  const snapshot={ context_mode:'isolated_reference',execution:{ type:'argus',isolation_verified:true,executor_version:'argus.native-reference.v1' },
    evaluator:{ version:'argus.deterministic.v1',cases:[{ case_key:'a',rules }] } };
  const judgement=scoreEvaluationOutput(answer,rules);
  return { experiment:{ id,status:'completed',evidence_kind:'frozen_v1',tenant_key:'default',workspace_key:'default',
    agent_id:null,model_ref:'fixture',credential_ref:null,evaluator_config:{},started_at:null,completed_at:null,created_by_user_id:null,created_at:'fixture',
    dataset_id:1,dataset_sha256:'d'.repeat(64),configuration_snapshot:snapshot,configuration_sha256:evaluationDigest(snapshot),
    expected_cases:[{ id:1,case_key:'a',sha256:'c'.repeat(64) }],evaluator_sha256:evaluationDigest(snapshot.evaluator),baseline_experiment_id:id===1?null:1 } as EvaluationExperiment,
    results:[{ id:1,experiment_id:id,trace_id:null,output_redacted:answer,input_tokens:null,output_tokens:null,error_message:null,created_at:'fixture',
      case_id:1,attempt:1,status:judgement.status,scores:judgement.scores,evaluator_version:judgement.version,
      latency_ms:20,cost_usd:null,evidence:{ executor_version:'argus.native-reference.v1',judgement } } as EvaluationResult] };
}
describe('complete and compatible quality evidence',()=>{
  it('accepts exact Codex executor evidence but not mismatched or old runtime evidence',()=>{
    const a=evidence(1),b=evidence(2);
    for (const record of [a,b]) {
      (record.experiment.configuration_snapshot!.execution as any)={ type:'codex',isolation_verified:true,executor_version:'argus.codex-reference.v1' };
      record.experiment.configuration_sha256=evaluationDigest(record.experiment.configuration_snapshot);
      record.results[0]!.evidence!.executor_version='argus.codex-reference.v1';
    }
    expect(compareEvaluationEvidence(b,a).comparison_state).toBe('passed');
    b.results[0]!.evidence!.executor_version='argus.native-reference.v1';
    expect(compareEvaluationEvidence(b,a).comparison_state).toBe('inconclusive');
  });
  it('passes complete evidence but fails equal weak candidates on mandatory criteria',()=>{
    expect(compareEvaluationEvidence(evidence(2),evidence(1)).comparison_state).toBe('passed');
    expect(compareEvaluationEvidence(evidence(2,'wrong'),evidence(1,'wrong')).comparison_state).toBe('failed');
  });
  it.each(['missing','duplicate','skipped','error','wrong_version','wrong_score','wrong_judgement','snapshot_drift'])('does not pass %s results',kind=>{
    const c=evidence(2);
    if(kind==='missing') c.results=[];
    if(kind==='duplicate') c.results.push(c.results[0]!);
    if(kind==='skipped') c.results[0]!.status='skipped';
    if(kind==='error') c.results[0]!.status='error';
    if(kind==='wrong_version') c.results[0]!.evaluator_version='old';
    if(kind==='wrong_score') c.results[0]!.scores={ overall:NaN };
    if(kind==='wrong_judgement') c.results[0]!.evidence!['judgement']={ version:'argus.deterministic.v1',assertions:[] };
    if(kind==='snapshot_drift') c.experiment.configuration_sha256='changed';
    expect(compareEvaluationEvidence(c,evidence(1))).toMatchObject({ result:null,comparison_state:'inconclusive' });
  });
  it.each(['tenant_key','workspace_key','dataset_sha256','evaluator_sha256'])('rejects incompatible %s',key=>{
    const c=evidence(2); (c.experiment as unknown as Record<string,unknown>)[key]='other';
    expect(compareEvaluationEvidence(c,evidence(1))).toMatchObject({ result:null,comparison_state:'not_comparable' });
  });
  it('rejects legacy evidence and reports median, P95 and partial costs separately',()=>{
    const c=evidence(2); c.experiment.evidence_kind='legacy_smoke';
    expect(compareEvaluationEvidence(c,evidence(1)).comparison_state).toBe('not_comparable');
    const r=evidence(1).results[0]!;
    const aggregate=summarizeEvaluationResults(1,'completed',[{ ...r,latency_ms:10,cost_usd:0.1 },{ ...r,latency_ms:20 }]);
    expect(aggregate).toMatchObject({ medianLatencyMs:15,p95LatencyMs:20,costCoverage:{ measured:1,total:2,knownSubtotalUsd:0.1 } });
    expect(aggregate.costUsd).toBeUndefined();
  });
  it('uses a recorded technical retry but includes the original uncertain attempt in cost coverage',()=>{
    const c=evidence(2);
    c.results[0]!.attempt=2;
    c.results[0]!.cost_usd=0.1;
    const record={ ...c,attempts:[{ case_id:1,attempt:1 },{ case_id:1,attempt:2 }] as EvaluationAttempt[] };
    const comparison=compareEvaluationEvidence(record,evidence(1));
    expect(comparison.comparison_state).toBe('passed');
    expect(comparison.candidate).toMatchObject({ costCoverage:{ measured:1,total:2 },attemptHistory:{ recorded:1,unresolved:1 } });
    expect(comparison.candidate.costUsd).toBeUndefined();
  });
  it('rejects retry-until-green over a previously judged failure',()=>{
    const c=evidence(2);
    const prior=evidence(2,'wrong').results[0]!;
    c.results[0]!.attempt=2;
    c.results.push(prior);
    expect(compareEvaluationEvidence({ ...c,attempts:[{ case_id:1,attempt:2 }] as EvaluationAttempt[] },evidence(1)).result).toBeNull();
  });
});
