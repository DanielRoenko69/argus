import pg from 'pg';
import { logger } from '../lib/logger.js';
import { encrypt } from '../lib/encryption.js';
import type {
  Agent, AgentWithRag, CreateAgentInput, UpdateAgentInput,
  RagIndex, CreateRagIndexInput, UpdateRagIndexInput,
  AgentSession, ChatMessage, PrContext,
} from './types.js';
import { EntraSidecarClient } from '../identity/entra.js';
import { resolveBlueprintId } from '../identity/blueprint.js';
import { loadConfig } from '../config/env.js';
import type { SessionUser } from '../auth/userAuth.js';
import { normalizeRole, hasRole } from '../auth/roles.js';
import { fetchUserAgentPolicyData } from '../auth/userPolicyStore.js';
import { resolveAgentAccess } from '../auth/userPolicyResolver.js';
import { agentVisibleToBundleScope } from '../auth/bundleScope.js';
import { validateAgentRuntimeProfileAssignment } from './runtimeProfiles.js';

export { agentVisibleToBundleScope } from '../auth/bundleScope.js';

// ── Agents ───────────────────────────────────────────────────

/**
 * Provision an Entra Service Principal for a freshly-created agent.
 * Fail-open: any Entra error is captured into entra_sync_error so the
 * admin can retry, but the agent row is never rolled back.
 */
async function provisionAgentSP(pool: pg.Pool, agent: Agent): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.entraAgentRegistration) return; // feature flag off — skip silently

  const blueprintId = resolveBlueprintId(agent, cfg.entraBlueprintMap);
  if (!blueprintId) {
    logger.info({ agent: agent.name }, 'No Entra blueprint mapped — skipping SP provision');
    return;
  }

  const client = new EntraSidecarClient({ sidecarUrl: cfg.entraSidecarUrl, envSlug: cfg.entraEnvSlug });

  try {
    const sp = await client.createAgentSP({ agentName: agent.name, blueprintId });
    await pool.query(
      `UPDATE mcp_agents SET entra_object_id=$1, entra_app_id=$2, entra_blueprint_id=$3,
                              entra_synced_at=now(), entra_sync_error=NULL
       WHERE id=$4`,
      [sp.objectId, sp.appId, sp.blueprintId, agent.id],
    );
    logger.info({ agent: agent.name, objectId: sp.objectId }, 'Entra SP provisioned');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await pool.query(
      'UPDATE mcp_agents SET entra_sync_error=$1 WHERE id=$2',
      [msg.slice(0, 500), agent.id],
    );
    logger.warn({ agent: agent.name, err: msg }, 'Entra SP provision failed — agent persisted without SP');
  }
}

// Sentinel das das Frontend zurueckschickt wenn der LLM-Key NICHT geaendert wurde.
// Verhindert dass das maskierte Display ('********') versehentlich als neuer Key
// verschluesselt + gespeichert wird.
const LLM_KEY_MASK = '********';

export class AgentCredentialProfileAssignmentError extends Error {
  readonly status = 400;
}

interface AgentCredentialAssignmentRow extends pg.QueryResultRow {
  provider_type: string;
  enabled: boolean;
  expires_at: string | null;
  credential_configured: boolean;
  model_provider_type: string | null;
}

/**
 * Validate the complete Agent → model alias → provider → credential profile
 * relationship before persistence. Runtime performs the same checks again so
 * disabling or expiring an already assigned profile remains fail-closed.
 */
export async function validateAgentCredentialProfileAssignment(
  pool: pg.Pool,
  model: string,
  profileId: number | null | undefined,
): Promise<void> {
  if (profileId == null) return;
  if (!Number.isSafeInteger(profileId) || profileId <= 0) {
    throw new AgentCredentialProfileAssignmentError('Credential Profile ist ungültig');
  }
  const result = await pool.query<AgentCredentialAssignmentRow>(
    `SELECT profile.provider_type, profile.enabled, profile.expires_at,
            (profile.api_key IS NOT NULL OR profile.secret_name IS NOT NULL) AS credential_configured,
            provider.provider_type AS model_provider_type
       FROM mcp_llm_credential_profiles profile
       LEFT JOIN mcp_models model ON model.model_name=$2
       LEFT JOIN mcp_llm_providers provider ON provider.id=model.provider_id
      WHERE profile.id=$1`,
    [profileId, model],
  );
  const row = result.rows[0];
  if (!row) throw new AgentCredentialProfileAssignmentError('Credential Profile wurde nicht gefunden');
  if (!row.model_provider_type) {
    throw new AgentCredentialProfileAssignmentError(`Modell-Alias „${model}“ hat keinen registrierten Provider`);
  }
  if (row.provider_type !== row.model_provider_type) {
    throw new AgentCredentialProfileAssignmentError('Credential Profile und Agent-Modell verwenden unterschiedliche Protokolle');
  }
  if (!row.enabled) throw new AgentCredentialProfileAssignmentError('Credential Profile ist deaktiviert');
  if (row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now()) {
    throw new AgentCredentialProfileAssignmentError('Credential Profile ist abgelaufen');
  }
  if (!row.credential_configured) {
    throw new AgentCredentialProfileAssignmentError('Credential Profile hat kein konfiguriertes Secret');
  }
}

