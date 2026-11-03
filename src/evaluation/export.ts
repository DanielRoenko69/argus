import { createHash } from 'node:crypto';
import type pg from 'pg';
import { appendCanonicalAuditEvent } from '../audit/canonicalAuditStore.js';
import { hasFreshMfaSession } from '../auth/userAuth.js';
import { hasRole } from '../auth/roles.js';
import { getTelemetryTrace } from '../observability/telemetryStore.js';
import { evaluationDigest, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { getEvaluationComparisonDetail, getEvaluationComparison, requireEvaluationRequestId } from './comparisonStore.js';
import { datasetContentDigest, evaluationCaseContent, getEvaluationDataset } from './store.js';
import { assertEvaluationAgent, boundedEvaluationJson } from './snapshots.js';
import { summarizeEvaluationComparison } from './regression.js';
import { evaluationComparisonPdf } from './pdf.js';

export const EVALUATION_EXPORT_SCHEMA='argus.evaluation.comparison-export.v1';
export const MAX_EVALUATION_EXPORT_BYTES=16*1024*1024;
export type EvaluationExportFormat='json'|'csv'|'pdf';
type Detail=NonNullable<Awaited<ReturnType<typeof getEvaluationComparisonDetail>>>;
type Dataset=NonNullable<Awaited<ReturnType<typeof getEvaluationDataset>>>;
const sha=(data:Buffer) => createHash('sha256').update(data).digest('hex');
const object=(value:unknown) => (value ?? {}) as Record<string,unknown>;
const integrity=() => { throw new EvaluationError('EVALUATION_EXPORT_INTEGRITY','Frozen comparison evidence failed verification',409); };
const tooLarge=() => { throw new EvaluationError('EVALUATION_EXPORT_TOO_LARGE','Export exceeds the 16 MiB limit; use a smaller comparison. No partial artifact was exported.',413); };
const allowedBundles=(ids:unknown,context:EvaluationContext) => {
  if (ids===null && context.user.allowed_bundles==null) return;
  if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || context.user.allowed_bundles && !context.user.allowed_bundles.includes(id))) missingReference();
};

/** Quoting alone does not stop spreadsheet formula execution. Protect every cell. */
export function evaluationCsvCell(value:unknown):string {
  let text=value==null ? '' : typeof value==='object' ? JSON.stringify(value) : String(value);
  if (/^[\s\uFEFF\x00-\x1f]*[=+\-@]/u.test(text) || /^[\t\r\n]/.test(text)) text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}

export function buildEvaluationExport(detail:Detail,record:Dataset) {
  const { comparison,records }=detail,{ dataset,cases }=record;
  if (comparison.status!=='completed') throw new EvaluationError('EVALUATION_EXPORT_NOT_COMPLETE','Complete the comparison before exporting final evidence.',409);
  if (evaluationDigest(comparison.plan)!==comparison.plan_sha256 || datasetContentDigest(cases)!==dataset.content_sha256
      || dataset.id!==comparison.dataset_id || dataset.contract_version!==1) integrity();
  for (const row of records) {
    const e=row.experiment;
    if (e.comparison_id!==comparison.id || e.dataset_id!==dataset.id || e.dataset_sha256!==dataset.content_sha256
        || evaluationDigest(e.configuration_snapshot)!==e.configuration_sha256
        || evaluationDigest(e.configuration_snapshot?.['evaluator'])!==e.evaluator_sha256
        || evaluationDigest(e.expected_cases)!==evaluationDigest(cases.map(c => ({ id:c.id,case_key:c.case_key,sha256:evaluationDigest(evaluationCaseContent(c)) })))) integrity();
  }
  const summary=summarizeEvaluationComparison(comparison,records);
  if (!['passed','failed'].includes(summary.comparison_state)) integrity();
  // Public frozen snapshots are already allowlisted at creation. Force redaction
  // again for exports; distinguish source digests from the redacted projection.
  const source={ comparison, dataset:{ id:dataset.id,dataset_key:dataset.dataset_key,version:dataset.version,name:dataset.name,
      description:dataset.description,content_sha256:dataset.content_sha256,contract_version:dataset.contract_version },
    cases:cases.map(c => ({ id:c.id,...evaluationCaseContent(c),source_trace_id:c.source_trace_id,source_span_id:c.source_span_id })),
    experiments:records.map(r => ({ position:r.position,round:r.round,variant:r.variant,
      experiment:{ id:r.experiment.id,agent_id:r.experiment.agent_id,model_ref:r.experiment.model_ref,status:r.experiment.status,
        baseline_experiment_id:r.experiment.baseline_experiment_id,created_at:r.experiment.created_at,started_at:r.experiment.started_at,completed_at:r.experiment.completed_at,
        dataset_sha256:r.experiment.dataset_sha256,configuration_sha256:r.experiment.configuration_sha256,evaluator_sha256:r.experiment.evaluator_sha256,
        expected_cases:r.experiment.expected_cases,configuration_snapshot:r.experiment.configuration_snapshot },
      attempts:r.attempts ?? [],results:r.results.map(v => ({ id:v.id,case_id:v.case_id,attempt:v.attempt,status:v.status,trace_id:v.trace_id,
        output:v.output_redacted,scores:v.scores,latency_ms:v.latency_ms,input_tokens:v.input_tokens,output_tokens:v.output_tokens,
        cost_usd:v.cost_usd,evaluator_version:v.evaluator_version,evidence:v.evidence,error_message:v.error_message,created_at:v.created_at })) })),
    summary,
    evidence_refs:{ comparison_path:`/build/evaluations?comparison=${comparison.id}`,
      audit_query:`/api/ui/audit/evidence/v1?resource_type=evaluation_comparison&resource_id=${comparison.id}`,
      reports_path:'/observe/audit?tab=reports',audit_filter:{ resourceType:'evaluation_comparison',resourceId:String(comparison.id) } },
    limitations:['Answer-only isolated reference evaluation; no proof of real-world tool/task completion.',
      'All rounds and all historical attempts are retained. Missing usage/cost remains unknown; catalog estimates are not invoices.',
      'No statistical significance, general model superiority or legal compliance certification is established.',
      'Source hashes identify retained evidence. Export redaction can change projected content; payload_sha256 verifies this projection only.',
      'Unsigned export: a hash detects corruption, not authenticity. No WORM, trusted timestamp or signing claim. Audit/Evidence reports are separate.',
      'CSV is a flattened attempt table; JSON is the complete redacted configuration and case manifest.'] };
  if (Buffer.byteLength(JSON.stringify(source))>MAX_EVALUATION_EXPORT_BYTES) tooLarge();
  const payload=boundedEvaluationJson(source,MAX_EVALUATION_EXPORT_BYTES,'comparison export') as typeof source;
  return { schema_version:EVALUATION_EXPORT_SCHEMA,payload_sha256:evaluationDigest(payload),payload };
}
export type EvaluationExport=ReturnType<typeof buildEvaluationExport>;

