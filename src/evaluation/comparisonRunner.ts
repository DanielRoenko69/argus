import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { EvaluationError, runComparisonSchema } from './contracts.js';
import { type EvaluationContext } from './context.js';
import { assertEvaluationCaller, EVALUATION_HEARTBEAT_MS, EVALUATION_LEASE_SECONDS } from './lifecycle.js';
import { executeComparisonChild, preflightEvaluationExperiment } from './runner.js';
import { mutate, getEvaluationExperiment } from './store.js';
import { getEvaluationComparison, getEvaluationComparisonDetail, lockComparisonLease, lockEvaluationComparison,
  requireEvaluationRequestId, stopComparisonChildren, type EvaluationComparison } from './comparisonStore.js';

function monitorComparison(pool:pg.Pool,id:number,token:string) {
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const tick=async () => {
    try {
      const r=await pool.query(`UPDATE mcp_evaluation_comparisons SET leased_until=clock_timestamp()+($3::int*interval '1 second')
        WHERE id=$1 AND token=$2 AND status='running' AND leased_until>clock_timestamp() RETURNING id`,[id,token,EVALUATION_LEASE_SECONDS]);
      if (!r.rows.length) stopped=true;
    } catch { stopped=true; }
    // Children also check this durable parent lease on every heartbeat/dispatch/commit.
    if (!stopped) { timer=setTimeout(() => { void tick(); },EVALUATION_HEARTBEAT_MS); timer.unref(); }
  };
  timer=setTimeout(() => { void tick(); },EVALUATION_HEARTBEAT_MS); timer.unref();
  return { stop() { stopped=true; clearTimeout(timer); } };
}

export async function runEvaluationComparison(pool:pg.Pool,id:number,input:unknown,context:EvaluationContext) {
  assertEvaluationCaller(context);
  requireEvaluationRequestId(context);
  runComparisonSchema.parse(input);
  const token=randomUUID();
  let claimed=false;
  const comparison=await mutate(pool,context,'comparison.started',{ comparisonId:id,acknowledge_cost:true },async client => {
    const c=await lockEvaluationComparison(client,id,context);
    if (c.environment!==context.environment) throw new EvaluationError('EVALUATION_ENVIRONMENT_MISMATCH','Start this comparison in the environment where it was saved',409);
    if (['running','completed'].includes(c.status)) throw new EvaluationError('EVALUATION_ALREADY_STARTED','Comparison already running or complete',409);
    const record=(await getEvaluationComparisonDetail(client,id,context))!;
    // No transport retry is hidden in Resume. Repair interrupted children separately.
    if (record.records.some(r => !['queued','completed'].includes(r.experiment.status))) {
      throw new EvaluationError('EVALUATION_COMPARISON_NEEDS_REVIEW','Inspect stopped experiments and explicitly retry eligible technical cases before resuming the series',409);
    }
    // Check both still-queued variants before scheduling A. Each child/case checks again.
    const checked=new Set<string>();
    for (const r of record.records) {
      if (r.experiment.status==='queued' && !checked.has(r.variant)) {
        await preflightEvaluationExperiment(client,r.experiment,context); checked.add(r.variant);
      }
    }
    await client.query(`UPDATE mcp_evaluation_comparisons SET status='running',token=$2,leased_until=clock_timestamp()+($3::int*interval '1 second'),
      cancel_requested=false,stop_reason=NULL,started_at=COALESCE(started_at,now()),completed_at=NULL WHERE id=$1`,[id,token,EVALUATION_LEASE_SECONDS]);
    claimed=true;
    return (await getEvaluationComparison(client,id,context))!;
  },rowId => getEvaluationComparison(pool,rowId,context));
  const completion=claimed ? runClaimedComparison(pool,comparison,context,token) : Promise.resolve();
  void completion.catch(() => logger.error({ comparisonId:id,code:'EVALUATION_COMPARISON_INTERRUPTED' },'Comparison interrupted; no automatic resume'));
  return { comparison_id:comparison.id,status:comparison.status,completion };
}

async function runClaimedComparison(pool:pg.Pool,comparison:EvaluationComparison,context:EvaluationContext,token:string) {
  const monitor=monitorComparison(pool,comparison.id,token);
  const stage=(key:string) => ({ ...context,requestId:`comparison:${comparison.id}:${token}:${key}` });
  let failed=false;
  let stopReason:string|null=null;
  try {
    try {
      for (const step of comparison.plan) {
        const parent=await getEvaluationComparison(pool,comparison.id,context);
        if (parent?.cancel_requested) break;
        const child=await getEvaluationExperiment(pool,step.experiment_id,context);
        if (child?.experiment.status==='completed') continue;
        const job=await executeComparisonChild(pool,step.experiment_id,stage('step:'+step.position),{ id:comparison.id,token,position:step.position });
        await job.completion;
        const outcome=await getEvaluationExperiment(pool,step.experiment_id,context);
        if (outcome?.experiment.status!=='completed') { failed=true; stopReason='EVALUATION_CHILD_STOPPED'; break; }
      }
    } catch(error) { failed=true; stopReason=error instanceof EvaluationError ? error.code : 'EVALUATION_COMPARISON_INTERRUPTED'; }
    await mutate(pool,stage('finish'),'comparison.finished',{ comparisonId:comparison.id },async client => {
      const c=await lockComparisonLease(client,comparison.id,token,context);
      const detail=(await getEvaluationComparisonDetail(client,comparison.id,context))!;
      const complete=detail.records.every(r => r.experiment.status==='completed');
      const status=c.cancel_requested ? 'cancelled' : complete && !failed ? 'completed' : 'failed';
      if (status!=='completed') await stopComparisonChildren(client,comparison.id);
      await client.query('UPDATE mcp_evaluation_comparisons SET status=$2,completed_at=now(),stop_reason=$3 WHERE id=$1',
        [comparison.id,status,c.cancel_requested ? 'EVALUATION_CANCEL_REQUESTED' : stopReason]);
      return (await getEvaluationComparison(client,comparison.id,context))!;
    },id => getEvaluationComparison(pool,id,context));
  } finally { monitor.stop(); }
}

export async function cancelEvaluationComparison(pool:pg.Pool,id:number,context:EvaluationContext) {
  assertEvaluationCaller(context);
  requireEvaluationRequestId(context);
  return mutate(pool,context,'comparison.cancel_requested',{ comparisonId:id },async client => {
    const c=await lockEvaluationComparison(client,id,context);
    if (!['queued','running'].includes(c.status)) throw new EvaluationError('EVALUATION_NOT_RUNNING','Only queued or running comparisons can be cancelled',409);
    await stopComparisonChildren(client,id);
    await client.query(`UPDATE mcp_evaluation_comparisons SET cancel_requested=true,stop_reason='EVALUATION_CANCEL_REQUESTED',
      status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,
      completed_at=CASE WHEN status='queued' THEN now() ELSE completed_at END WHERE id=$1`,[id]);
    return (await getEvaluationComparison(client,id,context))!;
  },rowId => getEvaluationComparison(pool,rowId,context));
}