function maskAgent<T extends { llm_api_key?: string | null }>(agent: T): T {
  if (agent.llm_api_key) {
    return { ...agent, llm_api_key: LLM_KEY_MASK };
  }
  return agent;
}

export async function listAgents(pool: pg.Pool): Promise<AgentWithRag[]> {
  const { rows } = await pool.query<AgentWithRag & { rag_indexes: string | null; code_indexes: string | null; composite_name: string | null }>(`
    SELECT a.*,
      c.name AS composite_name,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name, 'label', r.label, 'priority', ar.priority))
        FILTER (WHERE r.id IS NOT NULL),
        '[]'
      ) AS rag_indexes,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', ci.id,
          'repository_key', ci.repository_key,
          'branch_name', ci.branch_name,
          'commit_sha', ci.commit_sha,
          'provider', ci.provider,
          'file_count', ci.file_count,
          'symbol_count', ci.symbol_count,
          'edge_count', ci.edge_count,
          'priority', aci.priority
        )) FILTER (WHERE ci.id IS NOT NULL),
        '[]'
      ) AS code_indexes,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', sk.id, 'name', sk.name, 'label', sk.label, 'icon', sk.icon, 'category', sk.category, 'position', ags.position, 'revision_id', ags.revision_id, 'current_revision_id', sk.current_revision_id))
        FILTER (WHERE sk.id IS NOT NULL),
        '[]'
      ) AS skills
    FROM mcp_agents a
    LEFT JOIN mcp_composites c ON c.id = a.composite_id
    LEFT JOIN mcp_agent_rag_indexes ar ON ar.agent_id = a.id
    LEFT JOIN mcp_rag_indexes r ON r.id = ar.rag_index_id
    LEFT JOIN mcp_agent_code_index_snapshots aci ON aci.agent_id = a.id
    LEFT JOIN mcp_code_index_snapshots ci ON ci.id = aci.snapshot_id
    LEFT JOIN mcp_agent_skills ags ON ags.agent_id = a.id
    LEFT JOIN mcp_skills sk ON sk.id = ags.skill_id
    GROUP BY a.id, c.name
    ORDER BY a.label
  `);
  return (rows as unknown as AgentWithRag[]).map(maskAgent);
}

/**
 * True if a caller with `userRole` may see/use an agent with the given `minRole`.
 * NULL/empty minRole → no restriction. Otherwise weight-based via hasRole():
 * the caller's role must be >= minRole. Undefined caller role → treated as the
 * lowest privilege ('viewer') by hasRole/normalizeRole.
 */
export function agentVisibleToRole(minRole: string | null | undefined, userRole: string | null | undefined): boolean {
  if (!minRole) return true;
  return hasRole(userRole, normalizeRole(minRole));
}

/** DB-backed agent role-gate verdict. */
export type AgentRoleVerdict = 'ok' | 'not_found' | 'forbidden';

/** Identity used by all Agent execution boundaries. */
export interface AgentAccessUser {
  id: number;
  role?: string | null;
  allowed_bundles?: number[] | null;
  tenantKey?: string;
  workspaceKey?: string;
  entra_groups: string[];
  /** API-key / signed-grant service identity; skip end-user policy checks. */
  service?: boolean;
}

export interface AgentAccessOptions {
  /** Signed execution grants authorize exact Agent IDs independently of persistent Agent bundles. */
  allowServiceBundleOverride?: boolean;
}

/**
 * Loads the agent's min_role and decides whether `userRole` may use it:
 * 'not_found' → agent row gone; 'forbidden' → role too low; 'ok' → allowed
 * (incl. NULL min_role). Shared by every use-gate that holds only an agentId
 * (session-create, chat-send, workflow agent-step). Call sites that exempt
 * API-key/service identities must skip this when no session user is present
 * (they pass a real role only for authenticated end users).
 */
