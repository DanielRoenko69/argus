import type pg from 'pg';
import { z } from 'zod';
import { listChatVisibleAgents } from '../agents/agentStore.js';
import { getTelemetryTrace, listTelemetryTraces, type TelemetryTraceRow } from '../observability/telemetryStore.js';
import { boundedEvaluationJson } from './snapshots.js';
import { evaluationDigest, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { mutate } from './store.js';

export const qualityReviewSchema = z.object({
  source_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  previous_review_id:z.number().int().positive().safe().nullable(),
  status:z.enum(['open','reviewed','resolved']),
  verdict:z.enum(['needs_review','confirmed_issue','acceptable']),
  note:z.string().trim().min(1).max(2000),
}).strict().refine(b => b.status==='open' || b.verdict!=='needs_review', {
  message:'Reviewed or resolved items need a human verdict',path:['verdict'],
});
type Db = pg.Pool;
export interface QualityReview {
  id:number; trace_id:string; source_sha256:string;
  status:'open'|'reviewed'|'resolved'; verdict:'needs_review'|'confirmed_issue'|'acceptable';
  note:string; reviewer_user_id:number; previous_review_id:number|null; created_at:string;
}
export interface QualityItem {
  trace_id:string; name:string; agent:string|null; model:string|null; started_at:string;
  run_status:string; source_sha256:string; status:QualityReview['status']; review_stale:boolean;
  signals:{ failed_run:boolean; human_feedback:number; evaluation_failures:number; evaluation_errors:number };
  review:QualityReview|null;
  evaluation_experiment_id:number|null;
}
const access = (c:EvaluationContext) => ({ ...c,userId:c.user.id,observeAll:true,allowedBundleIds:c.user.allowed_bundles });
const scope = (c:EvaluationContext) => [c.tenantKey,c.workspaceKey];
const reviewColumns = 'id,trace_id,source_sha256,status,verdict,note,reviewer_user_id,previous_review_id,created_at';
function mapReview(row:QualityReview):QualityReview {
  return { ...row,id:Number(row.id),previous_review_id:row.previous_review_id==null ? null : Number(row.previous_review_id),
    note:String(boundedEvaluationJson(row.note,12000,'review note')) };
}

async function project(pool:Db,traces:TelemetryTraceRow[],context:EvaluationContext):Promise<QualityItem[]> {
  if (!traces.length) return [];
  const ids=traces.map(t => t.id);
  // One batched policy resolution, not one Agent/feedback query per card.
  const agents=context.tenantKey==='default' && context.workspaceKey==='default'
    ? (await listChatVisibleAgents(pool,context.user)).map(a => a.id) : [];
  const feedback=(await pool.query(`SELECT trace_id,count(*)::int AS count,
    encode(sha256(convert_to(jsonb_agg(jsonb_build_array(id,span_id,label,score,sentiment,tags,updated_at) ORDER BY id)::text,'UTF8')),'hex') AS digest
    FROM mcp_observability_feedback WHERE trace_id=ANY($1::uuid[]) AND active AND source='human'
      AND (sentiment IN ('negative','mixed') OR tags && ARRAY['needs-review','hallucination','unsafe','incomplete'])
    GROUP BY trace_id`,[ids])).rows;
  const results=(await pool.query(`SELECT r.trace_id,
    min(r.experiment_id)::text AS experiment_id,
    count(*) FILTER (WHERE r.status='failed')::int AS failures,
    count(*) FILTER (WHERE r.status='error')::int AS errors,
    encode(sha256(convert_to(jsonb_agg(jsonb_build_array(r.id,r.status,r.attempt) ORDER BY r.id)::text,'UTF8')),'hex') AS digest
    FROM mcp_evaluation_results r JOIN mcp_evaluation_experiments e ON e.id=r.experiment_id
    JOIN mcp_evaluation_datasets d ON d.id=e.dataset_id
    WHERE r.trace_id=ANY($1::uuid[]) AND r.status IN ('failed','error') AND e.evidence_kind='frozen_v1'
      AND e.tenant_key=$2 AND e.workspace_key=$3 AND d.tenant_key=$2 AND d.workspace_key=$3
      AND e.agent_id=ANY($4::int[])
      AND ($5::int[] IS NULL OR (d.bundle_ids <@ $5::int[]
        AND e.configuration_snapshot->'agent'->'bundle_ids' <@ to_jsonb($5::int[])))
      AND NOT EXISTS (SELECT 1 FROM mcp_evaluation_results later
        WHERE later.experiment_id=r.experiment_id AND later.case_id=r.case_id AND later.attempt>r.attempt)
    GROUP BY r.trace_id`,[ids,...scope(context),agents,context.user.allowed_bundles ?? null])).rows;
  const reviews=(await pool.query<QualityReview>(`SELECT DISTINCT ON (trace_id) ${reviewColumns}
    FROM mcp_quality_reviews WHERE trace_id=ANY($1::uuid[]) AND tenant_key=$2 AND workspace_key=$3
    ORDER BY trace_id,id DESC`,[ids,...scope(context)])).rows;
  const f=new Map(feedback.map(r => [r.trace_id,r])),e=new Map(results.map(r => [r.trace_id,r]));
  const history=new Map(reviews.map(r => [r.trace_id,mapReview(r)]));
  return traces.map(t => {
    const human=f.get(t.id),evaluation=e.get(t.id),review=history.get(t.id) ?? null;
    const signals={ failed_run:t.status==='failed',human_feedback:Number(human?.count ?? 0),
      evaluation_failures:Number(evaluation?.failures ?? 0),evaluation_errors:Number(evaluation?.errors ?? 0) };
    // Digest binds the reviewed content, not mutable UI state. Raw inputs never leave this projection.
    const digest=evaluationDigest({ trace:t.id,status:t.status,input:t.input_preview,output:t.output_preview,
      error:t.error_message,model:t.model,agent:t.agent_id,feedback:human?.digest ?? null,evaluation:evaluation?.digest ?? null });
    const stale=!!review && review.source_sha256!==digest;
    const safe=(v:string|null) => v==null ? null : String(boundedEvaluationJson(v.slice(0,512),4096,'trace label'));
    return { trace_id:t.id,name:safe(t.name)!,agent:safe(t.agent_name ?? null),model:safe(t.model),started_at:t.started_at,
      run_status:t.status,source_sha256:digest,status:stale ? 'open' as const : review?.status ?? 'open' as const,
      review_stale:stale,signals,review,evaluation_experiment_id:evaluation ? Number(evaluation.experiment_id) : null };
  });
}

export async function listQualityQueue(pool:Db,context:EvaluationContext) {
  // A bounded, disclosed observation window. No background materialization or model call.
  const traces=await listTelemetryTraces(pool,{ ...access(context),hours:24*30,limit:500,qualityCandidates:true });
  const items=(await project(pool,traces,context)).filter(t => Object.values(t.signals).some(Boolean));
  return { items,window_days:30,candidate_limit:500,possibly_truncated:traces.length===500 };
}
export async function getQualityItem(pool:Db,traceId:string,context:EvaluationContext) {
  const record=await getTelemetryTrace(pool,traceId,access(context));
  if (!record || record.trace.id!==traceId) missingReference();
  return (await project(pool,[record.trace],context))[0]!;
}
export async function getQualityReviewHistory(pool:Db,traceId:string,context:EvaluationContext) {
  const item=await getQualityItem(pool,traceId,context);
  const history=(await pool.query<QualityReview>(`SELECT ${reviewColumns} FROM mcp_quality_reviews
    WHERE trace_id=$1 AND tenant_key=$2 AND workspace_key=$3 ORDER BY id DESC LIMIT 21`,[traceId,...scope(context)])).rows;
  return { item,history:history.slice(0,20).map(mapReview),history_truncated:history.length>20 };
}
export async function saveQualityReview(pool:Db,traceId:string,raw:unknown,context:EvaluationContext) {
  const body=qualityReviewSchema.parse(raw);
  if (!context.requestId) throw new EvaluationError('EVALUATION_IDEMPOTENCY_REQUIRED','Use a stable Idempotency-Key');
  // Re-authorize even when the audited mutation returns a prior idempotent result.
  await getQualityItem(pool,traceId,context);
  return mutate(pool,context,'review.saved',{ traceId,...body },async client => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`quality:${context.tenantKey}:${context.workspaceKey}:${traceId}`]);
    await client.query('SELECT id FROM mcp_observability_traces WHERE id=$1 FOR UPDATE',[traceId]);
    await client.query('SELECT id FROM mcp_observability_feedback WHERE trace_id=$1 FOR SHARE',[traceId]);
    const item=await getQualityItem(client as unknown as Db,traceId,context);
    if (item.source_sha256!==body.source_sha256 || (item.review?.id ?? null)!==body.previous_review_id) {
      throw new EvaluationError('QUALITY_REVIEW_STALE','Evidence or review changed. Refresh and review again.',409);
    }
    const note=String(boundedEvaluationJson(body.note,12000,'review note'));
    const row=(await client.query<QualityReview>(`INSERT INTO mcp_quality_reviews
      (tenant_key,workspace_key,trace_id,source_sha256,status,verdict,note,reviewer_user_id,previous_review_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${reviewColumns}`,
    [...scope(context),traceId,body.source_sha256,body.status,body.verdict,note,context.user.id,body.previous_review_id])).rows[0]!;
    return mapReview(row);
  },async id => {
    const row=(await pool.query<QualityReview>(`SELECT ${reviewColumns} FROM mcp_quality_reviews
      WHERE id=$1 AND trace_id=$2 AND tenant_key=$3 AND workspace_key=$4`,[id,traceId,...scope(context)])).rows[0];
    return row ? mapReview(row) : null;
  });
}
