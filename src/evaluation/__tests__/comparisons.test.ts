import { createComparisonSchema, runComparisonSchema, evaluationDigest } from '../contracts.js';
import { comparisonOrder, type EvaluationComparison } from '../comparisonStore.js';
import { summarizeEvaluationComparison } from '../regression.js';
import { evaluationProgress } from '../lifecycle.js';
import { scoreEvaluationOutput } from '../scoring.js';
import type { EvaluationExperiment, EvaluationResult } from '../store.js';

const input={ name:'Fixture',dataset_id:1,baseline:{ agent_id:1,model_ref:'A' },candidate:{ agent_id:1,model_ref:'B' } };
function fixture() {
  const records=Array.from({ length:4 },(_,i) => {
    const id=i+1,variant=i%2===0 ? 'baseline' as const : 'candidate' as const;
    const rules={ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] };
    const snapshot={ context_mode:'isolated_reference',execution:{ type:'argus',isolation_verified:true,executor_version:'argus.native-reference.v1' },evaluator:{ rules } };
    const judgement=scoreEvaluationOutput('OK',rules);
    const experiment:EvaluationExperiment={ id,status:'completed',evidence_kind:'frozen_v1',tenant_key:'default',workspace_key:'default',dataset_id:1,dataset_sha256:'dataset',
      agent_id:1,model_ref:'fixture',credential_ref:null,evaluator_config:{},started_at:null,completed_at:null,created_at:'fixture',created_by_user_id:null,
      expected_cases:[{ id:1,case_key:'one',sha256:'case' }],configuration_snapshot:snapshot,configuration_sha256:evaluationDigest(snapshot),evaluator_sha256:evaluationDigest(snapshot.evaluator),
      baseline_experiment_id:variant==='candidate' ? id-1 : null };
    const result:EvaluationResult={ id,case_id:1,attempt:1,status:'passed',scores:judgement.scores,evaluator_version:judgement.version,
      experiment_id:id,trace_id:null,output_redacted:'OK',latency_ms:1,error_message:null,created_at:'fixture',
      input_tokens:1,output_tokens:1,cost_usd:0.01,evidence:{ executor_version:'argus.native-reference.v1',judgement } };
    return { position:id,round:Math.ceil(id/2),variant,experiment_id:id,configuration_sha256:experiment.configuration_sha256!,experiment,results:[result] };
  });
  const plan=records.map(({ position,round,variant,experiment_id,configuration_sha256 }) => ({ position,round,variant,experiment_id,configuration_sha256 }));
  return { records,comparison:{ id:1,status:'completed',repetitions:2,plan } as EvaluationComparison };
}
describe('paired evaluation contract',() => {
  it('defaults to one alternating pair and requires cost acknowledgement',() => {
    expect(createComparisonSchema.parse(input)).toMatchObject({ repetitions:1,order_mode:'alternating' });
    expect(runComparisonSchema.safeParse({}).success).toBe(false);
    expect(runComparisonSchema.safeParse({ acknowledge_cost:false }).success).toBe(false);
    expect(runComparisonSchema.safeParse({ acknowledge_cost:true }).success).toBe(true);
  });
  it.each([0,-1,11,1.5,Infinity])('rejects invalid repetition count %s',repetitions => {
    expect(createComparisonSchema.safeParse({ ...input,repetitions }).success).toBe(false);
  });
  it('alternates whole experiments by round and offers fixed baseline order',() => {
    expect(comparisonOrder(3,'alternating').map(r => r.variants)).toEqual([['baseline','candidate'],['candidate','baseline'],['baseline','candidate']]);
    expect(comparisonOrder(2,'baseline_first').map(r => r.variants)).toEqual([['baseline','candidate'],['baseline','candidate']]);
  });
  it('requires every expected pair before producing a green overall gate',() => {
    const { comparison,records }=fixture();
    expect(summarizeEvaluationComparison(comparison,records)).toMatchObject({ comparison_state:'passed',planned_requests:4,cost_coverage:{ measured:4,total:4 } });
    records[2]!.experiment.status='queued'; records[2]!.results=[];
    expect(summarizeEvaluationComparison(comparison,records)).toMatchObject({ comparison_state:'inconclusive',remaining_requests:1 });
  });
  it('rejects a substituted, missing or duplicated pair instead of cherry-picking',() => {
    const { comparison,records }=fixture();
    expect(summarizeEvaluationComparison(comparison,records.slice(1)).comparison_state).toBe('not_comparable');
    records[1]=records[0]!;
    expect(summarizeEvaluationComparison(comparison,records).comparison_state).toBe('not_comparable');
  });
  it('keeps a stopped parent inconclusive even with complete child evidence',() => {
    const { comparison,records }=fixture(); comparison.status='interrupted';
    expect(summarizeEvaluationComparison(comparison,records).comparison_state).toBe('inconclusive');
  });
  it('does not enable individual technical retries while the series runs',() => {
    const { records }=fixture();
    const record=records[0]!; record.experiment.status='interrupted'; record.experiment.comparison_status='running'; record.results=[];
    expect(evaluationProgress(record).retryable_case_ids).toEqual([]);
  });
});
