import type pg from 'pg';

export type AgentRuntimeType = 'argus' | 'codex' | 'claude-code' | 'hermes';
export type AgentRuntimeAuthMode = 'none' | 'chatgpt' | 'claude_subscription' | 'api_key' | 'managed_access_token' | 'runtime_adapter';
export type AgentRuntimeCodeContextMode = 'metadata_only' | 'bounded_source';
export type AgentRuntimeExecutionStrategy = 'attached' | 'managed' | 'auto';
export type AgentRuntimeWorkspacePolicy = 'context_only' | 'checkout' | 'isolated_worktree';
export type AgentRuntimeMemoryPolicy = 'none' | 'read_context' | 'propose_write';
export type AgentRuntimeNativeToolPolicy = 'disabled' | 'external_attested' | 'managed_mcp_only';
export type AgentRuntimeSessionPolicy = 'clean' | 'resume_project' | 'resume_explicit';

export interface AgentRuntimeAdapterBinding {
  adapter_pack_id: string | null;
  adapter_id: string | null;
  execution_strategy: AgentRuntimeExecutionStrategy | null;
  adapter_credential_ref: string | null;
  native_profile_ref: string | null;
  workspace_policy: AgentRuntimeWorkspacePolicy | null;
  memory_policy: AgentRuntimeMemoryPolicy | null;
  native_tool_policy: AgentRuntimeNativeToolPolicy | null;
  session_policy: AgentRuntimeSessionPolicy | null;
  adapter_config: Record<string, unknown> | null;
}

/** Public control-plane representation. It intentionally contains no secret. */
export interface AgentRuntimeProfile extends AgentRuntimeAdapterBinding {
  id: number;
  name: string;
  label: string;
  description: string;
  runtime_type: AgentRuntimeType;
  auth_mode: AgentRuntimeAuthMode;
  auth_ref: string | null;
  model: string | null;
  reasoning_effort: string | null;
  code_context_mode: AgentRuntimeCodeContextMode;
  code_context_max_results: number;
  code_context_max_bytes: number;
  enabled: boolean;
  max_concurrent_runs: number;
  allowed_task_types: string[];
  assigned_agent_count: number;
  managed: boolean;
  created_at: string;
  updated_at: string;
}

export interface AgentRuntimeAssignment extends AgentRuntimeAdapterBinding {
  agent_id: number;
  agent_name: string;
  runtime_type: AgentRuntimeType | null;
  profile_id: number | null;
  profile_name: string | null;
  profile_label: string | null;
  auth_mode: AgentRuntimeAuthMode | null;
  auth_ref: string | null;
  model: string | null;
  reasoning_effort: string | null;
  code_context_mode: AgentRuntimeCodeContextMode | null;
  code_context_max_results: number | null;
  code_context_max_bytes: number | null;
  max_concurrent_runs: number | null;
  profile_enabled: boolean | null;
}

export interface AgentRuntimeCodeContextPolicyInput {
  mode: AgentRuntimeCodeContextMode;
  maxResults: number;
  maxBytes: number;
}

export interface AgentRuntimeProfileInput {
  name: string;
  label: string;
  description: string;
  runtimeType: Exclude<AgentRuntimeType, 'hermes'>;
  model: string | null;
  reasoningEffort: string | null;
  enabled: boolean;
  maxConcurrentRuns: number;
  allowedTaskTypes: string[];
  codeContextMode: AgentRuntimeCodeContextMode;
  codeContextMaxResults: number;
  codeContextMaxBytes: number;
}

export class AgentRuntimeProfileAssignmentError extends Error {
  readonly status = 400;
}

export class AgentRuntimeCodeContextPolicyError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentRuntimeCodeContextPolicyError';
    this.status = status;
  }
}

export class AgentRuntimeProfileMutationError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AgentRuntimeProfileMutationError';
    this.status = status;
  }
}

function boundedText(value: unknown, field: string, maximum: number, required = false): string {
  if (typeof value !== 'string') throw new AgentRuntimeProfileMutationError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new AgentRuntimeProfileMutationError(`${field} is required`);
  if (normalized.length > maximum) throw new AgentRuntimeProfileMutationError(`${field} is too long`);
  return normalized;
}