export async function agentRoleGate(
  pool: pg.Pool,
  agentId: number,
  userRole: string | null | undefined,
): Promise<AgentRoleVerdict> {
  const { rows } = await pool.query<{ min_role: string | null }>(
    'SELECT min_role FROM mcp_agents WHERE id=$1', [agentId],
  );
  if (rows.length === 0) return 'not_found';
  return agentVisibleToRole(rows[0].min_role, userRole) ? 'ok' : 'forbidden';
}

/**
 * Full Agent use gate shared by HTTP, workflow and sub-agent execution.
 * Directly supplied Agent IDs receive the same visibility, role, bundle and
 * explicit user/group policy treatment as the enumerated chat list.
 */
export async function agentAccessGate(
  pool: pg.Pool,
  agentId: number,
  user?: AgentAccessUser,
  options?: AgentAccessOptions,
): Promise<{ verdict: AgentRoleVerdict; agent: AgentWithRag | null }> {
  const agent = await getAgent(pool, agentId);
  if (!agent || !agent.enabled) return { verdict: 'not_found', agent: null };
  if (!user) return { verdict: 'ok', agent };

  if (user.service) {
    return (options?.allowServiceBundleOverride || agentVisibleToBundleScope(agent.bundle_ids, user.allowed_bundles))
      ? { verdict: 'ok', agent }
      : { verdict: 'forbidden', agent };
  }

  if (normalizeRole(user.role ?? 'viewer') === 'chat_user' && agent.visibility !== 'internal') {
    return { verdict: 'forbidden', agent };
  }
  if (!agentVisibleToRole(agent.min_role, user.role)) {
    return { verdict: 'forbidden', agent };
  }
  if (!agentVisibleToBundleScope(agent.bundle_ids, user.allowed_bundles)) {
    return { verdict: 'forbidden', agent };
  }

  const rules = await fetchUserAgentPolicyData(pool, user.id, user.entra_groups ?? []);
  const allowed = resolveAgentAccess(rules, [agent.id]);
  return { verdict: allowed.includes(agent.id) ? 'ok' : 'forbidden', agent };
}

/**
 * Returns enabled agents visible to the given user in the /chat surface.
 *
 * Reuses `listAgents` for the DB fetch (same query, same masking).
 * Access filtering (applied in execution order — each gate must pass before the next):
 *   1. enabled-only (always).
 *   2. chat_user: visibility='internal' gate (higher roles skip this).
 *   3. per-agent min_role: hide agents whose minimum role exceeds the caller's
 *      (authenticated callers only).
 *   4. per-user/group agent-access rules from mcp_user_agent_rules /
 *      mcp_group_agent_rules (migration 115). When no rules exist the set is
 *      identical to today (backward-compatible default unrestricted).
 */
export async function listChatVisibleAgents(
  pool: pg.Pool,
  user?: SessionUser,
): Promise<AgentWithRag[]> {
  const all = await listAgents(pool);
  const enabled = all.filter(a => a.enabled);

  // Gate 2 (chat_user role): visibility='internal' filter
  let candidates: AgentWithRag[];
  if (normalizeRole(user?.role ?? 'viewer') === 'chat_user') {
    candidates = enabled.filter(a => a.visibility === 'internal');
  } else {
    candidates = enabled;
  }

  // Gates 3-4 need an authenticated identity. No user (unauthenticated/admin/
  // service paths) → unrestricted by design.
  if (!user) return candidates;

  // Gate 3: per-agent min_role (authenticated callers only). NULL min_role → visible.
  candidates = candidates.filter(a => agentVisibleToRole(a.min_role, user.role));
  // Explicit Agent bundle assignments must overlap the user's server-side
  // scope. Unassigned Agents remain visible; the runner narrows their tools.
  candidates = candidates.filter(a => agentVisibleToBundleScope(a.bundle_ids, user.allowed_bundles));

  // Gate 4: per-user/group agent-access rules (R2/R3)
  const agentRules = await fetchUserAgentPolicyData(
    pool,
    user.id,
    user.entra_groups ?? [],
  );

  const allowedIds = resolveAgentAccess(
    agentRules,
    candidates.map(a => a.id),
  );

  // No rules → allowedIds equals candidate ids exactly → no change
  if (allowedIds.length === candidates.length) return candidates;

  const allowedSet = new Set(allowedIds);
  return candidates.filter(a => allowedSet.has(a.id));
}

