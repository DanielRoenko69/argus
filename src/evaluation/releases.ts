import type pg from 'pg';
import { readPinnedAgentSkills } from '../agents/skillStore.js';
import { z } from 'zod';
import { hasRole } from '../auth/roles.js';
import { hasFreshMfaSession } from '../auth/userAuth.js';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import { assertGlobalCatalogScope, missingReference, type EvaluationContext } from './context.js';
import { evaluationDigest, EvaluationError, evaluationReadiness } from './contracts.js';
import { assertEvaluationAgent, boundedEvaluationJson, freezeEvaluationConfiguration } from './snapshots.js';
import { getEvaluationComparisonDetail, lockEvaluationComparison, requireEvaluationRequestId } from './comparisonStore.js';
import { getEvaluationDataset, mutate, type EvaluationExperiment } from './store.js';
import { buildEvaluationExport } from './export.js';
import { evaluationPreview } from './authoring.js';

const object=(v:unknown) => (v ?? {}) as Record<string,unknown>;
const fail=(code:string,message:string):never => { throw new EvaluationError(code,message,409); };
const settingsSchema=z.object({ model:z.string().min(1).max(255),runtime_profile_id:z.number().int().positive().nullable() }).strict();
type Settings=z.infer<typeof settingsSchema>;
export const executionReleaseSchema=z.object({ preview_sha256:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(8).max(2000),confirm:z.literal(true) }).strict();
const limitation='Changes only model/runtime for new runs. Prompt, Skills, Knowledge, tools, credentials and permissions stay unchanged. Answer tests are not production or tool certification; this is an operator decision, not four-eyes approval.';
interface Release {
  id:number; tenant_key:string; workspace_key:string; environment:string; comparison_id:number; agent_id:number; candidate_agent_id:number;
  action:'applied'|'rolled_back'; source_release_id:number|null; before_settings:Settings; after_settings:Settings;
  before_head_sha256:string; after_head_sha256:string; before_config_sha256:string; after_config_sha256:string;
  evidence_sha256:string; reason:string; actor_user_id:number; created_at:string;
}
export function authorizeRelease(context:EvaluationContext,mfaMaxAge?:number) {
  assertGlobalCatalogScope(context);
  if (!hasRole(context.user.role,'platform_admin') || !evaluatePermission(context.user,'agents.manage').allowed) {
    throw new EvaluationError('FORBIDDEN','Platform admin and agents.manage are required',403);
  }
  if (mfaMaxAge!==undefined && !hasFreshMfaSession(context.user,mfaMaxAge)) {
    throw new EvaluationError('MFA_STEP_UP_REQUIRED','Fresh provider-verified MFA is required for execution release',428);
  }
}
const normalize=(r:Release):Release => ({ ...r,id:Number(r.id),comparison_id:Number(r.comparison_id),agent_id:Number(r.agent_id),candidate_agent_id:Number(r.candidate_agent_id),source_release_id:r.source_release_id==null?null:Number(r.source_release_id) });
const scope=(c:EvaluationContext) => [c.tenantKey,c.workspaceKey,c.environment];
function allowedBundles(ids:unknown,context:EvaluationContext) {
  if (ids==null && context.user.allowed_bundles==null) return;
  if (!Array.isArray(ids) || ids.some(id=>!Number.isSafeInteger(id) || context.user.allowed_bundles && !context.user.allowed_bundles.includes(id))) missingReference();
}
function configOnly(s:Record<string,unknown>) {
  const { evaluator:_e,baseline_experiment_id:_b,...rest }=s; return rest;
}
function effectiveConfig(s:Record<string,unknown>) {
  const { source_updated_at:_t,...agent }=object(s['agent']);return { ...configOnly(s),agent };
}
/** Runtime changes may not smuggle in different workspace, memory or tool policy. */
export function executionReleaseChoices(a:Record<string,unknown>,b:Record<string,unknown>) {
  const aa=object(a['agent']),ba=object(b['agent']),ae=object(a['execution']),be=object(b['execution']);
  const context=(s:Record<string,unknown>) => {
    const { id:_id,name:_n,label:_l,source_updated_at:_t,model:_m,runtime_profile_id:_r,...agent }=object(s['agent']);
    return { version:s['version'],context_mode:s['context_mode'],agent,skills:s['skills'] };
  };
  if (evaluationDigest(context(a))!==evaluationDigest(context(b))) fail('EVALUATION_RELEASE_CONTEXT','V1 releases require identical prompt, Skills, parameters, role and Bundle context. Compare execution choices only.');
  const policies=['type','credential_ref','adapter_pack_id','adapter_id','workspace_policy','memory_policy','native_tool_policy','session_policy','adapter_config_sha256'];
  if (policies.some(k => evaluationDigest(ae[k] ?? null)!==evaluationDigest(be[k] ?? null))) fail('EVALUATION_RELEASE_POLICY','Runtime type, credentials and runtime policies must remain unchanged.');
  for (const s of [a,b]) if (!evaluationReadiness('frozen_v1',s).startable) fail('EVALUATION_RELEASE_UNSUPPORTED','Both execution targets must still support verified isolated evaluation.');
  const before=settingsSchema.parse({ model:aa['model'],runtime_profile_id:aa['runtime_profile_id'] ?? null });
  // Keep the unused native model text for a subscription profile; only switch its profile.
  const after=settingsSchema.parse({ model:ae['type']==='argus' ? be['model_alias'] : before.model,runtime_profile_id:ba['runtime_profile_id'] ?? null });
  if (ae['type']==='argus' && before.model!==ae['model_alias']) fail('EVALUATION_RELEASE_BASELINE','Baseline must evaluate the Agent’s current model, not an override.');
  if (evaluationDigest(before)===evaluationDigest(after)) fail('EVALUATION_RELEASE_NO_CHANGE','A and B have the same execution choice. This is a repeatability test; there is nothing to release.');
  return { before,after };
}
export async function rawHead(client:pg.PoolClient,id:number) {
  const row=(await client.query('SELECT * FROM mcp_agents WHERE id=$1',[id])).rows[0];
  if (!row) missingReference();return evaluationDigest(row);
}
export function runtimeReleasePolicyDigest(row:Record<string,unknown>) {
  // Pin every live setting, including code-context, task types and adapter/auth refs.
  // Only these descriptive/execution-selection fields may differ between profiles.
  const { id:_id,name:_name,label:_label,description:_description,model:_model,reasoning_effort:_effort,
    created_by:_author,created_at:_created,updated_at:_updated,...policy }=row;
  return evaluationDigest(policy);
}
async function profileEvidence(client:pg.PoolClient,id:number|null) {
  if (id===null) return { head:evaluationDigest(null),policy:evaluationDigest(null) };
  const row=(await client.query('SELECT * FROM mcp_agent_runtime_profiles WHERE id=$1 FOR SHARE',[id])).rows[0];
  if (!row) missingReference();
  return { head:evaluationDigest(row),policy:runtimeReleasePolicyDigest(row) };
}
export async function configurationHead(client:pg.PoolClient,snapshot:Record<string,unknown>,settings:Settings) {
  return evaluationDigest({ configuration:effectiveConfig(snapshot),runtime_head:(await profileEvidence(client,settings.runtime_profile_id)).head });
}
async function access(client:pg.PoolClient,release:Pick<Release,'agent_id'|'candidate_agent_id'>,context:EvaluationContext) {
  for (const id of [...new Set([release.agent_id,release.candidate_agent_id])].sort((a,b)=>a-b)) await assertEvaluationAgent(client,id,context);
}
export async function authorizeEvidence(client:pg.PoolClient,id:number,context:EvaluationContext) {
  const row=(await client.query(`SELECT c.id,d.bundle_ids FROM mcp_evaluation_comparisons c JOIN mcp_evaluation_datasets d ON d.id=c.dataset_id
    WHERE c.id=$1 AND c.tenant_key=$2 AND c.workspace_key=$3 AND c.environment=$4 AND d.tenant_key=$2 AND d.workspace_key=$3`,[id,...scope(context)])).rows[0];
  if (!row) missingReference();allowedBundles(row.bundle_ids,context);
  const sources=(await client.query(`SELECT e.agent_id,e.configuration_snapshot->'agent'->'bundle_ids' AS bundle_ids FROM mcp_evaluation_experiments e
    JOIN mcp_evaluation_comparison_steps s ON s.experiment_id=e.id WHERE s.comparison_id=$1 ORDER BY e.agent_id`,[id])).rows;
  for (const s of sources) { if (!s.agent_id) missingReference();allowedBundles(s.bundle_ids,context);await assertEvaluationAgent(client,Number(s.agent_id),context); }
}
export async function checkedSource(client:pg.PoolClient,e:EvaluationExperiment,context:EvaluationContext) {
  if (!e.agent_id || !e.configuration_snapshot) missingReference();
  const live=await freezeEvaluationConfiguration(client,e.agent_id,e.model_ref,e.credential_ref,context);
  if (evaluationDigest(live)!==evaluationDigest(configOnly(e.configuration_snapshot))) fail('EVALUATION_RELEASE_STALE','Agent, Skills or execution target changed since evaluation. Create a fresh comparison.');
  // Redacted prompts/Skills are intentionally not deployable configuration evidence.
  const agent=await assertEvaluationAgent(client,e.agent_id,context);
  if (evaluationDigest(agent.system_prompt)!==evaluationDigest(object(live['agent'])['system_prompt'])) fail('EVALUATION_RELEASE_REDACTED','The evaluated prompt was redacted; release is not supported for this snapshot.');
  const skills=await readPinnedAgentSkills(client,e.agent_id,true);
  if (evaluationDigest(skills)!==evaluationDigest(live['skills'])) fail('EVALUATION_RELEASE_REDACTED','Evaluated Skills were redacted; release is not supported for this snapshot.');
  return live;
}
export async function passingComparison(client:pg.PoolClient,id:number,context:EvaluationContext) {
  const comparison=await lockEvaluationComparison(client,id,context);
  if (comparison.environment!==context.environment) missingReference();
  if (comparison.status!=='completed' || !comparison.plan.length || comparison.plan.length>20) fail('EVALUATION_RELEASE_GATE','Complete the comparison before reviewing release.');
  // Bound decoded evidence before loading full results (same 16 MiB envelope as exports).
  const size=(await client.query(`SELECT
    (SELECT coalesce(sum(octet_length(to_jsonb(e)::text)),0) FROM mcp_evaluation_experiments e WHERE id=ANY($1::int[]))+
    (SELECT coalesce(sum(octet_length(to_jsonb(r)::text)),0) FROM mcp_evaluation_results r WHERE experiment_id=ANY($1::int[]))+
    (SELECT coalesce(sum(octet_length(to_jsonb(a)::text)),0) FROM mcp_evaluation_attempts a WHERE experiment_id=ANY($1::int[]))+
    (SELECT coalesce(sum(octet_length(to_jsonb(c)::text)),0) FROM mcp_evaluation_cases c WHERE dataset_id=$2) AS bytes`,[comparison.plan.map(s=>s.experiment_id),comparison.dataset_id])).rows[0];
  if (Number(size.bytes)>16*1024*1024) fail('EVALUATION_RELEASE_TOO_LARGE','Comparison evidence exceeds the release review limit (16 MiB).');
  const detail=await getEvaluationComparisonDetail(client,id,context);
  const dataset=await getEvaluationDataset(client,comparison.dataset_id,context);
  if (!detail || !dataset) missingReference();
  const a=detail.records.find(r=>r.round===1 && r.variant==='baseline')?.experiment;
  const b=detail.records.find(r=>r.round===1 && r.variant==='candidate')?.experiment;
  if (!a?.agent_id || !b?.agent_id) missingReference();
  // Same lock order for two simultaneous releases, including A/B in reverse order.
  await client.query('SELECT id FROM mcp_agents WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[a.agent_id,b.agent_id]]);
  allowedBundles(dataset.dataset.bundle_ids,context);
  for (const r of detail.records) {
    if (!r.experiment.agent_id) missingReference();await assertEvaluationAgent(client,r.experiment.agent_id,context);
    allowedBundles(object(r.experiment.configuration_snapshot?.['agent'])['bundle_ids'],context);
  }
  const evidence=buildEvaluationExport(detail,dataset);
  if (evidence.payload.summary.comparison_state!=='passed') fail('EVALUATION_RELEASE_GATE','All comparison rounds must pass before release.');
  return { detail,a:{ ...a,agent_id:a.agent_id },b:{ ...b,agent_id:b.agent_id },evidence };
}
async function buildReleasePreview(client:pg.PoolClient,id:number,context:EvaluationContext) {
  const { a,b,evidence }=await passingComparison(client,id,context);
  const currentA=await checkedSource(client,a,context),currentB=await checkedSource(client,b,context);
  const { before,after }=executionReleaseChoices(currentA,currentB);
  const profileA=await profileEvidence(client,before.runtime_profile_id),profileB=await profileEvidence(client,after.runtime_profile_id);
  if (profileA.policy!==profileB.policy) fail('EVALUATION_RELEASE_POLICY','Runtime context, task scope, adapter, authentication and other runtime settings must remain unchanged.');
  const data={ comparison_id:id,agent_id:a.agent_id,candidate_agent_id:b.agent_id,before_settings:before,after_settings:after,
    before_head_sha256:await rawHead(client,a.agent_id),candidate_head_sha256:await rawHead(client,b.agent_id),
    before_config_sha256:await configurationHead(client,currentA,before),
    expected_after_config_sha256:await configurationHead(client,{ ...currentA,agent:{ ...object(currentA['agent']),...after },execution:currentB['execution'] },after),evidence_sha256:evidence.payload_sha256,
    baseline_label:String(object(currentA['agent'])['label']),candidate_label:String(object(currentB['agent'])['label']),
    before_target:object(currentA['execution'])['effective_model'],after_target:object(currentB['execution'])['effective_model'],
    before_reasoning:object(currentA['execution'])['reasoning_effort'],after_reasoning:object(currentB['execution'])['reasoning_effort'],limitation };
  return { ...data,preview_sha256:evaluationDigest(data) };
}
export async function previewExecutionRelease(pool:pg.Pool,id:number,context:EvaluationContext) {
  authorizeRelease(context);return evaluationPreview(pool,c=>buildReleasePreview(c,id,context));
}
async function getRelease(client:Pick<pg.Pool,'query'>,id:number,context:EvaluationContext) {
  const r=(await client.query<Release>('SELECT * FROM mcp_evaluation_execution_releases WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 AND environment=$4',[id,...scope(context)])).rows[0];
  if (!r) missingReference();return normalize(r);
}
export async function listExecutionReleases(pool:pg.Pool,id:number,context:EvaluationContext) {
  authorizeRelease(context);
  return evaluationPreview(pool,async client => {
    await authorizeEvidence(client,id,context);
    const rows=(await client.query<Release>('SELECT * FROM mcp_evaluation_execution_releases WHERE comparison_id=$1 AND tenant_key=$2 AND workspace_key=$3 AND environment=$4 ORDER BY id DESC LIMIT 50',[id,...scope(context)])).rows.map(normalize);
    for (const row of rows) await access(client,row,context);
    return rows;
  });
}
async function currentConfiguration(client:pg.PoolClient,id:number,settings:Settings,context:EvaluationContext) {
  const profile=settings.runtime_profile_id ? (await client.query('SELECT runtime_type,model FROM mcp_agent_runtime_profiles WHERE id=$1 FOR SHARE',[settings.runtime_profile_id])).rows[0] : null;
  return freezeEvaluationConfiguration(client,id,profile && profile.runtime_type!=='argus' ? profile.model : settings.model,null,context);
}
async function writeSettings(client:pg.PoolClient,id:number,settings:Settings) {
  await client.query('UPDATE mcp_agents SET model=$2,runtime_profile_id=$3,updated_at=clock_timestamp() WHERE id=$1',[id,settings.model,settings.runtime_profile_id]);
}
async function insertRelease(client:pg.PoolClient,input:Omit<Release,'id'|'created_at'|'tenant_key'|'workspace_key'|'environment'|'actor_user_id'>,context:EvaluationContext) {
  return normalize((await client.query<Release>(`INSERT INTO mcp_evaluation_execution_releases
    (tenant_key,workspace_key,environment,comparison_id,agent_id,candidate_agent_id,action,source_release_id,before_settings,after_settings,
     before_head_sha256,after_head_sha256,before_config_sha256,after_config_sha256,evidence_sha256,reason,actor_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [...scope(context),input.comparison_id,input.agent_id,input.candidate_agent_id,input.action,input.source_release_id,input.before_settings,input.after_settings,
      input.before_head_sha256,input.after_head_sha256,input.before_config_sha256,input.after_config_sha256,input.evidence_sha256,input.reason,context.user.id])).rows[0]!);
}
async function replay(pool:pg.Pool,id:number,context:EvaluationContext) {
  return evaluationPreview(pool,async client => { const row=await getRelease(client,id,context);await authorizeEvidence(client,row.comparison_id,context);await access(client,row,context);return row; });
}
export async function applyExecutionRelease(pool:pg.Pool,id:number,input:unknown,context:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(context,mfaMaxAge);requireEvaluationRequestId(context);const b=executionReleaseSchema.parse(input);
  // Preauthorize even a replay; mutate() bypasses its callback on a stored event.
  await evaluationPreview(pool,client=>authorizeEvidence(client,id,context));
  return mutate(pool,context,'release.applied',{ id,...b },async client => {
    const p=await buildReleasePreview(client,id,context);
    if (p.preview_sha256!==b.preview_sha256) fail('EVALUATION_RELEASE_STALE','Release preview changed. Review the current configuration again.');
    await writeSettings(client,p.agent_id,p.after_settings);
    const after=await currentConfiguration(client,p.agent_id,p.after_settings,context);
    if (await configurationHead(client,after,p.after_settings)!==p.expected_after_config_sha256) fail('EVALUATION_RELEASE_STALE','The resulting configuration does not match the evaluated candidate. No change was applied.');
    // Revalidate the resulting Agent's credential/profile route before committing.
    return insertRelease(client,{ comparison_id:id,agent_id:p.agent_id,candidate_agent_id:p.candidate_agent_id,action:'applied',source_release_id:null,
      before_settings:p.before_settings,after_settings:p.after_settings,before_head_sha256:p.before_head_sha256,after_head_sha256:await rawHead(client,p.agent_id),
      before_config_sha256:p.before_config_sha256,after_config_sha256:p.expected_after_config_sha256,evidence_sha256:p.evidence_sha256,
      reason:String(boundedEvaluationJson(b.reason,8000,'release reason')) },context);
  },releaseId=>replay(pool,releaseId,context));
}
async function buildRollbackPreview(client:pg.PoolClient,id:number,context:EvaluationContext) {
  const row=await getRelease(client,id,context);
  await client.query('SELECT id FROM mcp_agents WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[[row.agent_id,row.candidate_agent_id]]);
  await access(client,row,context);
  await authorizeEvidence(client,row.comparison_id,context);
  if (row.action!=='applied' || (await client.query('SELECT id FROM mcp_evaluation_execution_releases WHERE source_release_id=$1',[id])).rows.length) fail('EVALUATION_RELEASE_ALREADY_REVERTED','This release has already been rolled back or is not an apply decision.');
  const current=await currentConfiguration(client,row.agent_id,row.after_settings,context);
  if (await rawHead(client,row.agent_id)!==row.after_head_sha256 || await configurationHead(client,current,row.after_settings)!==row.after_config_sha256) fail('EVALUATION_RELEASE_STALE','Agent or target changed after release. Rollback will not overwrite intervening changes.');
  const data={ release_id:id,agent_id:row.agent_id,before_settings:row.after_settings,after_settings:row.before_settings,
    current_head_sha256:row.after_head_sha256,evidence_sha256:row.evidence_sha256,limitation };
  return { row,preview:{ ...data,preview_sha256:evaluationDigest(data) } };
}
export async function previewExecutionRollback(pool:pg.Pool,id:number,context:EvaluationContext) {
  authorizeRelease(context);return evaluationPreview(pool,async c=>(await buildRollbackPreview(c,id,context)).preview);
}
export async function rollbackExecutionRelease(pool:pg.Pool,id:number,input:unknown,context:EvaluationContext,mfaMaxAge=600) {
  authorizeRelease(context,mfaMaxAge);requireEvaluationRequestId(context);const b=executionReleaseSchema.parse(input);
  await replay(pool,id,context);
  return mutate(pool,context,'release.rolled_back',{ id,...b },async client => {
    const { row,preview }=await buildRollbackPreview(client,id,context);
    if (preview.preview_sha256!==b.preview_sha256) fail('EVALUATION_RELEASE_STALE','Rollback preview changed. Review again.');
    await writeSettings(client,row.agent_id,row.before_settings);
    const restored=await currentConfiguration(client,row.agent_id,row.before_settings,context);
    if (await configurationHead(client,restored,row.before_settings)!==row.before_config_sha256) fail('EVALUATION_RELEASE_STALE','The previous execution target changed or is unavailable. No settings were restored.');
    return insertRelease(client,{ comparison_id:row.comparison_id,agent_id:row.agent_id,candidate_agent_id:row.candidate_agent_id,action:'rolled_back',source_release_id:id,
      before_settings:row.after_settings,after_settings:row.before_settings,before_head_sha256:row.after_head_sha256,after_head_sha256:await rawHead(client,row.agent_id),
      before_config_sha256:row.after_config_sha256,after_config_sha256:row.before_config_sha256,evidence_sha256:row.evidence_sha256,
      reason:String(boundedEvaluationJson(b.reason,8000,'rollback reason')) },context);
  },releaseId=>replay(pool,releaseId,context));
}
