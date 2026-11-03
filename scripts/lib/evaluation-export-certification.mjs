import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import * as store from '../../dist/evaluation/store.js';
import { createEvaluationComparison } from '../../dist/evaluation/comparisonStore.js';
import { evaluationDigest } from '../../dist/evaluation/contracts.js';
import { exportEvaluationComparison } from '../../dist/evaluation/export.js';

/** Real routes/PostgreSQL, synthetic answers and session ONLY; no live SSO claim. */
export async function certifyExports({ base,pool,context,ctx,agent,input,curated,prefix,requests,check }) {
  const ds=await store.createEvaluationDataset(pool,{ datasetKey:prefix+'-curated',version:1,name:'Demo · Dev / AIOps (synthetic)',agentId:agent.id },ctx());
  for (const c of curated) await store.createEvaluationCase(pool,ds.id,{ caseKey:c.case_key,input:c.input,context:c.context,expectedOutput:c.expected_output,rules:c.rules,metadata:{ evidence_kind:'fixture',domain:c.domain } },ctx());
  await store.activateEvaluationDataset(pool,ds.id,ctx());
  const comparison=await createEvaluationComparison(pool,{ ...input,dataset_id:ds.id,name:'Demo · curated A/B (synthetic)' },ctx());
  const path=base+`/api/admin/evaluations/comparisons/${comparison.id}`;
  const get=(format='json',headers={},suffix='/export/content') => fetch(path+suffix+'?format='+format,{ headers:{ 'Idempotency-Key':randomUUID(),...headers } });
  const auditCount=async() => Number((await pool.query("SELECT count(*) n FROM mcp_canonical_audit_events WHERE action='evaluation.comparison.exported' AND resource_id=$1",[String(comparison.id)])).rows[0].n);
  const beforeRequests=requests.length;
  await check('export denies local/stale/missing MFA, wrong role, foreign origin and incomplete comparisons',async() => {
    for(const format of ['json','csv','pdf']) {
      for (const mode of ['local','stale','none']) { const r=await get(format,{ 'X-Fixture-Mfa':mode });assert.equal(r.status,428);assert.equal((await r.json()).code,'MFA_STEP_UP_REQUIRED');assert.match(r.headers.get('Cache-Control'),/no-store/); }
      assert.equal((await get(format,{ 'X-Fixture-Role':'viewer' })).status,403);
      assert.equal((await get(format,{ Origin:'https://foreign.invalid' })).status,403);
      assert.equal((await get(format)).status,409);
    }
    assert.equal(await auditCount(),0);assert.equal(requests.length,beforeRequests);
  });
  await check('curated three-case comparison runs six local requests, preserving failed candidate evidence',async() => {
    const started=await fetch(path+'/run',{ method:'POST',headers:{ 'Content-Type':'application/json','Idempotency-Key':randomUUID() },body:JSON.stringify({ acknowledge_cost:true }) });
    assert.equal(started.status,202);
    let detail;
    for(let i=0;i<100;i++) { detail=await (await fetch(path)).json(); if(detail.comparison.status==='completed')break;await new Promise(r => setTimeout(r,100)); }
    assert.equal(detail.comparison.status,'completed',JSON.stringify(detail));
    assert.equal(detail.summary.comparison_state,'failed');assert.equal(requests.length-beforeRequests,6);
    assert.equal(detail.records[0].results.length,3);assert.equal(detail.records[1].results.length,3);
  });
  let document;
  await check('JSON/CSV/PDF are stable byte-verified downloads with one canonical audit per retry key',async() => {
    const key=randomUUID(),r=await get('json',{ 'Idempotency-Key':key });
    assert.equal(r.status,200,await r.clone().text());
    const bytes=Buffer.from(await r.arrayBuffer()),hash=createHash('sha256').update(bytes).digest('hex');
    assert.equal(r.headers.get('X-Argus-Artifact-Sha256'),hash);
    document=JSON.parse(bytes);assert.equal(document.payload_sha256,evaluationDigest(document.payload));assert.equal(document.payload.cases.length,3);
    assert.equal(document.payload.summary.comparison_state,'failed');
    const replay=await get('json',{ 'Idempotency-Key':key });assert.equal(replay.status,200);assert.deepEqual(Buffer.from(await replay.arrayBuffer()),bytes);
    assert.equal(replay.headers.get('X-Argus-Audit-Event-Id'),r.headers.get('X-Argus-Audit-Event-Id'));
    assert.equal(await auditCount(),1);
    assert.equal((await get('csv',{ 'Idempotency-Key':key })).status,409);assert.equal(await auditCount(),1);
    const csv=await get('csv',{},'/export');assert.equal(csv.status,200);assert.match(csv.headers.get('Content-Disposition'),/attachment; filename="argus-evaluation-/);
    const csvBytes=Buffer.from(await csv.arrayBuffer());assert.equal(csv.headers.get('X-Argus-Artifact-Sha256'),createHash('sha256').update(csvBytes).digest('hex'));
    assert.equal(csvBytes.toString().split('\r\n').filter(Boolean).length,7);assert.equal(await auditCount(),2);
    await mkdir('test-results',{ recursive:true });await writeFile('test-results/evaluation-demo.json',bytes);await writeFile('test-results/evaluation-demo.csv',csvBytes);
    const pdfKey=randomUUID(),pdf=await get('pdf',{ 'Idempotency-Key':pdfKey },'/export');
    assert.equal(pdf.status,200,await pdf.clone().text());
    assert.equal(pdf.headers.get('Content-Type'),'application/pdf');
    const pdfBytes=Buffer.from(await pdf.arrayBuffer());assert.equal(pdfBytes.subarray(0,5).toString(),'%PDF-');
    assert.equal(pdf.headers.get('X-Argus-Artifact-Sha256'),createHash('sha256').update(pdfBytes).digest('hex'));
    assert.equal(pdf.headers.get('X-Argus-Payload-Sha256'),document.payload_sha256);
    const pdfReplay=await get('pdf',{ 'Idempotency-Key':pdfKey });assert.equal(pdfReplay.status,200);
    assert.deepEqual(Buffer.from(await pdfReplay.arrayBuffer()),pdfBytes);
    assert.equal(pdfReplay.headers.get('X-Argus-Audit-Event-Id'),pdf.headers.get('X-Argus-Audit-Event-Id'));
    assert.equal(await auditCount(),3);await writeFile('test-results/evaluation-demo.pdf',pdfBytes);
  });
  await check('export rechecks access and input, never trusting a previous completed run',async() => {
    assert.equal((await get('html')).status,400);
    assert.equal((await fetch(path+'/export?format=json')).status,400);
    const fresh={ ...ctx(),user:{ ...context.user,mfa_method:'otp',mfa_verified_at:new Date().toISOString() } };
    for(const format of ['json','csv','pdf']) await assert.rejects(() => exportEvaluationComparison(pool,comparison.id,format,{ ...fresh,workspaceKey:'foreign' }),e => e.code==='EVALUATION_REFERENCE_NOT_FOUND');
    const bundle=(await pool.query("INSERT INTO mcp_service_bundles(name,label) VALUES ($1,'Revoked fixture') RETURNING id",[prefix+'-revoked'])).rows[0];
    await pool.query('UPDATE mcp_agents SET bundle_ids=$1 WHERE id=$2',[[bundle.id],agent.id]);
    try { for(const format of ['json','csv','pdf']) await assert.rejects(() => exportEvaluationComparison(pool,comparison.id,format,{ ...fresh,user:{ ...fresh.user,allowed_bundles:[] } }),e => e.status===403 || e.status===404); }
    finally { await pool.query('UPDATE mcp_agents SET bundle_ids=$1 WHERE id=$2',[[],agent.id]); }
    assert.equal(await auditCount(),3);
  });
  await check('audit persistence failure prevents artifact delivery and leaves no partial export event',async() => {
    await pool.query(`CREATE OR REPLACE FUNCTION evaluation_export_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='evaluation.comparison.exported' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER evaluation_export_fault BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION evaluation_export_fault()`);
    try { for(const format of ['json','csv','pdf']) { const failed=await get(format);assert.equal(failed.status,500);assert.equal(failed.headers.get('X-Argus-Artifact-Sha256'),null);assert.equal(await auditCount(),3); } }
    finally { await pool.query('DROP TRIGGER evaluation_export_fault ON mcp_canonical_audit_events; DROP FUNCTION evaluation_export_fault()'); }
    assert.equal(requests.length-beforeRequests,6);
  });
  return comparison;
}
