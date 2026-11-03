import type pg from 'pg';
import { z } from 'zod';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import { readPinnedAgentSkills,skillContentDigest,type PinnedAgentSkill } from '../agents/skillStore.js';
import { evaluationDigest,EvaluationError } from './contracts.js';
import { missingReference,type EvaluationContext } from './context.js';
import { assertEvaluationAgent,boundedEvaluationJson } from './snapshots.js';
import { evaluationPreview } from './authoring.js';
import { mutate } from './store.js';
import { requireEvaluationRequestId } from './comparisonStore.js';
import { authorizeRelease,rawHead } from './releases.js';

export const createSkillRevisionSchema=z.object({
  skill_id:z.number().int().positive().safe(),title:z.string().trim().min(1).max(120),content:z.string().min(1).max(32768),
  source_head_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface SkillRevision {
  id:number;skill_id:number;title:string;content:string;content_sha256:string;origin:'migration'|'catalog'|'draft';
  agent_id:number|null;source_revision_id:number|null;source_head_sha256:string|null;source_bundle_ids:number[]|null;
  source_url:string|null;source_ref:string|null;tenant_key:string|null;workspace_key:string|null;environment:string|null;
  created_by_user_id:number|null;created_at:string;
}
export const skillRevisionScope=(c:EvaluationContext)=>[c.tenantKey,c.workspaceKey,c.environment];
const normalize=(r:SkillRevision):SkillRevision=>({ ...r,id:Number(r.id),source_revision_id:r.source_revision_id==null?null:Number(r.source_revision_id) });
export function cleanDeployableSkill(content:string) {
  if (Buffer.byteLength(content,'utf8')>32768) throw new EvaluationError('EVALUATION_TOO_LARGE','Skill exceeds 32768 UTF-8 bytes');
  if (!content.trim() || boundedEvaluationJson(content,196608,'Skill')!==content || /\[REDACTED[^\]]*\]/i.test(content)) {
    throw new EvaluationError('EVALUATION_SKILL_REDACTED','Use non-empty Skill instructions without secrets or redaction placeholders.',409);
  }
  return content;
}
export async function agentSkillHead(client:pg.PoolClient,id:number) {
  return evaluationDigest({ agent:await rawHead(client,id),skills:await readPinnedAgentSkills(client,id,true) });
}
export async function getSkillRevision(client:pg.PoolClient,id:number,agentId:number,c:EvaluationContext):Promise<SkillRevision> {
  const r=(await client.query<SkillRevision>('SELECT * FROM mcp_skill_revisions WHERE id=$1',[id])).rows[0];
  if (!r) missingReference();
  await assertEvaluationAgent(client,agentId,c);
  if (r.origin==='draft' && (r.agent_id!==agentId || r.tenant_key!==c.tenantKey || r.workspace_key!==c.workspaceKey || r.environment!==c.environment
    || c.user.allowed_bundles && (!Array.isArray(r.source_bundle_ids) || r.source_bundle_ids.some(id=>!c.user.allowed_bundles!.includes(id))))) missingReference();
  if (!(await client.query('SELECT 1 FROM mcp_agent_skills WHERE agent_id=$1 AND skill_id=$2',[agentId,r.skill_id])).rows.length) missingReference();
  if (skillContentDigest(r.content)!==r.content_sha256) throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Skill revision verification failed',409);
  return normalize(r);
}
export async function getAgentSkillState(pool:pg.Pool,agentId:number,c:EvaluationContext) {
  authorizeRelease(c);
  return evaluationPreview(pool,async client=>{
    const agent=await assertEvaluationAgent(client,agentId,c),runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,agentId);
    const pinned=await readPinnedAgentSkills(client,agentId,true);
    if (pinned.length>50) throw new EvaluationError('EVALUATION_TOO_LARGE','The Skill workbench supports up to 50 attached Skills per Agent',409);
    const skills=[];
    for (const pin of pinned) {
      const rows=(await client.query<SkillRevision>(`SELECT * FROM mcp_skill_revisions WHERE skill_id=$1
        AND (origin<>'draft' OR (agent_id=$2 AND tenant_key=$3 AND workspace_key=$4 AND environment=$5
          AND ($6::int[] IS NULL OR (source_bundle_ids IS NOT NULL AND source_bundle_ids <@ $6::int[]))))
        ORDER BY id DESC LIMIT 25`,[pin.id,agentId,...skillRevisionScope(c),c.user.allowed_bundles ?? null])).rows;
      // Never expose raw imported content/provenance through the evaluation API.
      const project=(r:SkillRevision)=>({ id:Number(r.id),skill_id:r.skill_id,title:String(boundedEvaluationJson(r.title,2048,'title')),
        content:boundedEvaluationJson(r.content,262144,'Skill') as string,content_sha256:r.content_sha256,origin:r.origin,
        source_head_sha256:r.source_head_sha256,created_at:r.created_at,created_by_user_id:r.created_by_user_id,
        editable:(()=>{try {cleanDeployableSkill(r.content);return true;} catch {return false;}})() });
      const active=await getSkillRevision(client,pin.revision_id,agentId,c);
      skills.push({ id:pin.id,name:pin.name,active:project(active),revisions:rows.map(project) });
      if (Buffer.byteLength(JSON.stringify(skills),'utf8')>2*1024*1024) throw new EvaluationError('EVALUATION_TOO_LARGE','Skill history exceeds the 2 MiB workbench limit',409);
    }
    return { agent_id:agentId,label:agent.label,source_head_sha256:await agentSkillHead(client,agentId),
      model_ref:runtime?.runtime_type && runtime.runtime_type!=='argus' ? runtime.model : agent.model,skills };
  });
}
export async function createSkillRevision(pool:pg.Pool,agentId:number,input:unknown,c:EvaluationContext) {
  authorizeRelease(c);requireEvaluationRequestId(c);const b=createSkillRevisionSchema.parse(input);cleanDeployableSkill(b.content);
  await evaluationPreview(pool,async client=>{ await assertEvaluationAgent(client,agentId,c);
    if (!(await readPinnedAgentSkills(client,agentId,true)).some(s=>s.id===b.skill_id)) missingReference(); });
  const result=await mutate(pool,c,'skill.revision.created',{ agentId,...b },async client=>{
    await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR UPDATE',[agentId]);
    const agent=await assertEvaluationAgent(client,agentId,c),pin=(await readPinnedAgentSkills(client,agentId,true)).find(s=>s.id===b.skill_id);
    if (!pin) missingReference();
    if (await agentSkillHead(client,agentId)!==b.source_head_sha256) throw new EvaluationError('EVALUATION_SKILL_STALE','Agent or Skill pins changed. Reload before saving a draft.',409);
    cleanDeployableSkill(pin.content);
    if (pin.content===b.content) throw new EvaluationError('EVALUATION_SKILL_NO_CHANGE','Change the Skill instructions before saving a draft.',409);
    const source=await getSkillRevision(client,pin.revision_id,agentId,c);
    return normalize((await client.query<SkillRevision>(`INSERT INTO mcp_skill_revisions
      (skill_id,title,content,content_sha256,origin,tenant_key,workspace_key,environment,agent_id,source_revision_id,source_head_sha256,source_bundle_ids,created_by_user_id,source_url,source_ref)
      VALUES($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,[b.skill_id,String(boundedEvaluationJson(b.title,2048,'title')),b.content,
      skillContentDigest(b.content),...skillRevisionScope(c),agentId,pin.revision_id,b.source_head_sha256,agent.bundle_ids,c.user.id,source.source_url,source.source_ref])).rows[0]!);
  },id=>evaluationPreview(pool,client=>getSkillRevision(client,id,agentId,c)));
  return { id:result.id,skill_id:result.skill_id,content_sha256:result.content_sha256 };
}
/** One stored revision replaces one already-attached Skill, never authority/context. */
export async function withSkillRevision(client:pg.PoolClient,snapshot:Record<string,unknown>,id:number,c:EvaluationContext):Promise<Record<string,unknown>> {
  const agentId=Number((snapshot['agent'] as Record<string,unknown>)['id']);
  const r=await getSkillRevision(client,id,agentId,c),skills=snapshot['skills'] as PinnedAgentSkill[];
  const pin=skills.find(s=>s.id===r.skill_id),source=await agentSkillHead(client,agentId);
  if (!pin) missingReference();
  if (r.origin==='draft' && (r.source_head_sha256!==source || Number(r.source_revision_id)!==pin.revision_id)) {
    throw new EvaluationError('EVALUATION_SKILL_STALE','Draft source changed. Save a new draft from the current Agent.',409);
  }
  cleanDeployableSkill(r.content);cleanDeployableSkill(pin.content);
  if (pin.content_sha256===r.content_sha256) throw new EvaluationError('EVALUATION_SKILL_NO_CHANGE','The selected revision has the same Skill content.',409);
  return { ...snapshot,skills:skills.map(s=>s.id===r.skill_id ? { ...s,content:r.content,revision_id:r.id,content_sha256:r.content_sha256 } : s),
    skill_revision:{ id:r.id,skill_id:r.skill_id,content_sha256:r.content_sha256,source_head_sha256:source,source_revision_id:pin.revision_id } };
}
