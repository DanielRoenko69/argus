#!/usr/bin/env node
// Uses only a disposable loopback database and a local HTTP model fake.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express from 'express';
import pg from 'pg';
import * as store from '../dist/evaluation/store.js';
import { createEvaluationComparison } from '../dist/evaluation/comparisonStore.js';
import { evaluationPreview,buildComparisonPreview,listEvaluationTargets } from '../dist/evaluation/authoring.js';
import { registerEvaluationRoutes } from '../dist/evaluation/routes.js';

const connection=process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!connection || !['localhost','127.0.0.1','[::1]'].includes(new URL(connection).hostname)
    || !new URL(connection).pathname.endsWith('_cert')) throw new Error('Explicit loopback *_cert database required');
const pool=new pg.Pool({ connectionString:connection,max:6,connectionTimeoutMillis:10000 });
const prefix='eval-ui-'+randomUUID(),checks=[],requests=[],servers=[];
const serveDemo=process.argv.includes('--serve-demo');
let finishDemo=() => {};
const demoStop=serveDemo ? new Promise(resolve => { finishDemo=resolve;process.once('SIGINT',resolve);process.once('SIGTERM',resolve);process.on('message',m => { if(m==='stop')resolve(); }); }) : null;
const stopNonce=randomUUID();
const reportPath=serveDemo ? 'test-results/evaluation-demo-session.json' : 'test-results/evaluation-authoring.json';
const curated=JSON.parse(await readFile('docs/specs/evaluation/curated-cases.v1.json','utf8')).cases.filter(c => c.smoke);
const check=async (name,fn) => { console.log('Checking: '+name); await fn(); checks.push({ name,status:'passed' }); };
const listen=async app => {
  const s=await new Promise(resolve => { const server=app.listen(0,'127.0.0.1',() => resolve(server)); });
  servers.push(s); return `http://127.0.0.1:${s.address().port}`;
};
const reject=(fn,code) => assert.rejects(fn,e => e.code===code);
try {
  const fake=express(); fake.use(express.json());
  fake.post('/v1/chat/completions',(req,res) => {
    requests.push(req.body); assert.equal(req.body.tools,undefined);
    const supplied=JSON.parse(req.body.messages.at(-1).content).input;
    const curatedCase=curated.find(c => c.input===supplied);
    const output=curatedCase ? curatedCase.fixture_responses.find(r => r.label===(req.body.model==='baseline' ? 'correct' : 'wrong_non_empty')).output
      : req.body.model==='baseline' ? 'checkout unavailable' : 'Unknown service';
    res.json({ model:req.body.model,choices:[{ index:0,message:{ role:'assistant',content:output },finish_reason:'stop' }],
      usage:{ prompt_tokens:20,completion_tokens:3 } });
  });
  const providerUrl=await listen(fake);
  const user=(await pool.query("INSERT INTO mcp_users(username,password_hash,role) VALUES ($1,'synthetic','platform_admin') RETURNING id",[prefix])).rows[0];
  const context={ user:{ id:user.id,username:prefix,role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'' };
  const ctx=() => ({ ...context,requestId:randomUUID() });
  const { certifyCuration }=await import('./lib/evaluation-curation-certification.mjs');
  const curation=await certifyCuration({ pool,context,check });
  const provider=(await pool.query("INSERT INTO mcp_llm_providers(name,label,provider_type,base_url,auth_type) VALUES ($1,'Local certification provider','openai-compatible',$2,'none') RETURNING id",[prefix,providerUrl+'/v1'])).rows[0];
  const models=[];
  for (const variant of ['baseline','candidate']) models.push((await pool.query(`INSERT INTO mcp_models(model_name,display_name,provider,provider_id,upstream_model_name,supports_reasoning)
    VALUES ($1,$2,'openai-compatible',$3,$4,false) RETURNING id`,[prefix+variant,variant==='baseline' ? 'Reference model' : 'Candidate model',provider.id,variant])).rows[0]);
  const agent=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES ($1,'Incident summary reviewer',$2,'Use the supplied incident context.') RETURNING id",[prefix,prefix+'baseline'])).rows[0];
  const ds=await store.createEvaluationDataset(pool,{ datasetKey:prefix,version:1,name:'Incident response checks',agentId:agent.id },ctx());
  await store.createEvaluationCase(pool,ds.id,{ caseKey:'checkout-outage',input:'Name the affected service.',context:'checkout is unavailable',rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_includes',value:'checkout' }] } },ctx());
  await store.activateEvaluationDataset(pool,ds.id,ctx());
  const input={ name:'Reviewed A/B',dataset_id:ds.id,baseline:{ agent_id:agent.id,model_ref:prefix+'baseline' },candidate:{ agent_id:agent.id,model_ref:prefix+'candidate' },repetitions:1,order_mode:'alternating' };
  const preview=(body=input,c=context) => evaluationPreview(pool,client => buildComparisonPreview(client,body,c));
  const count=async () => Number((await pool.query('SELECT count(*) n FROM mcp_evaluation_experiments WHERE dataset_id=$1',[ds.id])).rows[0].n);
  let reviewed;
  await check('preflight is deterministic, secret-free, write-free and provider-free',async () => {
    const before=await count(); reviewed=await preview();
    assert.equal(reviewed.planned_requests,2); assert.equal(reviewed.comparison_kind,'model');
    assert.equal(reviewed.baseline.effective_model,'baseline');
    assert.equal((await preview()).preflight_sha256,reviewed.preflight_sha256);
    assert.equal(await count(),before); assert.equal(requests.length,0);
    assert.ok(!JSON.stringify(reviewed).includes('Use the supplied incident context.'));
    assert.ok(!JSON.stringify(reviewed).includes(providerUrl));
  });
  await check('prompt drift rejects reviewed save atomically, fresh review and idempotent save succeed',async () => {
    await pool.query("UPDATE mcp_agents SET system_prompt='Updated reviewed prompt' WHERE id=$1",[agent.id]);
    const before=await count();
    await reject(() => createEvaluationComparison(pool,{ ...input,reviewed_preflight_sha256:reviewed.preflight_sha256 },ctx()),'EVALUATION_PREFLIGHT_CHANGED');
    assert.equal(await count(),before);
    const fresh=await preview(),key=ctx(),body={ ...input,reviewed_preflight_sha256:fresh.preflight_sha256 };
    const created=await createEvaluationComparison(pool,body,key);
    assert.equal((await createEvaluationComparison(pool,body,key)).id,created.id);
    assert.equal(await count(),before+2); assert.equal(requests.length,0);
  });
  await check('target catalog exposes effective names; disabled providers and foreign scopes fail closed',async () => {
    const targets=await listEvaluationTargets(pool,agent.id,context);
    assert.equal(targets.targets.find(m => m.id===models[0].id).effective_model,'baseline');
    assert.equal(targets.targets.find(m => m.id===models[0].id).selectable,true);
    await pool.query('UPDATE mcp_llm_providers SET enabled=false WHERE id=$1',[provider.id]);
    assert.equal((await listEvaluationTargets(pool,agent.id,context)).targets.find(m => m.id===models[0].id).selectable,false);
    await reject(() => preview(),'EVALUATION_TARGET_UNAVAILABLE');
    await pool.query('UPDATE mcp_llm_providers SET enabled=true WHERE id=$1',[provider.id]);
    await reject(() => preview(input,{ ...context,workspaceKey:'foreign' }),'EVALUATION_REFERENCE_NOT_FOUND');
    await reject(() => listEvaluationTargets(pool,agent.id,{ ...context,workspaceKey:'foreign' }),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal(requests.length,0);
  });
  await check('external runtimes and inline credentials are explained and cannot fall back to API execution',async () => {
    const profile=(await pool.query("INSERT INTO mcp_agent_runtime_profiles(name,label,runtime_type,auth_mode,model) VALUES ($1,'Subscription fixture','codex','chatgpt','fixture-runtime') RETURNING id",[prefix])).rows[0];
    await pool.query('UPDATE mcp_agents SET runtime_profile_id=$1 WHERE id=$2',[profile.id,agent.id]);
    const targets=await listEvaluationTargets(pool,agent.id,context);
    assert.match(targets.blocker,/no verified isolated evaluation mode/);
    assert.equal(targets.targets.length,1);
    assert.equal(targets.targets[0].kind,'runtime_profile');
    assert.equal(targets.targets[0].effective_model,'fixture-runtime');
    assert.ok(targets.targets.every(t => !t.selectable));
    await reject(() => preview({ ...input,baseline:{ agent_id:agent.id,model_ref:'fixture-runtime' },candidate:{ agent_id:agent.id,model_ref:'fixture-runtime' } }),'EVALUATION_EXECUTOR_NOT_READY');
    await pool.query("UPDATE mcp_agents SET runtime_profile_id=NULL,llm_api_key='synthetic-not-a-key' WHERE id=$1",[agent.id]);
    assert.match((await listEvaluationTargets(pool,agent.id,context)).blocker,/inline key/);
    await reject(() => preview(),'EVALUATION_INLINE_CREDENTIAL_UNSUPPORTED');
    await pool.query('UPDATE mcp_agents SET llm_api_key=NULL WHERE id=$1',[agent.id]);
    assert.equal(requests.length,0);
  });

  const app=express(); app.use(express.json());
  // ONLY this isolated fixture server accepts synthetic auth. Never mounted in Argus production.
  const requireAuth=(req,_res,next) => {
    const mode=req.header('X-Fixture-Mfa') ?? 'fresh';
    req.user={ ...context.user,role:req.header('X-Fixture-Role') ?? 'platform_admin',
      auth_method:mode==='local' ? 'local' : 'oidc',mfa_method:mode==='none' ? null : 'otp',
      mfa_verified_at:mode==='none' ? null : new Date(Date.now()-(mode==='stale' ? 3600000 : 0)).toISOString() };
    next();
  };
  const sameOrigin=(req,res,next) => !req.header('Origin') || req.header('Origin')===`${req.protocol}://${req.get('host')}` ? next() : res.status(403).json({ error:'Foreign origin' });
  if(serveDemo) app.post('/__fixture/stop',sameOrigin,(req,res) => {
    if(req.body?.nonce!==stopNonce) { res.status(403).json({ error:'Invalid local demo stop token' });return; }
    res.json({ stopped:true });setTimeout(finishDemo,100);
  });
  registerEvaluationRoutes(app,pool,{ config:{},requireAuth,requireAdmin:(_req,_res,next) => next(),requireSameOrigin:sameOrigin });
  // Only these harmless shell reads are stubbed; evaluation endpoints use real routes and PostgreSQL.
  app.get('/api/me',(_req,res) => res.json({ user:{ ...context.user,display_name:'Evaluation certification' } }));
  app.get('/api/ui/overview',(_req,res) => res.json({ user:{ role:'platform_admin',displayName:'Evaluation certification' },stats:{ workflowsInReview:0 } }));
  app.get('/api/ui/runtime/codex',(_req,res) => res.json({ enabled:false,authenticated:false,activeRuns:0,runs:[] }));
  app.get('/api/ui/observability/traces/:id/feedback',(_req,res) => res.json({ feedback:[],summary:{ activeCount:0,labels:[],sentiments:{} } }));
  app.get('/api/ui/runs/agent/:id',(req,res) => res.json({ generatedAt:new Date().toISOString(),run:{ id:req.params.id,traceId:curation.traceId,kind:'agent',title:'Synthetic failed CI review',subtitle:'Local curation fixture',status:'failed',risk:'low',startedAt:new Date().toISOString(),durationMs:100,totalSteps:0,completedSteps:0 },steps:[],timeline:[],currentApproval:null,metrics:{ approvalCount:0 } }));
  app.get('/api/ui/navigation-capabilities',(_req,res) => res.json({ schemaVersion:1,actor:context.user,modules:[],permissions:[],navigation:{ canAdminPlatform:true,canRunEvaluations:true,canManageAgents:true,canManageKnowledge:true } }));
  app.get('/api/agents',(_req,res) => res.json([{ id:agent.id,name:prefix,label:'Incident summary reviewer',model:prefix+'baseline' }]));
  app.get('/api/ui/llm/catalog',(_req,res) => res.json({ models:models.map((m,i) => ({ id:m.id,modelName:prefix+(i ? 'candidate' : 'baseline'),displayName:i ? 'Candidate model' : 'Reference model',enabled:true,providerEnabled:true,providerLabel:'Local fake' })) }));
  app.use('/console-assets',express.static(resolve('argus-console/dist')));
  app.get(['/build/evaluations','/runs/agent/:id','/observe/quality'],async(_req,res) => {
    const html=await readFile(resolve('argus-console/dist/index.html'),'utf8');
    res.type('html').send(serveDemo ? html.replace('<body>',`<body><div style="position:fixed;bottom:0;left:0;right:0;z-index:99999;padding:8px;background:#662d00;color:white;text-align:center">LOCAL FIXTURE DEMO · synthetic answers and MFA · no live SSO, billing or production quality evidence
      <button type="button" data-demo-stop="${stopNonce}" onclick="fetch('/__fixture/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nonce:this.dataset.demoStop})}).then(r=>{if(r.ok)this.textContent='Demo stopped';else this.textContent='Stop failed'})">Stop demo</button></div>`) : html);
  });
  const base=await listen(app);
  const { certifyQualityInbox,certifyQualityEvaluationSignals }=await import('./lib/quality-inbox-certification.mjs');
  const quality=await certifyQualityInbox({ pool,context,check,base });
  await check('HTTP preflight requires admin scope and same-origin writes, validates input without model calls',async () => {
    const post=(headers={},body=input) => fetch(base+'/api/admin/evaluations/comparisons/preflight',{ method:'POST',headers:{ 'Content-Type':'application/json',...headers },body:JSON.stringify(body) });
    assert.equal((await post()).status,200);
    assert.equal((await post({ 'X-Fixture-Role':'viewer' })).status,403);
    assert.equal((await post({ Origin:'https://foreign.invalid' })).status,403);
    assert.equal((await post({},{})).status,400);
    assert.equal((await fetch(base+'/api/admin/evaluations/targets')).status,400);
    assert.equal(requests.length,0);
  });
  await check('curation HTTP routes reject unauthenticated role/scope, cross-origin and unreviewed imports',async () => {
    const post=(path,body,headers={}) => fetch(base+'/api/admin/evaluations'+path,{ method:'POST',headers:{ 'Content-Type':'application/json',...headers },body:JSON.stringify(body) });
    const source={ trace_id:curation.traceId };
    assert.equal((await post('/trace-preview',source,{ 'X-Fixture-Role':'viewer' })).status,403);
    assert.equal((await post('/trace-preview',source,{ Origin:'https://foreign.invalid' })).status,403);
    assert.equal((await post('/trace-preview',source,{ 'X-Argus-Tenant-Key':'foreign','X-Argus-Workspace-Key':'foreign' })).status,404);
    assert.equal((await post('/starter-sets/argus-dev-starter/import',{ reviewed:false })).status,400);
    assert.equal((await post('/trace-preview',source)).status,200);
    assert.equal(requests.length,0);
  });
  if (process.argv.includes('--browser')) {
    const { certifyBrowser }=await import('./lib/evaluation-authoring-browser.mjs');
    const draft=await store.createEvaluationDataset(pool,{ datasetKey:prefix+'-browser',version:1,name:'Browser incident checks',agentId:agent.id },ctx());
    await certifyBrowser({ base,datasetId:draft.id,modelPrefix:prefix,check,requests,curation,quality });
  }
  const { certifyExports }=await import('./lib/evaluation-export-certification.mjs');
  const demo=await certifyExports({ base,pool,context,ctx,agent,models,provider,input,curated,prefix,requests,check });
  await certifyQualityEvaluationSignals({ pool,context,check });
  if (!serveDemo) {
    const { certifySkillRevisions }=await import('./lib/skill-revision-certification.mjs');
    await certifySkillRevisions({ pool,base,context,input,agent,check,requests,failedComparisonId:demo.id,browser:process.argv.includes('--browser') });
    const { certifyPromptRevisions }=await import('./lib/prompt-revision-certification.mjs');
    await certifyPromptRevisions({ pool,base,context,input,agent,check,requests,failedComparisonId:demo.id,browser:process.argv.includes('--browser') });
    const { certifyExecutionReleases }=await import('./lib/evaluation-release-certification.mjs');
    await certifyExecutionReleases({ pool,base,context,input,prefix,provider,check,requests,failedComparisonId:demo.id,browser:process.argv.includes('--browser') });
  }
  if (serveDemo) {
    console.log(`\nLOCAL FIXTURE DEMO: ${base}/build/evaluations?comparison=${demo.id}\nNo live identity or provider. Use Stop demo in the banner (or Ctrl+C).\n`);
    await demoStop;
  }
  const report={ status:'passed',generated_at:new Date().toISOString(),evidence_kind:'local_fake_provider',auth_boundary:'fixture session; not a live SSO certification',paid_provider_calls:0,local_requests:requests.length,browser:process.argv.includes('--browser'),checks };
  await mkdir('test-results',{ recursive:true }); await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch(error) {
  const report={ status:'failed',generated_at:new Date().toISOString(),paid_provider_calls:0,local_requests:requests.length,checks,error_code:error.code ?? error.name,message:String(error.message).slice(0,800),stack:error.stack?.split('\n').slice(0,5) };
  await mkdir('test-results',{ recursive:true }); await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.error(JSON.stringify(report,null,2));
  process.exitCode=1;
} finally {
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
  if(process.connected) process.disconnect();
}
