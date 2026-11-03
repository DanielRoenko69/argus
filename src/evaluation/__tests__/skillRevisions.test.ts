import type pg from 'pg';
import { cleanDeployableSkill,createSkillRevisionSchema,createSkillRevision } from '../skillRevisions.js';
import { createComparisonSchema } from '../contracts.js';
import { skillContentDigest,readPinnedAgentSkills,replaceAgentSkills } from '../../agents/skillStore.js';
import { applySkillRelease,rollbackSkillRelease } from '../skillReleases.js';
import type { EvaluationContext } from '../context.js';

describe('pinned Skill revisions',()=>{
  it('retains exact UTF-8 bytes and rejects oversized/empty/redacted instructions',()=>{
    const text=' Review carefully.\n  Prüfen.';expect(cleanDeployableSkill(text)).toBe(text);
    expect(skillContentDigest('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    for (const value of ['', '  ', '[REDACTED]', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456','ä'.repeat(20000)]) expect(()=>cleanDeployableSkill(value)).toThrow();
  });
  it('accepts a stored candidate Skill but rejects mixed revisions, baselines and arbitrary authority',()=>{
    const b={ name:'Skill test',dataset_id:1,baseline:{ agent_id:1,model_ref:'same' },candidate:{ agent_id:1,model_ref:'same',skill_revision_id:2 } };
    expect(createComparisonSchema.safeParse(b).success).toBe(true);
    expect(createComparisonSchema.safeParse({ ...b,baseline:b.candidate }).success).toBe(false);
    for (const patch of [{ prompt_revision_id:3 },{ content:'override' },{ bundle_ids:[1] }]) expect(createComparisonSchema.safeParse({ ...b,candidate:{ ...b.candidate,...patch } }).success).toBe(false);
    expect(createSkillRevisionSchema.safeParse({ title:'Skill',skill_id:1,content:'Review',source_head_sha256:'a'.repeat(64),actor_user_id:2 }).success).toBe(false);
  });
  it('loads pinned content, verifies hashes and fails closed on disabled modules',async()=>{
    const row={ id:1,name:'review',content:'Review',position:0,revision_id:'19',content_sha256:skillContentDigest('Review'),enabled:true };
    const query=jest.fn().mockResolvedValue({ rows:[row] }),pool={ query } as unknown as pg.Pool;
    expect((await readPinnedAgentSkills(pool,1))[0]).toMatchObject({ revision_id:19,content:'Review' });
    expect(query.mock.calls[0][0]).toContain('r.id=ags.revision_id');
    query.mockResolvedValue({ rows:[{ ...row,enabled:false }] });await expect(readPinnedAgentSkills(pool,1)).rejects.toThrow(/disabled/);
    query.mockResolvedValue({ rows:[{ ...row,content:'tampered' }] });await expect(readPinnedAgentSkills(pool,1)).rejects.toThrow(/verification/);
  });
  it('replacement removes only unselected bindings and preserves existing pins',async()=>{
    const query=jest.fn().mockResolvedValue({ rows:[] });await replaceAgentSkills({ query } as unknown as pg.PoolClient,4,[2,1,2]);
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
    expect(query.mock.calls[1][0]).toContain('NOT (skill_id=ANY');
    expect(query.mock.calls).toHaveLength(4);
    expect(query.mock.calls[2][0]).toContain('DO UPDATE SET position=EXCLUDED.position');
    expect(query.mock.calls[2][0]).not.toContain('revision_id=');
  });
  it('denies unauthorized authors and release decisions before any database access',async()=>{
    const pool={} as pg.Pool,c={ tenantKey:'default',workspaceKey:'default',environment:'test',user:{ id:1,role:'viewer' } } as EvaluationContext;
    for (const run of [()=>createSkillRevision(pool,1,{},c),()=>applySkillRelease(pool,1,{},c),()=>rollbackSkillRelease(pool,1,{},c)]) await expect(run()).rejects.toMatchObject({ code:'FORBIDDEN' });
  });
});
