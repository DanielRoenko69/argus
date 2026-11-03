import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { hasRole } from '../auth/roles.js';
import { authorizedWorkspaceScopes } from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { EvaluationError, evaluationReadiness } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { getEvaluationExperiment, mutate, type EvaluationExperiment, type EvaluationResult, type EvaluationAttempt } from './store.js';
import { recoverEvaluationComparisons } from './comparisonStore.js';

export const EVALUATION_LEASE_SECONDS = 30;
export const EVALUATION_HEARTBEAT_MS = 2_000;
export type EvaluationEvidence = { experiment: EvaluationExperiment; results: EvaluationResult[]; attempts?: EvaluationAttempt[] };

export function assertEvaluationCaller(context: EvaluationContext) {
  if (!context?.user || !hasRole(context.user.role,'platform_admin')) throw new EvaluationError('FORBIDDEN','Admin caller context is required',403);
  if (!authorizedWorkspaceScopes(context.user).some(s => s.tenantKey===context.tenantKey && s.workspaceKey===context.workspaceKey)) missingReference();
}

/** Latest attempts are authoritative, not the highest-scoring or cheapest answers. */
export function evaluationProgress(record: EvaluationEvidence) {
  const latest = new Map<number,number>();
  for (const a of [...record.results,...(record.attempts ?? [])]) latest.set(a.case_id,Math.max(latest.get(a.case_id) ?? 0,a.attempt));
  const current = record.results.filter(r => r.attempt===latest.get(r.case_id));
  const complete = new Set(current.filter(r => r.status==='passed' || r.status==='failed').map(r => r.case_id));
  const expected = record.experiment.expected_cases ?? [];
  const openAttempts = (record.attempts ?? []).filter(a => !record.results.some(r => r.case_id===a.case_id && r.attempt===a.attempt));
  const retryable = ['failed','cancelled','interrupted'].includes(record.experiment.status)
    && record.experiment.comparison_status!=='running'
    && evaluationReadiness(record.experiment.evidence_kind,record.experiment.configuration_snapshot,'queued').startable;
  return { total_cases:expected.length,completed_cases:expected.filter(c => complete.has(c.id)).length,
    recorded_attempts:record.results.length,pending_attempts:openAttempts.length,
    retryable_case_ids:retryable ? expected.filter(c => !complete.has(c.id)).map(c => c.id) : [],
    current_results:current };
}

export async function lockEvaluationWorker(client: pg.PoolClient,id: number,token: string) {
  await client.query('SELECT id FROM mcp_evaluation_experiments WHERE id=$1 FOR UPDATE',[id]);
  const row = (await client.query<{ cancel_requested:boolean }>(`SELECT (w.cancel_requested OR EXISTS (
    SELECT 1 FROM mcp_evaluation_comparisons c WHERE c.id=w.comparison_id AND c.cancel_requested)) AS cancel_requested FROM mcp_evaluation_workers w
    JOIN mcp_evaluation_experiments e ON e.id=w.experiment_id WHERE e.id=$1 AND w.token=$2
    AND e.status='running' AND w.leased_until>clock_timestamp() AND evaluation_comparison_lease_valid(w) FOR UPDATE OF w`,[id,token])).rows[0];
  if (!row) throw new EvaluationError('EVALUATION_WORKER_FENCED','This execution lease is no longer active',409);
  return row;
}

/** Poll durable cancellation across replicas; fail closed on lease/DB loss. */
export function monitorEvaluationWorker(pool: pg.Pool,id: number,token: string) {
  const controller = new AbortController();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog = setTimeout(() => controller.abort(),EVALUATION_LEASE_SECONDS*1000);
  watchdog.unref();
  const tick = async () => {
    try {
      const row = (await pool.query<{ cancel_requested:boolean }>(`UPDATE mcp_evaluation_workers w
        SET leased_until=clock_timestamp()+($3::int*interval '1 second') FROM mcp_evaluation_experiments e
        WHERE w.experiment_id=$1 AND w.token=$2 AND e.id=w.experiment_id AND e.status='running'
          AND w.leased_until>clock_timestamp() AND evaluation_comparison_lease_valid(w)
        RETURNING (w.cancel_requested OR EXISTS (SELECT 1 FROM mcp_evaluation_comparisons c WHERE c.id=w.comparison_id AND c.cancel_requested)) AS cancel_requested`,[id,token,EVALUATION_LEASE_SECONDS])).rows[0];
      if (stopped) return;
      if (!row || row.cancel_requested) controller.abort();
      if (row) { clearTimeout(watchdog); watchdog=setTimeout(() => controller.abort(),EVALUATION_LEASE_SECONDS*1000); watchdog.unref(); }
    } catch { controller.abort(); }
    if (!stopped && !controller.signal.aborted) { timer=setTimeout(() => { void tick(); },EVALUATION_HEARTBEAT_MS); timer.unref(); }
  };
  timer=setTimeout(() => { void tick(); },EVALUATION_HEARTBEAT_MS); timer.unref();
  return { signal:controller.signal, stop() { stopped=true; clearTimeout(timer); clearTimeout(watchdog); } };
}