export function normalizeAgentRuntimeProfile(value: unknown): AgentRuntimeProfileInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeProfileMutationError('Runtime profile must be an object');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    'name', 'label', 'description', 'runtimeType', 'model', 'reasoningEffort', 'enabled',
    'maxConcurrentRuns', 'allowedTaskTypes', 'codeContextMode', 'codeContextMaxResults',
    'codeContextMaxBytes',
  ]);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new AgentRuntimeProfileMutationError('Runtime profile contains unsupported fields');
  }
  const name = boundedText(input['name'], 'name', 96, true);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new AgentRuntimeProfileMutationError('name may only contain lowercase letters, numbers, _ and -');
  }
  const label = boundedText(input['label'], 'label', 160, true);
  const description = boundedText(input['description'] ?? '', 'description', 4_000);
  const runtimeType = input['runtimeType'];
  if (runtimeType !== 'argus' && runtimeType !== 'codex' && runtimeType !== 'claude-code') {
    throw new AgentRuntimeProfileMutationError('runtimeType must be argus, codex or claude-code');
  }
  const model = input['model'] == null || input['model'] === ''
    ? null
    : boundedText(input['model'], 'model', 160, true);
  if (model && !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) {
    throw new AgentRuntimeProfileMutationError('model contains unsupported characters');
  }
  const rawEffort = input['reasoningEffort'];
  const reasoningEffort = rawEffort == null || rawEffort === '' ? null : rawEffort;
  if (reasoningEffort !== null && !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(reasoningEffort))) {
    throw new AgentRuntimeProfileMutationError('reasoningEffort is invalid');
  }
  if (runtimeType !== 'codex' && reasoningEffort !== null) {
    throw new AgentRuntimeProfileMutationError('reasoningEffort is only supported by Codex profiles');
  }
  const enabled = input['enabled'] ?? true;
  if (typeof enabled !== 'boolean') throw new AgentRuntimeProfileMutationError('enabled must be boolean');
  const maxConcurrentRuns = input['maxConcurrentRuns'] ?? 1;
  if (!Number.isSafeInteger(maxConcurrentRuns) || Number(maxConcurrentRuns) < 1 || Number(maxConcurrentRuns) > 32) {
    throw new AgentRuntimeProfileMutationError('maxConcurrentRuns must be an integer from 1 to 32');
  }
  const allowedTaskTypes = input['allowedTaskTypes'] ?? [];
  if (!Array.isArray(allowedTaskTypes) || allowedTaskTypes.length > 64
    || allowedTaskTypes.some(item => typeof item !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(item))) {
    throw new AgentRuntimeProfileMutationError('allowedTaskTypes must contain up to 64 safe task names');
  }
  const codeContextMode = input['codeContextMode'] ?? 'metadata_only';
  const codeContextMaxResults = input['codeContextMaxResults'] ?? 4;
  const codeContextMaxBytes = input['codeContextMaxBytes'] ?? 12_000;
  const codePolicy = normalizeAgentRuntimeCodeContextPolicy({
    mode: codeContextMode,
    maxResults: codeContextMaxResults,
    maxBytes: codeContextMaxBytes,
  });
  if (runtimeType === 'argus' && codePolicy.mode !== 'metadata_only') {
    throw new AgentRuntimeProfileMutationError('Argus API profiles cannot share out-of-process source context');
  }
  return {
    name, label, description, runtimeType, model, reasoningEffort: reasoningEffort == null ? null : String(reasoningEffort),
    enabled, maxConcurrentRuns: Number(maxConcurrentRuns), allowedTaskTypes: [...new Set(allowedTaskTypes as string[])],
    codeContextMode: codePolicy.mode, codeContextMaxResults: codePolicy.maxResults, codeContextMaxBytes: codePolicy.maxBytes,
  };
}

function runtimeAuth(type: AgentRuntimeProfileInput['runtimeType']): { mode: AgentRuntimeAuthMode; ref: string | null } {
  if (type === 'codex') return { mode: 'chatgpt', ref: 'codex-auth' };
  if (type === 'claude-code') return { mode: 'claude_subscription', ref: 'claude-auth' };
  return { mode: 'none', ref: null };
}

export function normalizeAgentRuntimeCodeContextPolicy(
  value: unknown,
): AgentRuntimeCodeContextPolicyInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentRuntimeCodeContextPolicyError('Code context policy must be an object');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['mode', 'maxResults', 'maxBytes']);
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new AgentRuntimeCodeContextPolicyError('Code context policy contains unsupported fields');
  }
  const mode = input['mode'];
  const maxResults = input['maxResults'];
  const maxBytes = input['maxBytes'];
  if (mode !== 'metadata_only' && mode !== 'bounded_source') {
    throw new AgentRuntimeCodeContextPolicyError('mode must be metadata_only or bounded_source');
  }
  if (!Number.isSafeInteger(maxResults) || Number(maxResults) < 1 || Number(maxResults) > 8) {
    throw new AgentRuntimeCodeContextPolicyError('maxResults must be an integer from 1 to 8');
  }
  if (!Number.isSafeInteger(maxBytes) || Number(maxBytes) < 1024 || Number(maxBytes) > 24_000) {
    throw new AgentRuntimeCodeContextPolicyError('maxBytes must be an integer from 1024 to 24000');
  }
  return { mode, maxResults: Number(maxResults), maxBytes: Number(maxBytes) };
}