export async function getAgent(pool: pg.Pool, id: number, opts?: { unmasked?: boolean }): Promise<AgentWithRag | null> {
  const { rows } = await pool.query<AgentWithRag & { composite_name: string | null }>(`
    SELECT a.*,
      c.name AS composite_name,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', r.id, 'name', r.name, 'label', r.label, 'priority', ar.priority))
        FILTER (WHERE r.id IS NOT NULL),
        '[]'
      ) AS rag_indexes,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', ci.id,
          'repository_key', ci.repository_key,
          'branch_name', ci.branch_name,
          'commit_sha', ci.commit_sha,
          'provider', ci.provider,
          'file_count', ci.file_count,
          'symbol_count', ci.symbol_count,
          'edge_count', ci.edge_count,
          'priority', aci.priority
        )) FILTER (WHERE ci.id IS NOT NULL),
        '[]'
      ) AS code_indexes,
      COALESCE(
        json_agg(DISTINCT jsonb_build_object('id', sk.id, 'name', sk.name, 'label', sk.label, 'icon', sk.icon, 'category', sk.category, 'position', ags.position, 'revision_id', ags.revision_id, 'current_revision_id', sk.current_revision_id))
        FILTER (WHERE sk.id IS NOT NULL),
        '[]'
      ) AS skills
    FROM mcp_agents a
    LEFT JOIN mcp_composites c ON c.id = a.composite_id
    LEFT JOIN mcp_agent_rag_indexes ar ON ar.agent_id = a.id
    LEFT JOIN mcp_rag_indexes r ON r.id = ar.rag_index_id
    LEFT JOIN mcp_agent_code_index_snapshots aci ON aci.agent_id = a.id
    LEFT JOIN mcp_code_index_snapshots ci ON ci.id = aci.snapshot_id
    LEFT JOIN mcp_agent_skills ags ON ags.agent_id = a.id
    LEFT JOIN mcp_skills sk ON sk.id = ags.skill_id
    WHERE a.id = $1
    GROUP BY a.id, c.name
  `, [id]);
  const row = rows[0];
  if (!row) return null;
  // Execution paths (agentRunner) must get the REAL encrypted llm_api_key so they
  // can decrypt it; API/UI callers get the masked value. Default = masked.
  return opts?.unmasked ? (row as unknown as AgentWithRag) : maskAgent(row as unknown as AgentWithRag);
}

export async function createAgent(pool: pg.Pool, input: CreateAgentInput, userId?: number): Promise<Agent> {
  const model = input.model ?? 'gpt-4o';
  await validateAgentCredentialProfileAssignment(pool, model, input.llm_credential_profile_id);
  await validateAgentRuntimeProfileAssignment(pool, input.runtime_profile_id);
  const { rows } = await pool.query<Agent>(
    `INSERT INTO mcp_agents (name, label, description, model, temperature, max_tokens, system_prompt, agent_role, composite_id, gitea_project, enabled, max_iterations, created_by, agent_mode, task_type, pr_branch, pr_number, ticket_id, allowed_paths, bitbucket_repo, bundle_ids, llm_api_key, llm_credential_profile_id, runtime_profile_id, thinking_budget, untrusted_tool_output_enforcement, codegraph_enabled, visibility, min_role, risk_level, human_oversight_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31) RETURNING *`,
    [
      input.name, input.label, input.description ?? '',
      model, input.temperature ?? 0.7, input.max_tokens ?? 4096,
      input.system_prompt ?? null, input.agent_role ?? null,
      input.composite_id ?? null, input.gitea_project ?? null,
      input.enabled ?? true, input.max_iterations ?? 10, userId ?? null,
      input.agent_mode ?? 'chat', input.task_type ?? null,
      input.pr_branch ?? null, input.pr_number ?? null,
      input.ticket_id ?? null, input.allowed_paths ?? null,
      input.bitbucket_repo ?? null, input.bundle_ids ?? null,
      input.llm_api_key ? encrypt(input.llm_api_key) : null,
      input.llm_credential_profile_id ?? null,
      input.runtime_profile_id ?? null,
      input.thinking_budget ?? 0,
      input.untrusted_tool_output_enforcement ?? true,
      input.codegraph_enabled ?? false,
      input.visibility ?? 'internal',
      input.min_role || null,
      input.risk_level ?? 'low',
      input.human_oversight_required ?? false,
    ],
  );
  const created = rows[0]!;
  logger.info({ agent: input.name }, 'Agent created');
  // Fire-and-forget Entra provisioning. We do NOT await because Graph can be
  // slow (1-3s) and we don't want createAgent to hang. The admin UI polls
  // entra_synced_at to show status.
  provisionAgentSP(pool, created).catch(() => {/* logged inside */});
  return created;
}

