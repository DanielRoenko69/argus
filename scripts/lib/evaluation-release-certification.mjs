import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createEvaluationComparison } from '../../dist/evaluation/comparisonStore.js';
import { previewExecutionRelease,applyExecutionRelease,previewExecutionRollback,rollbackExecutionRelease,listExecutionReleases } from '../../dist/evaluation/releases.js';

/** Invoked only by the disposable *_cert harness. All inference goes to its loopback fake. */
export async function certifyExecutionReleases({ pool,base,context,input,prefix,provider,check,requests,failedComparisonId,browser:browserCheck }) {
  const ctx=()=>({ ...context,requestId:randomUUID(),user:{ ...context.user,mfa_method:'otp',mfa_verified_at:new Date().toISOString() } });
  const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
  const alias=prefix+'-release-candidate';
  await pool.query(`INSERT INTO mcp_models(model_name,display_name,provider,provider_id,upstream_model_name,supports_reasoning) VALUES ($1,'Release fixture','openai-compatible',$2,'baseline',false)`,[alias,provider.id]);
  const post=(path,body={},headers={})=>fetch(base+'/api/admin/evaluations'+path,{ method:'POST',headers:{ 'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers },body:JSON.stringify(body) });
  const make=async()=>{
    const agent=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES ($1,'Execution release fixture',$2,'Review supplied context') RETURNING id",[randomUUID(),input.baseline.model_ref])).rows[0];
    const c=await createEvaluationComparison(pool,{ ...input,name:'Execution release fixture',baseline:{ agent_id:agent.id,model_ref:input.baseline.model_ref },candidate:{ agent_id:agent.id,model_ref:alias } },ctx());
    assert.equal((await post(`/comparisons/${c.id}/run`,{ acknowledge_cost:true })).status,202);
    let detail;
    for (let i=0;i<150;i++) { detail=await(await fetch(base+`/api/admin/evaluations/comparisons/${c.id}`)).json();if(detail.comparison.status==='completed')break;await new Promise(r=>setTimeout(r,100)); }
    assert.equal(detail.summary.comparison_state,'passed',JSON.stringify(detail));return { id:c.id,agent:agent.id };
  };
  const first=await make(),p=await previewExecutionRelease(pool,first.id,ctx());
  const body={ preview_sha256:p.preview_sha256,reason:'Reviewed the synthetic regression evidence.',confirm:true };
  const model=async id=>(await pool.query('SELECT model FROM mcp_agents WHERE id=$1',[id])).rows[0].model;
  await check('release requires fresh MFA, scope, same-origin and a bound reviewed decision',async()=>{
    await reject(()=>previewExecutionRelease(pool,failedComparisonId,ctx()),'EVALUATION_RELEASE_GATE');
    for (const mode of ['local','stale','none']) assert.equal((await post(`/comparisons/${first.id}/release`,body,{ 'X-Fixture-Mfa':mode })).status,428);
    assert.equal((await post(`/comparisons/${first.id}/release`,body,{ 'X-Fixture-Role':'viewer' })).status,403);
    assert.equal((await post(`/comparisons/${first.id}/release`,body,{ Origin:'https://foreign.invalid' })).status,403);
    await reject(()=>previewExecutionRelease(pool,first.id,{ ...ctx(),workspaceKey:'foreign' }),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal((await post(`/comparisons/${first.id}/release`,{ ...body,actor_user_id:999 })).status,400);
    assert.equal(await model(first.agent),input.baseline.model_ref);
  });
  await check('audit failure rolls back Agent change and immutable release together',async()=>{
    await pool.query(`CREATE FUNCTION execution_release_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='evaluation.release.applied' THEN RAISE EXCEPTION 'fixture audit unavailable'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER execution_release_fault BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION execution_release_fault()`);
    try { await assert.rejects(()=>applyExecutionRelease(pool,first.id,body,ctx()));assert.equal(await model(first.agent),input.baseline.model_ref);assert.equal((await listExecutionReleases(pool,first.id,ctx())).length,0); }
    finally { await pool.query('DROP TRIGGER execution_release_fault ON mcp_canonical_audit_events; DROP FUNCTION execution_release_fault()'); }
  });
  let release,winningContext;
  await check('competing releases serialize; replay is idempotent and decisions plus outbox are immutable',async()=>{
    const contexts=[ctx(),ctx()];const results=await Promise.allSettled(contexts.map(c=>applyExecutionRelease(pool,first.id,body,c)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
    const index=results.findIndex(r=>r.status==='fulfilled');release=results[index].value;winningContext=contexts[index];
    assert.equal((await applyExecutionRelease(pool,first.id,body,winningContext)).id,release.id);
    await reject(()=>applyExecutionRelease(pool,first.id,{ ...body,reason:'Different decision' },winningContext),'EVALUATION_IDEMPOTENCY_CONFLICT');
    assert.equal(await model(first.agent),alias);
    const event=(await pool.query("SELECT event_id,resource_type,payload_summary FROM mcp_canonical_audit_events WHERE action='evaluation.release.applied' AND resource_id=$1",[String(release.id)])).rows;
    assert.equal(event.length,1);assert.equal(event[0].resource_type,'evaluation_execution_release');assert.ok(!JSON.stringify(event).includes(body.reason));
    assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[event[0].event_id])).rows.length,1);
    await reject(()=>pool.query("UPDATE mcp_evaluation_execution_releases SET reason='rewrite' WHERE id=$1",[release.id]),'23514');
    await reject(()=>pool.query('DELETE FROM mcp_evaluation_execution_releases WHERE id=$1',[release.id]),'23514');
    await pool.query('UPDATE mcp_agents SET enabled=false WHERE id=$1',[first.agent]);
    await reject(()=>applyExecutionRelease(pool,first.id,body,winningContext),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  // A separate fresh pair proves rollback without manually restoring a historical Agent head.
  const second=await make();
  let secondRelease;
  await check('rollback restores only the old execution choice as a new audited decision',async()=>{
    const p=await previewExecutionRelease(pool,second.id,ctx());secondRelease=await applyExecutionRelease(pool,second.id,{ ...body,preview_sha256:p.preview_sha256 },ctx());
    const preview=await previewExecutionRollback(pool,secondRelease.id,ctx()),c=ctx(),b={ ...body,preview_sha256:preview.preview_sha256 };
    const rollback=await rollbackExecutionRelease(pool,secondRelease.id,b,c);
    assert.equal(rollback.source_release_id,secondRelease.id);assert.equal(rollback.action,'rolled_back');assert.equal(await model(second.agent),input.baseline.model_ref);
    assert.equal((await rollbackExecutionRelease(pool,secondRelease.id,b,c)).id,rollback.id);
    await reject(()=>previewExecutionRollback(pool,secondRelease.id,ctx()),'EVALUATION_RELEASE_ALREADY_REVERTED');
    assert.equal((await listExecutionReleases(pool,second.id,ctx())).length,2);
  });
  if(browserCheck) {
    const third=await make();
    const { chromium,expect }=createRequire(resolve('argus-console/package.json'))('@playwright/test');
    const browser=await chromium.launch({ headless:true,...(process.env.EVALUATION_BROWSER_CHANNEL ? { channel:process.env.EVALUATION_BROWSER_CHANNEL } : process.platform==='win32' ? { channel:'msedge' } : {}) });
    const page=await browser.newPage({ viewport:{ width:1440,height:1050 },reducedMotion:'reduce' });
    await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    try { await check('Edge release review, MFA denial, confirmation and rollback; light/dark/mobile layout',async()=>{
      await page.goto(base+`/build/evaluations?comparison=${third.id}`);
      const panel=page.getByRole('region',{ name:'Controlled execution release' });
      await panel.getByRole('button',{ name:'Review execution release',exact:true }).click();
      const confirm=panel.getByRole('button',{ name:'Confirm release with MFA' });await expect(confirm).toBeDisabled();
      await panel.getByLabel(/Decision reason/).fill('Reviewed synthetic matching cases and unchanged policies.');await panel.getByRole('checkbox').check();
      await panel.screenshot({ path:'test-results/evaluation-release-dark.png' });
      await page.getByRole('button',{ name:'Use light theme' }).click();await panel.screenshot({ path:'test-results/evaluation-release-light.png' });
      await page.getByRole('button',{ name:'Use dark theme' }).click();await page.setViewportSize({ width:390,height:844 });
      await panel.screenshot({ path:'test-results/evaluation-release-mobile.png' });
      const overflow=await page.evaluate(()=>[...document.querySelectorAll('main *')].filter(e=>e.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(e=>({ tag:e.tagName,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right })));
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),{ message:JSON.stringify(overflow) }).toBe(true);await page.setViewportSize({ width:1440,height:1050 });
      await page.setExtraHTTPHeaders({ 'X-Fixture-Mfa':'none' });await confirm.click();await expect(panel.getByRole('link',{ name:'Confirm MFA and return to comparison' })).toBeVisible();
      await page.setExtraHTTPHeaders({});const calls=requests.length;await confirm.click();await expect(panel.getByText(/Decision saved and audited/)).toBeVisible();assert.equal(await model(third.agent),alias);
      await panel.getByRole('button',{ name:/Review rollback #/ }).click();await panel.getByLabel(/Decision reason/).fill('Restoring the known previous execution choice.');await panel.getByRole('checkbox').check();
      await panel.getByRole('button',{ name:'Confirm rollback with MFA' }).click();await expect(panel.getByText(/Rolled back #/)).toBeVisible();assert.equal(await model(third.agent),input.baseline.model_ref);assert.equal(requests.length,calls);
    }); } finally { await browser.close(); }
  }
  const last=await make();
  await check('stale preview blocks release; unavailable old target and intervening edits block rollback',async()=>{
    const p=await previewExecutionRelease(pool,last.id,ctx());
    await reject(()=>applyExecutionRelease(pool,last.id,{ ...body,preview_sha256:'0'.repeat(64) },ctx()),'EVALUATION_RELEASE_STALE');
    const r=await applyExecutionRelease(pool,last.id,{ ...body,preview_sha256:p.preview_sha256 },ctx());
    const back=await previewExecutionRollback(pool,r.id,ctx());
    await pool.query('UPDATE mcp_models SET enabled=false WHERE model_name=$1',[input.baseline.model_ref]);
    await reject(()=>rollbackExecutionRelease(pool,r.id,{ ...body,preview_sha256:back.preview_sha256 },ctx()),'EVALUATION_TARGET_UNAVAILABLE');
    assert.equal(await model(last.agent),alias);assert.equal((await listExecutionReleases(pool,last.id,ctx())).length,1);
    await pool.query("UPDATE mcp_agents SET system_prompt='Intervening edit' WHERE id=$1",[last.agent]);
    await reject(()=>previewExecutionRollback(pool,r.id,ctx()),'EVALUATION_RELEASE_STALE');
    await reject(()=>previewExecutionRelease(pool,last.id,ctx()),'EVALUATION_TARGET_UNAVAILABLE');
  });
}