export function serializeEvaluationExport(document:EvaluationExport,format:'json'|'csv') {
  if (format==='json') return Buffer.from(JSON.stringify(document,null,2)+'\n','utf8');
  const p=document.payload;
  const columns=['schema_version','payload_sha256','comparison_id','comparison_name','gate','plan_sha256','dataset_id','dataset_version','dataset_sha256',
    'round','variant','experiment_id','agent_id','requested_model','effective_model','configuration_sha256','evaluator_sha256',
    'case_id','case_key','task','reference_context','reviewer_reference','criteria','attempt','status','output','score','latency_ms',
    'input_tokens','output_tokens','cost_usd','usage_source','cost_source','judgement','trace_id','trace_path','error'];
  const rows:string[]=[columns.map(evaluationCsvCell).join(',')];
  const add=(row:unknown[]) => rows.push(row.map(evaluationCsvCell).join(','));
  for (const r of p.experiments) for (const c of p.cases) {
    const numbers=[...new Set([...r.results.filter(v => v.case_id===c.id).map(v => v.attempt),...r.attempts.filter(v => v.case_id===c.id).map(v => v.attempt)])].sort((a,b) => a-b);
    for (const attempt of numbers) {
      const v=r.results.find(v => v.case_id===c.id && v.attempt===attempt),start=r.attempts.find(a => a.case_id===c.id && a.attempt===attempt);
      const measurements=object(v?.evidence?.['measurements']),trace=v?.trace_id ?? start?.trace_id;
      add([document.schema_version,document.payload_sha256,p.comparison.id,p.comparison.name,p.summary.comparison_state,p.comparison.plan_sha256,p.dataset.id,p.dataset.version,p.dataset.content_sha256,
        r.round,r.variant,r.experiment.id,r.experiment.agent_id,r.experiment.model_ref,object(r.experiment.configuration_snapshot?.['execution'])['effective_model'],r.experiment.configuration_sha256,r.experiment.evaluator_sha256,
        c.id,c.case_key,c.input,c.context,c.expected_output,c.rules,attempt,v?.status ?? 'unresolved',v?.output,v?.scores['overall'],v?.latency_ms,
        v?.input_tokens,v?.output_tokens,v?.cost_usd,measurements['usage_source'] ?? 'unknown',measurements['cost_source'] ?? 'unknown',v?.evidence?.['judgement'],trace,trace ? `/observe/logs?trace=${encodeURIComponent(trace)}` : null,v?.error_message]);
    }
  }
  return Buffer.from('\uFEFF'+rows.join('\r\n')+'\r\n','utf8');
}