export async function updateAgent(pool: pg.Pool, id: number, input: UpdateAgentInput): Promise<Agent> {
  if (input.model !== undefined || input.llm_credential_profile_id !== undefined) {
    const current = await pool.query<{ model: string; llm_credential_profile_id: number | null }>(
      'SELECT model, llm_credential_profile_id FROM mcp_agents WHERE id=$1',
      [id],
    );
    if (!current.rows[0]) throw new Error(`Agent ${id} not found`);
    await validateAgentCredentialProfileAssignment(
      pool,
      input.model ?? current.rows[0].model,
      input.llm_credential_profile_id === undefined
        ? current.rows[0].llm_credential_profile_id
        : input.llm_credential_profile_id,
    );
  }
  if (input.runtime_profile_id !== undefined) {
    await validateAgentRuntimeProfileAssignment(pool, input.runtime_profile_id);
  }
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.label !== undefined)          { sets.push(`label=$${idx++}`);          values.push(input.label); }
  if (input.description !== undefined)    { sets.push(`description=$${idx++}`);    values.push(input.description); }
  if (input.model !== undefined)          { sets.push(`model=$${idx++}`);          values.push(input.model); }
  if (input.temperature !== undefined)    { sets.push(`temperature=$${idx++}`);    values.push(input.temperature); }
  if (input.max_tokens !== undefined)     { sets.push(`max_tokens=$${idx++}`);     values.push(input.max_tokens); }
  if (input.system_prompt !== undefined)  { sets.push(`system_prompt=$${idx++}`);  values.push(input.system_prompt || null); }
  if (input.agent_role !== undefined)     { sets.push(`agent_role=$${idx++}`);     values.push(input.agent_role || null); }
  if (input.composite_id !== undefined)   { sets.push(`composite_id=$${idx++}`);   values.push(input.composite_id); }
  if (input.gitea_project !== undefined)  { sets.push(`gitea_project=$${idx++}`);  values.push(input.gitea_project || null); }
  if (input.enabled !== undefined)        { sets.push(`enabled=$${idx++}`);        values.push(input.enabled); }
  if (input.max_iterations !== undefined) { sets.push(`max_iterations=$${idx++}`); values.push(input.max_iterations); }
  if (input.agent_mode !== undefined)     { sets.push(`agent_mode=$${idx++}`);     values.push(input.agent_mode); }
  if (input.task_type !== undefined)      { sets.push(`task_type=$${idx++}`);      values.push(input.task_type ?? null); }
  if (input.pr_branch !== undefined)      { sets.push(`pr_branch=$${idx++}`);      values.push(input.pr_branch ?? null); }
  if (input.pr_number !== undefined)      { sets.push(`pr_number=$${idx++}`);      values.push(input.pr_number ?? null); }
  if (input.ticket_id !== undefined)      { sets.push(`ticket_id=$${idx++}`);      values.push(input.ticket_id ?? null); }
  if (input.allowed_paths !== undefined)  { sets.push(`allowed_paths=$${idx++}`);  values.push(input.allowed_paths ?? null); }
  if (input.bitbucket_repo !== undefined) { sets.push(`bitbucket_repo=$${idx++}`); values.push(input.bitbucket_repo ?? null); }
  if (input.bundle_ids !== undefined)     { sets.push(`bundle_ids=$${idx++}`);     values.push(input.bundle_ids ?? null); }
  // Sentinel-Wert vom Frontend bedeutet "Wert unveraendert" -> Update skippen.
  // Verhindert dass das Masken-Display als neuer Cipher gespeichert wird.
  if (input.llm_api_key !== undefined && input.llm_api_key !== LLM_KEY_MASK) {
    sets.push(`llm_api_key=$${idx++}`); values.push(encrypt(input.llm_api_key ?? null));
  }
  if (input.llm_credential_profile_id !== undefined) { sets.push(`llm_credential_profile_id=$${idx++}`); values.push(input.llm_credential_profile_id); }
  if (input.runtime_profile_id !== undefined)       { sets.push(`runtime_profile_id=$${idx++}`);       values.push(input.runtime_profile_id); }
  if (input.thinking_budget !== undefined){ sets.push(`thinking_budget=$${idx++}`);values.push(input.thinking_budget); }
  if (input.untrusted_tool_output_enforcement !== undefined) { sets.push(`untrusted_tool_output_enforcement=$${idx++}`); values.push(input.untrusted_tool_output_enforcement); }
  if (input.codegraph_enabled !== undefined) { sets.push(`codegraph_enabled=$${idx++}`); values.push(input.codegraph_enabled); }
  if (input.visibility !== undefined)        { sets.push(`visibility=$${idx++}`);        values.push(input.visibility); }
  if (input.min_role !== undefined)          { sets.push(`min_role=$${idx++}`);          values.push(input.min_role || null); }
  if (input.risk_level !== undefined)        { sets.push(`risk_level=$${idx++}`);        values.push(input.risk_level); }
  if (input.human_oversight_required !== undefined) {
    sets.push(`human_oversight_required=$${idx++}`); values.push(input.human_oversight_required);
  }

  if (sets.length === 0) {
    const existing = await getAgent(pool, id);
    if (!existing) throw new Error(`Agent ${id} not found`);
    return existing;
  }

  values.push(id);
  const { rows } = await pool.query<Agent>(
    `UPDATE mcp_agents SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    values,
  );
  if (rows.length === 0) throw new Error(`Agent ${id} not found`);
  logger.info({ agentId: id }, 'Agent updated');
  return rows[0];
}

export async function deleteAgent(pool: pg.Pool, id: number): Promise<void> {
  // Look up entra_object_id first so we can clean up Entra after the DB delete succeeds.
  const { rows: existing } = await pool.query<{ entra_object_id: string | null }>(
    'SELECT entra_object_id FROM mcp_agents WHERE id=$1', [id],
  );
  const objectId = existing[0]?.entra_object_id ?? null;

  const { rowCount } = await pool.query('DELETE FROM mcp_agents WHERE id=$1', [id]);
  if (rowCount === 0) throw new Error(`Agent ${id} not found`);
  logger.info({ agentId: id }, 'Agent deleted');

  // Soft-delete the SP in Entra after Argus DB deletion. Entra retains
  // soft-deleted SPs for 30 days, giving us an undo window.
  if (objectId) {
    const cfg = loadConfig();
    if (cfg.entraAgentRegistration) {
      const client = new EntraSidecarClient({ sidecarUrl: cfg.entraSidecarUrl, envSlug: cfg.entraEnvSlug });
      client.deleteAgentSP(objectId).catch(err => {
        logger.warn({ objectId, err: String(err) }, 'Entra SP soft-delete failed — manual cleanup required');
      });
    }
  }
}

export async function setAgentRagIndexes(pool: pg.Pool, agentId: number, ragIndexIds: number[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mcp_agent_rag_indexes WHERE agent_id=$1', [agentId]);
    for (let i = 0; i < ragIndexIds.length; i++) {
      await client.query(
        'INSERT INTO mcp_agent_rag_indexes (agent_id, rag_index_id, priority) VALUES ($1,$2,$3)',
        [agentId, ragIndexIds[i], i],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Replace the Agent's immutable repository-knowledge assignments atomically. */
export async function setAgentCodeIndexes(pool: pg.Pool, agentId: number, snapshotIds: number[]): Promise<void> {
  if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('agent id must be a positive integer');
  if (!Array.isArray(snapshotIds) || snapshotIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('snapshot ids must be positive integers');
  }
  if (new Set(snapshotIds).size !== snapshotIds.length) throw new Error('snapshot ids must be unique');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM mcp_agent_code_index_snapshots WHERE agent_id=$1', [agentId]);
    for (let i = 0; i < snapshotIds.length; i++) {
      const inserted = await client.query(
        `INSERT INTO mcp_agent_code_index_snapshots (agent_id, snapshot_id, priority)
         SELECT $1, snapshot.id, $3
           FROM mcp_code_index_snapshots snapshot
          WHERE snapshot.id=$2 AND snapshot.status='ready'`,
        [agentId, snapshotIds[i], i],
      );
      if (inserted.rowCount !== 1) throw new Error(`ready repository snapshot ${snapshotIds[i]} not found`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── RAG Indexes ──────────────────────────────────────────────

export async function listRagIndexes(pool: pg.Pool): Promise<RagIndex[]> {
  const { rows } = await pool.query<RagIndex>(
    'SELECT * FROM mcp_rag_indexes ORDER BY label',
  );
  return rows;
}

export async function getRagIndex(pool: pg.Pool, id: number): Promise<RagIndex | null> {
  const { rows } = await pool.query<RagIndex>('SELECT * FROM mcp_rag_indexes WHERE id=$1', [id]);
  return rows[0] ?? null;
}

export async function createRagIndex(pool: pg.Pool, input: CreateRagIndexInput): Promise<RagIndex> {
  const { rows } = await pool.query<RagIndex>(
    `INSERT INTO mcp_rag_indexes (name, label, description, provider, endpoint, index_name, api_key, semantic_config, vector_field, adapter_config, top_k, enabled)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      input.name, input.label, input.description ?? '',
      input.provider ?? 'pgvector', input.endpoint ?? '', input.index_name ?? '',
      encrypt(input.api_key ?? null), input.semantic_config ?? null,
      input.vector_field ?? null, input.adapter_config ?? {},
      input.top_k ?? 5, input.enabled ?? true,
    ],
  );
  logger.info({ name: input.name }, 'RAG index created');
  return rows[0];
}

