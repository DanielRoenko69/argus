import type pg from 'pg';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { createComparisonSchema, evaluationDigest, evaluationReadiness, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { buildComparisonPreview } from './authoring.js';
import { cloneFrozenEvaluationExperiment, getEvaluationExperiment, insertFrozenEvaluationExperiment, mutate,
  type EvaluationExperiment, type EvaluationExperimentStatus } from './store.js';

export interface EvaluationComparisonStep {
  position:number; round:number; variant:'baseline'|'candidate'; experiment_id:number; configuration_sha256:string;
}
export interface EvaluationComparison {
  id:number; name:string; tenant_key:string; workspace_key:string; environment:string; dataset_id:number;
  repetitions:number; order_mode:'alternating'|'baseline_first'; plan:EvaluationComparisonStep[]; plan_sha256:string;
  status:EvaluationExperimentStatus; cancel_requested:boolean; stop_reason:string|null; created_at:string; started_at:string|null; completed_at:string|null;
}
const publicColumns='id,name,tenant_key,workspace_key,environment,dataset_id,repetitions,order_mode,plan,plan_sha256,status,cancel_requested,stop_reason,created_at,started_at,completed_at';
type Db=Pick<pg.Pool,'query'>;
const normalize=(c:EvaluationComparison):EvaluationComparison => ({ ...c,id:Number(c.id),dataset_id:Number(c.dataset_id) });

export function comparisonOrder(repetitions:number,mode:EvaluationComparison['order_mode']) {
  return Array.from({ length:repetitions },(_,i) => ({ round:i+1,
    variants:(mode==='alternating' && i%2===1 ? ['candidate','baseline'] : ['baseline','candidate']) as Array<'baseline'|'candidate'> }));
}
export function requireEvaluationRequestId(context:EvaluationContext) {
  if (!context.requestId) throw new EvaluationError('EVALUATION_IDEMPOTENCY_REQUIRED','An Idempotency-Key is required',400);
}
export async function getEvaluationComparison(pool:Db,id:number,scope:AuthorizedWorkspaceScope) {
  const row=(await pool.query<EvaluationComparison>(`SELECT ${publicColumns} FROM mcp_evaluation_comparisons
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3`,[id,scope.tenantKey,scope.workspaceKey])).rows[0];
  return row ? normalize(row) : null;
}
export async function listEvaluationComparisons(pool:Db,scope:AuthorizedWorkspaceScope) {
  return (await pool.query<EvaluationComparison>(`SELECT ${publicColumns} FROM mcp_evaluation_comparisons
    WHERE tenant_key=$1 AND workspace_key=$2 ORDER BY id DESC LIMIT 100`,[scope.tenantKey,scope.workspaceKey])).rows.map(normalize);
}
export async function getEvaluationComparisonDetail(pool:Db,id:number,scope:AuthorizedWorkspaceScope) {
  const comparison=await getEvaluationComparison(pool,id,scope);
  if (!comparison) return null;
  const records=[];
  if (evaluationDigest(comparison.plan)!==comparison.plan_sha256) throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Comparison plan verification failed',409);
  for (const step of comparison.plan) {
    const record=await getEvaluationExperiment(pool,step.experiment_id,scope);
    if (!record || record.experiment.configuration_sha256!==step.configuration_sha256) {
      throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Comparison snapshot verification failed',409);
    }
    records.push({ ...step,...record });
  }
  return { comparison,records };
}

export async function createEvaluationComparison(pool:pg.Pool,input:unknown,context:EvaluationContext) {
  requireEvaluationRequestId(context);
  const b=createComparisonSchema.parse(input);
  return mutate(pool,context,'comparison.created',b,async client => {
    if (b.reviewed_preflight_sha256 || b.candidate.prompt_revision_id || b.candidate.skill_revision_id) {
      const current=await buildComparisonPreview(client,b,context);
      if (b.reviewed_preflight_sha256 && current.preflight_sha256!==b.reviewed_preflight_sha256) {
        throw new EvaluationError('EVALUATION_PREFLIGHT_CHANGED','Configuration changed since review. Run preflight again before saving.',409);
      }
    }
    const make=(target:typeof b.candidate,baselineId?:number) => insertFrozenEvaluationExperiment(client,{
      datasetId:b.dataset_id,agentId:target.agent_id,modelRef:target.model_ref,credentialRef:target.credential_ref,
      evaluatorConfig:{ version:'argus.deterministic.v1' },baselineExperimentId:baselineId,promptRevisionId:target.prompt_revision_id,skillRevisionId:target.skill_revision_id,
    },context);
    const baseline=await make(b.baseline);
    const candidate=await make(b.candidate,Number(baseline.id));
    for (const e of [baseline,candidate]) {
      const ready=evaluationReadiness(e.evidence_kind,e.configuration_snapshot);
      if (!ready.startable) throw new EvaluationError(ready.code,ready.reason,409);
    }
    const plan:EvaluationComparisonStep[]=[];
    for (const round of comparisonOrder(b.repetitions,b.order_mode)) {
      const a=round.round===1 ? baseline : await cloneFrozenEvaluationExperiment(client,baseline,null,context);
      const c=round.round===1 ? candidate : await cloneFrozenEvaluationExperiment(client,candidate,Number(a.id),context);
      const pair={ baseline:a,candidate:c };
      for (const variant of round.variants) plan.push({ position:plan.length+1,round:round.round,variant,
        experiment_id:Number(pair[variant].id),configuration_sha256:pair[variant].configuration_sha256! });
    }
    const row=normalize((await client.query<EvaluationComparison>(`INSERT INTO mcp_evaluation_comparisons
      (name,tenant_key,workspace_key,environment,dataset_id,repetitions,order_mode,plan,plan_sha256,created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING ${publicColumns}`,
    [b.name,context.tenantKey,context.workspaceKey,context.environment,b.dataset_id,b.repetitions,b.order_mode,JSON.stringify(plan),evaluationDigest(plan),context.user.id])).rows[0]!);
    for (const step of plan) await client.query(`INSERT INTO mcp_evaluation_comparison_steps
      (comparison_id,experiment_id,position,round,variant) VALUES ($1,$2,$3,$4,$5)`,[row.id,step.experiment_id,step.position,step.round,step.variant]);
    return row;
  },id => getEvaluationComparison(pool,id,context));
}

/** Parent first, then child locks everywhere that coordinates the series. */
export async function lockEvaluationComparison(client:pg.PoolClient,id:number,context:AuthorizedWorkspaceScope) {
  await client.query('SELECT id FROM mcp_evaluation_comparisons WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 FOR UPDATE',[id,context.tenantKey,context.workspaceKey]);
  const row=await getEvaluationComparison(client,id,context);
  if (!row) missingReference();
  return row;
}
export async function lockComparisonLease(client:pg.PoolClient,id:number,token:string,context:EvaluationContext) {
  const c=await lockEvaluationComparison(client,id,context);
  const lease=(await client.query(`SELECT id FROM mcp_evaluation_comparisons WHERE id=$1 AND token=$2
    AND environment=$3 AND status='running' AND leased_until>clock_timestamp()`,[id,token,context.environment])).rows[0];
  if (!lease) throw new EvaluationError('EVALUATION_COMPARISON_FENCED','Comparison execution lease is no longer active',409);
  return c;
}

export async function stopComparisonChildren(client:pg.PoolClient,id:number) {
  // Lock children before workers to match result/cancel lock order.
  await client.query(`SELECT e.id FROM mcp_evaluation_experiments e JOIN mcp_evaluation_comparison_steps s ON s.experiment_id=e.id
    WHERE s.comparison_id=$1 AND e.status='running' ORDER BY e.id FOR UPDATE OF e`,[id]);
  await client.query(`UPDATE mcp_evaluation_workers w SET cancel_requested=true FROM mcp_evaluation_comparison_steps s
    WHERE s.comparison_id=$1 AND s.experiment_id=w.experiment_id`,[id]);
}

/** Never schedules work: process loss requires explicit operator review/resume. */
export async function recoverEvaluationComparisons(pool:pg.Pool,environment:string) {
  const candidates=(await pool.query<{ id:string; token:string; tenant_key:string; workspace_key:string }>(`SELECT id,token,tenant_key,workspace_key
    FROM mcp_evaluation_comparisons WHERE status='running' AND environment=$1 AND leased_until<clock_timestamp() ORDER BY id LIMIT 50`,[environment])).rows;
  let recovered=0;
  for (const c of candidates) {
    const scope={ environment,tenantKey:c.tenant_key,workspaceKey:c.workspace_key };
    try {
      const outcome=await executeCanonicalAuditedMutation(pool,{ name:'evaluation.comparison.recovered',eventId:c.token },scope,async client => {
        await lockEvaluationComparison(client,Number(c.id),scope);
        const row=(await client.query<EvaluationComparison>(`UPDATE mcp_evaluation_comparisons SET status='interrupted',completed_at=now(),stop_reason='EVALUATION_COMPARISON_INTERRUPTED'
          WHERE id=$1 AND token=$2 AND status='running' AND leased_until<clock_timestamp() RETURNING ${publicColumns}`,[c.id,c.token])).rows[0];
        if (!row) throw new EvaluationError('EVALUATION_LEASE_RENEWED','Comparison lease changed',409);
        await stopComparisonChildren(client,Number(c.id));
        return row;
      },row => ({ ...scope,solution:'argus.core',actor:{ type:'system',id:'evaluation-recovery',authMethod:'system',effectiveRoles:[] },
        action:'evaluation.comparison.interrupted',outcome:'failure',risk:'medium',resource:{ type:'evaluation_comparison',id:String(row.id) },
        payload:{ after:{ status:'interrupted',automatic_retry:false } } }));
      if (!outcome.replayed) recovered++;
    } catch(error) { if (!(error instanceof EvaluationError && error.code==='EVALUATION_LEASE_RENEWED')) throw error; }
  }
  return recovered;
}

export type ComparisonClaim={ id:number; token:string; position:number };
export async function authorizeComparisonChild(client:pg.PoolClient,id:number,context:EvaluationContext,retry:boolean,claim?:ComparisonClaim) {
  const member=(await client.query<{ comparison_id:string; position:number }>('SELECT comparison_id,position FROM mcp_evaluation_comparison_steps WHERE experiment_id=$1',[id])).rows[0];
  if (!member) {
    if (claim) missingReference();
    return;
  }
  const parent=await lockEvaluationComparison(client,Number(member.comparison_id),context);
  if (retry && parent.status!=='running' && !claim) return;
  if (!claim || claim.id!==parent.id || claim.position!==member.position || retry) {
    throw new EvaluationError('EVALUATION_COMPARISON_CONTROLLED','Start this experiment through its comparison; technical retries require a stopped comparison',409);
  }
  const lease=await lockComparisonLease(client,parent.id,claim.token,context);
  if (lease.cancel_requested) throw new EvaluationError('EVALUATION_CANCEL_REQUESTED','Comparison cancellation requested',409);
  const earlier=(await client.query<EvaluationExperiment>(`SELECT e.* FROM mcp_evaluation_comparison_steps s JOIN mcp_evaluation_experiments e ON e.id=s.experiment_id
    WHERE s.comparison_id=$1 AND s.position<$2 AND e.status<>'completed'`,[parent.id,claim.position])).rows;
  if (earlier.length) throw new EvaluationError('EVALUATION_COMPARISON_ORDER','Earlier comparison steps must complete first',409);
}
