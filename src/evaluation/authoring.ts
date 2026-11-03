import type pg from 'pg';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import { resolveRegisteredLlmTarget } from '../llm/modelRegistry.js';
import { createComparisonSchema, evaluationDigest, evaluationReadiness, evaluationRulesSchema, EvaluationError } from './contracts.js';
import { missingReference, type EvaluationContext } from './context.js';
import { assertEvaluationAgent, freezeEvaluationConfiguration } from './snapshots.js';
import { datasetContentDigest, getEvaluationDataset } from './store.js';
import { buildEvaluationRequest } from './nativeExecutor.js';
import { codexEvaluationAvailable, codexProfileSupported, buildCodexEvaluationRequest } from './codexExecutor.js';
import { withPromptRevision } from './promptRevisions.js';
import { withSkillRevision } from './skillRevisions.js';

/** Preview operations never persist evidence or send provider requests. */
export async function evaluationPreview<T>(pool:pg.Pool,read:(client:pg.PoolClient)=>Promise<T>):Promise<T> {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    return await read(client);
  } finally {
    try { await client.query('ROLLBACK'); } finally { client.release(); }
  }
}

export async function listEvaluationTargets(pool:pg.Pool,agentId:number,context:EvaluationContext) {
  return evaluationPreview(pool,async client => {
    const agent=await assertEvaluationAgent(client,agentId,context);
    const runtime=await getAgentRuntimeAssignment(client as unknown as pg.Pool,agentId);
    const runtimeType=runtime?.runtime_type ?? 'argus';
    const codexReady=codexProfileSupported(runtime) && await codexEvaluationAvailable();
    const blocked=agent.runtime_profile_id && !runtime?.profile_enabled
      ? 'The assigned runtime profile is disabled. Update the Agent configuration first.'
      : runtimeType!=='argus' && !codexReady
        ? 'This runtime has no verified isolated evaluation mode yet. Normal Agent runs remain available; no API fallback will be used.'
        : agent.llm_api_key ? 'This Agent uses an inline key. Configure a managed credential profile first.' : null;
    const agentInfo={ id:agent.id,label:agent.label || agent.name,runtime_type:runtimeType,
      runtime_label:runtime?.profile_label ?? 'Direct API',default_model:runtimeType==='argus' ? agent.model : runtime?.model ?? null,
      reasoning_effort:runtime?.reasoning_effort ?? null };
    if (runtimeType!=='argus') {
      // A subscription profile is not an API alias. Show its real target, but do
      // not suggest unrelated API models or grant execution before certification.
      return { agent:agentInfo,blocker:blocked,
        targets:runtime?.profile_id && runtime.model?.trim() ? [{ id:runtime.profile_id,
          kind:'runtime_profile' as const,model_ref:runtime.model,label:runtime.profile_label ?? runtime.model,
          effective_model:runtime.model,provider_label:runtimeType,selectable:codexReady && !blocked,reason:blocked }] : [],
        note:codexReady ? 'Uses the assigned Codex model and reasoning setting. No tools, API fallback or automatic retries. Starting uses subscription quota; monetary cost is unknown.'
          : 'This runtime adapter is not available for isolated evaluation. No subscription or API request can start from this selection.',
      };
    }
    const rows=(await client.query(`SELECT m.id,m.model_name,m.display_name,m.upstream_model_name,m.enabled,
        p.label AS provider_label,p.enabled AS provider_enabled,
        count(*) FILTER (WHERE m.enabled AND p.enabled) OVER (PARTITION BY m.model_name) AS aliases
      FROM mcp_models m LEFT JOIN mcp_llm_providers p ON p.id=m.provider_id
      ORDER BY m.display_name,m.id`)).rows;
    return {
      agent:agentInfo,
      blocker:blocked,
      targets:rows.map(m => ({ id:Number(m.id),kind:'api_model' as const,model_ref:m.model_name,label:m.display_name || m.model_name,
        effective_model:m.upstream_model_name || m.model_name,provider_label:m.provider_label ?? 'Provider missing',
        selectable:!blocked && m.enabled && m.provider_enabled===true && Number(m.aliases)===1,
        reason:blocked ?? (!m.enabled ? 'Model disabled' : !m.provider_enabled ? 'Provider unavailable or disabled'
          : Number(m.aliases)!==1 ? 'Model alias is ambiguous' : null),
      })),
      note:'Catalog availability only. Preflight checks credentials and configuration without contacting a provider.',
    };
  });
}

const object=(v:unknown) => (v ?? {}) as Record<string,unknown>;
function publicConfiguration(snapshot:Record<string,unknown>) {
  const agent=object(snapshot['agent']),execution=object(snapshot['execution']);
  const codex=execution['type']==='codex';
  return { agent_id:Number(agent['id']),agent_name:String(agent['label'] || agent['name']),model_ref:String(execution['model_alias']),
    effective_model:String(execution['effective_model']),runtime_label:String(execution['profile_label'] ?? execution['profile_name'] ?? 'Direct API'),
    prompt_sha256:evaluationDigest(agent['system_prompt']),skills_sha256:evaluationDigest(snapshot['skills']),
    skill_count:Array.isArray(snapshot['skills']) ? snapshot['skills'].length : 0,
    temperature:codex ? null : agent['temperature'],max_tokens:codex ? null : agent['max_tokens'],thinking_budget:codex ? null : agent['thinking_budget'],
    reasoning_effort:execution['reasoning_effort'],configuration_sha256:evaluationDigest(snapshot) };
}