export async function listAgentRuntimeProfiles(pool: pg.Pool): Promise<AgentRuntimeProfile[]> {
  const { rows } = await pool.query<AgentRuntimeProfile>(`
    SELECT p.*,
           (p.created_by IS NULL) AS managed,
           (SELECT COUNT(*)::integer FROM mcp_agents a WHERE a.runtime_profile_id = p.id) AS assigned_agent_count,
           b.pack_id AS adapter_pack_id,
           b.adapter_id,
           b.execution_strategy,
           b.credential_ref AS adapter_credential_ref,
           b.native_profile_ref,
           b.workspace_policy,
           b.memory_policy,
           b.native_tool_policy,
           b.session_policy,
           b.config AS adapter_config
      FROM mcp_agent_runtime_profiles p
      LEFT JOIN mcp_runtime_adapter_profiles b ON b.runtime_profile_id = p.id
     ORDER BY p.runtime_type, p.label
  `);
  return rows;
}

export async function createAgentRuntimeProfile(
  pool: pg.Pool,
  value: unknown,
  createdBy: number | null,
): Promise<AgentRuntimeProfile> {
  const input = normalizeAgentRuntimeProfile(value);
  const auth = runtimeAuth(input.runtimeType);
  try {
    const { rows } = await pool.query<AgentRuntimeProfile>(`
      INSERT INTO mcp_agent_runtime_profiles (
        name, label, description, runtime_type, auth_mode, auth_ref, model, reasoning_effort,
        enabled, max_concurrent_runs, allowed_task_types, code_context_mode,
        code_context_max_results, code_context_max_bytes, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *, 0::integer AS assigned_agent_count, false AS managed,
        NULL::text AS adapter_pack_id, NULL::text AS adapter_id, NULL::text AS execution_strategy,
        NULL::text AS adapter_credential_ref, NULL::text AS native_profile_ref,
        NULL::text AS workspace_policy, NULL::text AS memory_policy,
        NULL::text AS native_tool_policy, NULL::text AS session_policy, NULL::jsonb AS adapter_config
    `, [
      input.name, input.label, input.description, input.runtimeType, auth.mode, auth.ref,
      input.model, input.reasoningEffort, input.enabled, input.maxConcurrentRuns,
      input.allowedTaskTypes, input.codeContextMode, input.codeContextMaxResults,
      input.codeContextMaxBytes, createdBy,
    ]);
    return rows[0]!;
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AgentRuntimeProfileMutationError('A runtime profile with this name already exists', 409);
    }
    throw error;
  }
}

export async function updateAgentRuntimeProfile(
  pool: pg.Pool,
  profileId: number,
  value: unknown,
): Promise<{ before: AgentRuntimeProfile; profile: AgentRuntimeProfile }> {
  if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new AgentRuntimeProfileMutationError('Runtime profile id is invalid');
  const input = normalizeAgentRuntimeProfile(value);
  const current = await pool.query<AgentRuntimeProfile>(`
    SELECT *, (created_by IS NULL) AS managed,
      (SELECT COUNT(*)::integer FROM mcp_agents WHERE runtime_profile_id=$1) AS assigned_agent_count
      FROM mcp_agent_runtime_profiles WHERE id=$1
  `, [profileId]);
  const before = current.rows[0];
  if (!before) throw new AgentRuntimeProfileMutationError('Runtime profile was not found', 404);
  if (before.managed || before.runtime_type === 'hermes') {
    throw new AgentRuntimeProfileMutationError('Platform and module-managed runtime profiles cannot be edited here', 409);
  }
  const auth = runtimeAuth(input.runtimeType);
  try {
    const updated = await pool.query<AgentRuntimeProfile>(`
      UPDATE mcp_agent_runtime_profiles SET
        name=$2, label=$3, description=$4, runtime_type=$5, auth_mode=$6, auth_ref=$7,
        model=$8, reasoning_effort=$9, enabled=$10, max_concurrent_runs=$11,
        allowed_task_types=$12, code_context_mode=$13, code_context_max_results=$14,
        code_context_max_bytes=$15
      WHERE id=$1
      RETURNING *, false AS managed,
        (SELECT COUNT(*)::integer FROM mcp_agents WHERE runtime_profile_id=$1) AS assigned_agent_count,
        NULL::text AS adapter_pack_id, NULL::text AS adapter_id, NULL::text AS execution_strategy,
        NULL::text AS adapter_credential_ref, NULL::text AS native_profile_ref,
        NULL::text AS workspace_policy, NULL::text AS memory_policy,
        NULL::text AS native_tool_policy, NULL::text AS session_policy, NULL::jsonb AS adapter_config
    `, [
      profileId, input.name, input.label, input.description, input.runtimeType, auth.mode, auth.ref,
      input.model, input.reasoningEffort, input.enabled, input.maxConcurrentRuns,
      input.allowedTaskTypes, input.codeContextMode, input.codeContextMaxResults, input.codeContextMaxBytes,
    ]);
    return { before, profile: updated.rows[0]! };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AgentRuntimeProfileMutationError('A runtime profile with this name already exists', 409);
    }
    throw error;
  }
}

