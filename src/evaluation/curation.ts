import type pg from 'pg';
import { z } from 'zod';
import { getTelemetryTrace } from '../observability/telemetryStore.js';
import { missingReference, type EvaluationContext } from './context.js';
import { createCaseSchema, evaluationDigest, EvaluationError } from './contracts.js';
import { boundedEvaluationJson } from './snapshots.js';
import { getEvaluationDataset, insertEvaluationCase, lockDataset, mutate, requireDraft, type CreateCaseInput, type EvaluationDataset } from './store.js';
import { evaluationStarterSets } from './starterSets.js';

export const traceSourceSchema=z.object({ trace_id:z.string().uuid(),span_id:z.string().uuid().nullable().default(null) }).strict();
export const traceCaseSchema=z.object({
  source:traceSourceSchema,reviewed_preview_sha256:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.literal(true),
  case:createCaseSchema.omit({ source_trace_id:true,source_span_id:true,metadata:true }),
}).strict();
export const starterImportSchema=z.object({ reviewed_content_sha256:z.string().regex(/^[a-f0-9]{64}$/),reviewed:z.literal(true) }).strict();

export async function previewEvaluationTrace(pool:pg.Pool,source:z.infer<typeof traceSourceSchema>,context:EvaluationContext) {
  const record=await getTelemetryTrace(pool,source.trace_id,{ ...context,userId:context.user.id,observeAll:true,allowedBundleIds:context.user.allowed_bundles });
  if (!record || record.trace.id!==source.trace_id) missingReference();
  const entity=source.span_id ? record.spans.find(s => s.id===source.span_id) : record.trace;
  if (!entity) missingReference();
  // No wholesale metadata, credentials, headers or unrelated spans. Never infer ground truth.
  const content={ source:{ trace_id:record.trace.id,span_id:source.span_id },
    name:boundedEvaluationJson(entity.name,1024,'source name'),status:entity.status,
    input:boundedEvaluationJson(entity.input_preview,32768,'trace input'),
    observed_output:boundedEvaluationJson(entity.output_preview,32768,'observed output') };
  return { ...content,preview_sha256:evaluationDigest(content),
    warning:'Recorded previews may be incomplete. Redaction is best-effort: remove personal or confidential data manually. The observed output is NOT an expected answer. No tools or live retrieval will run in the evaluation.' };
}

function requireKey(context:EvaluationContext) {
  if (!context.requestId) throw new EvaluationError('EVALUATION_IDEMPOTENCY_REQUIRED','Use a stable Idempotency-Key for this import');
}
export async function createEvaluationCaseFromTrace(pool:pg.Pool,datasetId:number,body:z.infer<typeof traceCaseSchema>,context:EvaluationContext) {
  requireKey(context);
  const checkPreview=async (db:pg.Pool) => {
    const preview=await previewEvaluationTrace(db,body.source,context);
    if (preview.preview_sha256!==body.reviewed_preview_sha256) throw new EvaluationError('EVALUATION_SOURCE_CHANGED','Trace evidence changed. Reopen and review a fresh preview before saving.',409);
  };
  // Replays must re-authorize current evidence, not just reload a previously saved case.
  await checkPreview(pool);
  const input:CreateCaseInput={ caseKey:body.case.case_key,input:body.case.input,expectedOutput:body.case.expected_output,
    context:body.case.context,rules:body.case.rules,sourceTraceId:body.source.trace_id,sourceSpanId:body.source.span_id,
    metadata:{ curation:{ version:1,origin:'trace_review',preview_sha256:body.reviewed_preview_sha256,
      reviewed_by_user_id:context.user.id,expected_answer_origin:'human_authored',observed_answer_is_ground_truth:false } } };
  return mutate(pool,context,'case.curated',{ datasetId,...input },async client => {
    requireDraft(await lockDataset(client,datasetId,context));
    // Bind the checked preview to stable rows through the case/audit commit.
    await client.query('SELECT id FROM mcp_observability_traces WHERE id=$1 FOR SHARE',[body.source.trace_id]);
    if (body.source.span_id) await client.query('SELECT id FROM mcp_observability_spans WHERE id=$1 AND trace_id=$2 FOR SHARE',[body.source.span_id,body.source.trace_id]);
    await checkPreview(client as unknown as pg.Pool);
    const duplicate=await client.query(`SELECT id FROM mcp_evaluation_cases WHERE dataset_id=$1 AND source_trace_id=$2
      AND source_span_id IS NOT DISTINCT FROM $3::uuid LIMIT 1`,[datasetId,body.source.trace_id,body.source.span_id]);
    if (duplicate.rows.length) throw new EvaluationError('EVALUATION_SOURCE_DUPLICATE','This trace/span is already in this test set. Open the existing case or choose another draft.',409);
    return insertEvaluationCase(client,datasetId,input,context);
  },async id => (await getEvaluationDataset(pool,datasetId,context))?.cases.find(c => c.id===id) ?? null);
}

export async function importEvaluationStarterSet(pool:pg.Pool,key:string,body:z.infer<typeof starterImportSchema>,context:EvaluationContext) {
  requireKey(context);
  const preset=evaluationStarterSets.find(p => p.key===key);
  if (!preset) missingReference();
  if (preset.content_sha256!==body.reviewed_content_sha256) throw new EvaluationError('EVALUATION_STARTER_CHANGED','Refresh and review the starter set before importing.',409);
  return mutate(pool,context,'dataset.starter_imported',{ key,version:preset.version,sha256:preset.content_sha256 },async client => {
    // One transaction for the draft, all cases and audit/outbox. Never auto-activate or run.
    const dataset=(await client.query<EvaluationDataset>(`INSERT INTO mcp_evaluation_datasets
      (dataset_key,version,name,description,bundle_ids,created_by_user_id,tenant_key,workspace_key,contract_version)
      VALUES ($1,$2,$3,$4,'{}',$5,$6,$7,1) RETURNING *`,
    [preset.key,preset.version,preset.name,preset.description,context.user.id,context.tenantKey,context.workspaceKey])).rows[0]!;
    for (const c of preset.cases) await insertEvaluationCase(client,Number(dataset.id),c,context);
    return (await getEvaluationDataset(client,Number(dataset.id),context))!.dataset;
  },async id => (await getEvaluationDataset(pool,id,context))?.dataset ?? null);
}
