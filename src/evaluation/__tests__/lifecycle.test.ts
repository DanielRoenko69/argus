import { evaluationProgress, monitorEvaluationWorker } from '../lifecycle.js';
import { retryEvaluationSchema } from '../contracts.js';
import type { EvaluationExperiment, EvaluationResult, EvaluationAttempt } from '../store.js';
import type pg from 'pg';
import { jest } from '@jest/globals';

const experiment:EvaluationExperiment={ id:1,status:'interrupted',evidence_kind:'frozen_v1',
  tenant_key:'default',workspace_key:'default',dataset_id:1,dataset_sha256:null,configuration_sha256:null,evaluator_sha256:null,
  agent_id:1,model_ref:'fixture',credential_ref:null,evaluator_config:{},baseline_experiment_id:null,started_at:null,completed_at:null,created_by_user_id:null,created_at:'fixture',
  expected_cases:[1,2,3].map(id => ({ id,case_key:String(id),sha256:'fixture' })),
  configuration_snapshot:{ execution:{ type:'argus',executor_version:'argus.native-reference.v1',isolation_verified:true } } };
const result=(case_id:number,attempt:number,status:string) => ({ case_id,attempt,status } as EvaluationResult);
const attempt=(case_id:number,n:number) => ({ case_id,attempt:n } as EvaluationAttempt);

describe('evaluation lifecycle',() => {
  it('never retries an already judged answer, including failed assertions',() => {
    const p=evaluationProgress({ experiment,results:[result(1,1,'passed'),result(2,1,'failed'),result(3,1,'error')] });
    expect(p).toMatchObject({ completed_cases:2,total_cases:3,retryable_case_ids:[3] });
  });
  it('keeps unknown started attempts visible and does not reuse a superseded result',() => {
    const p=evaluationProgress({ experiment,results:[result(1,1,'error')],attempts:[attempt(1,1),attempt(1,2)] });
    expect(p).toMatchObject({ completed_cases:0,pending_attempts:1,current_results:[],retryable_case_ids:[1,2,3] });
  });
  it.each(['queued','running','completed'])('does not offer retries while %s',status => {
    expect(evaluationProgress({ experiment:{ ...experiment,status } as EvaluationExperiment,results:[] }).retryable_case_ids).toEqual([]);
  });
  it('requires bounded case selection and explicit duplicate-cost acknowledgement',() => {
    expect(retryEvaluationSchema.safeParse({ case_ids:[1] }).success).toBe(false);
    expect(retryEvaluationSchema.safeParse({ case_ids:[],acknowledge_possible_duplicate_cost:true }).success).toBe(false);
    expect(retryEvaluationSchema.safeParse({ case_ids:[1],acknowledge_possible_duplicate_cost:true }).success).toBe(true);
  });
  it.each(['cancel','fenced','database'])('aborts the active request on %s',async mode => {
    jest.useFakeTimers();
    const query=jest.fn<(...args:unknown[])=>Promise<unknown>>();
    if (mode==='database') query.mockRejectedValue(new Error('unavailable'));
    else query.mockResolvedValue({ rows:mode==='cancel' ? [{ cancel_requested:true }] : [] });
    const worker=monitorEvaluationWorker({ query } as unknown as pg.Pool,1,'token');
    await jest.advanceTimersByTimeAsync(2000);
    expect(worker.signal.aborted).toBe(true);
    worker.stop();
    expect(jest.getTimerCount()).toBe(0);
    jest.useRealTimers();
  });
});