export async function cancelEvaluationExperiment(pool: pg.Pool,id: number,context: EvaluationContext) {
  assertEvaluationCaller(context);
  return mutate(pool,context,'experiment.cancel_requested',{ experimentId:id },async client => {
    await client.query('SELECT id FROM mcp_evaluation_experiments WHERE id=$1 FOR UPDATE',[id]);
    const record = await getEvaluationExperiment(client,id,context);
    if (!record) missingReference();
    if (record.experiment.comparison_id && (record.experiment.status==='queued' || record.experiment.comparison_status==='running')) {
      throw new EvaluationError('EVALUATION_COMPARISON_CONTROLLED','Cancel the comparison instead of an individual scheduled experiment',409);
    }
    if (record.experiment.status==='queued') {
      return (await client.query<EvaluationExperiment>("UPDATE mcp_evaluation_experiments SET status='cancelled',completed_at=now() WHERE id=$1 RETURNING *",[id])).rows[0]!;
    }
    if (record.experiment.status!=='running') throw new EvaluationError('EVALUATION_NOT_RUNNING','Only queued or running experiments can be cancelled',409);
    await client.query('UPDATE mcp_evaluation_workers SET cancel_requested=true WHERE experiment_id=$1',[id]);
    return record.experiment;
  },async rowId => (await getEvaluationExperiment(pool,rowId,context))?.experiment ?? null);
}

/** Reconcile durable evidence, never create a new execution worker or call a provider. */
export async function recoverEvaluationExperiments(pool: pg.Pool,environment: string) {
  const candidates = (await pool.query<{ id:string; tenant_key:string; workspace_key:string; token:string|null }>(`SELECT e.id,e.tenant_key,e.workspace_key,w.token
    FROM mcp_evaluation_experiments e LEFT JOIN mcp_evaluation_workers w ON w.experiment_id=e.id
    WHERE e.status='running' AND ((w.environment=$1 AND w.leased_until<clock_timestamp()) OR
      (w.experiment_id IS NULL AND COALESCE(e.started_at,e.created_at)<clock_timestamp()-interval '30 seconds'))
    ORDER BY e.id LIMIT 50`,[environment])).rows;
  let recovered=0;
  for (const c of candidates) {
    const scope={ environment,tenantKey:c.tenant_key,workspaceKey:c.workspace_key };
    try {
      const outcome = await executeCanonicalAuditedMutation(pool,{ name:'evaluation.experiment.recovered',eventId:c.token ?? 'legacy:'+c.id },scope,async client => {
        await client.query('SELECT id FROM mcp_evaluation_experiments WHERE id=$1 FOR UPDATE',[c.id]);
        const record=await getEvaluationExperiment(client,Number(c.id),scope);
        if (!record) missingReference();
        const progress=evaluationProgress(record);
        // The final result may have committed just before a crash in finalization.
        // Reconcile that existing evidence; never require another paid request.
        const status=progress.total_cases>0 && progress.completed_cases===progress.total_cases
          ? record.cancellation_requested ? 'cancelled' : 'completed' : 'interrupted';
        const rows = (await client.query<EvaluationExperiment>(`UPDATE mcp_evaluation_experiments e SET status=$3,completed_at=now()
          WHERE id=$1 AND status='running' AND NOT EXISTS (SELECT 1 FROM mcp_evaluation_workers w WHERE w.experiment_id=e.id
            AND (w.token IS DISTINCT FROM $2::uuid OR w.leased_until>=clock_timestamp())) RETURNING *`,[c.id,c.token,status])).rows;
        if (!rows[0]) throw new EvaluationError('EVALUATION_LEASE_RENEWED','Worker lease changed',409);
        await client.query(`UPDATE mcp_observability_traces SET status='failed',ended_at=now(),error_message='EVALUATION_INTERRUPTED: provider outcome may be unknown'
          WHERE kind='evaluation' AND status='running' AND metadata->>'evaluationExperimentId'=$1`,[String(c.id)]);
        return rows[0];
      },row => ({ ...scope,solution:'argus.core',actor:{ type:'system',id:'evaluation-recovery',authMethod:'system',effectiveRoles:[] },
        action:row.status==='interrupted' ? 'evaluation.experiment.interrupted' : 'evaluation.experiment.recovered',outcome:row.status==='completed' ? 'success' : row.status==='cancelled' ? 'cancelled' : 'failure',risk:'medium',
        resource:{ type:'evaluation_experiment',id:String(row.id) },payload:{ after:{ status:row.status,automatic_retry:false } } }));
      if (!outcome.replayed) recovered++;
    } catch (error) { if (!(error instanceof EvaluationError && error.code==='EVALUATION_LEASE_RENEWED')) throw error; }
  }
  return recovered;
}

export function startEvaluationRecoveryWorker(pool: pg.Pool,environment: string) {
  let stopped=false;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const sweep=async () => {
    try { await recoverEvaluationComparisons(pool,environment); await recoverEvaluationExperiments(pool,environment); }
    catch { logger.error({ code:'EVALUATION_RECOVERY_FAILED' },'Evaluation recovery failed; no provider requests were repeated'); }
    if (!stopped) { timer=setTimeout(() => { void sweep(); },10_000); timer.unref(); }
  };
  void sweep();
  return { stop() { stopped=true; clearTimeout(timer); } };
}
