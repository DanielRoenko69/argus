#!/usr/bin/env node
// Provider-free gate. Requires an explicitly disposable, already migrated DB.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import pg from 'pg';
import express from 'express';
import { registerEvaluationRoutes } from '../dist/evaluation/routes.js';
import * as store from '../dist/evaluation/store.js';
import { evaluationDigest } from '../dist/evaluation/contracts.js';

const url=process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_cert')) throw new Error('Set EVALUATION_CERTIFICATION_DATABASE_URL to an explicitly disposable *_cert database');
const pool=new pg.Pool({ connectionString:url,max:8,connectionTimeoutMillis:10000 });
const checks=[];
const prefix='eval-cert-'+randomUUID();
const check=async(name,run) => { await run(); checks.push({ name,status:'passed' }); };
const rejects=(fn,code) => assert.rejects(fn,error => error.code===code);
let server;
try {
  await check('migration upgrades populated legacy data without inventing provenance',async() => {
    const schema='eval_upgrade_'+randomUUID().replaceAll('-','');
    const client=await pool.connect();
    try {
      await client.query('CREATE SCHEMA '+schema);
      await client.query('SET search_path TO '+schema);
      await client.query(`CREATE TABLE mcp_users(id INTEGER PRIMARY KEY); CREATE TABLE mcp_agents(id INTEGER PRIMARY KEY);
        CREATE TABLE mcp_observability_traces(id UUID PRIMARY KEY); CREATE TABLE mcp_observability_spans(id UUID PRIMARY KEY);`);
      await client.query(await readFile('db/migrations/160_native_evaluation_datasets.sql','utf8'));
      const ds=(await client.query(`INSERT INTO mcp_evaluation_datasets(dataset_key,version,name,status) VALUES('legacy',1,'Legacy','active') RETURNING id`)).rows[0];
      const c=(await client.query(`INSERT INTO mcp_evaluation_cases(dataset_id,case_key,input_redacted,input_sha256) VALUES($1,'legacy','"input"',$2) RETURNING id`,[ds.id,'a'.repeat(64)])).rows[0];
      const e=(await client.query(`INSERT INTO mcp_evaluation_experiments(dataset_id,model_ref,status) VALUES($1,'old-model','completed') RETURNING id`,[ds.id])).rows[0];
      await client.query(`INSERT INTO mcp_evaluation_results(experiment_id,case_id,status,scores) VALUES($1,$2,'passed','{"non_empty":1}')`,[e.id,c.id]);
      await client.query(await readFile('db/migrations/258_evaluation_frozen_scope.sql','utf8'));
      await client.query(await readFile('db/migrations/259_evaluation_result_evidence.sql','utf8'));
      await client.query(await readFile('db/migrations/260_evaluation_recovery.sql','utf8'));
      await client.query(await readFile('db/migrations/261_evaluation_comparisons.sql','utf8'));
      const legacy=await store.getEvaluationExperiment(client,Number(e.id),{ tenantKey:'default',workspaceKey:'default' });
      assert.equal(legacy.experiment.evidence_kind,'legacy_smoke');
      assert.equal(legacy.experiment.configuration_snapshot,null);
      assert.equal(legacy.experiment.dataset_sha256,null);
      assert.equal(legacy.results[0].scores.non_empty,1);
      const frozen=await store.getEvaluationDataset(client,Number(ds.id),{ tenantKey:'default',workspaceKey:'default' });
      assert.equal(frozen.dataset.contract_version,0);
      assert.equal(frozen.dataset.content_sha256,null);
    } finally { await client.query('SET search_path TO public'); client.release(); }
  });
  const user=(await pool.query(`INSERT INTO mcp_users (username,display_name,password_hash,role) VALUES ($1,'Evaluation fixture','not-an-auth-credential','platform_admin') RETURNING id`,[prefix])).rows[0];
  const context={ user:{ id:user.id,username:prefix,display_name:'Fixture',role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' },
    tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'' };
  const other={ ...context,tenantKey:'other',workspaceKey:'other',user:{ ...context.user,workspace_scopes:[{ tenantKey:'other',workspaceKey:'other',isDefault:true }] } };
  const agent=(await pool.query(`INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES($1,'Evaluation fixture','fixture-model','Review the fixture only.') RETURNING id`,[prefix])).rows[0];
  const provider=(await pool.query(`INSERT INTO mcp_llm_providers(name,label,provider_type,base_url,auth_type) VALUES($1,'Fixture','openai-compatible','http://127.0.0.1:1/v1','none') RETURNING id`,[prefix])).rows[0];
  await pool.query(`INSERT INTO mcp_models(model_name,provider,provider_id,upstream_model_name) VALUES($1,'openai-compatible',$2,'fixture-upstream')`,[prefix,provider.id]);
  const newDataset=async(suffix,ctx=context) => store.createEvaluationDataset(pool,{ datasetKey:prefix+suffix,version:1,name:'Fixture dataset' },ctx);
  const caseInput={ caseKey:'case-a',input:'Review null input.',expectedOutput:'null guard',context:{ synthetic:true },
    rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_includes',value:'null' }] } };
  const dataset=await newDataset('-main');
  await check('canonical audit is atomic and same-key replay does not duplicate',async() => {
    const ctx={ ...context,requestId:'fixture-replay-key' };
    const a=await store.createEvaluationCase(pool,dataset.id,caseInput,ctx);
    const b=await store.createEvaluationCase(pool,dataset.id,caseInput,ctx);
    assert.equal(a.id,b.id);
    await rejects(()=>store.createEvaluationCase(pool,dataset.id,{ ...caseInput,caseKey:'conflicting-replay' },ctx),'EVALUATION_IDEMPOTENCY_CONFLICT');
    const events=await pool.query(`SELECT event_id FROM mcp_canonical_audit_events WHERE producer_name='evaluation.case.created' AND actor_id=$1`,[String(user.id)]);
    assert.equal(events.rows.length,1);
    const outbox=await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[events.rows[0].event_id]);
    assert.equal(outbox.rows.length,1);
  });
  await check('activation hashes cases and rejects later API/direct-SQL changes',async() => {
    const frozen=await store.activateEvaluationDataset(pool,dataset.id,context);
    const record=await store.getEvaluationDataset(pool,dataset.id,context);
    assert.equal(frozen.content_sha256,store.datasetContentDigest(record.cases));
    await rejects(()=>store.createEvaluationCase(pool,dataset.id,{ ...caseInput,caseKey:'later' },context),'EVALUATION_DATASET_IMMUTABLE');
    await rejects(()=>pool.query("UPDATE mcp_evaluation_cases SET expected_output='\"changed\"' WHERE dataset_id=$1",[dataset.id]),'23514');
    await rejects(()=>pool.query("UPDATE mcp_evaluation_datasets SET status='draft' WHERE id=$1",[dataset.id]),'23514');
    await rejects(()=>pool.query("DELETE FROM mcp_evaluation_cases WHERE dataset_id=$1",[dataset.id]),'23514');
  });
  await check('concurrent activation/case insertion always preserves the frozen digest',async() => {
    for(let i=0;i<5;i++) {
      const ds=await newDataset('-race-'+i);
      await store.createEvaluationCase(pool,ds.id,caseInput,context);
      const insertFirst=i%2===1 ? store.createEvaluationCase(pool,ds.id,{ ...caseInput,caseKey:'racing-case' },context) : null;
      const outcomes=await Promise.allSettled([
        store.activateEvaluationDataset(pool,ds.id,context),
        insertFirst ?? store.createEvaluationCase(pool,ds.id,{ ...caseInput,caseKey:'racing-case' },context),
      ]);
      assert.equal(outcomes[0].status,'fulfilled');
      if(outcomes[1].status==='rejected') assert.equal(outcomes[1].reason.code,'EVALUATION_DATASET_IMMUTABLE');
      const record=await store.getEvaluationDataset(pool,ds.id,context);
      assert.equal(record.dataset.case_count,record.cases.length);
      assert.equal(record.dataset.content_sha256,store.datasetContentDigest(record.cases));
    }
  });
  const experimentInput={ datasetId:dataset.id,agentId:agent.id,modelRef:prefix,evaluatorConfig:{ version:'argus.deterministic.v1' } };
  let experiment;
  await check('experiment freezes expected cases, effective model and redacted configuration',async() => {
    experiment=await store.createEvaluationExperiment(pool,experimentInput,context);
    assert.equal(experiment.evidence_kind,'frozen_v1');
    assert.equal(experiment.expected_cases.length,1);
    assert.equal(experiment.configuration_snapshot.execution.effective_model,'fixture-upstream');
    assert.equal(experiment.configuration_sha256,evaluationDigest(experiment.configuration_snapshot));
    assert.equal(experiment.configuration_snapshot.execution.isolation_verified,true);
    await pool.query("UPDATE mcp_agents SET system_prompt='Changed later' WHERE id=$1",[agent.id]);
    const historic=await store.getEvaluationExperiment(pool,experiment.id,context);
    assert.equal(historic.experiment.configuration_snapshot.agent.system_prompt,'Review the fixture only.');
    await rejects(()=>pool.query("UPDATE mcp_evaluation_experiments SET model_ref='different' WHERE id=$1",[experiment.id]),'23514');
  });
  await check('scope predicates hide datasets, experiments, results and global catalogs',async() => {
    assert.equal(await store.getEvaluationDataset(pool,dataset.id,other),null);
    assert.equal(await store.getEvaluationExperiment(pool,experiment.id,other),null);
    assert.equal((await store.listEvaluationExperiments(pool,other)).length,0);
    await rejects(()=>store.createEvaluationDataset(pool,{ datasetKey:prefix,version:1,name:'Other',agentId:agent.id },other),'EVALUATION_REFERENCE_NOT_FOUND');
    await rejects(()=>store.activateEvaluationDataset(pool,dataset.id,other),'EVALUATION_REFERENCE_NOT_FOUND');
    await rejects(()=>pool.query("UPDATE mcp_evaluation_datasets SET tenant_key='other' WHERE id=$1",[dataset.id]),'23514');
  });
  await check('invalid model, credential and baseline references fail before execution',async() => {
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,modelRef:'not-a-model' },context),'EVALUATION_TARGET_UNAVAILABLE');
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,credentialRef:'profile:999999' },context),'EVALUATION_REFERENCE_NOT_FOUND');
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,baselineExperimentId:999999 },context),'EVALUATION_REFERENCE_NOT_FOUND');
    const foreign=await newDataset('-foreign',other);
    await store.createEvaluationCase(pool,foreign.id,caseInput,other);
    await store.activateEvaluationDataset(pool,foreign.id,other);
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,datasetId:foreign.id },context),'EVALUATION_REFERENCE_NOT_FOUND');
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,datasetId:foreign.id },other),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('runtime model labels cannot silently override the actual configured model',async() => {
    const runtime=(await pool.query("SELECT id,model FROM mcp_agent_runtime_profiles WHERE runtime_type='codex' AND enabled LIMIT 1")).rows[0];
    assert.ok(runtime);
    await pool.query('UPDATE mcp_agents SET runtime_profile_id=$2 WHERE id=$1',[agent.id,runtime.id]);
    await rejects(()=>store.createEvaluationExperiment(pool,{ ...experimentInput,modelRef:'not-the-profile-model' },context),'EVALUATION_MODEL_MISMATCH');
    const external=await store.createEvaluationExperiment(pool,{ ...experimentInput,modelRef:runtime.model },context);
    assert.equal(external.configuration_snapshot.execution.effective_model,runtime.model);
    assert.equal(external.configuration_snapshot.execution.isolation_verified,false);
    await pool.query('UPDATE mcp_agents SET runtime_profile_id=NULL WHERE id=$1',[agent.id]);
  });
  await check('results cannot reference another dataset or overwrite prior evidence',async() => {
    const separate=await newDataset('-result');
    const wrongCase=await store.createEvaluationCase(pool,separate.id,caseInput,context);
    await pool.query("UPDATE mcp_evaluation_experiments SET status='running' WHERE id=$1",[experiment.id]);
    await rejects(()=>pool.query("INSERT INTO mcp_evaluation_results(experiment_id,case_id,status) VALUES($1,$2,'passed')",[experiment.id,wrongCase.id]),'23514');
    const result=(await pool.query("INSERT INTO mcp_evaluation_results(experiment_id,case_id,status) VALUES($1,$2,'passed') RETURNING id",[experiment.id,experiment.expected_cases[0].id])).rows[0];
    await rejects(()=>pool.query("UPDATE mcp_evaluation_results SET status='failed' WHERE id=$1",[result.id]),'23514');
    await rejects(()=>pool.query("DELETE FROM mcp_evaluation_results WHERE id=$1",[result.id]),'23514');
    // Synthetic SQL evidence only, never exposed as actual quality execution.
    await pool.query("UPDATE mcp_evaluation_experiments SET status='failed' WHERE id=$1",[experiment.id]);
  });
  await check('trace and span provenance cannot cross scope or use unrelated spans',async() => {
    const traceId=randomUUID();
    await pool.query(`INSERT INTO mcp_observability_traces(id,root_trace_id,name,kind,status,started_at,metadata) VALUES($1,$1,'Fixture','agent','completed',now(),$2::jsonb)`,[traceId,JSON.stringify({ tenantKey:'other',workspaceKey:'other' })]);
    const ds=await newDataset('-trace');
    await rejects(()=>store.createEvaluationCase(pool,ds.id,{ ...caseInput,sourceTraceId:traceId },context),'EVALUATION_REFERENCE_NOT_FOUND');
    await rejects(()=>store.createEvaluationCase(pool,ds.id,{ ...caseInput,sourceSpanId:randomUUID() },context),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('failed canonical audit rolls back the protected mutation',async() => {
    const ds=await newDataset('-audit-rollback');
    await assert.rejects(()=>store.createEvaluationCase(pool,ds.id,caseInput,{ ...context,user:{ ...context.user,auth_method:'x'.repeat(500) } }),error=>error.constructor.name==='CanonicalAuditValidationError');
    assert.equal((await store.getEvaluationDataset(pool,ds.id,context)).cases.length,0);
  });
  const app=express(); app.use(express.json());
  const auth=(req,res,next)=>{ if(req.header('x-fixture-user')==='missing') return res.sendStatus(401); req.user=context.user; next(); };
  const admin=(req,res,next)=>{ if(req.header('x-fixture-role')==='viewer') return res.sendStatus(403); next(); };
  registerEvaluationRoutes(app,pool,{ config:{},requireAuth:auth,requireAdmin:admin,requireSameOrigin:(req,res,next)=>req.header('origin')==='http://fixture' ? next() : res.sendStatus(403) });
  server=await new Promise(resolve=>{ const listening=app.listen(0,'127.0.0.1',()=>resolve(listening)); });
  const base='http://127.0.0.1:'+server.address().port+'/api/admin/evaluations';
  await check('HTTP permissions, malformed scope, and no-provider start gate',async() => {
    assert.equal((await fetch(base+'/datasets',{ headers:{ 'x-fixture-user':'missing' } })).status,401);
    assert.equal((await fetch(base+'/datasets',{ headers:{ 'x-fixture-role':'viewer' } })).status,403);
    assert.equal((await fetch(base+'/datasets',{ headers:{ 'x-argus-tenant-key':'other','x-argus-workspace-key':'other' } })).status,404);
    assert.equal((await fetch(base+'/experiments/'+experiment.id+'/run',{ method:'POST' })).status,403);
    const response=await fetch(base+'/experiments/'+experiment.id+'/run',{ method:'POST',headers:{ origin:'http://fixture' } });
    assert.equal(response.status,409);
    assert.equal((await response.json()).code,'EVALUATION_ALREADY_STARTED');
    assert.equal((await store.getEvaluationExperiment(pool,experiment.id,context)).experiment.status,'failed');
    const regression=await (await fetch(base+'/experiments/'+experiment.id+'/regression')).json();
    assert.equal(regression.result,null);
  });
  const fixture=JSON.parse(await readFile('docs/specs/evaluation/curated-cases.v1.json','utf8'));
  await check('all 12 curated cases round-trip through the real HTTP contract',async() => {
    const ds=await newDataset('-corpus');
    for(const row of fixture.cases) {
      const { case_key,input,expected_output,context:reference,rules }=row;
      const response=await fetch(base+'/datasets/'+ds.id+'/cases',{ method:'POST',headers:{ origin:'http://fixture','content-type':'application/json' },
        body:JSON.stringify({ case_key,input,expected_output,context:reference,rules }) });
      assert.equal(response.status,201,await response.text());
    }
    assert.equal((await store.activateEvaluationDataset(pool,ds.id,context)).case_count,12);
  });
  const report={ status:'passed',generated_at:new Date().toISOString(),evidence_kind:'provider_free_certification',provider_calls:0,checks };
  await mkdir('test-results',{ recursive:true });
  await writeFile('test-results/evaluation-foundation.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(JSON.stringify({ status:'failed',passed_checks:checks,error_code:error.code ?? error.name,message:String(error.message).slice(0,300) },null,2));
  process.exitCode=1;
} finally {
  if(server) await new Promise(resolve=>server.close(resolve));
  await pool.end();
}
