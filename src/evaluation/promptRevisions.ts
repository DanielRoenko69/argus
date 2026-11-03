import type pg from 'pg';
import { z } from 'zod';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import { evaluationDigest, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { assertEvaluationAgent, boundedEvaluationJson } from './snapshots.js';
import { evaluationPreview } from './authoring.js';
import { mutate } from './store.js';
import { requireEvaluationRequestId } from './comparisonStore.js';
import { authorizeRelease, rawHead } from './releases.js';

export const createPromptRevisionSchema=z.object({
  title:z.string().trim().min(1).max(120),system_prompt:z.string().min(1).max(32768),
  source_head_sha256:z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export interface PromptRevision {
  id:number;agent_id:number;title:string;system_prompt:string;content_sha256:string;
  source_head_sha256:string;source_prompt:string|null;source_revision_id:number|null;
  source_bundle_ids:number[]|null;
  tenant_key:string;workspace_key:string;environment:string;created_by_user_id:number;created_at:string;
}
const scope=(c:EvaluationContext)=>[c.tenantKey,c.workspaceKey,c.environment];
const normalize=(r:PromptRevision):PromptRevision=>({ ...r,id:Number(r.id),source_revision_id:r.source_revision_id==null?null:Number(r.source_revision_id) });
export function cleanDeployablePrompt(value:string|null) {
  const clean=boundedEvaluationJson(value,32770,'system prompt');
  if (clean!==value || /\[REDACTED[^\]]*\]/i.test(value ?? '')) {
    throw new EvaluationError('EVALUATION_PROMPT_REDACTED','Remove sensitive content or redaction placeholders before saving a deployable prompt.',409);
  }
  if (value!==null && Buffer.byteLength(value,'utf8')>32768) throw new EvaluationError('EVALUATION_TOO_LARGE','System prompt exceeds 32768 bytes');
  return value;
}
export async function getPromptRevision(client:pg.PoolClient,id:number,c:EvaluationContext) {
  const row=(await client.query<PromptRevision>(`SELECT * FROM mcp_agent_prompt_revisions
    WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 AND environment=$4`,[id,...scope(c)])).rows[0];
  if (!row) missingReference();
  await assertEvaluationAgent(client,row.agent_id,c);
  if (c.user.allowed_bundles && (!Array.isArray(row.source_bundle_ids) || row.source_bundle_ids.some(id=>!c.user.allowed_bundles!.includes(id)))) missingReference();
  if (evaluationDigest(row.system_prompt)!==row.content_sha256) throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Prompt revision verification failed',409);
  return normalize(row);
}
export async function getAgentPromptState(pool:pg.Pool,agentId:number,c:EvaluationContext) {
  authorizeRelease(c);
  return evaluationPreview(pool,async client=>{
    const agent=await assertEvaluationAgent(client,agentId,c);
    const runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,agentId);
    const raw=(await client.query('SELECT prompt_revision_id FROM mcp_agents WHERE id=$1',[agentId])).rows[0];
    const revisions=(await client.query<PromptRevision>(`SELECT * FROM mcp_agent_prompt_revisions WHERE agent_id=$1
      AND tenant_key=$2 AND workspace_key=$3 AND environment=$4
      AND ($5::integer[] IS NULL OR (source_bundle_ids IS NOT NULL AND source_bundle_ids <@ $5::integer[]))
      ORDER BY id DESC LIMIT 25`,[agentId,...scope(c),c.user.allowed_bundles ?? null])).rows.map(normalize);
    let editable=true;
    try { cleanDeployablePrompt(agent.system_prompt); } catch { editable=false; }
    return { agent_id:agentId,label:agent.label,source_head_sha256:await rawHead(client,agentId),
      system_prompt:boundedEvaluationJson(agent.system_prompt,262144,'system prompt') as string|null,
      active_revision_id:raw.prompt_revision_id==null?null:Number(raw.prompt_revision_id),editable,
      model_ref:runtime?.runtime_type && runtime.runtime_type!=='argus' ? runtime.model : agent.model,
      revisions };
  });
}
export async function createPromptRevision(pool:pg.Pool,agentId:number,input:unknown,c:EvaluationContext) {
  authorizeRelease(c);requireEvaluationRequestId(c);const b=createPromptRevisionSchema.parse(input);
  cleanDeployablePrompt(b.system_prompt);
  // Recheck access even when the canonical mutation returns a replay.
  await evaluationPreview(pool,client=>assertEvaluationAgent(client,agentId,c));
  return mutate(pool,c,'prompt.revision.created',{ agentId,...b },async client=>{
    await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR UPDATE',[agentId]);
    const agent=await assertEvaluationAgent(client,agentId,c);
    if (await rawHead(client,agentId)!==b.source_head_sha256) throw new EvaluationError('EVALUATION_PROMPT_STALE','Agent changed. Reload the active prompt before saving a new draft.',409);
    cleanDeployablePrompt(agent.system_prompt);
    if (b.system_prompt===agent.system_prompt) throw new EvaluationError('EVALUATION_PROMPT_NO_CHANGE','Change the system prompt before saving a draft.',409);
    const source=(await client.query('SELECT prompt_revision_id FROM mcp_agents WHERE id=$1',[agentId])).rows[0];
    return normalize((await client.query<PromptRevision>(`INSERT INTO mcp_agent_prompt_revisions
      (tenant_key,workspace_key,environment,agent_id,title,system_prompt,content_sha256,source_head_sha256,source_prompt,source_revision_id,created_by_user_id,source_bundle_ids)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[...scope(c),agentId,
      String(boundedEvaluationJson(b.title,1024,'title')),b.system_prompt,evaluationDigest(b.system_prompt),b.source_head_sha256,agent.system_prompt,source.prompt_revision_id,c.user.id,agent.bundle_ids])).rows[0]!);
  },id=>evaluationPreview(pool,client=>getPromptRevision(client,id,c)));
}
/** Only a stored, scoped, unchanged-source revision can replace a frozen prompt. */
export async function withPromptRevision(client:pg.PoolClient,snapshot:Record<string,unknown>,id:number,c:EvaluationContext):Promise<Record<string,unknown>> {
  const r=await getPromptRevision(client,id,c),agent=snapshot['agent'] as Record<string,unknown>;
  if (r.agent_id!==agent['id']) missingReference();
  if (await rawHead(client,r.agent_id)!==r.source_head_sha256 || evaluationDigest(agent['system_prompt'])!==evaluationDigest(r.source_prompt)) {
    throw new EvaluationError('EVALUATION_PROMPT_STALE','The draft source Agent changed. Save a new draft and comparison.',409);
  }
  cleanDeployablePrompt(r.system_prompt);
  return { ...snapshot,agent:{ ...agent,system_prompt:r.system_prompt },
    prompt_revision:{ id:r.id,content_sha256:r.content_sha256,source_head_sha256:r.source_head_sha256 } };
}
