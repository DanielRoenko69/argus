import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { evaluationStarterSets } from '../../dist/evaluation/starterSets.js';
import { previewEvaluationTrace, createEvaluationCaseFromTrace, importEvaluationStarterSet } from '../../dist/evaluation/curation.js';
import { createEvaluationDataset, getEvaluationDataset, activateEvaluationDataset } from '../../dist/evaluation/store.js';

/** Caller owns an explicitly disposable *_cert DB. No model execution paths. */
export async function certifyCuration({ pool,context,check }) {
  const ctx=(extra={}) => ({ ...context,requestId:randomUUID(),...extra });
  const reject=(fn,code) => assert.rejects(fn,e => e.code===code);
  const isolated={ tenantKey:'curation-cert',workspaceKey:'curation-cert' };
  await check('starter import is atomic, scoped, draft-only and replay-safe',async() => {
    for (const set of evaluationStarterSets) {
      const body={ reviewed:true,reviewed_content_sha256:set.content_sha256 },c=ctx(isolated);
      const ds=await importEvaluationStarterSet(pool,set.key,body,c);
      assert.equal(ds.status,'draft'); assert.equal(ds.case_count,12); assert.equal(ds.agent_id,null);
      assert.equal((await importEvaluationStarterSet(pool,set.key,body,c)).id,ds.id);
      assert.equal(await getEvaluationDataset(pool,ds.id,context),null);
      const record=await getEvaluationDataset(pool,ds.id,c);
      assert.equal(record.cases.length,12); assert.ok(record.cases.every(row => row.metadata.evidence_kind==='synthetic'));
      await reject(() => importEvaluationStarterSet(pool,set.key,body,ctx(isolated)),'23505');
      await reject(() => importEvaluationStarterSet(pool,set.key,{ ...body,reviewed_content_sha256:'a'.repeat(64) },ctx()),'EVALUATION_STARTER_CHANGED');
    }
  });
  await check('starter audit failure rolls back all twelve cases and the draft',async() => {
    const set=evaluationStarterSets[0],bad=ctx({ tenantKey:'curation-rollback',workspaceKey:'curation-rollback',user:{ ...context.user,auth_method:'x'.repeat(500) } });
    await assert.rejects(() => importEvaluationStarterSet(pool,set.key,{ reviewed:true,reviewed_content_sha256:set.content_sha256 },bad));
    assert.equal((await pool.query("SELECT id FROM mcp_evaluation_datasets WHERE tenant_key='curation-rollback'")).rows.length,0);
  });
  const traceId=randomUUID(),spanId=randomUUID();
  await pool.query(`INSERT INTO mcp_observability_traces(id,root_trace_id,name,kind,status,started_at,user_id,input_preview,output_preview)
    VALUES($1,$1,'Synthetic failed CI review','agent','failed',now(),$2,$3::jsonb,$4::jsonb)`,
    [traceId,context.user.id,JSON.stringify({ task:'Review the failed Jenkins build.',password:'fixture-password' }),JSON.stringify({ answer:'Ready to merge',api_key:'fixture-key' })]);
  await pool.query(`INSERT INTO mcp_observability_spans(id,trace_id,name,kind,status,started_at,input_preview,output_preview)
    VALUES($1,$2,'Synthetic LLM judgement','llm','completed',now(),'"CI failed"','"Ready to merge"')`,[spanId,traceId]);
  const source={ trace_id:traceId,span_id:spanId },preview=await previewEvaluationTrace(pool,source,context);
  const body={ source,reviewed:true,reviewed_preview_sha256:preview.preview_sha256,case:{ case_key:'ci-failure',input:'Review CI',context:'Jenkins failed',expected_output:'Not ready to merge',
    rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_includes',value:'Not ready' }] } } };
  const draft=await createEvaluationDataset(pool,{ datasetKey:'curation-'+randomUUID(),version:1,name:'Trace curation certification' },ctx());
  await check('trace preview is redacted and scope/span-safe without creating a case',async() => {
    const p=await previewEvaluationTrace(pool,{ trace_id:traceId,span_id:null },context);
    assert.ok(!JSON.stringify(p).includes('fixture-password')); assert.ok(!JSON.stringify(p).includes('fixture-key'));
    assert.equal(p.expected_output,undefined);
    await reject(() => previewEvaluationTrace(pool,source,{ ...context,...isolated }),'EVALUATION_REFERENCE_NOT_FOUND');
    await reject(() => previewEvaluationTrace(pool,{ ...source,span_id:randomUUID() },context),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal((await getEvaluationDataset(pool,draft.id,context)).cases.length,0);
  });
  await check('trace save rechecks preview and fails closed on drift or foreign dataset',async() => {
    await reject(() => createEvaluationCaseFromTrace(pool,draft.id,{ ...body,reviewed_preview_sha256:'a'.repeat(64) },ctx()),'EVALUATION_SOURCE_CHANGED');
    const foreign=await createEvaluationDataset(pool,{ datasetKey:'foreign-'+randomUUID(),version:1,name:'Foreign' },ctx(isolated));
    await reject(() => createEvaluationCaseFromTrace(pool,foreign.id,body,ctx()),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal((await getEvaluationDataset(pool,draft.id,context)).cases.length,0);
  });
  await check('trace save is audited, preserves human expectations, and prevents concurrent duplicates',async() => {
    const c=ctx(),row=await createEvaluationCaseFromTrace(pool,draft.id,body,c);
    assert.equal((await createEvaluationCaseFromTrace(pool,draft.id,body,c)).id,row.id);
    assert.equal(row.expected_output,'Not ready to merge'); assert.equal(row.metadata.curation.reviewed_by_user_id,context.user.id);
    assert.equal(row.metadata.curation.observed_answer_is_ground_truth,false);
    const result=await Promise.allSettled([1,2].map(n => createEvaluationCaseFromTrace(pool,draft.id,{ ...body,case:{ ...body.case,case_key:'copy-'+n } },ctx())));
    assert.ok(result.every(r => r.status==='rejected' && r.reason.code==='EVALUATION_SOURCE_DUPLICATE'));
    const events=await pool.query(`SELECT event_id FROM mcp_canonical_audit_events WHERE producer_name='evaluation.case.curated' AND resource_id=$1`,[String(row.id)]);
    assert.equal(events.rows.length,1);
    assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[events.rows[0].event_id])).rows.length,1);
    await pool.query(`UPDATE mcp_observability_traces SET metadata='{"tenantKey":"hidden","workspaceKey":"hidden"}' WHERE id=$1`,[traceId]);
    await reject(() => createEvaluationCaseFromTrace(pool,draft.id,body,c),'EVALUATION_REFERENCE_NOT_FOUND');
    await pool.query("UPDATE mcp_observability_traces SET metadata='{}' WHERE id=$1",[traceId]);
  });
  await check('two first-time concurrent captures serialize to one case',async() => {
    const ds=await createEvaluationDataset(pool,{ datasetKey:'race-'+randomUUID(),version:1,name:'Race' },ctx());
    const r=await Promise.allSettled([1,2].map(n => createEvaluationCaseFromTrace(pool,ds.id,{ ...body,case:{ ...body.case,case_key:'race-'+n } },ctx())));
    assert.equal(r.filter(x => x.status==='fulfilled').length,1);
    assert.equal(r.filter(x => x.status==='rejected' && x.reason.code==='EVALUATION_SOURCE_DUPLICATE').length,1);
    assert.equal((await getEvaluationDataset(pool,ds.id,context)).cases.length,1);
  });
  await check('active datasets reject curation; audit failure rolls back a new case',async() => {
    await activateEvaluationDataset(pool,draft.id,ctx());
    await reject(() => createEvaluationCaseFromTrace(pool,draft.id,body,ctx()),'EVALUATION_DATASET_IMMUTABLE');
    const ds=await createEvaluationDataset(pool,{ datasetKey:'rollback-'+randomUUID(),version:1,name:'Rollback' },ctx());
    await assert.rejects(() => createEvaluationCaseFromTrace(pool,ds.id,body,ctx({ user:{ ...context.user,auth_method:'x'.repeat(500) } })));
    assert.equal((await getEvaluationDataset(pool,ds.id,context)).cases.length,0);
  });
  return { traceId,spanId };
}
