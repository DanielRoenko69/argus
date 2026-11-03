// Token-free PostgreSQL integration. Only an explicitly disposable loopback *_cert database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import pg from 'pg';
import * as store from '../dist/evaluation/store.js';
import { createEvaluationComparison,getEvaluationComparisonDetail } from '../dist/evaluation/comparisonStore.js';
import { runEvaluationComparison } from '../dist/evaluation/comparisonRunner.js';
import { executeEvaluationExperiment } from '../dist/evaluation/runner.js';
import { evaluationPreview,buildComparisonPreview,listEvaluationTargets } from '../dist/evaluation/authoring.js';
import { summarizeEvaluationComparison } from '../dist/evaluation/regression.js';
const url=process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!url || !['localhost','127.0.0.1','[::1]'].includes(new URL(url).hostname) || !new URL(url).pathname.endsWith('_cert')) throw new Error('Explicit loopback *_cert database required');
const pool=new pg.Pool({ connectionString:url,max:8 });
const name='codex-eval-cert-'+randomUUID(),requests=[];
const app=express();app.use(express.json());
let ready=true;
app.get('/codex-evaluation/status',(_req,res)=>res.json({ ready,executor_version:'argus.codex-reference.v1',cli_version:'codex-cli 0.146.0',models:['gpt-5.6-terra'] }));
app.post('/codex-evaluation/run',(req,res)=>{
  requests.push(req.body);
  assert.equal(req.body.model,'gpt-5.6-terra');assert.equal(req.body.reasoningEffort,'xhigh');assert.equal(req.body.instructions,'Frozen evaluation fixture.');
  assert.deepEqual(Object.keys(req.body).sort(),['input','instructions','model','reasoningEffort']);
  assert.deepEqual(JSON.parse(req.body.input),{ input:'Return OK',reference_context:{} });
  assert.match(req.header('x-evaluation-attempt-id'),/^[a-f0-9-]{36}$/);
  res.json({ executor_version:'argus.codex-reference.v1',output:'OK',model:'gpt-5.6-terra',requests:1,input_tokens:6,output_tokens:1 });
});
const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
process.env.AGENT_WORKSPACE_URL='http://127.0.0.1:'+server.address().port;process.env.WORKSPACE_SECRET='synthetic-fixture-only';
try {
  const user=(await pool.query("INSERT INTO mcp_users(username,password_hash,role) VALUES($1,'fixture','platform_admin') RETURNING id",[name])).rows[0];
  const context={ user:{ id:user.id,username:name,role:'platform_admin',allowed_bundles:null,entra_groups:[] },tenantKey:'default',workspaceKey:'default',environment:'test' };
  const ctx=()=>({ ...context,requestId:randomUUID() });
  const profile=(await pool.query("INSERT INTO mcp_agent_runtime_profiles(name,label,runtime_type,auth_mode,model,reasoning_effort) VALUES($1,'Codex fixture','codex','chatgpt','gpt-5.6-terra','xhigh') RETURNING id",[name])).rows[0];
  const agent=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt,runtime_profile_id) VALUES($1,'Codex fixture','unused-api-alias','Frozen evaluation fixture.',$2) RETURNING id",[name,profile.id])).rows[0];
  const ds=await store.createEvaluationDataset(pool,{ datasetKey:name,version:1,name:'Codex fixture',agentId:agent.id },ctx());
  await store.createEvaluationCase(pool,ds.id,{ caseKey:'one',input:'Return OK',rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] } },ctx());
  await store.activateEvaluationDataset(pool,ds.id,ctx());
  const targets=await listEvaluationTargets(pool,agent.id,context);
  assert.equal(targets.blocker,null);assert.equal(targets.targets[0].selectable,true);assert.equal(targets.agent.reasoning_effort,'xhigh');
  const input={ name:'Codex same-model repeatability',dataset_id:ds.id,baseline:{ agent_id:agent.id,model_ref:'gpt-5.6-terra' },candidate:{ agent_id:agent.id,model_ref:'gpt-5.6-terra' },repetitions:1,order_mode:'alternating' };
  const preview=await evaluationPreview(pool,c=>buildComparisonPreview(c,input,context));
  assert.equal(preview.planned_requests,2);assert.ok(preview.warnings.some(w=>w.includes('repeatability')));assert.equal(preview.baseline.max_tokens,null);assert.equal(requests.length,0);
  const comparison=await createEvaluationComparison(pool,{ ...input,reviewed_preflight_sha256:preview.preflight_sha256 },ctx());
  await pool.query("UPDATE mcp_agents SET system_prompt='Changed after freezing' WHERE id=$1",[agent.id]);
  const job=await runEvaluationComparison(pool,comparison.id,{ acknowledge_cost:true },ctx());await job.completion;
  const detail=await getEvaluationComparisonDetail(pool,comparison.id,context);
  if (detail.comparison.status!=='completed') console.log(JSON.stringify({ fixture_only:true,stop_reason:detail.comparison.stop_reason,requests:requests.length,
    children:detail.records.map(r=>({ status:r.experiment.status,errors:r.results.map(v=>v.error_message) })) }));
  assert.equal(detail.comparison.status,'completed');assert.equal(requests.length,2);
  assert.equal(summarizeEvaluationComparison(detail.comparison,detail.records).comparison_state,'passed');
  for (const record of detail.records) {
    const r=record.results[0];assert.equal(r.status,'passed');assert.equal(r.cost_usd,null);assert.equal(r.input_tokens,6);assert.ok(r.trace_id);
    assert.equal(r.evidence.executor_version,'argus.codex-reference.v1');
  }
  const create=()=>store.createEvaluationExperiment(pool,{ datasetId:ds.id,agentId:agent.id,modelRef:'gpt-5.6-terra',evaluatorConfig:{ version:'argus.deterministic.v1' } },ctx());
  const drift=await create();
  await pool.query("UPDATE mcp_agent_runtime_profiles SET reasoning_effort='high' WHERE id=$1",[profile.id]);
  await assert.rejects(()=>executeEvaluationExperiment(pool,{},drift.id,ctx()),e=>e.code==='EVALUATION_CONFIGURATION_DRIFT');
  assert.equal(requests.length,2);
  await pool.query("UPDATE mcp_agent_runtime_profiles SET reasoning_effort='xhigh' WHERE id=$1",[profile.id]);
  ready=false;
  assert.equal((await listEvaluationTargets(pool,agent.id,context)).targets[0].selectable,false);
  await assert.rejects(()=>executeEvaluationExperiment(pool,{},drift.id,ctx()),e=>e.code==='EVALUATION_CODEX_UNAVAILABLE');
  assert.equal(requests.length,2);
  const events=await pool.query("SELECT event_id FROM mcp_canonical_audit_events WHERE producer_name='evaluation.result.recorded' AND actor_id=$1",[String(user.id)]);
  assert.equal(events.rows.length,2);
  console.log(JSON.stringify({ passed:true,fixture_only:true,requests:2,checks:['target-discovery','same-model-pair','frozen-prompt','judgement','unknown-cost','trace-audit','profile-drift','bridge-unavailable-no-fallback'] }));
} finally { server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end(); }
