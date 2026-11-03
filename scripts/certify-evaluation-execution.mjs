#!/usr/bin/env node
// Real PostgreSQL + local fake provider. Never use normal Argus data or paid models.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import * as store from '../dist/evaluation/store.js';
import { executeEvaluationExperiment } from '../dist/evaluation/runner.js';
import { compareEvaluationEvidence } from '../dist/evaluation/regression.js';
import { registerEvaluationRoutes } from '../dist/evaluation/routes.js';

const url = process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_cert')) throw new Error('Explicit disposable *_cert database required');
const pool = new pg.Pool({ connectionString:url,max:8,connectionTimeoutMillis:10000 });
const prefix = 'eval-exec-'+randomUUID();
const checks = [], requests = [], servers = [];
const check = async (name,run) => { await run(); checks.push({ name,status:'passed' }); };
const listen = async app => { const server = await new Promise(resolve => { const s = app.listen(0,'127.0.0.1',()=>resolve(s)); }); servers.push(server); return 'http://127.0.0.1:'+server.address().port; };
const rejects = (fn,code) => assert.rejects(fn,error => error.code === code);
let mode = 'correct';
try {
  const fixture = JSON.parse(await readFile('docs/specs/evaluation/curated-cases.v1.json','utf8')).cases.filter(c => c.smoke);
  const providerApp = express(); providerApp.use(express.json());
  providerApp.post('/v1/chat/completions',(req,res) => {
    requests.push(req.body);
    assert.equal(req.body.tools,undefined);
    assert.equal(req.body.model,'fixture-upstream');
    assert.equal(req.body.messages.length,2);
    assert.equal(req.body.messages[0].content,'Frozen fixture prompt.');
    const input = JSON.parse(req.body.messages[1].content);
    assert.deepEqual(Object.keys(input).sort(),['input','reference_context']);
    const c = fixture.find(c => c.input === input.input);
    assert.ok(c);
    if (mode === 'error') return res.status(503).json({ error:'synthetic secret body that must not escape' });
    const answer = c.fixture_responses.find(r => r.label === mode);
    const usage = c === fixture[0] ? { prompt_tokens:100,completion_tokens:10,total_tokens:110 } : undefined;
    res.json({ id:'fake-provider',model:'fixture-upstream',choices:[{ index:0,message:{ role:'assistant',content:answer.output },finish_reason:'stop' }],...(usage ? { usage } : {}) });
  });
  const providerBase = await listen(providerApp);
  const user = (await pool.query(`INSERT INTO mcp_users(username,display_name,password_hash,role) VALUES($1,'Evaluation fixture','not-a-password','platform_admin') RETURNING id`,[prefix])).rows[0];
  const context = { user:{ id:user.id,username:prefix,role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'' };
  const provider = (await pool.query(`INSERT INTO mcp_llm_providers(name,label,provider_type,base_url,auth_type) VALUES($1,'Fake provider','openai-compatible',$2,'none') RETURNING id`,[prefix,providerBase+'/v1'])).rows[0];
  await pool.query(`INSERT INTO mcp_models(model_name,provider,provider_id,upstream_model_name,input_cost_per_1k,output_cost_per_1k,supports_reasoning) VALUES($1,'openai-compatible',$2,'fixture-upstream',0.01,0.02,false)`,[prefix,provider.id]);
  const agent = (await pool.query(`INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES($1,'Fixture',$1,'Frozen fixture prompt.') RETURNING id`,[prefix])).rows[0];
  const ds = await store.createEvaluationDataset(pool,{ datasetKey:prefix,version:1,name:'Three synthetic cases',agentId:agent.id },context);
  for (const c of fixture) await store.createEvaluationCase(pool,ds.id,{ caseKey:c.case_key,input:c.input,context:c.context,expectedOutput:c.expected_output,rules:c.rules },context);
  await store.activateEvaluationDataset(pool,ds.id,context);
  const create = (baseline=null) => store.createEvaluationExperiment(pool,{ datasetId:ds.id,agentId:agent.id,modelRef:prefix,evaluatorConfig:{ version:'argus.deterministic.v1' },baselineExperimentId:baseline },context);
  const load = id => store.getEvaluationExperiment(pool,id,context);
  const run = async e => { const job = await executeEvaluationExperiment(pool,{},e.id,context); await job.completion; return load(e.id); };
  const base = await create();
  let baseline;
  await check('atomic claim, duplicate request and snapshot-only prompt execution',async () => {
    await pool.query("UPDATE mcp_agents SET system_prompt='Changed after snapshot' WHERE id=$1",[agent.id]);
    const ctx = { ...context,requestId:'start-'+base.id };
    const job = await executeEvaluationExperiment(pool,{},base.id,ctx);
    const replay = await executeEvaluationExperiment(pool,{},base.id,ctx);
    await replay.completion; await job.completion;
    baseline = await load(base.id);
    assert.equal(requests.length,3);
    assert.equal(baseline.experiment.status,'completed');
    assert.ok(baseline.results.every(r => r.status === 'passed'));
    await rejects(()=>executeEvaluationExperiment(pool,{},base.id,context),'EVALUATION_ALREADY_STARTED');
    await rejects(()=>pool.query("UPDATE mcp_evaluation_experiments SET status='queued' WHERE id=$1",[base.id]),'23514');
    await pool.query("UPDATE mcp_agents SET system_prompt='Frozen fixture prompt.' WHERE id=$1",[agent.id]);
  });
  await check('usage presence, partial cost coverage, trace and canonical evidence',async () => {
    assert.equal(baseline.results.filter(r => r.input_tokens !== null).length,1);
    assert.equal(baseline.results.filter(r => r.cost_usd !== null).length,1);
    for (const r of baseline.results) {
      assert.equal(r.evidence.executor_version,'argus.native-reference.v1');
      assert.ok(r.trace_id);
      const trace = (await pool.query('SELECT * FROM mcp_observability_traces WHERE id=$1',[r.trace_id])).rows[0];
      assert.equal(trace.kind,'evaluation'); assert.equal(trace.status,'completed');
      assert.equal(trace.metadata.tenantKey,'default');
      assert.equal(trace.metadata.measurements.usage_source,r.evidence.measurements.usage_source);
      assert.equal(trace.input_preview,null); // No prompt copies in telemetry.
    }
    const events = (await pool.query("SELECT event_id FROM mcp_canonical_audit_events WHERE producer_name='evaluation.result.recorded' AND actor_id=$1",[String(user.id)])).rows;
    assert.equal(events.length,3);
    for (const e of events) assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[e.event_id])).rows.length,1);
  });
  await check('complete passing comparison and wrong non-empty mandatory failures',async () => {
    const candidate = await run(await create(base.id));
    const comparison = compareEvaluationEvidence(candidate,baseline);
    assert.equal(comparison.result.status,'passed');
    assert.equal(comparison.candidate.costUsd,undefined);
    assert.equal(comparison.candidate.costCoverage.measured,1);
    mode = 'wrong_non_empty';
    const wrong = await run(await create(base.id));
    assert.equal(wrong.experiment.status,'completed');
    assert.ok(wrong.results.every(r => r.status === 'failed'));
    assert.equal(compareEvaluationEvidence(wrong,baseline).result.status,'failed');
    assert.equal(compareEvaluationEvidence({ ...candidate,results:candidate.results.slice(1) },baseline).result,null);
    mode = 'correct';
  });
  await check('provider failures do not retry or fabricate usage',async () => {
    mode = 'error'; const before = requests.length;
    const error = await run(await create(base.id));
    assert.equal(requests.length-before,3);
    assert.equal(error.experiment.status,'failed');
    assert.ok(error.results.every(r => r.status === 'error' && r.input_tokens === null && r.cost_usd === null));
    assert.equal(compareEvaluationEvidence(error,baseline).result,null);
    assert.ok(!JSON.stringify(error).includes('synthetic secret body'));
    mode = 'correct';
  });
  await check('routing drift and audit failure block before any provider request',async () => {
    const e = await create(); const before = requests.length;
    await pool.query("UPDATE mcp_models SET upstream_model_name='other' WHERE model_name=$1",[prefix]);
    await rejects(()=>executeEvaluationExperiment(pool,{},e.id,context),'EVALUATION_CONFIGURATION_DRIFT');
    await pool.query("UPDATE mcp_models SET upstream_model_name='fixture-upstream' WHERE model_name=$1",[prefix]);
    await assert.rejects(()=>executeEvaluationExperiment(pool,{},e.id,{ ...context,user:{ ...context.user,auth_method:'x'.repeat(500) } }));
    assert.equal((await load(e.id)).experiment.status,'queued');
    assert.equal(requests.length,before);
  });
  await check('revoked Agent access blocks before dispatch',async () => {
    const e = await create(); const before = requests.length;
    await pool.query('UPDATE mcp_agents SET enabled=false WHERE id=$1',[agent.id]);
    await rejects(()=>executeEvaluationExperiment(pool,{},e.id,context),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal(requests.length,before);
    await pool.query('UPDATE mcp_agents SET enabled=true WHERE id=$1',[agent.id]);
  });
  await check('HTTP start responds 202 after claim and publishes scored results',async () => {
    const app = express(); app.use(express.json());
    registerEvaluationRoutes(app,pool,{ config:{},requireAuth:(req,res,next)=>{ req.user=context.user; next(); },requireAdmin:(req,res,next)=>next(),requireSameOrigin:(req,res,next)=>next() });
    const baseUrl = await listen(app); const e = await create(base.id);
    const started = await fetch(baseUrl+'/api/admin/evaluations/experiments/'+e.id+'/run',{ method:'POST' });
    assert.equal(started.status,202);
    for (let n=0;n<100;n++) { if ((await load(e.id)).experiment.status !== 'running') break; await new Promise(resolve=>setTimeout(resolve,20)); }
    const regression = await (await fetch(baseUrl+'/api/admin/evaluations/experiments/'+e.id+'/regression')).json();
    assert.equal(regression.result.status,'passed');
  });
  const report = { status:'passed',generated_at:new Date().toISOString(),evidence_kind:'local_fake_provider',paid_provider_calls:0,local_requests:requests.length,checks };
  await mkdir('test-results',{ recursive:true });
  await writeFile('test-results/evaluation-execution.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  console.error(JSON.stringify({ status:'failed',checks,error_code:error.code ?? error.name,message:String(error.message).slice(0,300) },null,2));
  process.exitCode = 1;
} finally {
  for (const server of servers.reverse()) await new Promise(resolve=>server.close(resolve));
  await pool.end();
}