export async function deleteAgentRuntimeProfile(pool: pg.Pool, profileId: number): Promise<AgentRuntimeProfile> {
  if (!Number.isSafeInteger(profileId) || profileId <= 0) throw new AgentRuntimeProfileMutationError('Runtime profile id is invalid');
  const current = await pool.query<AgentRuntimeProfile>(`
    SELECT *, (created_by IS NULL) AS managed,
      (SELECT COUNT(*)::integer FROM mcp_agents WHERE runtime_profile_id=$1) AS assigned_agent_count
      FROM mcp_agent_runtime_profiles WHERE id=$1
  `, [profileId]);
  const profile = current.rows[0];
  if (!profile) throw new AgentRuntimeProfileMutationError('Runtime profile was not found', 404);
  if (profile.managed || profile.runtime_type === 'hermes') {
    throw new AgentRuntimeProfileMutationError('Platform and module-managed runtime profiles cannot be deleted here', 409);
  }
  if (profile.assigned_agent_count > 0) {
    throw new AgentRuntimeProfileMutationError('Remove Agent assignments before deleting this runtime profile', 409);
  }
  await pool.query('DELETE FROM mcp_agent_runtime_profiles WHERE id=$1', [profileId]);
  return profile;
}

export async function validateAgentRuntimeProfileAssignment(
  pool: pg.Pool,
  profileId: number | null | undefined,
): Promise<void> {
  if (profileId == null) return;
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw new AgentRuntimeProfileAssignmentError('Runtime-Profil ist ungültig');
  }

  const { rows } = await pool.query<{
    runtime_type: AgentRuntimeType;
    auth_mode: AgentRuntimeAuthMode;
    enabled: boolean;
    auth_ref: string | null;
    adapter_pack_id: string | null;
    adapter_id: string | null;
    execution_strategy: AgentRuntimeExecutionStrategy | null;
  }>(
    `SELECT p.runtime_type, p.auth_mode, p.enabled, p.auth_ref,
            b.pack_id AS adapter_pack_id, b.adapter_id, b.execution_strategy
       FROM mcp_agent_runtime_profiles p
       LEFT JOIN mcp_runtime_adapter_profiles b ON b.runtime_profile_id = p.id
      WHERE p.id = $1`,
    [profileId],
  );
  const row = rows[0];
  if (!row) throw new AgentRuntimeProfileAssignmentError('Runtime-Profil wurde nicht gefunden');
  if (!row.enabled) throw new AgentRuntimeProfileAssignmentError('Runtime-Profil ist deaktiviert');

  // A Codex profile must resolve to a configured runtime reference. The
  // reference is not a secret; authentication is checked by agent-workspace
  // against its protected CODEX_HOME volume at execution time.
  if (row.runtime_type === 'codex' && row.auth_mode === 'chatgpt' && !row.auth_ref) {
    throw new AgentRuntimeProfileAssignmentError('Codex Runtime-Profil hat keine Runtime-Referenz');
  }
  if (row.runtime_type === 'claude-code' && row.auth_mode === 'claude_subscription' && !row.auth_ref) {
    throw new AgentRuntimeProfileAssignmentError('Claude Code Runtime-Profil hat keine Runtime-Referenz');
  }
  if (row.runtime_type === 'hermes'
    && (row.auth_mode !== 'runtime_adapter' || !row.adapter_pack_id || !row.adapter_id || !row.execution_strategy)) {
    throw new AgentRuntimeProfileAssignmentError('Hermes Runtime-Profil hat keine vollständige Adapter-Bindung');
  }
}

