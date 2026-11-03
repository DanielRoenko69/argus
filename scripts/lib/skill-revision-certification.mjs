import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createSkill,updateSkill,setAgentSkills,readPinnedAgentSkills } from '../../dist/agents/skillStore.js';
import { createSkillRevision,getAgentSkillState } from '../../dist/evaluation/skillRevisions.js';
import { createEvaluationComparison,getEvaluationComparisonDetail } from '../../dist/evaluation/comparisonStore.js';
import { previewSkillRelease,applySkillRelease,previewSkillRollback,rollbackSkillRelease,listSkillReleases } from '../../dist/evaluation/skillReleases.js';

/** Disposable *_cert database, loopback fake provider, fixture identities only. */
export async function certifySkillRevisions({ pool,base,context,input,agent,requests,check,browser:browserCheck,failedComparisonId }) {
  const ctx=()=>({ ...context,requestId:randomUUID(),user:{ ...context.user,mfa_method:'otp',mfa_verified_at:new Date().toISOString() } });
  const reject=(fn,code)=>assert.rejects(fn,e=>e.code===code);
  const post=(path,body={},headers={})=>fetch(base+'/api/admin/evaluations'+path,{ method:'POST',headers:{ 'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers },body:JSON.stringify(body) });
  const read=async id=>(await readPinnedAgentSkills(pool,id))[0];
  const makeDraft=async()=>{
    const ids=[];
    for (let n=0;n<2;n++) ids.push((await pool.query("INSERT INTO mcp_agents(name,label,model,system_prompt) VALUES($1,'Skill fixture',$2,'Use the supplied context.') RETURNING id",[randomUUID(),input.baseline.model_ref])).rows[0].id);
    const skill=await createSkill(pool,{ name:'skill-'+randomUUID(),label:'Incident guidance',content:'Identify the affected service from evidence.' });
    for (const id of ids) await setAgentSkills(pool,id,[skill.id]);
    const active=await read(ids[0]),source=await getAgentSkillState(pool,ids[0],ctx());
    const body={ skill_id:skill.id,title:'Precise incident guidance',content:'Identify the affected service and distinguish observations from assumptions.',source_head_sha256:source.source_head_sha256 };
    const c=ctx(),draft=(await createSkillRevision(pool,ids[0],body,c));
    return { id:ids[0],peer:ids[1],skill,active,body,c,draft };
  };
  const makePair=async(f,run=true,revisionId=f.draft.id)=>{
    const target={ agent_id:f.id,model_ref:input.baseline.model_ref };
    const pair=await createEvaluationComparison(pool,{ ...input,name:'Saved Skill fixture',baseline:target,candidate:{ ...target,skill_revision_id:revisionId } },ctx());
    if (run) {
      const result=await post(`/comparisons/${pair.id}/run`,{ acknowledge_cost:true });assert.equal(result.status,202,JSON.stringify(await result.json()));
      for (let n=0;n<150;n++) { const d=await getEvaluationComparisonDetail(pool,pair.id,context);if(d.comparison.status==='completed')return pair;await new Promise(r=>setTimeout(r,100)); }
      throw new Error('Skill fixture comparison did not complete');
    }
    return pair;
  };
  const f=await makeDraft();
  await check('Skill imports and assignment saves preserve pins; new assignments select the catalog version',async()=>{
    const calls=requests.length;
    const updated=await updateSkill(pool,f.skill.id,{ content:'New library guidance: include the affected service.',source_ref:'fixture-main' });
    assert.notEqual(Number(updated.current_revision_id),f.active.revision_id);
    await setAgentSkills(pool,f.id,[f.skill.id]);
    assert.equal((await read(f.id)).revision_id,f.active.revision_id);assert.equal((await read(f.peer)).content,f.active.content);
    // A newly attached Agent gets the newest published catalog, never an Agent draft.
    const third=(await pool.query("INSERT INTO mcp_agents(name,label,model) VALUES($1,'New Skill consumer',$2) RETURNING id",[randomUUID(),input.baseline.model_ref])).rows[0].id;
    await setAgentSkills(pool,third,[f.skill.id]);assert.equal((await read(third)).revision_id,Number(updated.current_revision_id));
    const unchanged=await updateSkill(pool,f.skill.id,{ content:updated.content,imported_at:new Date().toISOString() });assert.equal(unchanged.current_revision_id,updated.current_revision_id);
    assert.equal(requests.length,calls);
  });
  await check('Skill history and pins are immutable, content-verified and bound to one Skill and Agent',async()=>{
    assert.equal((await createSkillRevision(pool,f.id,f.body,f.c)).id,f.draft.id);
    await reject(()=>pool.query("UPDATE mcp_skill_revisions SET content='rewritten' WHERE id=$1",[f.draft.id]),'23514');
    await reject(()=>pool.query('DELETE FROM mcp_skill_revisions WHERE id=$1',[f.active.revision_id]),'23514');
    await reject(()=>pool.query('UPDATE mcp_agent_skills SET revision_id=$1 WHERE agent_id=$2',[f.draft.id,f.peer]),'23514');
    const other=await createSkill(pool,{ name:'other-'+randomUUID(),label:'Other',content:'Other instructions' });
    await reject(()=>pool.query('UPDATE mcp_agent_skills SET revision_id=$1 WHERE agent_id=$2',[other.current_revision_id,f.id]),'23503');
    await reject(()=>createSkillRevision(pool,f.id,{ ...f.body,content:'[REDACTED]' },ctx()),'EVALUATION_SKILL_REDACTED');
    await reject(()=>createSkillRevision(pool,f.id,{ ...f.body,content:f.active.content },ctx()),'EVALUATION_SKILL_NO_CHANGE');
    assert.equal((await post(`/agents/${f.id}/skill-revisions`,f.body,{ 'X-Fixture-Role':'viewer' })).status,403);
    assert.equal((await post(`/agents/${f.id}/skill-revisions`,f.body,{ Origin:'https://foreign.invalid' })).status,403);
    await reject(()=>getAgentSkillState(pool,f.id,{ ...ctx(),workspaceKey:'foreign' }),'EVALUATION_REFERENCE_NOT_FOUND');
    await reject(()=>makePair({ ...f,id:f.peer },false),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('saved Skill drafts retain historical Bundle scope even after Agent reassignment',async()=>{
    const g=await makeDraft();await pool.query('UPDATE mcp_agents SET bundle_ids=ARRAY[888] WHERE id=$1',[g.id]);
    const c={ ...ctx(),user:{ ...ctx().user,allowed_bundles:[888] } };
    assert.equal((await getAgentSkillState(pool,g.id,c)).skills[0].revisions.some(r=>r.id===g.draft.id),false);
    await reject(()=>createSkillRevision(pool,g.id,g.body,{ ...c,requestId:g.c.requestId }),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  const calls=requests.length,pair=await makePair(f);
  await check('same-model A/B sends exact pinned and candidate Skills; traces freeze version identity',async()=>{
    assert.equal(requests.length,calls+2);assert.equal(requests[calls].model,requests[calls+1].model);
    assert.ok(JSON.stringify(requests[calls].messages).includes(f.active.content));assert.ok(!JSON.stringify(requests[calls].messages).includes(f.body.content));
    assert.ok(JSON.stringify(requests[calls+1].messages).includes(f.body.content));
    const detail=await getEvaluationComparisonDetail(pool,pair.id,context),candidate=detail.records.find(r=>r.variant==='candidate');
    const trace=(await pool.query('SELECT metadata FROM mcp_observability_traces WHERE id=$1',[candidate.results[0].trace_id])).rows[0];
    assert.equal(trace.metadata.agent_skill_revisions[0].revision_id,f.draft.id);assert.equal((await read(f.id)).revision_id,f.active.revision_id);
  });
  const preview=await previewSkillRelease(pool,pair.id,ctx()),body={ preview_sha256:preview.preview_sha256,reason:'Reviewed synthetic Skill evidence.',confirm:true };
  await check('Skill release enforces passing evidence, fresh MFA, same origin and reviewed digest',async()=>{
    await reject(()=>previewSkillRelease(pool,failedComparisonId,ctx()),'EVALUATION_RELEASE_GATE');
    for (const mode of ['local','stale','none']) assert.equal((await post(`/comparisons/${pair.id}/skill-release`,body,{ 'X-Fixture-Mfa':mode })).status,428);
    assert.equal((await post(`/comparisons/${pair.id}/skill-release`,body,{ Origin:'https://foreign.invalid' })).status,403);
    await reject(()=>applySkillRelease(pool,pair.id,{ ...body,preview_sha256:'0'.repeat(64) },ctx()),'EVALUATION_SKILL_STALE');
    assert.equal((await read(f.id)).revision_id,f.active.revision_id);
  });
  const auditFault=async(action,fn)=>{
    await pool.query(`CREATE FUNCTION skill_audit_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.action='${action}' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER skill_audit_fault BEFORE INSERT ON mcp_canonical_audit_events FOR EACH ROW EXECUTE FUNCTION skill_audit_fault()`);
    try { await fn(); } finally { await pool.query('DROP TRIGGER skill_audit_fault ON mcp_canonical_audit_events; DROP FUNCTION skill_audit_fault()'); }
  };
  await check('Skill pin and decision roll back if canonical audit fails',()=>auditFault('evaluation.skill.release.applied',async()=>{
    await reject(()=>applySkillRelease(pool,pair.id,body,ctx()),'P0001');assert.equal((await read(f.id)).revision_id,f.active.revision_id);assert.equal((await listSkillReleases(pool,pair.id,ctx())).length,0);
  }));
  let release;
  await check('concurrent Skill releases have one winner, retry once and never change peer Agents or Library',async()=>{
    const contexts=[ctx(),ctx()],outcomes=await Promise.allSettled(contexts.map(c=>applySkillRelease(pool,pair.id,body,c)));
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1,JSON.stringify(outcomes));const winner=outcomes.findIndex(x=>x.status==='fulfilled');release=outcomes[winner].value;
    assert.equal((await applySkillRelease(pool,pair.id,body,contexts[winner])).id,release.id);
    assert.equal((await read(f.id)).revision_id,f.draft.id);assert.equal((await read(f.peer)).revision_id,f.active.revision_id);
    assert.notEqual((await pool.query('SELECT content FROM mcp_skills WHERE id=$1',[f.skill.id])).rows[0].content,f.body.content);
    const event=(await pool.query("SELECT event_id,resource_type,payload_summary FROM mcp_canonical_audit_events WHERE action='evaluation.skill.release.applied' AND resource_id=$1",[String(release.id)])).rows[0];
    assert.equal(event.resource_type,'agent_skill_release');assert.ok(!JSON.stringify(event).includes(f.body.content));assert.ok(!JSON.stringify(event).includes(body.reason));
    assert.equal((await pool.query('SELECT id FROM mcp_canonical_audit_outbox WHERE event_id=$1',[event.event_id])).rows.length,1);
    await reject(()=>pool.query("UPDATE mcp_agent_skill_releases SET reason='rewritten' WHERE id=$1",[release.id]),'23514');
  });
  await check('Skill rollback is failure-atomic, separately audited and idempotent',async()=>{
    const p=await previewSkillRollback(pool,release.id,ctx()),b={ ...body,preview_sha256:p.preview_sha256 },c=ctx();
    await auditFault('evaluation.skill.release.rolled_back',async()=>{ await reject(()=>rollbackSkillRelease(pool,release.id,b,c),'P0001');assert.equal((await read(f.id)).revision_id,f.draft.id); });
    const restored=await rollbackSkillRelease(pool,release.id,b,c);assert.equal((await rollbackSkillRelease(pool,release.id,b,c)).id,restored.id);
    assert.equal((await read(f.id)).revision_id,f.active.revision_id);assert.equal((await read(f.peer)).revision_id,f.active.revision_id);
    await reject(()=>previewSkillRollback(pool,release.id,ctx()),'EVALUATION_SKILL_ALREADY_REVERTED');
    await pool.query('UPDATE mcp_agents SET enabled=false WHERE id=$1',[f.id]);await reject(()=>rollbackSkillRelease(pool,release.id,b,c),'EVALUATION_REFERENCE_NOT_FOUND');
  });
  await check('draft/source drift blocks dispatch and intervening changes block rollback',async()=>{
    const g=await makeDraft(),p=await makePair(g,false);await pool.query("UPDATE mcp_agents SET system_prompt='Intervening edit' WHERE id=$1",[g.id]);
    await reject(()=>makePair(g,false),'EVALUATION_SKILL_STALE');const calls=requests.length;
    assert.equal((await post(`/comparisons/${p.id}/run`,{ acknowledge_cost:true })).status,409);assert.equal(requests.length,calls);
    const h=await makeDraft(),q=await makePair(h),v=await previewSkillRelease(pool,q.id,ctx());
    const r=await applySkillRelease(pool,q.id,{ ...body,preview_sha256:v.preview_sha256 },ctx());
    await pool.query('UPDATE mcp_agent_skills SET position=position+1 WHERE agent_id=$1',[h.id]);await reject(()=>previewSkillRollback(pool,r.id,ctx()),'EVALUATION_SKILL_STALE');
  });
  await check('imported catalog versions can be reviewed and released to one Agent; disabled Skills fail closed',async()=>{
    const g=await makeDraft(),v=await updateSkill(pool,g.skill.id,{ content:'Imported runbook: distinguish observations from assumptions.' });
    const p=await makePair(g,true,Number(v.current_revision_id)),preview=await previewSkillRelease(pool,p.id,ctx());
    await applySkillRelease(pool,p.id,{ ...body,preview_sha256:preview.preview_sha256 },ctx());
    assert.equal((await read(g.id)).revision_id,Number(v.current_revision_id));assert.equal((await read(g.peer)).revision_id,g.active.revision_id);
    await pool.query('UPDATE mcp_skills SET enabled=false WHERE id=$1',[g.skill.id]);
    const response=await fetch(base+`/api/admin/evaluations/agents/${g.id}/skill-revisions`);assert.equal(response.status,409);assert.equal((await response.json()).code,'EVALUATION_SKILL_UNAVAILABLE');
    await assert.rejects(()=>read(g.id),e=>e.name==='SkillPinUnavailableError');
  });
  if (browserCheck) {
    const skill=await createSkill(pool,{ name:'browser-'+randomUUID(),label:'Browser Skill',content:'Use the affected service from supplied evidence.' });await setAgentSkills(pool,agent.id,[skill.id]);
    const { chromium,expect }=createRequire(resolve('argus-console/package.json'))('@playwright/test');
    const browser=await chromium.launch({ headless:true,...(process.env.EVALUATION_BROWSER_CHANNEL ? { channel:process.env.EVALUATION_BROWSER_CHANNEL } : process.platform==='win32' ? { channel:'msedge' } : {}) });
    const page=await browser.newPage({ viewport:{ width:1440,height:1050 },reducedMotion:'reduce' });await page.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
    try { await check('Edge Skill draft, same-model comparison, MFA release and rollback in dark/light/mobile',async()=>{
      await page.goto(base+'/build/evaluations');const calls=requests.length,old=await read(agent.id),newContent='State the affected service and separate facts from uncertainty.';
      const workbench=page.getByRole('region',{ name:'Skill drafts' });await workbench.getByLabel('Agent for Skill draft').selectOption(String(agent.id));await workbench.getByLabel('Attached Skill').selectOption(String(skill.id));
      await workbench.getByRole('button',{ name:'New Skill draft',exact:true }).click();await workbench.getByLabel('Candidate Skill instructions').fill(newContent);
      await workbench.getByRole('button',{ name:'Save Skill draft',exact:true }).click();await expect(workbench.getByText('Skill draft saved. Active Agents and the Library were not changed.')).toBeVisible();
      assert.equal((await read(agent.id)).revision_id,old.revision_id);assert.equal(requests.length,calls);
      await workbench.locator('button:not(:disabled)').filter({ hasText:/Compare Skill #/ }).click();
      const dialog=page.getByRole('dialog',{ name:'Create comparison' });await dialog.getByLabel('Comparison dataset').selectOption(String(input.dataset_id));await dialog.getByRole('button',{ name:'Check comparison',exact:true }).click();
      await expect(dialog.getByText(/Changed: Skills/)).toBeVisible();await dialog.getByRole('button',{ name:'Save comparison',exact:true }).click();await expect(dialog).not.toBeVisible();assert.equal(requests.length,calls);
      const compare=page.getByRole('region',{ name:'Paired comparisons' });await compare.getByRole('checkbox',{ name:/I authorize 2 new provider requests/ }).check();await compare.getByRole('button',{ name:'Start comparison',exact:true }).click();
      const panel=page.getByRole('region',{ name:'Controlled Skill release' });await panel.getByRole('button',{ name:'Review Skill release',exact:true }).click();const confirm=panel.getByRole('button',{ name:'Confirm Skill release with MFA' });await expect(confirm).toBeDisabled();
      await panel.getByLabel(/Skill decision reason/).fill('Reviewed same-Agent synthetic passing evidence.');await panel.getByRole('checkbox').check();
      await panel.screenshot({ path:'test-results/skill-release-dark.png' });await page.getByRole('button',{ name:'Use light theme' }).click();await panel.screenshot({ path:'test-results/skill-release-light.png' });await page.getByRole('button',{ name:'Use dark theme' }).click();
      await page.setViewportSize({ width:390,height:844 });await panel.evaluate(el=>window.scrollBy(0,el.getBoundingClientRect().top-90));await page.screenshot({ path:'test-results/skill-release-mobile.png' });await confirm.scrollIntoViewIfNeeded();await page.screenshot({ path:'test-results/skill-release-mobile-confirm.png' });
      await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.setViewportSize({ width:1440,height:1050 });
      await page.setExtraHTTPHeaders({ 'X-Fixture-Mfa':'none' });await confirm.click();await expect(panel.getByRole('link',{ name:'Confirm MFA and return to comparison' })).toBeVisible();await page.setExtraHTTPHeaders({});await confirm.click();
      await expect(panel.getByText('Skill decision saved and audited. No model was called.')).toBeVisible();assert.equal((await read(agent.id)).content,newContent);
      await panel.getByRole('button',{ name:/Review Skill rollback #/ }).click();await panel.getByLabel(/Skill decision reason/).fill('Restore the original pinned Skill.');await panel.getByRole('checkbox').check();await panel.getByRole('button',{ name:'Confirm Skill rollback with MFA' }).click();
      await expect(panel.getByText(/Skill rollback of #/)).toBeVisible();assert.equal((await read(agent.id)).revision_id,old.revision_id);assert.equal(requests.length,calls+2);
    }); } finally { await browser.close();await setAgentSkills(pool,agent.id,[]); }
  }
}
