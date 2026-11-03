#!/usr/bin/env node
// Explicit disposable database + loopback fake provider only. No live models.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import express from 'express';
import pg from 'pg';
import * as store from '../dist/evaluation/store.js';
import { executeEvaluationExperiment, retryEvaluationExperiment } from '../dist/evaluation/runner.js';
import { cancelEvaluationExperiment, recoverEvaluationExperiments, startEvaluationRecoveryWorker, evaluationProgress } from '../dist/evaluation/lifecycle.js';
import { compareEvaluationEvidence } from '../dist/evaluation/regression.js';
import { registerEvaluationRoutes } from '../dist/evaluation/routes.js';

const url=process.env.EVALUATION_CERTIFICATION_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_cert')) throw new Error('Explicit disposable *_cert database required');
const pool=new pg.Pool({ connectionString:url,max:8,connectionTimeoutMillis:10000 });
if (process.argv.includes('--worker')) {
  process.once('message',async ({ id,context }) => {
    try { const job=await executeEvaluationExperiment(pool,{},id,context); await job.completion; process.send?.({ done:true }); }
    catch { process.send?.({ failed:true }); }
    finally { await pool.end(); process.disconnect(); }
  });
} else {
  const prefix='eval-recovery-'+randomUUID();
  const checks=[],requests=[],servers=[],children=[],held=[];
  let mode='ok',modeCalls=0;
  const setMode=value => { mode=value; modeCalls=0; };
  const check=async (name,fn) => { await fn(); checks.push({ name,status:'passed' }); };
  const wait=async (predicate) => { const deadline=Date.now()+15000; while (!await predicate()) { if (Date.now()>deadline) throw new Error('Fixture wait timeout'); await new Promise(r=>setTimeout(r,50)); } };
  const listen=async app => { const server=await new Promise(resolve => { const s=app.listen(0,'127.0.0.1',()=>resolve(s)); }); servers.push(server); return 'http://127.0.0.1:'+server.address().port; };
  const rejects=(fn,code) => assert.rejects(fn,e => e.code===code);
  const expire=id => pool.query("UPDATE mcp_evaluation_workers SET leased_until=clock_timestamp()-interval '1 second' WHERE experiment_id=$1",[id]);
  try {
    const fake=express(); fake.use(express.json());
    const answer=res => res.json({ model:'fixture',choices:[{ index:0,message:{ role:'assistant',content:'OK' },finish_reason:'stop' }],usage:{ prompt_tokens:5,completion_tokens:1,total_tokens:6 } });
    fake.post('/v1/chat/completions',(req,res) => {
      requests.push(req.body); modeCalls++;
      if (mode==='hold' || mode==='second_hold' && modeCalls===2) { held.push(res); return; }
      answer(res);
    });
    const base=await listen(fake);
    const user=(await pool.query("INSERT INTO mcp_users(username,display_name,password_hash,role) VALUES($1,'Fixture','not-a-password','platform_admin') RETURNING id",[prefix])).rows[0];
    const context={ user:{ id:user.id,username:prefix,role:'platform_admin',allowed_bundles:null,entra_groups:[],auth_method:'oidc' },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'' };
    const provider=(await pool.query("INSERT INTO mcp_llm_providers(name,label,provider_type,base_url,auth_type) VALUES($1,'Fake provider','openai-compatible',$2,'none') RETURNING id",[prefix,base+'/v1'])).rows[0];
    await pool.query("INSERT INTO mcp_models(model_name,provider,provider_id,upstream_model_name,input_cost_per_1k,output_cost_per_1k,supports_reasoning) VALUES($1,'openai-compatible',$2,'fixture',0.01,0.02,false)",[prefix,provider.id]);
    const agent=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES($1,'Fixture',$1,'Fixture') RETURNING id",[prefix])).rows[0];
    const ds=await store.createEvaluationDataset(pool,{ datasetKey:prefix,version:1,name:'Recovery fixture',agentId:agent.id },context);
    for (const key of ['a','b','c']) await store.createEvaluationCase(pool,ds.id,{ caseKey:key,input:key,rules:{ version:'argus.deterministic.v1',assertions:[{ type:'text_equals',value:'OK' }] } },context);
    await store.activateEvaluationDataset(pool,ds.id,context);
    const create=baseline => store.createEvaluationExperiment(pool,{ datasetId:ds.id,agentId:agent.id,modelRef:prefix,baselineExperimentId:baseline ?? null },context);
    const load=id => store.getEvaluationExperiment(pool,id,context);
    const start=e => executeEvaluationExperiment(pool,{},e.id,context);
    const startChild=e => { const c=fork(fileURLToPath(import.meta.url),['--worker'],{ stdio:['ignore','ignore','inherit','ipc'] }); children.push(c); c.send({ id:e.id,context }); return c; };
    const baseline=await create(); await (await start(baseline)).completion;
    let cancelled,firstResult;
    await check('cross-process cancellation stops further cases and retains finished evidence',async () => {
      setMode('second_hold'); cancelled=await create(baseline.id); const before=requests.length;
      const worker=startChild(cancelled); const exited=once(worker,'exit');
      await wait(()=>requests.length===before+2);
      firstResult=(await load(cancelled.id)).results[0]; assert.ok(firstResult);
      await cancelEvaluationExperiment(pool,cancelled.id,{ ...context,requestId:'cancel-'+cancelled.id });
      await exited;
      const record=await load(cancelled.id);
      assert.equal(record.experiment.status,'cancelled'); assert.equal(requests.length,before+2);
      assert.deepEqual(record.results[0],firstResult); assert.equal(record.results[1].status,'error');
      assert.equal(record.results[1].cost_usd,null);
      assert.equal(evaluationProgress(record).retryable_case_ids.length,2);
    });
    await check('retry is explicit, scoped and idempotent; successful cases are never reissued',async () => {
      setMode('ok'); const record=await load(cancelled.id),ids=evaluationProgress(record).retryable_case_ids,before=requests.length;
      const input={ case_ids:ids,acknowledge_possible_duplicate_cost:true },ctx={ ...context,requestId:'retry-'+cancelled.id };
      await assert.rejects(()=>retryEvaluationExperiment(pool,cancelled.id,{ case_ids:ids },ctx));
      await rejects(()=>retryEvaluationExperiment(pool,cancelled.id,input,{ ...ctx,requestId:'' }),'EVALUATION_IDEMPOTENCY_REQUIRED');
      await rejects(()=>retryEvaluationExperiment(pool,cancelled.id,{ ...input,case_ids:[firstResult.case_id] },context),'EVALUATION_IDEMPOTENCY_REQUIRED');
      await rejects(()=>retryEvaluationExperiment(pool,cancelled.id,{ ...input,case_ids:[firstResult.case_id] },ctx),'EVALUATION_RETRY_NOT_ELIGIBLE');
      const other={ ...ctx,workspaceKey:'other',user:{ ...ctx.user,workspace_scopes:[{ tenantKey:'default',workspaceKey:'other',isDefault:true }] } };
      await rejects(()=>retryEvaluationExperiment(pool,cancelled.id,input,other),'EVALUATION_REFERENCE_NOT_FOUND');
      const jobs=await Promise.all([retryEvaluationExperiment(pool,cancelled.id,input,ctx),retryEvaluationExperiment(pool,cancelled.id,input,ctx)]);
      await Promise.all(jobs.map(j=>j.completion));
      const done=await load(cancelled.id);
      assert.equal(requests.length,before+2); assert.equal(done.experiment.status,'completed');
      assert.equal(done.results.length,4); assert.deepEqual(done.results[0],firstResult);
      const comparison=compareEvaluationEvidence(done,await load(baseline.id));
      assert.equal(comparison.comparison_state,'passed'); assert.equal(comparison.candidate.costCoverage.total,4);
      assert.equal(comparison.candidate.costUsd,undefined);
      await rejects(()=>retryEvaluationExperiment(pool,cancelled.id,{ ...input,case_ids:[ids[0]] },ctx),'EVALUATION_IDEMPOTENCY_CONFLICT');
      await rejects(()=>pool.query("UPDATE mcp_evaluation_results SET status='passed' WHERE id=$1",[done.results[1].id]),'23514');
      await rejects(()=>pool.query('DELETE FROM mcp_evaluation_attempts WHERE experiment_id=$1',[cancelled.id]),'23514');
    });
    await check('actual worker process loss becomes interrupted without dispatch; recovery is idempotent',async () => {
      setMode('hold'); const e=await create(),before=requests.length;
      const child=startChild(e); const exited=once(child,'exit');
      await wait(()=>requests.length===before+1); child.kill(); await exited;
      await expire(e.id);
      const recovered=await Promise.all([recoverEvaluationExperiments(pool,'test'),recoverEvaluationExperiments(pool,'test')]);
      assert.equal(recovered.reduce((a,b)=>a+b,0),1); assert.equal(requests.length,before+1);
      const record=await load(e.id);
      assert.equal(record.experiment.status,'interrupted'); assert.equal(record.attempts.length,1); assert.equal(record.results.length,0);
      assert.equal(evaluationProgress(record).pending_attempts,1);
      assert.equal(await recoverEvaluationExperiments(pool,'test'),0);
      const events=(await pool.query("SELECT event_id,actor_type FROM mcp_canonical_audit_events WHERE resource_id=$1 AND action='evaluation.experiment.interrupted'",[String(e.id)])).rows;
      assert.equal(events.length,1); assert.equal(events[0].actor_type,'system');
      assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[events[0].event_id])).rows.length,1);
    });
    await check('expired worker cannot commit a late response or finish a recovered run',async () => {
      setMode('hold'); const e=await create(),before=requests.length;
      const job=await start(e); const rejected=assert.rejects(job.completion,error=>error.code==='EVALUATION_WORKER_FENCED');
      await wait(()=>requests.length===before+1); await expire(e.id); await recoverEvaluationExperiments(pool,'test');
      answer(held.at(-1)); await rejected;
      const record=await load(e.id); assert.equal(record.experiment.status,'interrupted'); assert.equal(record.results.length,0);
      assert.equal(requests.length,before+1);
    });
    await check('live heartbeat prevents false recovery while provider is slow',async () => {
      setMode('hold'); const e=await create(),before=requests.length,job=await start(e);
      await wait(()=>requests.length===before+1);
      const initial=(await load(e.id)).lease_expires_at;
      await wait(async () => new Date((await load(e.id)).lease_expires_at)>new Date(initial));
      assert.equal(await recoverEvaluationExperiments(pool,'test'),0);
      await cancelEvaluationExperiment(pool,e.id,context); await job.completion;
      assert.equal((await load(e.id)).experiment.status,'cancelled');
    });
    await check('audit failure after provider dispatch keeps start evidence and never reissues',async () => {
      setMode('ok'); const e=await create(),before=requests.length;
      await pool.query(`CREATE OR REPLACE FUNCTION fixture_reject_evaluation_result() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='evaluation.result.recorded' AND NEW.actor_id='${Number(user.id)}' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_evaluation_audit_failure BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_evaluation_result();`);
      try { const job=await start(e); await assert.rejects(job.completion); }
      finally { await pool.query('DROP TRIGGER fixture_evaluation_audit_failure ON mcp_canonical_audit_events; DROP FUNCTION fixture_reject_evaluation_result()'); }
      const record=await load(e.id); assert.equal(record.experiment.status,'running'); assert.equal(record.results.length,0); assert.equal(record.attempts.length,1);
      await expire(e.id); await recoverEvaluationExperiments(pool,'test');
      assert.equal((await load(e.id)).experiment.status,'interrupted'); assert.equal(requests.length,before+1);
    });
    await check('HTTP cancellation, strict retry validation, progress and queued cancellation without provider',async () => {
      const app=express(); app.use(express.json());
      registerEvaluationRoutes(app,pool,{ config:{},requireAuth:(req,_res,next)=>{ req.user=context.user; next(); },requireAdmin:(_req,_res,next)=>next(),requireSameOrigin:(_req,_res,next)=>next() });
      const api=await listen(app),e=await create(),before=requests.length;
      const response=await fetch(`${api}/api/admin/evaluations/experiments/${e.id}/cancel`,{ method:'POST',headers:{ 'content-type':'application/json' },body:'{}' });
      assert.equal(response.status,202); assert.equal((await response.json()).status,'cancelled');
      const detail=await (await fetch(`${api}/api/admin/evaluations/experiments/${e.id}`)).json();
      assert.equal(detail.progress.total_cases,3); assert.equal(detail.progress.retryable_case_ids.length,3);
      const bad=await fetch(`${api}/api/admin/evaluations/experiments/${e.id}/retry`,{ method:'POST',headers:{ 'content-type':'application/json','Idempotency-Key':'fixture-http-retry' },body:JSON.stringify({ case_ids:detail.progress.retryable_case_ids }) });
      assert.equal(bad.status,400); assert.equal(requests.length,before);
    });
    await check('startup recovery finalizes fully recorded evidence without replaying completed cases',async () => {
      setMode('ok'); const e=await create(),before=requests.length;
      await pool.query(`CREATE OR REPLACE FUNCTION fixture_reject_evaluation_finish() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='evaluation.experiment.finished' AND NEW.actor_id='${Number(user.id)}' THEN RAISE EXCEPTION 'fixture finish failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fixture_evaluation_finish_failure BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION fixture_reject_evaluation_finish();`);
      try { await assert.rejects((await start(e)).completion); }
      finally { await pool.query('DROP TRIGGER fixture_evaluation_finish_failure ON mcp_canonical_audit_events; DROP FUNCTION fixture_reject_evaluation_finish()'); }
      const pending=await load(e.id); assert.equal(pending.experiment.status,'running'); assert.equal(pending.results.length,3);
      await expire(e.id);
      const worker=startEvaluationRecoveryWorker(pool,'test');
      try { await wait(async () => (await load(e.id)).experiment.status==='completed'); }
      finally { worker.stop(); }
      assert.equal(requests.length,before+3);
      assert.deepEqual((await load(e.id)).results,pending.results);
    });
    const report={ status:'passed',checks,provider:'loopback fixture only',fake_requests:requests.length,paid_requests:0 };
    await mkdir('test-results',{ recursive:true }); await writeFile('test-results/evaluation-recovery.json',JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(report,null,2));
  } catch(error) { console.error(JSON.stringify({ status:'failed',checks,error_code:error.code,message:error.message },null,2)); process.exitCode=1; }
  finally {
    for (const c of children) if (c.exitCode===null && c.signalCode===null) c.kill();
    for (const res of held) res.destroy();
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
    await pool.end();
  }
}
