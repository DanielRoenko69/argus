import type pg from 'pg';
import { evaluationDigest,EvaluationError } from './contracts.js';
import { missingReference,type EvaluationContext } from './context.js';
import { evaluationPreview } from './authoring.js';
import { assertEvaluationAgent,boundedEvaluationJson,freezeEvaluationConfiguration } from './snapshots.js';
import { authorizeEvidence,authorizeRelease,checkedSource,configurationHead,executionReleaseSchema,passingComparison } from './releases.js';
import { agentSkillHead,getSkillRevision,skillRevisionScope,withSkillRevision } from './skillRevisions.js';
import { requireEvaluationRequestId } from './comparisonStore.js';
import { mutate } from './store.js';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';

const object=(v:unknown)=>(v ?? {}) as Record<string,unknown>;
const fail=(message:string):never=>{ throw new EvaluationError('EVALUATION_SKILL_STALE',message,409); };
const limitation='Only this Agent’s selected Skill pin changes for new turns. Other Agents and the shared Skill Library stay unchanged. No model, prompt, tools or permissions change. This is not four-eyes approval or production certification.';
interface SkillRelease {
  id:number;agent_id:number;skill_id:number;comparison_id:number;revision_id:number;previous_revision_id:number;
  action:'applied'|'rolled_back';source_release_id:number|null;before_head_sha256:string;after_head_sha256:string;
  before_config_sha256:string;after_config_sha256:string;evidence_sha256:string;reason:string;actor_user_id:number;created_at:string;
}
const normalize=(r:SkillRelease):SkillRelease=>({ ...r,id:Number(r.id),revision_id:Number(r.revision_id),previous_revision_id:Number(r.previous_revision_id),source_release_id:r.source_release_id==null?null:Number(r.source_release_id) });
async function head(client:pg.PoolClient,snapshot:Record<string,unknown>) {
  const { evaluator:_e,baseline_experiment_id:_b,skill_revision:_s,...rest }=snapshot,agent=object(snapshot['agent']);
  return configurationHead(client,rest,{ model:String(agent['model']),runtime_profile_id:agent['runtime_profile_id'] as number|null });
}
async function current(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const agent=await assertEvaluationAgent(client,id,c),runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,id);
  return freezeEvaluationConfiguration(client,id,runtime?.runtime_type && runtime.runtime_type!=='argus' ? runtime.model! : agent.model,null,c);
}
async function buildPreview(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const { a,b,evidence }=await passingComparison(client,id,c);
  const revisionId=object(b.configuration_snapshot?.['skill_revision'])['id'];
  if (!Number.isSafeInteger(revisionId) || a.agent_id!==b.agent_id || a.model_ref!==b.model_ref || b.configuration_snapshot?.['prompt_revision']) {
    throw new EvaluationError('EVALUATION_SKILL_COMPARISON_REQUIRED','Select a same-Agent, same-model comparison against one saved Skill revision.',409);
  }
  const revision=await getSkillRevision(client,Number(revisionId),a.agent_id,c),baseline=await checkedSource(client,a,c);
  const expected=await withSkillRevision(client,baseline,revision.id,c);
  const { evaluator:_e,baseline_experiment_id:_b,...candidate }=b.configuration_snapshot!;
  if (evaluationDigest(expected)!==evaluationDigest(candidate)) fail('Candidate is not the exact Skill revision with unchanged execution and context.');
  const previousId=Number(object(expected['skill_revision'])['source_revision_id']);
  const previous=await getSkillRevision(client,previousId,a.agent_id,c);
  const data={ comparison_id:id,agent_id:a.agent_id,skill_id:revision.skill_id,revision_id:revision.id,previous_revision_id:previousId,
    before_content:previous.content,after_content:revision.content,before_head_sha256:await agentSkillHead(client,a.agent_id),
    before_config_sha256:await head(client,baseline),after_config_sha256:await head(client,expected),evidence_sha256:evidence.payload_sha256,limitation };
  return { ...data,preview_sha256:evaluationDigest(data) };
}
export async function previewSkillRelease(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,client=>buildPreview(client,id,c));
}
async function getRelease(client:pg.PoolClient,id:number,c:EvaluationContext,lock=false) {
  const row=(await client.query<SkillRelease>(`SELECT * FROM mcp_agent_skill_releases
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 AND environment=$4`,[id,...skillRevisionScope(c)])).rows[0];
  if (!row) missingReference();
  if (lock) await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR UPDATE',[row.agent_id]);
  await authorizeEvidence(client,row.comparison_id,c);
  await getSkillRevision(client,Number(row.revision_id),row.agent_id,c);
  await getSkillRevision(client,Number(row.previous_revision_id),row.agent_id,c);
  return normalize(row);
}
export async function listSkillReleases(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,async client=>{
    await authorizeEvidence(client,id,c);
    const rows=(await client.query<SkillRelease>(`SELECT * FROM mcp_agent_skill_releases WHERE comparison_id=$1
      AND tenant_key=$2 AND workspace_key=$3 AND environment=$4 ORDER BY id DESC LIMIT 50`,[id,...skillRevisionScope(c)])).rows;
    for (const r of rows) await getRelease(client,Number(r.id),c);
    return rows.map(normalize);
  });
}
async function setPin(client:pg.PoolClient,agentId:number,skillId:number,revisionId:number) {
  const result=await client.query('UPDATE mcp_agent_skills SET revision_id=$3 WHERE agent_id=$1 AND skill_id=$2',[agentId,skillId,revisionId]);
  if (result.rowCount!==1) missingReference();
  await client.query('UPDATE mcp_agents SET updated_at=clock_timestamp() WHERE id=$1',[agentId]);
}
async function insert(client:pg.PoolClient,r:Omit<SkillRelease,'id'|'created_at'|'actor_user_id'>,c:EvaluationContext) {
  return normalize((await client.query<SkillRelease>(`INSERT INTO mcp_agent_skill_releases
    (tenant_key,workspace_key,environment,agent_id,skill_id,comparison_id,revision_id,previous_revision_id,action,source_release_id,
     before_head_sha256,after_head_sha256,before_config_sha256,after_config_sha256,evidence_sha256,reason,actor_user_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,[...skillRevisionScope(c),r.agent_id,r.skill_id,r.comparison_id,r.revision_id,r.previous_revision_id,r.action,r.source_release_id,
    r.before_head_sha256,r.after_head_sha256,r.before_config_sha256,r.after_config_sha256,r.evidence_sha256,r.reason,c.user.id])).rows[0]!);
}
export async function applySkillRelease(pool:pg.Pool,id:number,input:unknown,c:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(c,mfaMaxAge);requireEvaluationRequestId(c);const b=executionReleaseSchema.parse(input);
  await evaluationPreview(pool,client=>authorizeEvidence(client,id,c));
  return mutate(pool,c,'skill.release.applied',{ id,...b },async client=>{
    const p=await buildPreview(client,id,c);
    if (p.preview_sha256!==b.preview_sha256) fail('Review changed. Preview Skill release again.');
    await setPin(client,p.agent_id,p.skill_id,p.revision_id);
    if (await head(client,await current(client,p.agent_id,c))!==p.after_config_sha256) fail('Resulting Agent does not match the evaluated Skill. No change applied.');
    return insert(client,{ agent_id:p.agent_id,skill_id:p.skill_id,comparison_id:id,revision_id:p.revision_id,previous_revision_id:p.previous_revision_id,action:'applied',source_release_id:null,
      before_head_sha256:p.before_head_sha256,after_head_sha256:await agentSkillHead(client,p.agent_id),before_config_sha256:p.before_config_sha256,
      after_config_sha256:p.after_config_sha256,evidence_sha256:p.evidence_sha256,reason:String(boundedEvaluationJson(b.reason,8000,'decision reason')) },c);
  },rid=>evaluationPreview(pool,client=>getRelease(client,rid,c)));
}
async function buildRollback(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const row=await getRelease(client,id,c,true);
  if (row.action!=='applied' || (await client.query('SELECT id FROM mcp_agent_skill_releases WHERE source_release_id=$1',[id])).rows.length) {
    throw new EvaluationError('EVALUATION_SKILL_ALREADY_REVERTED','This release has already been rolled back or is not an apply decision.',409);
  }
  if (await agentSkillHead(client,row.agent_id)!==row.after_head_sha256 || await head(client,await current(client,row.agent_id,c))!==row.after_config_sha256) {
    fail('Agent or execution context changed after release. Rollback will not overwrite intervening changes.');
  }
  const revision=await getSkillRevision(client,row.revision_id,row.agent_id,c),previous=await getSkillRevision(client,row.previous_revision_id,row.agent_id,c);
  const data={ release_id:id,agent_id:row.agent_id,skill_id:row.skill_id,revision_id:row.previous_revision_id,previous_revision_id:row.revision_id,
    before_content:revision.content,after_content:previous.content,current_head_sha256:row.after_head_sha256,evidence_sha256:row.evidence_sha256,limitation };
  return { row,preview:{ ...data,preview_sha256:evaluationDigest(data) } };
}
export async function previewSkillRollback(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,async client=>(await buildRollback(client,id,c)).preview);
}
export async function rollbackSkillRelease(pool:pg.Pool,id:number,input:unknown,c:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(c,mfaMaxAge);requireEvaluationRequestId(c);const b=executionReleaseSchema.parse(input);
  await evaluationPreview(pool,client=>getRelease(client,id,c));
  return mutate(pool,c,'skill.release.rolled_back',{ id,...b },async client=>{
    const { row,preview }=await buildRollback(client,id,c);
    if (preview.preview_sha256!==b.preview_sha256) fail('Review changed. Preview rollback again.');
    await setPin(client,row.agent_id,row.skill_id,row.previous_revision_id);
    if (await head(client,await current(client,row.agent_id,c))!==row.before_config_sha256) fail('The previous execution context changed. No Skill was restored.');
    return insert(client,{ agent_id:row.agent_id,skill_id:row.skill_id,comparison_id:row.comparison_id,revision_id:row.previous_revision_id,previous_revision_id:row.revision_id,action:'rolled_back',source_release_id:id,
      before_head_sha256:row.after_head_sha256,after_head_sha256:await agentSkillHead(client,row.agent_id),before_config_sha256:row.after_config_sha256,
      after_config_sha256:row.before_config_sha256,evidence_sha256:row.evidence_sha256,reason:String(boundedEvaluationJson(b.reason,8000,'decision reason')) },c);
  },rid=>evaluationPreview(pool,client=>getRelease(client,rid,c)));
}
