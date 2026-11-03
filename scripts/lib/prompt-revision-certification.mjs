import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createPromptRevision,getAgentPromptState } from '../../dist/evaluation/promptRevisions.js';
import { createEvaluationComparison,getEvaluationComparisonDetail } from '../../dist/evaluation/comparisonStore.js';
import { previewPromptRelease,applyPromptRelease,previewPromptRollback,rollbackPromptRelease,listPromptReleases } from '../../dist/evaluation/promptReleases.js';

/** Runs solely inside the disposable loopback *_cert database and fake provider. */
export async function certifyPromptRevisions({ pool,base,context,input,agent,requests,check,browser:browserCheck,failedComparisonId }) {
  const ctx=()=>({ ...context,requestId:randomUUID(),user:{ ...context.user,mfa_method:'otp',mfa_verified_at:new Date().toISOString() } });
  const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
  const post=(path,body={},headers={})=>fetch(base+'/api/admin/evaluations'+path,{ method:'POST',headers:{ 'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers },body:JSON.stringify(body) });
  const read=async id=>(await pool.query('SELECT * FROM mcp_agents WHERE id=$1',[id])).rows[0];
  const makeDraft=async()=>{
    const a=(await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES ($1,'Prompt fixture',$2,'Use supplied context.') RETURNING id",[randomUUID(),input.baseline.model_ref])).rows[0];
    const source=await getAgentPromptState(pool,a.id,ctx());
    assert.equal(source.model_ref,input.baseline.model_ref,'An Agent without a runtime profile uses its native model alias');
    const body={ title:'Explicit incident guidance',system_prompt:'Identify the affected service from supplied evidence. Do not invent facts.',source_head_sha256:source.source_head_sha256 };
    const c=ctx(),draft=await createPromptRevision(pool,a.id,body,c);
    return { a,source,body,c,draft };
  };
  const makePair=async(fixture,run=true)=>{
    const target={ agent_id:fixture.a.id,model_ref:input.baseline.model_ref };
    const pair=await createEvaluationComparison(pool,{ ...input,name:'Saved prompt fixture',baseline:target,candidate:{ ...target,prompt_revision_id:fixture.draft.id } },ctx());
    if (run) {
      const result=await post(`/comparisons/${pair.id}/run`,{ acknowledge_cost:true });assert.equal(result.status,202,JSON.stringify(await result.json()));
      for (let n=0;n<150;n++) { const detail=await getEvaluationComparisonDetail(pool,pair.id,context);if(detail.comparison.status==='completed')return pair;await new Promise(r=>setTimeout(r,100)); }
      throw new Error('Prompt fixture comparison did not complete');
    }
    return pair;
  };
  const first=await makeDraft();
  await check('prompt history retains its original Bundle access boundary after Agent reassignment',async()=>{
    const f=await makeDraft();
    await pool.query('UPDATE mcp_agents SET bundle_ids=ARRAY[888] WHERE id=$1',[f.a.id]);
    const restricted={ ...ctx(),user:{ ...ctx().user,allowed_bundles:[888] } };
    assert.equal((await getAgentPromptState(pool,f.a.id,restricted)).revisions.length,0);
    await reject(()=>createPromptRevision(pool,f.a.id,f.body,{ ...restricted,requestId:f.c.requestId }),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('prompt drafts are immutable, token-free, secret-rejecting, scoped and idempotent',async()=>{
    const calls=requests.length;
    assert.equal((await createPromptRevision(pool,first.a.id,first.body,first.c)).id,first.draft.id);
    assert.equal((await read(first.a.id)).system_prompt,first.source.system_prompt);
    await reject(()=>createPromptRevision(pool,first.a.id,{ ...first.body,system_prompt:'[REDACTED]' },ctx()),'EVALUATION_PROMPT_REDACTED');
    await reject(()=>createPromptRevision(pool,first.a.id,{ ...first.body,system_prompt:first.source.system_prompt },ctx()),'EVALUATION_PROMPT_NO_CHANGE');
    await reject(()=>getAgentPromptState(pool,first.a.id,{ ...ctx(),workspaceKey:'foreign' }),'EVALUATION_REFERENCE_NOT_FOUND');
    assert.equal((await post(`/agents/${first.a.id}/prompt-revisions`,first.body,{ 'X-Fixture-Role':'viewer' })).status,403);
    assert.equal((await post(`/agents/${first.a.id}/prompt-revisions`,first.body,{ Origin:'https://foreign.invalid' })).status,403);
    await reject(()=>pool.query("UPDATE mcp_agent_prompt_revisions SET system_prompt='rewrite' WHERE id=$1",[first.draft.id]),'23514');
    await reject(()=>pool.query('DELETE FROM mcp_agent_prompt_revisions WHERE id=$1',[first.draft.id]),'23514');
    assert.equal(requests.length,calls);
    const target={ agent_id:first.a.id,model_ref:input.baseline.model_ref };
    await reject(()=>createEvaluationComparison(pool,{ ...input,baseline:target,candidate:{ agent_id:first.a.id,model_ref:input.candidate.model_ref,prompt_revision_id:first.draft.id } },ctx()),'EVALUATION_PROMPT_CONTEXT');
  });
  const before=requests.length,pair=await makePair(first);
  await check('same-model A/B sends active and saved prompts separately and freezes prompt identity',async()=>{
    assert.equal(requests.length,before+2);
    assert.ok(JSON.stringify(requests[before].messages).includes(first.source.system_prompt));
    assert.ok(!JSON.stringify(requests[before].messages).includes(first.draft.system_prompt));
    assert.ok(JSON.stringify(requests[before+1].messages).includes(first.draft.system_prompt));
    assert.equal(requests[before].model,requests[before+1].model);
    assert.equal((await read(first.a.id)).system_prompt,first.source.system_prompt);
    const detail=await getEvaluationComparisonDetail(pool,pair.id,context),candidate=detail.records.find(r=>r.variant==='candidate');
    const trace=(await pool.query('SELECT metadata FROM mcp_observability_traces WHERE id=$1',[candidate.results[0].trace_id])).rows[0];
    assert.equal(trace.metadata.agent_prompt_revision_id,first.draft.id);assert.equal(trace.metadata.agent_prompt_sha256,first.draft.content_sha256);
  });
  const preview=await previewPromptRelease(pool,pair.id,ctx()),body={ preview_sha256:preview.preview_sha256,reason:'Reviewed synthetic prompt comparison.',confirm:true };
  await check('prompt release blocks failed gates, missing MFA, foreign origin and stale preview',async()=>{
    await reject(()=>previewPromptRelease(pool,failedComparisonId,ctx()),'EVALUATION_RELEASE_GATE');
    for(const mode of ['local','stale','none']) assert.equal((await post(`/comparisons/${pair.id}/prompt-release`,body,{ 'X-Fixture-Mfa':mode })).status,428);
    assert.equal((await post(`/comparisons/${pair.id}/prompt-release`,body,{ Origin:'https://foreign.invalid' })).status,403);
    await reject(()=>applyPromptRelease(pool,pair.id,{ ...body,preview_sha256:'0'.repeat(64) },ctx()),'EVALUATION_PROMPT_STALE');
    assert.equal((await read(first.a.id)).system_prompt,first.source.system_prompt);
  });
  const auditFault=async(action,fn)=>{
    await pool.query(`CREATE FUNCTION prompt_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='${action}' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER prompt_audit_fault BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION prompt_audit_fault()`);
    try { await fn(); } finally { await pool.query('DROP TRIGGER prompt_audit_fault ON mcp_canonical_audit_events; DROP FUNCTION prompt_audit_fault()'); }
  };
  await check('prompt adoption rolls back when canonical audit fails',()=>auditFault('evaluation.prompt.release.applied',async()=>{
    await reject(()=>applyPromptRelease(pool,pair.id,body,ctx()),'P0001');
    assert.equal((await read(first.a.id)).system_prompt,first.source.system_prompt);assert.equal((await listPromptReleases(pool,pair.id,ctx())).length,0);
  }));
  let release;
  await check('competing prompt decisions serialize and retries never apply twice',async()=>{
    const contexts=[ctx(),ctx()],outcomes=await Promise.allSettled(contexts.map(c=>applyPromptRelease(pool,pair.id,body,c)));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(outcomes));
    const winner=outcomes.findIndex(x=>x.status==='fulfilled');release=outcomes[winner].value;
    assert.equal((await applyPromptRelease(pool,pair.id,body,contexts[winner])).id,release.id);
    const active=await read(first.a.id);assert.equal(active.system_prompt,first.draft.system_prompt);assert.equal(Number(active.prompt_revision_id),first.draft.id);assert.equal(active.model,input.baseline.model_ref);
    const event=(await pool.query("SELECT event_id,resource_type,payload_summary FROM mcp_canonical_audit_events WHERE action='evaluation.prompt.release.applied' AND resource_id=$1",[String(release.id)])).rows[0];
    assert.equal(event.resource_type,'agent_prompt_release');assert.ok(!JSON.stringify(event).includes(first.draft.system_prompt));assert.ok(!JSON.stringify(event).includes(body.reason));
    assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[event.event_id])).rows.length,1);
    await reject(()=>pool.query("UPDATE mcp_agent_prompt_releases SET reason='rewrite' WHERE id=$1",[release.id]),'23514');
  });
  await check('prompt rollback is separately audited, failure-atomic and idempotent',async()=>{
    const p=await previewPromptRollback(pool,release.id,ctx()),b={ ...body,preview_sha256:p.preview_sha256 },c=ctx();
    await auditFault('evaluation.prompt.release.rolled_back',async()=>{ await reject(()=>rollbackPromptRelease(pool,release.id,b,c),'P0001');assert.equal((await read(first.a.id)).system_prompt,first.draft.system_prompt); });
    const restored=await rollbackPromptRelease(pool,release.id,b,c);assert.equal(restored.source_release_id,release.id);
    assert.equal((await rollbackPromptRelease(pool,release.id,b,c)).id,restored.id);
    assert.equal((await read(first.a.id)).system_prompt,first.source.system_prompt);assert.equal((await read(first.a.id)).prompt_revision_id,null);
    await reject(()=>previewPromptRollback(pool,release.id,ctx()),'EVALUATION_PROMPT_ALREADY_REVERTED');
    await pool.query('UPDATE mcp_agents SET enabled=false WHERE id=$1',[first.a.id]);
    await reject(()=>createPromptRevision(pool,first.a.id,first.body,first.c),'EVALUATION_REFERENCE_NOT_FOUND');
    await reject(()=>rollbackPromptRelease(pool,release.id,b,c),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('stale drafts block evaluation and direct edits invalidate active revision pointers',async()=>{
    const f=await makeDraft(),p=await makePair(f,false);
    await pool.query("UPDATE mcp_agents SET system_prompt='Changed while drafting' WHERE id=$1",[f.a.id]);
    await reject(()=>makePair(f,false),'EVALUATION_PROMPT_STALE');
    const calls=requests.length;assert.equal((await post(`/comparisons/${p.id}/run`,{ acknowledge_cost:true })).status,409);assert.equal(requests.length,calls);
    const g=await makeDraft(),pair=await makePair(g),preview=await previewPromptRelease(pool,pair.id,ctx());
    const r=await applyPromptRelease(pool,pair.id,{ ...body,preview_sha256:preview.preview_sha256 },ctx());
    await pool.query("UPDATE mcp_agents SET system_prompt='Manual intervening edit' WHERE id=$1",[g.a.id]);
    assert.equal((await read(g.a.id)).prompt_revision_id,null);
    await reject(()=>previewPromptRollback(pool,r.id,ctx()),'EVALUATION_PROMPT_STALE');
  });
  if (browserCheck) {
    const { chromium,expect }=createRequire(resolve('argus-console/package.json'))('@playwright/test');
    const browser=await chromium.launch({ headless:true,...(process.env.EVALUATION_BROWSER_CHANNEL ? { channel:process.env.EVALUATION_BROWSER_CHANNEL } : process.platform==='win32' ? { channel:'msedge' } : {}) });
    const page=await browser.newPage({ viewport:{ width:1440,height:1050 },reducedMotion:'reduce' });
    await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    try { await check('Edge prompt draft, comparison, MFA release and rollback with dark/light/mobile views',async()=>{
      await page.goto(base+'/build/evaluations');const old=await read(agent.id),calls=requests.length;
      const workbench=page.getByRole('region',{ name:'Prompt drafts' });
      await workbench.getByLabel('Agent for prompt draft').selectOption(String(agent.id));
      await workbench.getByRole('button',{ name:'New prompt draft',exact:true }).click();
      const newPrompt='Summarize only the affected service stated in the incident evidence.';
      await workbench.getByLabel('Draft title').fill('Browser prompt improvement');await workbench.getByLabel('Candidate system prompt').fill(newPrompt);
      await workbench.getByRole('button',{ name:'Save prompt draft',exact:true }).click();await expect(workbench.getByText('Prompt draft saved. The active Agent was not changed.')).toBeVisible();
      assert.equal((await read(agent.id)).system_prompt,old.system_prompt);assert.equal(requests.length,calls);
      await workbench.getByRole('button',{ name:/Compare prompt #/ }).click();
      const dialog=page.getByRole('dialog',{ name:'Create comparison' });await dialog.getByLabel('Comparison dataset').selectOption(String(input.dataset_id));
      await dialog.getByRole('button',{ name:'Check comparison',exact:true }).click();await expect(dialog.getByText(/Changed: system prompt/)).toBeVisible();
      await dialog.getByRole('button',{ name:'Save comparison',exact:true }).click();await expect(dialog).not.toBeVisible();assert.equal(requests.length,calls);
      const compare=page.getByRole('region',{ name:'Paired comparisons' });await compare.getByRole('checkbox',{ name:/I authorize 2 new provider requests/ }).check();
      await compare.getByRole('button',{ name:'Start comparison',exact:true }).click();
      const panel=page.getByRole('region',{ name:'Controlled prompt release' });await panel.getByRole('button',{ name:'Review prompt release',exact:true }).click();
      await expect(panel.getByText(newPrompt,{ exact:true })).toBeVisible();const confirm=panel.getByRole('button',{ name:'Confirm prompt release with MFA' });await expect(confirm).toBeDisabled();
      await panel.getByLabel(/Prompt decision reason/).fill('Reviewed identical runtime and all synthetic criteria.');await panel.getByRole('checkbox').check();
      await panel.screenshot({ path:'test-results/prompt-release-dark.png' });await page.getByRole('button',{ name:'Use light theme' }).click();await panel.screenshot({ path:'test-results/prompt-release-light.png' });
      await page.getByRole('button',{ name:'Use dark theme' }).click();await page.setViewportSize({ width:390,height:844 });
      // Capture the actual viewport, not a tall element with fixed AppShell chrome overlaid mid-image.
      await panel.evaluate(el=>window.scrollBy(0,el.getBoundingClientRect().top-90));
      await page.screenshot({ path:'test-results/prompt-release-mobile.png' });
      await confirm.scrollIntoViewIfNeeded();await page.screenshot({ path:'test-results/prompt-release-mobile-confirm.png' });
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.setViewportSize({ width:1440,height:1050 });
      await page.setExtraHTTPHeaders({ 'X-Fixture-Mfa':'none' });await confirm.click();await expect(panel.getByRole('link',{ name:'Confirm MFA and return to comparison' })).toBeVisible();
      await page.setExtraHTTPHeaders({});await confirm.click();await expect(panel.getByText('Prompt decision saved and audited. No model was called.')).toBeVisible();assert.equal((await read(agent.id)).system_prompt,newPrompt);
      await panel.getByRole('button',{ name:/Review prompt rollback #/ }).click();await panel.getByLabel(/Prompt decision reason/).fill('Return the fixture to the previous prompt.');await panel.getByRole('checkbox').check();
      await panel.getByRole('button',{ name:'Confirm prompt rollback with MFA' }).click();await expect(panel.getByText(/Prompt rollback of #/)).toBeVisible();
      assert.equal((await read(agent.id)).system_prompt,old.system_prompt);assert.equal(requests.length,calls+2);
    }); } finally { await browser.close(); }
  }
}
