import type pg from 'pg';
import { readPinnedAgentSkills } from '../agents/skillStore.js';
import { agentAccessGate } from '../agents/agentStore.js';
import { getAgentRuntimeAssignment } from '../agents/runtimeProfiles.js';
import { redactJson } from '../lib/redaction.js';
import { evaluationDigest, EvaluationError } from './contracts.js';
import { assertGlobalCatalogScope, missingReference, type EvaluationContext } from './context.js';
import type { LlmTarget } from '../llm/types.js';
import { CODEX_EVALUATION_EXECUTOR, codexProfileSupported, codexEvaluationAvailable, codexRuntimeDigest, codexEvaluationTarget } from './codexExecutor.js';

export const NATIVE_EVALUATION_EXECUTOR = 'argus.native-reference.v1';
/** Routing fingerprint excludes credential values, permits rotation of the same reference. */
export function evaluationTargetDigest(target: Pick<LlmTarget, 'provider' | 'baseUrl' | 'authType' | 'model' | 'timeoutMs' | 'supportsReasoning'>) {
  return evaluationDigest({ provider:target.provider,baseUrl:target.baseUrl.replace(/\/+$/, ''),authType:target.authType,
    model:target.model,timeoutMs:target.timeoutMs,supportsReasoning:target.supportsReasoning });
}

export function boundedEvaluationJson(value: unknown, bytes: number, label: string): unknown {
  // Enforce the bound before walking arbitrary user-controlled JSON.
  const encoded = JSON.stringify(value ?? null);
  if (Buffer.byteLength(encoded, 'utf8') > bytes) throw new EvaluationError('EVALUATION_TOO_LARGE', `${label} exceeds ${bytes} bytes`);
  const strip = (v: unknown, depth = 0): unknown => {
    if (depth > 24) throw new EvaluationError('EVALUATION_TOO_DEEP', `${label} exceeds maximum nesting`);
    if (Array.isArray(v)) return v.map(item => strip(item, depth + 1));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, child]) =>
      [k, /(?:password|secret|api[_-]?key|(?:access|refresh|auth)[_-]?token|authorization|cookie)|^token$/i.test(k) ? '[REDACTED]' : strip(child, depth + 1)]));
    // Canonical UTC timestamps are provenance, not phone numbers. Preserve only
    // this exact bounded shape; all other strings use forced content redaction.
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
      && Number.isFinite(Date.parse(v))) return v;
    if (typeof v === 'string') return redactJson(v, { forceEnabled: true }).value;
    return v;
  };
  return strip(JSON.parse(encoded));
}

export async function assertEvaluationAgent(client: pg.PoolClient, id: number, context: EvaluationContext) {
  assertGlobalCatalogScope(context);
  await client.query('SELECT id FROM mcp_agents WHERE id=$1 FOR SHARE', [id]);
  const access = await agentAccessGate(client as unknown as pg.Pool, id, context.user);
  if (access.verdict !== 'ok' || !access.agent) missingReference();
  return access.agent;
}