/** Called in the save transaction too, so a reviewed configuration cannot drift silently. */
export async function buildComparisonPreview(client:pg.PoolClient,input:unknown,context:EvaluationContext) {
  const { reviewed_preflight_sha256:_reviewed,...b }=createComparisonSchema.parse(input);
  await client.query('SELECT id FROM mcp_evaluation_datasets WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3 FOR UPDATE',
    [b.dataset_id,context.tenantKey,context.workspaceKey]);
  const record=await getEvaluationDataset(client,b.dataset_id,context);
  if (!record) missingReference();
  const { dataset,cases }=record;
  if (dataset.status!=='active' || dataset.contract_version!==1 || !cases.length) {
    throw new EvaluationError('EVALUATION_DATASET_NOT_FROZEN','Select an active test set with frozen cases',409);
  }
  if (datasetContentDigest(cases)!==dataset.content_sha256) throw new EvaluationError('EVALUATION_DIGEST_MISMATCH','Dataset digest verification failed',409);
  for (const c of cases) evaluationRulesSchema.parse(c.rules);
  if ((b.candidate.prompt_revision_id || b.candidate.skill_revision_id) && (!b.baseline.agent_id || b.baseline.agent_id!==b.candidate.agent_id
    || b.baseline.model_ref!==b.candidate.model_ref || (b.baseline.credential_ref ?? null)!==(b.candidate.credential_ref ?? null))) {
    throw new EvaluationError('EVALUATION_PROMPT_CONTEXT','Revision comparisons require the same Agent, model and credential on both sides.',409);
  }
  const freeze=async (variant:typeof b.candidate) => {
    const agentId=variant.agent_id ?? dataset.agent_id;
    if (!agentId) throw new EvaluationError('EVALUATION_AGENT_REQUIRED','Select an Agent for both variants');
    const live=await freezeEvaluationConfiguration(client,agentId,variant.model_ref,variant.credential_ref ?? null,context);
    if ((b.candidate.prompt_revision_id || b.candidate.skill_revision_id) && object(live['execution'])['type']==='argus' && object(live['agent'])['model']!==variant.model_ref) {
      throw new EvaluationError('EVALUATION_PROMPT_CONTEXT','Prompt comparisons must use the Agent’s current execution choice.',409);
    }
    const snapshot=variant.prompt_revision_id ? await withPromptRevision(client,live,variant.prompt_revision_id,context)
      : variant.skill_revision_id ? await withSkillRevision(client,live,variant.skill_revision_id,context) : live;
    const ready=evaluationReadiness('frozen_v1',snapshot);
    if (!ready.startable) throw new EvaluationError(ready.code,ready.reason,409);
    const execution=object(snapshot['execution']);
    if (execution['type']==='codex') {
      for (const c of cases) buildCodexEvaluationRequest(snapshot,c);
      return snapshot;
    }
    const credential=execution['credential_ref'];
    const profileId=typeof credential==='string' ? Number(credential.replace('profile:','')) : null;
    let target;
    try { target=await resolveRegisteredLlmTarget(client as unknown as pg.Pool,variant.model_ref,null,profileId,true); }
    catch { throw new EvaluationError('EVALUATION_CREDENTIAL_UNAVAILABLE','The selected API target is unavailable. Review the provider and managed credentials in Settings → Models.',409); }
    for (const c of cases) buildEvaluationRequest(snapshot,c,target);
    return snapshot;
  };
  const a=await freeze(b.baseline),c=await freeze(b.candidate);
  const baseline=publicConfiguration(a),candidate=publicConfiguration(c);
  const differences=(['agent_id','model_ref','effective_model','runtime_label','prompt_sha256','skills_sha256',
    'temperature','max_tokens','thinking_budget','reasoning_effort'] as const)
    .filter(key => evaluationDigest(baseline[key])!==evaluationDigest(candidate[key]));
  const configurationChanged=differences.some(k => !['model_ref','effective_model'].includes(k));
  return { ready:true as const,dataset:{ id:dataset.id,name:dataset.name,version:dataset.version,case_count:cases.length,sha256:dataset.content_sha256 },
    baseline,candidate,differences,comparison_kind:configurationChanged ? 'agent_configuration' : 'model',
    planned_requests:cases.length*2*b.repetitions,repetitions:b.repetitions,order_mode:b.order_mode,
    preflight_sha256:evaluationDigest({ input:b,dataset_sha256:dataset.content_sha256,baseline:a,candidate:c }),
    warnings:[...(differences.length ? [] : ['Both variants have the same configuration; this measures repeatability.']),
      'This checks local configuration, not provider reachability. Access and routing are checked again at execution.',
      'Costs depend on actual usage. Missing prices or usage remain unknown; no automatic retries.'],
  };
}