export async function updateRagIndex(pool: pg.Pool, id: number, input: UpdateRagIndexInput): Promise<RagIndex> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (input.label !== undefined)          { sets.push(`label=$${idx++}`);          values.push(input.label); }
  if (input.description !== undefined)    { sets.push(`description=$${idx++}`);    values.push(input.description); }
  if (input.provider !== undefined)       { sets.push(`provider=$${idx++}`);       values.push(input.provider); }
  if (input.endpoint !== undefined)       { sets.push(`endpoint=$${idx++}`);       values.push(input.endpoint); }
  if (input.index_name !== undefined)     { sets.push(`index_name=$${idx++}`);     values.push(input.index_name); }
  if (input.api_key !== undefined)        { sets.push(`api_key=$${idx++}`);        values.push(encrypt(input.api_key || null)); }
  if (input.semantic_config !== undefined){ sets.push(`semantic_config=$${idx++}`);values.push(input.semantic_config || null); }
  if (input.vector_field !== undefined)   { sets.push(`vector_field=$${idx++}`);   values.push(input.vector_field || null); }
  if (input.adapter_config !== undefined) { sets.push(`adapter_config=$${idx++}`); values.push(input.adapter_config); }
  if (input.top_k !== undefined)          { sets.push(`top_k=$${idx++}`);          values.push(input.top_k); }
  if (input.enabled !== undefined)        { sets.push(`enabled=$${idx++}`);        values.push(input.enabled); }

  if (sets.length === 0) {
    const existing = await getRagIndex(pool, id);
    if (!existing) throw new Error(`RAG index ${id} not found`);
    return existing;
  }

  values.push(id);
  const { rows } = await pool.query<RagIndex>(
    `UPDATE mcp_rag_indexes SET ${sets.join(', ')} WHERE id=$${idx} RETURNING *`,
    values,
  );
  if (rows.length === 0) throw new Error(`RAG index ${id} not found`);
  logger.info({ ragIndexId: id }, 'RAG index updated');
  return rows[0];
}

