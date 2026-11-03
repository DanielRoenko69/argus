import { executionReleaseChoices,executionReleaseSchema,applyExecutionRelease,runtimeReleasePolicyDigest } from '../releases.js';
import type pg from 'pg';
import type { EvaluationContext } from '../context.js';
const a={ version:1,context_mode:'isolated_reference',agent:{ id:1,name:'A',model:'model-a',runtime_profile_id:null,system_prompt:'Review',temperature:0.2,bundle_ids:[1] },skills:[],
  execution:{ type:'argus',model_alias:'model-a',credential_ref:null,executor_version:'argus.native-reference.v1',isolation_verified:true } };
const b={ ...a,agent:{ ...a.agent,id:2,name:'B' },execution:{ ...a.execution,model_alias:'model-b' } };
describe('controlled execution release contract',()=>{
  it('pins all runtime policy fields, not just the isolated evaluator subset',()=>{
    const profile={ id:1,name:'A',model:'terra',reasoning_effort:'high',auth_ref:'codex-auth',code_context_mode:'off',native_profile_ref:null,allowed_task_types:['analysis'],max_concurrent_runs:2 };
    expect(runtimeReleasePolicyDigest(profile)).toBe(runtimeReleasePolicyDigest({ ...profile,id:2,name:'B',model:'terra',reasoning_effort:'xhigh',created_by:7 }));
    for (const key of ['auth_ref','code_context_mode','native_profile_ref','allowed_task_types','max_concurrent_runs','new_future_policy']) expect(runtimeReleasePolicyDigest({ ...profile,[key]:'changed' })).not.toBe(runtimeReleasePolicyDigest(profile));
  });
  it('adopts only model/runtime, never other Agent fields',()=>expect(executionReleaseChoices(a,b)).toEqual({ before:{ model:'model-a',runtime_profile_id:null },after:{ model:'model-b',runtime_profile_id:null } }));
  it.each(['system_prompt','temperature','bundle_ids','agent_role'])('rejects different %s',key=>{
    expect(()=>executionReleaseChoices(a,{ ...b,agent:{ ...b.agent,[key]:'changed' } })).toThrow(/identical/);
  });
  it.each(['type','credential_ref','memory_policy','native_tool_policy','workspace_policy','adapter_config_sha256'])('rejects changing execution policy %s',key=>{
    expect(()=>executionReleaseChoices(a,{ ...b,execution:{ ...b.execution,[key]:'changed' } })).toThrow(/policies/);
  });
  it('explains repeatability and rejects a baseline model override',()=>{
    expect(()=>executionReleaseChoices(a,a)).toThrow(/nothing to release/);
    expect(()=>executionReleaseChoices({ ...a,execution:{ ...a.execution,model_alias:'other' } },b)).toThrow(/current model/);
  });
  it('refuses uncertified execution and different Skills',()=>{
    expect(()=>executionReleaseChoices(a,{ ...b,execution:{ ...b.execution,isolation_verified:false } })).toThrow(/verified/);
    expect(()=>executionReleaseChoices(a,{ ...b,skills:[{ content:'changed' }] })).toThrow(/identical/);
  });
  it('permits a certified Codex reasoning profile switch without touching the unused API alias',()=>{
    const x={ ...a,agent:{ ...a.agent,runtime_profile_id:1 },execution:{ ...a.execution,type:'codex',executor_version:'argus.codex-reference.v1',reasoning_effort:'high' } };
    const y={ ...x,agent:{ ...x.agent,id:2,model:'unused',runtime_profile_id:2 },execution:{ ...x.execution,reasoning_effort:'xhigh' } };
    expect(executionReleaseChoices(x,y).after).toEqual({ model:'model-a',runtime_profile_id:2 });
  });
  it('requires reason, digest and explicit confirmation; refuses actor injection',()=>{
    const body={ preview_sha256:'a'.repeat(64),reason:'Reviewed all cases',confirm:true };
    expect(executionReleaseSchema.safeParse(body).success).toBe(true);
    for(const bad of [{ ...body,reason:' ' },{ ...body,confirm:false },{ ...body,actor_user_id:4 },{ ...body,preview_sha256:'stale' }]) expect(executionReleaseSchema.safeParse(bad).success).toBe(false);
  });
  it('rejects non-admin, foreign scope and missing MFA before database access',async()=>{
    const pool={ connect:jest.fn() } as unknown as pg.Pool;
    const c={ user:{ id:1,role:'platform_admin',auth_method:'local' },tenantKey:'default',workspaceKey:'default',environment:'test' } as EvaluationContext;
    await expect(applyExecutionRelease(pool,1,{},c)).rejects.toMatchObject({ code:'MFA_STEP_UP_REQUIRED' });
    await expect(applyExecutionRelease(pool,1,{},{ ...c,user:{ ...c.user,role:'viewer' } })).rejects.toMatchObject({ status:403 });
    await expect(applyExecutionRelease(pool,1,{},{ ...c,workspaceKey:'foreign' })).rejects.toMatchObject({ status:404 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