/** Audit commits before any bytes are delivered. Replays still recheck access. */
export async function exportEvaluationComparison(pool:pg.Pool,id:number,format:EvaluationExportFormat,context:EvaluationContext,mfaMaxAge=600) {
  if (!['json','csv','pdf'].includes(format)) throw new EvaluationError('EVALUATION_INVALID','Choose json, csv or pdf');
  if (!hasRole(context.user.role,'platform_admin')) throw new EvaluationError('FORBIDDEN','Platform admin access required',403);
  if (!hasFreshMfaSession(context.user,mfaMaxAge)) throw new EvaluationError('MFA_STEP_UP_REQUIRED','Fresh provider-verified MFA is required for evidence export',428);
  requireEvaluationRequestId(context);
  const client=await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await client.query("SET LOCAL statement_timeout='10s'");
    const comparison=await getEvaluationComparison(client,id,context);
    if (!comparison) missingReference();
    if (comparison.status!=='completed') throw new EvaluationError('EVALUATION_EXPORT_NOT_COMPLETE','Complete the comparison before exporting final evidence.',409);
    if (!comparison.plan.length || comparison.plan.length>20) integrity();
    const ids=comparison.plan.map(s => s.experiment_id);
    // Bound decoded content BEFORE loading rows into Node; compressed storage size is not sufficient.
    const size=(await client.query(`SELECT
      (SELECT coalesce(sum(octet_length(to_jsonb(e)::text)),0) FROM mcp_evaluation_experiments e WHERE id=ANY($1::int[]))+
      (SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0) FROM mcp_evaluation_results r WHERE experiment_id=ANY($1::int[]))+
      (SELECT coalesce(sum(octet_length(to_jsonb(a)::text)),0) FROM mcp_evaluation_attempts a WHERE experiment_id=ANY($1::int[]))+
      (SELECT coalesce(sum(octet_length(to_jsonb(c)::text)),0) FROM mcp_evaluation_cases c WHERE dataset_id=$2) AS bytes`,[ids,comparison.dataset_id])).rows[0];
    if (Number(size.bytes)>MAX_EVALUATION_EXPORT_BYTES) tooLarge();
    const detail=await getEvaluationComparisonDetail(client,id,context),record=await getEvaluationDataset(client,comparison.dataset_id,context);
    if (!detail || !record) missingReference();
    allowedBundles(record.dataset.bundle_ids,context);
    for (const row of detail.records) {
      if (!row.experiment.agent_id) missingReference();
      await assertEvaluationAgent(client,row.experiment.agent_id,context);
      allowedBundles(object(row.experiment.configuration_snapshot?.['agent'])['bundle_ids'],context);
    }
    for (const trace of new Set(record.cases.map(c => c.source_trace_id).filter((id):id is string => !!id))) {
      if (!await getTelemetryTrace(client as unknown as pg.Pool,trace,{ userId:context.user.id,observeAll:true,allowedBundleIds:context.user.allowed_bundles,...context })) missingReference();
    }
    const document=buildEvaluationExport(detail,record);
    const bytes=format==='pdf' ? await evaluationComparisonPdf(document) : serializeEvaluationExport(document,format);
    if (bytes.length>MAX_EVALUATION_EXPORT_BYTES) tooLarge();
    const artifactSha256=sha(bytes),binding=evaluationDigest({ id,format,schema:EVALUATION_EXPORT_SCHEMA,artifact_sha256:artifactSha256 });
    const event=await appendCanonicalAuditEvent(client,{ producer:{ name:'evaluation.comparison.exported',eventId:evaluationDigest({ actor:context.user.id,key:context.requestId }) },
      environment:context.environment,workspaceKey:context.workspaceKey,tenantKey:context.tenantKey,solution:'argus.core',
      actor:{ type:'human',id:String(context.user.id),authMethod:context.user.auth_method!,effectiveRoles:[context.user.role] },
      action:'evaluation.comparison.exported',outcome:'success',risk:'high',resource:{ type:'evaluation_comparison',id:String(id),revision:binding },
      correlation:{ requestId:context.requestId },payload:{ context:{ format,schema:EVALUATION_EXPORT_SCHEMA,artifact_sha256:artifactSha256,payload_sha256:document.payload_sha256,
        dataset_sha256:record.dataset.content_sha256,plan_sha256:comparison.plan_sha256,byte_count:bytes.length,delivery:'prepared_not_client_receipt',
        mfa_verified_at:context.user.mfa_verified_at,mfa_method:context.user.mfa_method,mfa_max_age_seconds:mfaMaxAge } } });
    if (event.resource.revision!==binding) throw new EvaluationError('EVALUATION_IDEMPOTENCY_CONFLICT','This export key was already used for another artifact',409);
    await client.query('COMMIT');
    return { bytes,artifactSha256,payloadSha256:document.payload_sha256,auditEventId:event.eventId,
      filename:`argus-evaluation-${id}-${artifactSha256.slice(0,12)}.${format}`,contentType:format==='pdf' ? 'application/pdf' : format==='json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8' };
  } catch(error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}