export async function deleteRagIndex(pool: pg.Pool, id: number): Promise<void> {
  const { rowCount } = await pool.query('DELETE FROM mcp_rag_indexes WHERE id=$1', [id]);
  if (rowCount === 0) throw new Error(`RAG index ${id} not found`);
  logger.info({ ragIndexId: id }, 'RAG index deleted');
}

// ── Sessions ─────────────────────────────────────────────────

export async function createSession(pool: pg.Pool, agentId: number, sessionId: string, userId?: number): Promise<AgentSession> {
  const { rows } = await pool.query<AgentSession>(
    `INSERT INTO mcp_agent_sessions (id, agent_id, user_id, messages) VALUES ($1,$2,$3,'[]') RETURNING *`,
    [sessionId, agentId, userId ?? null],
  );
  return rows[0];
}

export async function getSession(
  pool: pg.Pool,
  sessionId: string,
  /** When provided, restricts to sessions owned by this user (DB-level IDOR prevention). */
  userId?: number,
): Promise<AgentSession | null> {
  if (userId !== undefined) {
    const { rows } = await pool.query<AgentSession>(
      'SELECT * FROM mcp_agent_sessions WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)',
      [sessionId, userId],
    );
    return rows[0] ?? null;
  }
  const { rows } = await pool.query<AgentSession>(
    'SELECT * FROM mcp_agent_sessions WHERE id=$1',
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function listSessions(pool: pg.Pool, agentId: number, userId?: number): Promise<AgentSession[]> {
  if (userId !== undefined) {
    const { rows } = await pool.query<AgentSession>(
      'SELECT * FROM mcp_agent_sessions WHERE agent_id=$1 AND user_id=$2 ORDER BY last_active DESC LIMIT 50',
      [agentId, userId],
    );
    return rows;
  }
  const { rows } = await pool.query<AgentSession>(
    'SELECT * FROM mcp_agent_sessions WHERE agent_id=$1 ORDER BY last_active DESC LIMIT 50',
    [agentId],
  );
  return rows;
}

export async function appendMessages(
  pool: pg.Pool,
  sessionId: string,
  newMessages: ChatMessage[],
  /** When provided, only updates sessions owned by this user. */
  userId?: number,
): Promise<void> {
  const whereClause = userId !== undefined
    ? 'id=$2 AND (user_id=$3 OR user_id IS NULL)'
    : 'id=$2';
  const params = userId !== undefined
    ? [JSON.stringify(newMessages), sessionId, userId]
    : [JSON.stringify(newMessages), sessionId];
  await pool.query(
    `UPDATE mcp_agent_sessions
     SET messages = messages || $1::jsonb, last_active = now()
     WHERE ${whereClause}`,
    params,
  );
}

/** Append a pre-chained run of messages and move the active-leaf pointer in one UPDATE. */
export async function appendBranch(
  pool: pg.Pool,
  sessionId: string,
  chained: ChatMessage[],
  newLeafId: string,
  userId?: number,
): Promise<void> {
  const whereClause = userId !== undefined ? 'id=$3 AND (user_id=$4 OR user_id IS NULL)' : 'id=$3';
  const params = userId !== undefined
    ? [JSON.stringify(chained), newLeafId, sessionId, userId]
    : [JSON.stringify(chained), newLeafId, sessionId];
  await pool.query(
    `UPDATE mcp_agent_sessions
     SET messages = messages || $1::jsonb, active_leaf_id = $2, last_active = now()
     WHERE ${whereClause}`,
    params,
  );
}

/** Overwrite a session's messages array + set its active-leaf. Used to upgrade a legacy
 *  (id-less, null-leaf) session to a linear tree in place before tree-aware appends. */
export async function replaceSessionMessages(
  pool: pg.Pool,
  sessionId: string,
  messages: ChatMessage[],
  leafId: string | null,
  userId?: number,
): Promise<void> {
  const whereClause = userId !== undefined ? 'id=$3 AND (user_id=$4 OR user_id IS NULL)' : 'id=$3';
  const params = userId !== undefined
    ? [JSON.stringify(messages), leafId, sessionId, userId]
    : [JSON.stringify(messages), leafId, sessionId];
  await pool.query(
    `UPDATE mcp_agent_sessions SET messages = $1::jsonb, active_leaf_id = $2 WHERE ${whereClause}`,
    params,
  );
}

/** Switch the visible branch by pointing active_leaf_id at a (validated) leaf id. */
export async function setActiveLeaf(
  pool: pg.Pool,
  sessionId: string,
  leafId: string,
  userId?: number,
): Promise<void> {
  const whereClause = userId !== undefined ? 'id=$2 AND (user_id=$3 OR user_id IS NULL)' : 'id=$2';
  const params = userId !== undefined ? [leafId, sessionId, userId] : [leafId, sessionId];
  await pool.query(
    `UPDATE mcp_agent_sessions SET active_leaf_id = $1, last_active = now() WHERE ${whereClause}`,
    params,
  );
}

export async function deleteSession(
  pool: pg.Pool,
  sessionId: string,
  /** When provided, only deletes sessions owned by this user. */
  userId?: number,
): Promise<void> {
  if (userId !== undefined) {
    await pool.query(
      'DELETE FROM mcp_agent_sessions WHERE id=$1 AND (user_id=$2 OR user_id IS NULL)',
      [sessionId, userId],
    );
  } else {
    await pool.query('DELETE FROM mcp_agent_sessions WHERE id=$1', [sessionId]);
  }
}

export async function cleanupOldSessions(pool: pg.Pool, olderThanDays = 7): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM mcp_agent_sessions WHERE last_active < now() - ($1 || ' days')::interval`,
    [olderThanDays],
  );
  return rowCount ?? 0;
}

export async function updateSessionPrContext(pool: pg.Pool, sessionId: string, prContext: PrContext): Promise<void> {
  await pool.query(
    `UPDATE mcp_agent_sessions SET pr_context = $1::jsonb WHERE id = $2`,
    [JSON.stringify(prContext), sessionId],
  );
}