export async function freezeEvaluationConfiguration(
  client: pg.PoolClient, agentId: number, modelRef: string, credentialRef: string | null, context: EvaluationContext,
): Promise<Record<string, unknown>> {
  const agent = await assertEvaluationAgent(client, agentId, context);
  if (agent.runtime_profile_id) await client.query('SELECT id FROM mcp_agent_runtime_profiles WHERE id=$1 FOR SHARE', [agent.runtime_profile_id]);
  const runtime = await getAgentRuntimeAssignment(client as unknown as pg.Pool, agentId);
  if (agent.runtime_profile_id && (!runtime?.profile_id || !runtime.profile_enabled)) missingReference();
  const type = runtime?.runtime_type ?? 'argus';
  const external = type !== 'argus';
  const codexReady=codexProfileSupported(runtime) && await codexEvaluationAvailable();
  if (external && (!runtime?.model || modelRef !== runtime.model)) {
    throw new EvaluationError('EVALUATION_MODEL_MISMATCH', 'Use the exact model configured on the selected runtime profile');
  }
  if (agent.llm_api_key) throw new EvaluationError('EVALUATION_INLINE_CREDENTIAL_UNSUPPORTED', 'Use a managed credential profile, not an inline Agent key');
  const modelRows = external ? [] : (await client.query(
    `SELECT m.id,m.model_name,m.upstream_model_name,m.deployment_name,m.provider_id,m.updated_at,
            m.supports_reasoning,m.input_cost_per_1k,m.output_cost_per_1k,
            p.provider_type,p.credential_profile_id,p.updated_at AS provider_updated_at,
            p.base_url,p.auth_type,p.config AS provider_config
       FROM mcp_models m JOIN mcp_llm_providers p ON p.id=m.provider_id
      WHERE m.model_name=$1 AND m.enabled AND p.enabled FOR SHARE OF m,p`, [modelRef])).rows;
  if (!external && modelRows.length !== 1) {
    throw new EvaluationError('EVALUATION_TARGET_UNAVAILABLE', 'Select one enabled, unambiguous model alias with an enabled provider', 409);
  }
  const model = modelRows[0] ?? null;
  const targetDigest = model ? evaluationTargetDigest({ provider:model.provider_type,baseUrl:model.base_url,
    authType:model.auth_type,model:model.upstream_model_name || modelRef,supportsReasoning:model.supports_reasoning,
    timeoutMs:Number(model.provider_config?.timeoutMs ?? process.env['LLM_REQUEST_TIMEOUT_MS'] ?? 120000) }) : null;
  // Do not expose provider URLs/config; keep only a routing digest and public model metadata.
  const publicModel = model ? Object.fromEntries(Object.entries(model).filter(([key]) => !['base_url','auth_type','provider_config'].includes(key))) : null;
  const profileId = external ? null : agent.llm_credential_profile_id ?? model?.credential_profile_id ?? null;
  const effectiveCredentialRef = profileId ? `profile:${profileId}` : null;
  if (credentialRef !== null && credentialRef !== effectiveCredentialRef) missingReference();
  if (profileId) {
    const profile = (await client.query(
      `SELECT id FROM mcp_llm_credential_profiles WHERE id=$1 AND enabled AND provider_type=$2
         AND (expires_at IS NULL OR expires_at>now()) AND (api_key IS NOT NULL OR secret_name IS NOT NULL) FOR SHARE`,
      [profileId, model.provider_type])).rows[0];
    if (!profile) missingReference();
  }
  const skills = await readPinnedAgentSkills(client,agentId,true);
  // Explicit allowlists: do not serialize Agent, provider or adapter objects wholesale.
  return boundedEvaluationJson({
    version: 1, context_mode: 'isolated_reference',
    agent: { id: agent.id, name: agent.name, label:agent.label, model: agent.model, system_prompt: agent.system_prompt,
      temperature: agent.temperature, max_tokens: agent.max_tokens, thinking_budget: agent.thinking_budget,
      max_iterations: agent.max_iterations, agent_mode: agent.agent_mode, agent_role: agent.agent_role,
      bundle_ids: agent.bundle_ids, runtime_profile_id: agent.runtime_profile_id ?? null,
      untrusted_tool_output_enforcement: agent.untrusted_tool_output_enforcement,
      source_updated_at: agent.updated_at },
    skills,
    execution: { type, profile_id: runtime?.profile_id ?? null, profile_name: runtime?.profile_name ?? null, profile_label:runtime?.profile_label ?? null,
      reasoning_effort: runtime?.reasoning_effort ?? null, effective_model: external ? runtime!.model : model.upstream_model_name || modelRef,
      model_alias: modelRef, model_catalog: publicModel, credential_ref: effectiveCredentialRef,
      target_sha256:codexReady ? evaluationTargetDigest(codexEvaluationTarget(runtime!.model!)) : targetDigest,
      executor_version:codexReady ? CODEX_EVALUATION_EXECUTOR : external ? null : NATIVE_EVALUATION_EXECUTOR,
      ...(codexReady ? { runtime_configuration_sha256:codexRuntimeDigest(runtime!),applied_parameters:['model','reasoning_effort'] } : {}),
      // Native runtime adapters are recorded for visibility, never enabled implicitly.
      adapter_pack_id: runtime?.adapter_pack_id ?? null, adapter_id: runtime?.adapter_id ?? null,
      workspace_policy: runtime?.workspace_policy ?? null, memory_policy: runtime?.memory_policy ?? null,
      native_tool_policy: runtime?.native_tool_policy ?? null, session_policy: runtime?.session_policy ?? null,
      adapter_config_sha256: evaluationDigest(runtime?.adapter_config ?? null),
      isolation_verified: !external || codexReady },
  }, 262_144, 'configuration snapshot') as Record<string, unknown>;
}
