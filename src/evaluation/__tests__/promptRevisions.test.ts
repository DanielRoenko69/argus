import type pg from 'pg';
import type { EvaluationContext } from '../context.js';
import { cleanDeployablePrompt,createPromptRevisionSchema,createPromptRevision } from '../promptRevisions.js';
import { applyPromptRelease,rollbackPromptRelease } from '../promptReleases.js';
import { createComparisonSchema,evaluationDigest } from '../contracts.js';
import { agentPromptEvidence } from '../../agents/promptEvidence.js';

describe('versioned Agent prompts',()=>{
  it('preserves deployable prompt bytes, including whitespace and null baseline',()=>{
    expect(cleanDeployablePrompt('Review carefully.\n  Return JSON.')).toBe('Review carefully.\n  Return JSON.');
    expect(cleanDeployablePrompt(null)).toBeNull();
  });
  it.each(['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456','[REDACTED]','[REDACTED_EMAIL]'])('rejects redacted or sensitive prompt %s',prompt=>{
    expect(()=>cleanDeployablePrompt(prompt)).toThrow(/sensitive|redaction/);
  });
  it('bounds UTF-8, not only character count',()=>expect(()=>cleanDeployablePrompt('ä'.repeat(20000))).toThrow(/exceeds/));
  it('accepts only an immutable candidate revision reference, not arbitrary overrides or identity',()=>{
    const b={ name:'Prompt test',dataset_id:1,baseline:{ agent_id:1,model_ref:'same' },candidate:{ agent_id:1,model_ref:'same',prompt_revision_id:2 } };
    expect(createComparisonSchema.safeParse(b).success).toBe(true);
    expect(createComparisonSchema.safeParse({ ...b,baseline:b.candidate }).success).toBe(false);
    expect(createComparisonSchema.safeParse({ ...b,candidate:{ ...b.candidate,system_prompt:'Injected' } }).success).toBe(false);
    const draft={ title:'Candidate',system_prompt:'Review',source_head_sha256:'a'.repeat(64) };
    expect(createPromptRevisionSchema.safeParse(draft).success).toBe(true);
    for (const patch of [{ actor_user_id:5 },{ model:'other' },{ source_head_sha256:'' }]) expect(createPromptRevisionSchema.safeParse({ ...draft,...patch }).success).toBe(false);
  });
  it('records prompt identity without content and without inventing a version for old Agents',()=>{
    expect(agentPromptEvidence({ system_prompt:'Review',prompt_revision_id:'12' })).toEqual({ agent_prompt_sha256:evaluationDigest('Review'),agent_prompt_revision_id:12 });
    expect(agentPromptEvidence({ system_prompt:null })).toEqual({ agent_prompt_sha256:evaluationDigest(null),agent_prompt_revision_id:null });
  });
  it('blocks foreign scope/non-admin and missing MFA before touching persistence',async()=>{
    const pool={ connect:jest.fn() } as unknown as pg.Pool;
    const c={ user:{ id:1,role:'platform_admin',auth_method:'local' },tenantKey:'default',workspaceKey:'default',environment:'test',requestId:'test-key' } as EvaluationContext;
    for (const operation of [applyPromptRelease,rollbackPromptRelease]) {
      await expect(operation(pool,1,{},c)).rejects.toMatchObject({ code:'MFA_STEP_UP_REQUIRED' });
      await expect(operation(pool,1,{},{ ...c,workspaceKey:'foreign' })).rejects.toMatchObject({ status:404 });
    }
    await expect(createPromptRevision(pool,1,{},{ ...c,user:{ ...c.user,role:'viewer' } })).rejects.toMatchObject({ status:403 });
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
