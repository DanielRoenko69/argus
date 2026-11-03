#!/usr/bin/env node
// Synthetic fixtures only: real disposable PostgreSQL and a loopback fake provider.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import * as store from '../dist/evaluation/store.js';
import * as comparisons from '../dist/evaluation/comparisonStore.js';
import { runEvaluationComparison, cancelEvaluationComparison } from '../dist/evaluation/comparisonRunner.js';
import { executeEvaluationExperiment, retryEvaluationExperiment } from '../dist/evaluation/runner.js';
import { recoverEvaluationExperiments, cancelEvaluationExperiment } from '../dist/evaluation/lifecycle.js';
import { summarizeEvaluationComparison } from '../dist/evaluation/regression.js';
import { registerEvaluationRoutes } from '../dist/evaluation/routes.js';

const url=process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_cert')) throw new Error('Explicit disposable *_cert database required');
const pool=new pg.Pool({ connectionString:url,max:8,connectionTimeoutMillis:10000 });
if (process.argv.includes('--worker')) {
  await new Promise(resolve => process.once('message',async ({ id,context }) => {
    try { const job=await runEvaluationComparison(pool,id,{ acknowledge_cost:true },context); await job.completion; }
    finally { await pool.end(); resolve(); }
  }));
  process.exit(0);
}
const prefix='eval-pair-'+randomUUID(), checks=[],requests=[],servers=[],children=[];
const check=async (name,fn) => { await fn(); checks.push({ name,status:'passed' }); };
const rejects=(fn,code) => assert.rejects(fn,e => e.code===code);
const wait=async predicate => {
  const until=Date.now()+12000;
  while (!await predicate()) { if (Date.now()>until) throw new Error('Fixture condition timed out'); await new Promise(r => setTimeout(r,30)); }
};
const listen=async app => {
  const server=await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',() => resolve(s)); }); servers.push(server);
  return 'http://127.0.0.1:'+server.address().port;
};
let mode='ok'; const held=[]; let onRequest=async () => {};
try {
  const fake=express(); fake.use(express.json());
  fake.post('/v1/chat/completions',async (req,res) => {
    requests.push({ model:req.body.model,prompt:req.body.messages[0].content,input:req.body.messages[1].content });
    assert.equal(req.body.tools,undefined);
    await onRequest();
    const reply=() => res.json({ model:req.body.model,choices:[{ index:0,message:{ role:'assistant',content:mode==='wrong' && req.body.model==='B' ? 'wrong' : 'OK' },finish_reason:'stop' }],usage:{ prompt_tokens:10,completion_tokens:1 } });
    if (mode==='hold') held.push(reply);
    else if (mode==='error') res.status(503).json({ error:'synthetic-only' });
    else reply();
  });
  const base=await listen(fake);
  const user=(await pool.query("INSERT INTO mcp_users(username,password_hash,role) VALUES ($1,'synthetic','platform_admin') RETURNING id",[prefix])).rows[0];
  const context={ user:{ id:user.id,username:prefix,role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'' };
  const ctx=() => ({ ...context,requestId:randomUUID() });
  const provider=(await pool.query("INSERT INTO mcp_llm_providers(name,label,provider_type,base_url,auth_type) VALUES ($1,'Pair fake','openai-compatible',$2,'none') RETURNING id",[prefix,base+'/v1'])).rows[0];
  for (const variant of ['A','B']) await pool.query(`INSERT INTO mcp_models(model_name,provider,provider_id,upstream_model_name,input_cost_per_1k,output_cost_per_1k,supports_reasoning)
    VALUES ($1,'openai-compatible',$2,$3,0.01,0.02,false)`,[prefix+variant,provider.id,variant]);
  const agent=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES ($1,'Pair fixture',$2,'Frozen pair prompt.') RETURNING id",[prefix,prefix+'A'])).rows[0];
  const ds=await store.createEvaluationDataset(pool,{ datasetKey:prefix,version:1,name:'Two paired cases',agentId:agent.id },ctx());
  for (let n=1;n<=2;n++) await store.createEvaluationCase(pool,ds.id,{ caseKey:'case-'+n,input:'Return OK '+n,rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] } },ctx());
  await store.activateEvaluationDataset(pool,ds.id,ctx());
  const input={ name:'Paired fixture',dataset_id:ds.id,baseline:{ agent_id:agent.id,model_ref:prefix+'A' },candidate:{ agent_id:agent.id,model_ref:prefix+'B' },repetitions:2,order_mode:'alternating' };
  const create=(b=input,c=ctx()) => comparisons.createEvaluationComparison(pool,b,c);
  const load=id => comparisons.getEvaluationComparisonDetail(pool,id,context);
  const start=(c,request=ctx()) => runEvaluationComparison(pool,c.id,{ acknowledge_cost:true },request);
  const run=async c => { await (await start(c)).completion; return load(c.id); };
  let c;
  await check('atomic pair creation, frozen repetitions and stable idempotent save',async () => {
    const key=ctx(), before=requests.length;
    c=await create(input,key);
    assert.equal((await create(input,key)).id,c.id);
    await rejects(() => create({ ...input,repetitions:3 },key),'EVALUATION_IDEMPOTENCY_CONFLICT');
    const detail=await load(c.id);
    assert.equal(detail.records.length,4); assert.equal(requests.length,before);
    assert.deepEqual(c.plan.map(s => s.variant),['baseline','candidate','candidate','baseline']);
    const hashes=detail.records.filter(r => r.variant==='baseline').map(r => r.experiment.configuration_sha256);
    assert.equal(new Set(hashes).size,1);
    await rejects(() => pool.query("UPDATE mcp_evaluation_comparisons SET repetitions=1 WHERE id=$1",[c.id]),'23514');
    await rejects(() => pool.query("DELETE FROM mcp_evaluation_comparison_steps WHERE comparison_id=$1",[c.id]),'23514');
    const count=Number((await pool.query('SELECT count(*) n FROM mcp_evaluation_experiments WHERE dataset_id=$1',[ds.id])).rows[0].n);
    await rejects(() => create({ ...input,candidate:{ ...input.candidate,model_ref:'missing' } }),'EVALUATION_TARGET_UNAVAILABLE');
    assert.equal(Number((await pool.query('SELECT count(*) n FROM mcp_evaluation_experiments WHERE dataset_id=$1',[ds.id])).rows[0].n),count);
  });
  await check('alternating complete-dataset execution, no double start, all paired gates',async () => {
    const before=requests.length,key=ctx();
    await pool.query("UPDATE mcp_agents SET system_prompt='Later prompt must not leak' WHERE id=$1",[agent.id]);
    const job=await start(c,key);
    await (await start(c,key)).completion;
    await rejects(() => start(c),'EVALUATION_ALREADY_STARTED');
    await job.completion;
    const record=await load(c.id);
    assert.equal(record.comparison.status,'completed');
    assert.deepEqual(requests.slice(before).map(r => r.model),['A','A','B','B','B','B','A','A']);
    assert.ok(requests.slice(before).every(r => r.prompt==='Frozen pair prompt.'));
    const summary=summarizeEvaluationComparison(record.comparison,record.records);
    assert.equal(summary.comparison_state,'passed'); assert.equal(summary.planned_requests,8); assert.equal(summary.cost_coverage.total,8);
    const trace=(await pool.query('SELECT metadata FROM mcp_observability_traces WHERE id=$1',[record.records[0].results[0].trace_id])).rows[0];
    assert.equal(trace.metadata.evaluationComparisonId,c.id);
    assert.equal(summarizeEvaluationComparison(record.comparison,record.records.slice(1)).comparison_state,'not_comparable');
    await pool.query("UPDATE mcp_agents SET system_prompt='Frozen pair prompt.' WHERE id=$1",[agent.id]);
  });
  await check('mandatory failures do not trigger retries or cherry-pick a passing round',async () => {
    mode='wrong'; const before=requests.length;
    const d=await run(await create({ ...input,order_mode:'baseline_first' }));
    assert.equal(d.comparison.status,'completed');
    assert.deepEqual(requests.slice(before).map(r => r.model),['A','A','B','B','A','A','B','B']);
    assert.equal(summarizeEvaluationComparison(d.comparison,d.records).comparison_state,'failed');
    mode='ok';
  });
  await check('child start cannot bypass order; routing drift blocks the series before dispatch',async () => {
    const d=await create(),before=requests.length;
    await rejects(() => executeEvaluationExperiment(pool,{},d.plan[0].experiment_id,ctx()),'EVALUATION_COMPARISON_CONTROLLED');
    await rejects(() => cancelEvaluationExperiment(pool,d.plan[1].experiment_id,ctx()),'EVALUATION_COMPARISON_CONTROLLED');
    await pool.query("UPDATE mcp_models SET upstream_model_name='changed' WHERE model_name=$1",[prefix+'B']);
    await rejects(() => start(d),'EVALUATION_CONFIGURATION_DRIFT');
    assert.equal(requests.length,before); assert.equal((await load(d.id)).comparison.status,'queued');
    await pool.query("UPDATE mcp_models SET upstream_model_name='B' WHERE model_name=$1",[prefix+'B']);
    onRequest=async () => { if (requests.length===before+2) await pool.query("UPDATE mcp_models SET upstream_model_name='changed' WHERE model_name=$1",[prefix+'B']); };
    const stopped=await run(d);
    assert.equal(stopped.comparison.status,'failed'); assert.equal(requests.length,before+2);
    assert.equal(stopped.comparison.stop_reason,'EVALUATION_CONFIGURATION_DRIFT');
    assert.equal(stopped.records[0].experiment.status,'completed');
    assert.ok(stopped.records.slice(1).every(r => r.experiment.status==='queued'));
    await pool.query("UPDATE mcp_models SET upstream_model_name='B' WHERE model_name=$1",[prefix+'B']);
    onRequest=async () => {};
  });
  await check('technical failure stops subsequent experiments; only explicit retry and resume continue',async () => {
    mode='error'; const d=await create(),before=requests.length;
    const stopped=await run(d);
    assert.equal(requests.length-before,2); assert.equal(stopped.comparison.status,'failed');
    assert.equal(summarizeEvaluationComparison(stopped.comparison,stopped.records).comparison_state,'inconclusive');
    await rejects(() => start(d),'EVALUATION_COMPARISON_NEEDS_REVIEW');
    mode='ok';
    const child=stopped.records[0];
    const retry=await retryEvaluationExperiment(pool,child.experiment.id,{ case_ids:child.experiment.expected_cases.map(c => c.id),acknowledge_possible_duplicate_cost:true },ctx());
    await retry.completion;
    const resumed=await run(d);
    assert.equal(resumed.comparison.status,'completed'); assert.equal(requests.length-before,10);
    const s=summarizeEvaluationComparison(resumed.comparison,resumed.records);
    assert.equal(s.cost_coverage.total,10); assert.equal(s.cost_coverage.measured,8);
  });
  await check('durable cancellation stops an active series, retains attempts and leaves future steps queued',async () => {
    mode='hold'; const d=await create(),before=requests.length;
    const job=await start(d); await wait(() => requests.length>before);
    await rejects(() => retryEvaluationExperiment(pool,d.plan[0].experiment_id,{ case_ids:[1],acknowledge_possible_duplicate_cost:true },ctx()),'EVALUATION_COMPARISON_CONTROLLED');
    await cancelEvaluationComparison(pool,d.id,ctx());
    await job.completion;
    const detail=await load(d.id);
    assert.equal(detail.comparison.status,'cancelled'); assert.equal(requests.length-before,1);
    assert.equal(detail.records[0].experiment.status,'cancelled');
    assert.ok(detail.records.slice(1).every(r => r.experiment.status==='queued'));
    mode='ok'; held.splice(0).forEach(fn => fn());
  });
  await check('expired parent lease fences a late child even while its own lease remains valid',async () => {
    mode='hold'; const d=await create(),before=requests.length;
    const job=await start(d); await wait(() => requests.length>before);
    await pool.query("UPDATE mcp_evaluation_comparisons SET leased_until=clock_timestamp()-interval '1 second' WHERE id=$1",[d.id]);
    mode='ok'; held.splice(0).forEach(fn => fn());
    await assert.rejects(job.completion);
    await comparisons.recoverEvaluationComparisons(pool,'test');
    const detail=await load(d.id);
    assert.equal(detail.comparison.status,'interrupted'); assert.equal(detail.records[0].results.length,0);
    assert.equal(requests.length-before,1);
    await pool.query("UPDATE mcp_evaluation_workers SET leased_until=clock_timestamp()-interval '1 second' WHERE comparison_id=$1",[d.id]);
    await recoverEvaluationExperiments(pool,'test');
  });
  await check('real worker process loss never automatically schedules remaining steps',async () => {
    mode='hold'; const d=await create(),before=requests.length;
    const child=fork(fileURLToPath(import.meta.url),['--worker'],{ stdio:['ignore','ignore','ignore','ipc'],windowsHide:true }); children.push(child);
    child.send({ id:d.id,context:ctx() }); await wait(() => requests.length>before);
    await new Promise(resolve => { child.once('exit',resolve); child.kill(); });
    await pool.query("UPDATE mcp_evaluation_comparisons SET leased_until=clock_timestamp()-interval '1 second' WHERE id=$1",[d.id]);
    await pool.query("UPDATE mcp_evaluation_workers SET leased_until=clock_timestamp()-interval '1 second' WHERE comparison_id=$1",[d.id]);
    await comparisons.recoverEvaluationComparisons(pool,'test'); await recoverEvaluationExperiments(pool,'test');
    const detail=await load(d.id);
    assert.equal(detail.comparison.status,'interrupted'); assert.equal(detail.records[0].experiment.status,'interrupted');
    assert.equal(detail.records[0].attempts.length,1); assert.equal(detail.records[0].results.length,0);
    assert.equal(requests.length-before,1); await rejects(() => start(d),'EVALUATION_COMPARISON_NEEDS_REVIEW');
    mode='ok'; held.splice(0).forEach(fn => fn());
  });
  await check('scope opacity, required acknowledgement, audit failure rollback and HTTP contract',async () => {
    const d=await create(),before=requests.length;
    assert.equal(await comparisons.getEvaluationComparison(pool,d.id,{ tenantKey:'foreign',workspaceKey:'foreign' }),null);
    await assert.rejects(() => runEvaluationComparison(pool,d.id,{},ctx()));
    await rejects(() => start(d,context),'EVALUATION_IDEMPOTENCY_REQUIRED');
    await assert.rejects(() => start(d,{ ...ctx(),user:{ ...context.user,auth_method:'x'.repeat(500) } }));
    assert.equal((await load(d.id)).comparison.status,'queued'); assert.equal(requests.length,before);
    const app=express(); app.use(express.json());
    registerEvaluationRoutes(app,pool,{ config:{},requireAuth:(req,res,next) => { req.user=context.user; next(); },requireAdmin:(_req,_res,next)=>next(),requireSameOrigin:(_req,_res,next)=>next() });
    const baseUrl=await listen(app);
    const get=await fetch(baseUrl+'/api/admin/evaluations/comparisons/'+d.id);
    assert.equal(get.status,200); const body=await get.json();
    assert.equal(body.summary.planned_requests,8); assert.equal(body.comparison.token,undefined);
    const missingKey=await fetch(baseUrl+'/api/admin/evaluations/comparisons',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify(input) });
    assert.equal(missingKey.status,400);
    const headers={ 'Content-Type':'application/json','Idempotency-Key':randomUUID() };
    const created=await fetch(baseUrl+'/api/admin/evaluations/comparisons',{ method:'POST',headers,body:JSON.stringify({ ...input,repetitions:1 }) });
    assert.equal(created.status,201); const fresh=(await created.json()).comparison;
    const runHeaders={ 'Content-Type':'application/json','Idempotency-Key':randomUUID() };
    const startHttp=() => fetch(baseUrl+'/api/admin/evaluations/comparisons/'+fresh.id+'/run',{ method:'POST',headers:runHeaders,body:JSON.stringify({ acknowledge_cost:true }) });
    const accepted=await startHttp(); assert.equal(accepted.status,202);
    assert.equal((await startHttp()).status,202);
    await wait(async () => (await load(fresh.id)).comparison.status!=='running');
    const completed=await (await fetch(baseUrl+'/api/admin/evaluations/comparisons/'+fresh.id)).json();
    assert.equal(completed.summary.comparison_state,'passed'); assert.equal(requests.length-before,4);
  });
  const report={ status:'passed',generated_at:new Date().toISOString(),evidence_kind:'local_fake_provider',paid_provider_calls:0,local_requests:requests.length,checks };
  await mkdir('test-results',{ recursive:true }); await writeFile('test-results/evaluation-comparisons.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(JSON.stringify({ status:'failed',checks,error_code:error.code ?? error.name,message:String(error.message).slice(0,400),stack:error.stack?.split('\n').slice(0,5) },null,2));
  process.exitCode=1;
} finally {
  children.forEach(child => { if (child.exitCode===null) child.kill(); });
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
}