const runtimeAdapterBindingSelect = `
           b.pack_id AS adapter_pack_id,
           b.adapter_id,
           b.execution_strategy,
           b.credential_ref AS adapter_credential_ref,
           b.native_profile_ref,
           b.workspace_policy,
           b.memory_policy,
           b.native_tool_policy,
           b.session_policy,
           b.config AS adapter_config`;

export async function listAgentRuntimeAssignments(pool: pg.Pool): Promise<AgentRuntimeAssignment[]> {
  const { rows } = await pool.query<AgentRuntimeAssignment>(`
    SELECT a.id AS agent_id,
           a.name AS agent_name,
           p.runtime_type,
           p.id AS profile_id,
           p.name AS profile_name,
           p.label AS profile_label,
           p.auth_mode,
           p.auth_ref,
           p.model,
           p.reasoning_effort,
           p.code_context_mode,
           p.code_context_max_results,
           p.code_context_max_bytes,
           p.max_concurrent_runs,
           p.enabled AS profile_enabled,
           ${runtimeAdapterBindingSelect}
      FROM mcp_agents a
      LEFT JOIN mcp_agent_runtime_profiles p ON p.id = a.runtime_profile_id
      LEFT JOIN mcp_runtime_adapter_profiles b ON b.runtime_profile_id = p.id
     WHERE a.enabled = true
     ORDER BY a.id
  `);
  return rows;
}

/** Resolve one Agent's effective control-plane runtime without exposing auth material. */
export async function getAgentRuntimeAssignment(
  pool: pg.Pool,
  agentId: number,
  runtimeProfileId?: number,
): Promise<AgentRuntimeAssignment | null> {
  if (runtimeProfileId !== undefined
    && (!Number.isSafeInteger(runtimeProfileId) || runtimeProfileId <= 0)) {
    throw new AgentRuntimeProfileAssignmentError('Runtime-Profil ist ungÃ¼ltig');
  }
  const { rows } = await pool.query<AgentRuntimeAssignment>(`
    SELECT a.id AS agent_id,
           a.name AS agent_name,
           p.runtime_type,
           p.id AS profile_id,
           p.name AS profile_name,
           p.label AS profile_label,
           p.auth_mode,
           p.auth_ref,
           p.model,
           p.reasoning_effort,
           p.code_context_mode,
           p.code_context_max_results,
           p.code_context_max_bytes,
           p.max_concurrent_runs,
           p.enabled AS profile_enabled,
           ${runtimeAdapterBindingSelect}
      FROM mcp_agents a
      LEFT JOIN mcp_agent_runtime_profiles p
        ON p.id = COALESCE($2::integer, a.runtime_profile_id)
      LEFT JOIN mcp_runtime_adapter_profiles b ON b.runtime_profile_id = p.id
     WHERE a.id = $1 AND a.enabled = true
     LIMIT 1
  `, [agentId, runtimeProfileId ?? null]);
  return rows[0] ?? null;
}

export async function updateAgentRuntimeCodeContextPolicy(
  pool: pg.Pool,
  profileId: number,
  value: unknown,
): Promise<{ before: AgentRuntimeProfile; profile: AgentRuntimeProfile }> {
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw new AgentRuntimeCodeContextPolicyError('Runtime profile id is invalid');
  }
  const policy = normalizeAgentRuntimeCodeContextPolicy(value);
  const current = await pool.query<AgentRuntimeProfile>(
    'SELECT *, 0::integer AS assigned_agent_count FROM mcp_agent_runtime_profiles WHERE id=$1',
    [profileId],
  );
  const before = current.rows[0];
  if (!before) throw new AgentRuntimeCodeContextPolicyError('Runtime profile was not found', 404);
  if (policy.mode === 'bounded_source' && before.runtime_type === 'argus') {
    throw new AgentRuntimeCodeContextPolicyError('Bounded source sharing is only valid for out-of-process runtimes');
  }
  const updated = await pool.query<AgentRuntimeProfile>(
    `UPDATE mcp_agent_runtime_profiles
        SET code_context_mode=$2,
            code_context_max_results=$3,
            code_context_max_bytes=$4
      WHERE id=$1
      RETURNING *, (
        SELECT COUNT(*)::integer FROM mcp_agents WHERE runtime_profile_id=$1
      ) AS assigned_agent_count`,
    [profileId, policy.mode, policy.maxResults, policy.maxBytes],
  );
  return { before, profile: updated.rows[0]! };
}
