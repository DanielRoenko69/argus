import type pg from 'pg';
import { evaluationDigest, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { evaluationPreview } from './authoring.js';
import { assertEvaluationAgent, boundedEvaluationJson, freezeEvaluationConfiguration } from './snapshots.js';
import { authorizeEvidence, authorizeRelease, checkedSource, configurationHead, executionReleaseSchema, passingComparison, rawHead } from './releases.js';
import { getPromptRevision, withPromptRevision } from './promptRevisions.js';
import { requireEvaluationRequestId } from './comparisonStore.js';
import { mutate } from './store.js';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';

const object=(v:unknown)=>(v ?? {}) as Record<string,unknown>;
const scope=(c:EvaluationContext)=>[c.tenantKey,c.workspaceKey,c.environment];
const fail=(message:string):never=>{ throw new EvaluationError('EVALUATION_PROMPT_STALE',message,409); };
const limit='Only the system prompt changes for new runs. No Skills, models, tools, Knowledge or permissions are changed. Answer tests are not production certification or four-eyes approval.';
interface PromptRelease {
  id:number;agent_id:number;comparison_id:number;revision_id:number;action:'applied'|'rolled_back';source_release_id:number|null;
  before_head_sha256:string;after_head_sha256:string;before_config_sha256:string;after_config_sha256:string;evidence_sha256:string;
  reason:string;actor_user_id:number;created_at:string;
}
const normalize=(r:PromptRelease):PromptRelease=>({ ...r,id:Number(r.id),revision_id:Number(r.revision_id),source_release_id:r.source_release_id==null?null:Number(r.source_release_id) });
const strip=(s:Record<string,unknown>)=>{ const { evaluator:_e,baseline_experiment_id:_b,prompt_revision:_p,...rest }=s;return rest; };
async function head(client:pg.PoolClient,snapshot:Record<string,unknown>) {
  const agent=object(snapshot['agent']);
  return configurationHead(client,strip(snapshot),{ model:String(agent['model']),runtime_profile_id:agent['runtime_profile_id'] as number|null });
}
async function current(client:pg.PoolClient,agentId:number,c:EvaluationContext) {
  const agent=await assertEvaluationAgent(client,agentId,c),runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,agentId);
  return freezeEvaluationConfiguration(client,agentId,runtime?.runtime_type && runtime.runtime_type!=='argus' ? runtime.model! : agent.model,null,c);
}
async function buildPreview(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const { a,b,evidence }=await passingComparison(client,id,c);
  const revisionId=object(b.configuration_snapshot?.['prompt_revision'])['id'];
  if (!Number.isSafeInteger(revisionId) || a.agent_id!==b.agent_id || a.model_ref!==b.model_ref) {
    throw new EvaluationError('EVALUATION_PROMPT_COMPARISON_REQUIRED','Select a comparison of the active Agent against a saved prompt draft.',409);
  }
  const revision=await getPromptRevision(client,Number(revisionId),c);
  const baseline=await checkedSource(client,a,c);
  const expected=await withPromptRevision(client,baseline,revision.id,c);
  const { evaluator:_e,baseline_experiment_id:_b,...candidate }=b.configuration_snapshot!;
  if (evaluationDigest(expected)!==evaluationDigest(candidate)) fail('Candidate is not the exact saved prompt with unchanged runtime and context.');
  const data={ comparison_id:id,agent_id:revision.agent_id,revision_id:revision.id,
    before_prompt:revision.source_prompt,after_prompt:revision.system_prompt,before_revision_id:revision.source_revision_id,
    before_head_sha256:await rawHead(client,revision.agent_id),before_config_sha256:await head(client,baseline),
    after_config_sha256:await head(client,expected),evidence_sha256:evidence.payload_sha256,limitation:limit };
  return { ...data,preview_sha256:evaluationDigest(data) };
}
export async function previewPromptRelease(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,client=>buildPreview(client,id,c));
}
async function getRelease(client:pg.PoolClient,id:number,c:EvaluationContext,lock=false) {
  const row=(await client.query<PromptRelease>(`SELECT * FROM mcp_agent_prompt_releases
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 AND environment=$4`,[id,...scope(c)])).rows[0];
  if (!row) missingReference();
  if (lock) await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR UPDATE',[row.agent_id]);
  await authorizeEvidence(client,row.comparison_id,c);await assertEvaluationAgent(client,row.agent_id,c);
  return normalize(row);
}
export async function listPromptReleases(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,async client=>{
    await authorizeEvidence(client,id,c);
    return (await client.query<PromptRelease>(`SELECT * FROM mcp_agent_prompt_releases WHERE comparison_id=$1
      AND tenant_key=$2 AND workspace_key=$3 AND environment=$4 ORDER BY id DESC LIMIT 50`,[id,...scope(c)])).rows.map(normalize);
  });
}
async function updatePrompt(client:pg.PoolClient,id:number,prompt:string|null,revisionId:number|null) {
  await client.query('UPDATE mcp_agents SET system_prompt=$2,prompt_revision_id=$3,updated_at=clock_timestamp() WHERE id=$1',[id,prompt,revisionId]);
}
async function insert(client:pg.PoolClient,row:Omit<PromptRelease,'id'|'created_at'|'actor_user_id'>,c:EvaluationContext) {
  return normalize((await client.query<PromptRelease>(`INSERT INTO mcp_agent_prompt_releases
    (tenant_key,workspace_key,environment,agent_id,comparison_id,revision_id,action,source_release_id,
     before_head_sha256,after_head_sha256,before_config_sha256,after_config_sha256,evidence_sha256,reason,actor_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[...scope(c),row.agent_id,row.comparison_id,row.revision_id,row.action,row.source_release_id,
    row.before_head_sha256,row.after_head_sha256,row.before_config_sha256,row.after_config_sha256,row.evidence_sha256,row.reason,c.user.id])).rows[0]!);
}
export async function applyPromptRelease(pool:pg.Pool,id:number,input:unknown,c:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(c,mfaMaxAge);requireEvaluationRequestId(c);const b=executionReleaseSchema.parse(input);
  await evaluationPreview(pool,client=>authorizeEvidence(client,id,c));
  return mutate(pool,c,'prompt.release.applied',{ id,...b },async client=>{
    const p=await buildPreview(client,id,c);
    if (p.preview_sha256!==b.preview_sha256) fail('Review changed. Preview the prompt release again.');
    await updatePrompt(client,p.agent_id,p.after_prompt,p.revision_id);
    if (await head(client,await current(client,p.agent_id,c))!==p.after_config_sha256) fail('Resulting Agent does not match the evaluated prompt. No change applied.');
    return insert(client,{ agent_id:p.agent_id,comparison_id:id,revision_id:p.revision_id,action:'applied',source_release_id:null,
      before_head_sha256:p.before_head_sha256,after_head_sha256:await rawHead(client,p.agent_id),before_config_sha256:p.before_config_sha256,
      after_config_sha256:p.after_config_sha256,evidence_sha256:p.evidence_sha256,reason:String(boundedEvaluationJson(b.reason,8000,'decision reason')) },c);
  },rid=>evaluationPreview(pool,client=>getRelease(client,rid,c)));
}
async function buildRollback(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const row=await getRelease(client,id,c,true);
  if (row.action!=='applied' || (await client.query('SELECT id FROM mcp_agent_prompt_releases WHERE source_release_id=$1',[id])).rows.length) {
    throw new EvaluationError('EVALUATION_PROMPT_ALREADY_REVERTED','This decision has already been rolled back or is not a release.',409);
  }
  if (await rawHead(client,row.agent_id)!==row.after_head_sha256 || await head(client,await current(client,row.agent_id,c))!==row.after_config_sha256) {
    fail('Agent or execution target changed after release. Rollback will not overwrite intervening changes.');
  }
  const revision=await getPromptRevision(client,row.revision_id,c);
  const data={ release_id:id,agent_id:row.agent_id,revision_id:row.revision_id,before_prompt:revision.system_prompt,
    after_prompt:revision.source_prompt,after_revision_id:revision.source_revision_id,
    current_head_sha256:row.after_head_sha256,evidence_sha256:row.evidence_sha256,limitation:limit };
  return { row,preview:{ ...data,preview_sha256:evaluationDigest(data) } };
}
export async function previewPromptRollback(pool:pg.Pool,id:number,c:EvaluationContext) {
  authorizeRelease(c);return evaluationPreview(pool,async client=>(await buildRollback(client,id,c)).preview);
}
export async function rollbackPromptRelease(pool:pg.Pool,id:number,input:unknown,c:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(c,mfaMaxAge);requireEvaluationRequestId(c);const b=executionReleaseSchema.parse(input);
  await evaluationPreview(pool,client=>getRelease(client,id,c));
  return mutate(pool,c,'prompt.release.rolled_back',{ id,...b },async client=>{
    const { row,preview }=await buildRollback(client,id,c);
    if (preview.preview_sha256!==b.preview_sha256) fail('Review changed. Preview rollback again.');
    await updatePrompt(client,row.agent_id,preview.after_prompt,preview.after_revision_id);
    if (await head(client,await current(client,row.agent_id,c))!==row.before_config_sha256) fail('The previous execution context changed. No prompt was restored.');
    return insert(client,{ agent_id:row.agent_id,comparison_id:row.comparison_id,revision_id:row.revision_id,action:'rolled_back',source_release_id:id,
      before_head_sha256:row.after_head_sha256,after_head_sha256:await rawHead(client,row.agent_id),before_config_sha256:row.after_config_sha256,
      after_config_sha256:row.before_config_sha256,evidence_sha256:row.evidence_sha256,reason:String(boundedEvaluationJson(b.reason,8000,'decision reason')) },c);
  },rid=>evaluationPreview(pool,client=>getRelease(client,rid,c)));
}
