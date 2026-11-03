import type pg from 'pg';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import { getAllRemoteTools, getRemoteConnection } from '../backends/remoteMcpClients.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { loadDynamicTools } from '../tools/dynamic/index.js';
import { loadBundleToolBackendIds } from '../solutionPacks/bundleCapabilities.js';
import { WORKSPACE_TOOLS } from '../tools/workspace.js';
import { getAgentRagTools } from '../tools/ragTools.js';
import { SUBAGENT_TOOL_PARALLEL, SUBAGENT_TOOL_SINGLE } from './subagents.js';
import { getAgentRuntimeAssignment, type AgentRuntimeAssignment } from './runtimeProfiles.js';
import { getAgentRuntimeExecutor } from './runtimeExecutor.js';
import type { AgentWithRag } from './types.js';

export type AgentReadinessStatus = 'ready' | 'degraded' | 'blocked' | 'disabled';
export type CapabilityState = 'ready' | 'warning' | 'blocked' | 'disabled';

export interface AgentReadinessRuntime {
  type: 'argus' | 'codex' | 'claude-code' | 'hermes';
  profileId: number | null;
  profileName: string | null;
  profileLabel: string | null;
  model: string;
  state: CapabilityState;
  authenticated: boolean | null;
  activeRuns: number | null;
  maxConcurrentRuns: number | null;
  availableSlots: number | null;
  trust?: 'core_governed' | 'external_attested';
  detail: string;
}

export interface AgentReadinessBackend {
  id: number;
  name: string;
  type: 'http' | 'mcp' | 'builtin';
  enabled: boolean;
  connected: boolean | null;
  trustStatus: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
  toolCount: number;
  state: CapabilityState;
  detail: string;
}

export interface AgentReadinessBundle {
  id: number;
  name: string;
  label: string;
  toolNames: string[];
  backends: AgentReadinessBackend[];
  state: CapabilityState;
}

export interface AgentReadinessTool {
  name: string;
  source: 'bundle' | 'workspace' | 'knowledge' | 'subagent';
}

export interface AgentCapabilityReadiness {
  agentId: number;
  agentName: string;
  status: AgentReadinessStatus;
  ready: boolean;
  checkedAt: string;
  blockers: string[];
  warnings: string[];
  runtime: AgentReadinessRuntime;
  bundles: AgentReadinessBundle[];
  tools: AgentReadinessTool[];
  capabilities: {
    workspace: { available: boolean; toolCount: number };
    knowledge: { available: boolean; toolCount: number };
    subagents: { available: boolean; toolCount: number };
    codegraph: { available: boolean; toolCount: number };
  };
}

interface BundleRow extends pg.QueryResultRow {
  id: number;
  name: string;
  label: string;
}

interface BackendRow extends pg.QueryResultRow {
  bundle_id: number;
  id: number;
  name: string;
  backend_type: 'http' | 'mcp' | 'builtin';
  enabled: boolean;
  trust_status: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
  registry_tool_count: number | string | null;
}

interface CompositeRow extends pg.QueryResultRow {
  enabled: boolean;
  included_bundle_ids: Array<number | null> | null;
  tool_allow_patterns: string[] | null;
  tool_deny_patterns: string[] | null;
}

interface ModelReadinessRow extends pg.QueryResultRow {
  model_enabled: boolean;
  supports_tools: boolean;
  provider_enabled: boolean;
  provider_label: string;
  auth_type: 'bearer' | 'api-key' | 'none';
  provider_credential_configured: boolean;
  provider_profile_enabled: boolean | null;
  provider_profile_expired: boolean | null;
  provider_profile_configured: boolean | null;
  agent_direct_credential_configured: boolean;
  agent_profile_enabled: boolean | null;
  agent_profile_expired: boolean | null;
  agent_profile_configured: boolean | null;
  last_test_status: 'healthy' | 'failed' | null;
  last_test_error: string | null;
}

interface RuntimeStatus {
  enabled: boolean;
  authenticated: boolean;
  activeRuns: number;
  maxConcurrentRuns: number;
}

export interface AgentReadinessOptions {
  bundleIds?: number[] | null;
  /**
   * Exact tool catalog granted to this execution. When present, readiness
   * evaluates only the Bundle backends that own those tools. The persistent
   * Agent/Studio view omits this option and therefore remains bundle-wide.
   */
  allowedToolNames?: string[] | null;
  /**
   * Allow a signed workspace execution to use an HTTP provider bundle as a
   * credential scope even when it intentionally exposes no MCP tools.
   * Ordinary Agent runs remain fail-closed.
   */
  allowToollessBundles?: boolean;
  /** Runtime assignment supplied by a mutation-free template preview. */
  runtimeAssignment?: AgentRuntimeAssignment | null;
  probeRuntime?: boolean;
  runtimeStatusLoader?: (runtimeType: 'codex' | 'claude-code') => Promise<RuntimeStatus>;
  allowedToolNamesLoader?: (bundleIds: number[]) => Promise<Set<string>>;
  toolBackendIdsLoader?: (bundleIds: number[], toolNames: string[]) => Promise<Set<number>>;
}

const runtimeCache = new Map<string, { expiresAt: number; status: RuntimeStatus }>();

function boundedUnique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].slice(0, 100);
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`).test(value);
}

function applyCompositePatterns(names: string[], allow: string[], deny: string[]): string[] {
  let result = names;
  if (allow.length) result = result.filter(name => allow.some(pattern => globMatch(pattern, name)));
  if (deny.length) result = result.filter(name => !deny.some(pattern => globMatch(pattern, name)));
  return result;
}

function integer(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

async function defaultRuntimeStatusLoader(runtimeType: 'codex' | 'claude-code'): Promise<RuntimeStatus> {
  if (!WORKSPACE_SECRET) throw new Error('WORKSPACE_SECRET is not configured');
  const cacheKey = runtimeType;
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.status;
  const route = runtimeType === 'codex' ? 'codex' : 'claude';
  const response = await fetch(`${AGENT_WORKSPACE_URL.replace(/\/+$/, '')}/${route}/status`, {
    headers: { 'x-workspace-secret': WORKSPACE_SECRET },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`${runtimeType} runtime status HTTP ${response.status}`);
  const body = await response.json() as Record<string, unknown>;
  const status = {
    enabled: body['enabled'] === true,
    authenticated: body['authenticated'] === true,
    activeRuns: integer(body['activeRuns']),
    maxConcurrentRuns: Math.max(1, integer(body['maxConcurrentRuns']) || 1),
  };
  runtimeCache.set(cacheKey, { status, expiresAt: Date.now() + 5_000 });
  return status;
}

async function inspectArgusRuntime(
  pool: pg.Pool,
  agent: AgentWithRag,
  toolCount: number,
  blockers: string[],
  warnings: string[],
): Promise<AgentReadinessRuntime> {
  const modelResult = await pool.query<ModelReadinessRow>(
    `SELECT model.enabled AS model_enabled,
            model.supports_tools,
            provider.enabled AS provider_enabled,
            provider.label AS provider_label,
            provider.auth_type,
            (provider.api_key IS NOT NULL OR provider.secret_name IS NOT NULL) AS provider_credential_configured,
            provider_profile.enabled AS provider_profile_enabled,
            (provider_profile.expires_at IS NOT NULL AND provider_profile.expires_at <= now()) AS provider_profile_expired,
            (provider_profile.api_key IS NOT NULL OR provider_profile.secret_name IS NOT NULL) AS provider_profile_configured,
            $3::boolean AS agent_direct_credential_configured,
            agent_profile.enabled AS agent_profile_enabled,
            (agent_profile.expires_at IS NOT NULL AND agent_profile.expires_at <= now()) AS agent_profile_expired,
            (agent_profile.api_key IS NOT NULL OR agent_profile.secret_name IS NOT NULL) AS agent_profile_configured,
            provider.last_test_status,
            provider.last_test_error
       FROM mcp_models model
       LEFT JOIN mcp_llm_providers provider ON provider.id=model.provider_id
       LEFT JOIN mcp_llm_credential_profiles provider_profile ON provider_profile.id=provider.credential_profile_id
       LEFT JOIN mcp_llm_credential_profiles agent_profile ON agent_profile.id=$2
      WHERE model.model_name=$1
      LIMIT 1`,
    [agent.model, agent.llm_credential_profile_id ?? null, Boolean(agent.llm_api_key)],
  );
  const model = modelResult.rows[0];
  if (!model || model.provider_label == null) {
    warnings.push(`Model '${agent.model}' is not backed by the managed model catalog; legacy environment fallback will be used`);
    return {
      type: 'argus', profileId: null, profileName: null, profileLabel: null,
      model: agent.model, state: 'warning', authenticated: null,
      activeRuns: null, maxConcurrentRuns: null, availableSlots: null,
      trust: 'core_governed',
      detail: 'Legacy model fallback; provider readiness is not fully observable',
    };
  }
  if (!model.model_enabled) blockers.push(`LLM model '${agent.model}' is disabled`);
  if (!model.provider_enabled) blockers.push(`LLM provider '${model.provider_label}' is disabled`);
  if (toolCount > 0 && !model.supports_tools) blockers.push(`LLM model '${agent.model}' does not support tool calling`);

  let credentialReady = model.auth_type === 'none';
  if (agent.llm_credential_profile_id != null) {
    credentialReady = model.agent_profile_enabled === true
      && model.agent_profile_expired !== true
      && model.agent_profile_configured === true;
    if (!credentialReady) blockers.push(`Agent credential profile for '${model.provider_label}' is unavailable, expired or unconfigured`);
  } else if (process.env['DIRECT_AGENT_API_KEYS'] === 'true' && model.agent_direct_credential_configured) {
    credentialReady = true;
  } else if (model.provider_profile_enabled != null) {
    credentialReady = model.provider_profile_enabled === true
      && model.provider_profile_expired !== true
      && model.provider_profile_configured === true;
    if (!credentialReady) blockers.push(`Provider credential profile for '${model.provider_label}' is unavailable, expired or unconfigured`);
  } else if (model.provider_credential_configured) {
    credentialReady = true;
  }
  if (!credentialReady && model.auth_type !== 'none') blockers.push(`No credential is configured for LLM provider '${model.provider_label}'`);
  if (model.last_test_status === 'failed') {
    warnings.push(`Last provider check failed for '${model.provider_label}'${model.last_test_error ? `: ${model.last_test_error.slice(0, 180)}` : ''}`);
  }
  const blocked = blockers.some(item => item.includes(agent.model) || item.includes(model.provider_label));
  return {
    type: 'argus', profileId: null, profileName: null, profileLabel: null,
    model: agent.model, state: blocked ? 'blocked' : model.last_test_status === 'failed' ? 'warning' : 'ready',
    authenticated: credentialReady, activeRuns: null, maxConcurrentRuns: null, availableSlots: null,
    trust: 'core_governed',
    detail: credentialReady ? `${model.provider_label} is configured` : `${model.provider_label} needs credentials`,
  };
}

async function inspectExternalRuntime(
  assignment: AgentRuntimeAssignment,
  runtimeType: 'codex' | 'claude-code',
  probe: boolean,
  loader: (runtimeType: 'codex' | 'claude-code') => Promise<RuntimeStatus>,
  blockers: string[],
  warnings: string[],
): Promise<AgentReadinessRuntime> {
  const label = runtimeType === 'codex' ? 'Codex' : 'Claude Code';
  if (assignment.profile_enabled === false) blockers.push(`${label} runtime profile is disabled`);
  if (!assignment.auth_ref) blockers.push(`${label} runtime profile has no protected authentication reference`);
  if (!probe) {
    return {
      type: runtimeType, profileId: assignment.profile_id, profileName: assignment.profile_name,
      profileLabel: assignment.profile_label, model: assignment.model ?? label,
      state: blockers.length ? 'blocked' : 'warning', authenticated: null,
      activeRuns: null, maxConcurrentRuns: null, availableSlots: null,
      trust: 'core_governed',
      detail: 'Runtime profile configured; live status was not probed',
    };
  }
  try {
    const status = await loader(runtimeType);
    const availableSlots = Math.max(0, status.maxConcurrentRuns - status.activeRuns);
    if (!status.enabled) blockers.push(`${label} runtime is disabled in agent-workspace`);
    if (!status.authenticated) blockers.push(`${label} runtime is not authenticated`);
    if (availableSlots === 0) blockers.push(`${label} runtime has no free execution slot`);
    const runtimeBlocked = !status.enabled || !status.authenticated || availableSlots === 0;
    return {
      type: runtimeType, profileId: assignment.profile_id, profileName: assignment.profile_name,
      profileLabel: assignment.profile_label, model: assignment.model ?? label,
      state: runtimeBlocked ? 'blocked' : 'ready', authenticated: status.authenticated,
      activeRuns: status.activeRuns, maxConcurrentRuns: status.maxConcurrentRuns, availableSlots,
      trust: 'core_governed',
      detail: runtimeBlocked ? `${label} runtime needs attention` : `${label} runtime is authenticated with ${availableSlots} free slot${availableSlots === 1 ? '' : 's'}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blockers.push(`${label} runtime status is unavailable: ${message}`);
    return {
      type: runtimeType, profileId: assignment.profile_id, profileName: assignment.profile_name,
      profileLabel: assignment.profile_label, model: assignment.model ?? label,
      state: 'blocked', authenticated: null, activeRuns: null, maxConcurrentRuns: null, availableSlots: null,
      trust: 'core_governed',
      detail: `${label} runtime status is unavailable`,
    };
  }
}

async function inspectHermesRuntime(
  assignment: AgentRuntimeAssignment,
  agent: AgentWithRag,
  probe: boolean,
  blockers: string[],
  warnings: string[],
): Promise<AgentReadinessRuntime> {
  if (assignment.profile_enabled === false) blockers.push('Hermes runtime profile is disabled');
  if (assignment.auth_mode !== 'runtime_adapter'
    || !assignment.adapter_pack_id
    || !assignment.adapter_id
    || !assignment.execution_strategy) {
    blockers.push('Hermes runtime profile has no complete adapter binding');
  }
  const managed = assignment.execution_strategy === 'managed';
  if (managed) {
    if (agent.agent_mode !== 'worker' && agent.agent_mode !== 'reviewer') {
      blockers.push('Managed Hermes is reserved for Argus Dev worker and reviewer agents');
    }
    if (assignment.workspace_policy !== 'checkout'
      || (assignment.memory_policy !== 'read_context' && assignment.memory_policy !== 'propose_write')
      || assignment.native_tool_policy !== 'managed_mcp_only'
      || assignment.session_policy !== 'clean') {
      blockers.push('Managed Hermes requires checkout, the governed Core memory bridge, managed_mcp_only tools and clean sessions');
    }
    warnings.push('Argus Dev retains tests, Git, branch, PR and approval ownership, including memory decisions; Hermes receives only a scoped runtime MCP workspace lease');
  } else {
    if (agent.agent_mode !== 'chat') {
      blockers.push('Attached Hermes supports chat agents only; worker and reviewer execution require Managed Hermes');
    }
    if (assignment.execution_strategy !== 'attached') {
      blockers.push(`Hermes '${assignment.execution_strategy ?? 'unknown'}' execution is not provisioned for Agent Runtime v1`);
    }
    warnings.push('Attached Hermes native tools are externally attested; Argus bundles, memory and workspace writes are not injected');
  }
  const base = {
    type: 'hermes' as const,
    profileId: assignment.profile_id,
    profileName: assignment.profile_name,
    profileLabel: assignment.profile_label,
    model: assignment.model ?? 'hermes-upstream',
    trust: managed ? 'core_governed' as const : 'external_attested' as const,
  };
  if (!probe) {
    return {
      ...base,
      state: blockers.length ? 'blocked' : 'warning',
      authenticated: null,
      activeRuns: null,
      maxConcurrentRuns: assignment.max_concurrent_runs,
      availableSlots: null,
      detail: 'Hermes adapter configured; live status was not probed',
    };
  }
  const executor = getAgentRuntimeExecutor('hermes');
  if (!executor) {
    blockers.push('Hermes runtime executor is not configured');
    return {
      ...base,
      state: 'blocked', authenticated: null, activeRuns: null,
      maxConcurrentRuns: assignment.max_concurrent_runs, availableSlots: null,
      detail: 'Hermes runtime executor is unavailable',
    };
  }
  try {
    const status = await executor.readiness(assignment);
    if (!status.enabled) blockers.push('Hermes runtime adapter is unavailable');
    if (!status.authenticated) blockers.push('Hermes upstream runtime is not ready');
    const availableSlots = status.activeRuns == null || status.maxConcurrentRuns == null
      ? null
      : Math.max(0, status.maxConcurrentRuns - status.activeRuns);
    if (availableSlots === 0) blockers.push('Hermes runtime has no free execution slot');
    return {
      ...base,
      state: !status.enabled || !status.authenticated || availableSlots === 0 ? 'blocked' : 'ready',
      authenticated: status.authenticated,
      activeRuns: status.activeRuns,
      maxConcurrentRuns: status.maxConcurrentRuns,
      availableSlots,
      trust: status.trust,
      detail: status.detail,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    blockers.push(`Hermes runtime status is unavailable: ${message}`);
    return {
      ...base,
      state: 'blocked', authenticated: null, activeRuns: null,
      maxConcurrentRuns: assignment.max_concurrent_runs, availableSlots: null,
      detail: 'Hermes runtime status is unavailable',
    };
  }
}

export async function assessAgentReadiness(
  pool: pg.Pool,
  agent: AgentWithRag,
  options: AgentReadinessOptions = {},
): Promise<AgentCapabilityReadiness> {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const explicitBundleIds = [...new Set((options.bundleIds ?? agent.bundle_ids ?? []).filter(id => Number.isSafeInteger(id) && id > 0))];
  let composite: CompositeRow | null = null;
  if (agent.composite_id != null) {
    const result = await pool.query<CompositeRow>(
      'SELECT enabled, included_bundle_ids, tool_allow_patterns, tool_deny_patterns FROM mcp_composites WHERE id=$1',
      [agent.composite_id],
    );
    composite = result.rows[0] ?? null;
    if (!composite) blockers.push(`Composite ${agent.composite_id} does not exist`);
    else if (!composite.enabled) blockers.push(`Composite ${agent.composite_id} is disabled`);
  }
  // Older composite records may contain NULL or otherwise invalid array entries.
  // Ignore them instead of turning stale data into a false execution blocker.
  const compositeBundleIds = [...new Set((composite?.included_bundle_ids ?? []).filter(
    (id): id is number => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
  ))];
  const inspectedBundleIds = [...new Set([...explicitBundleIds, ...compositeBundleIds])];
  const hasConstrainedComposite = Boolean(composite && (composite.tool_allow_patterns?.length ?? 0) > 0);
  if (!explicitBundleIds.length && !compositeBundleIds.length && !hasConstrainedComposite) {
    warnings.push('No MCP bundle boundary is assigned; the Agent can inherit the unscoped platform tool catalog');
  }

  const bundleRows = inspectedBundleIds.length
    ? (await pool.query<BundleRow>(
        'SELECT id, name, label FROM mcp_service_bundles WHERE id = ANY($1::int[]) ORDER BY label',
        [inspectedBundleIds],
      )).rows
    : [];
  const foundBundleIds = new Set(bundleRows.map(bundle => bundle.id));
  for (const missingId of inspectedBundleIds.filter(id => !foundBundleIds.has(id))) {
    blockers.push(`MCP bundle ${missingId} does not exist`);
  }
  const backendRows = inspectedBundleIds.length
    ? (await pool.query<BackendRow>(
        `SELECT assignment.bundle_id,
                backend.id,
                backend.name,
                backend.backend_type,
                backend.enabled,
                registry.trust_status,
                registry.tool_count AS registry_tool_count
           FROM mcp_backend_bundles assignment
           JOIN mcp_backends backend ON backend.id=assignment.backend_id
           LEFT JOIN mcp_registry_entries registry ON registry.backend_id=backend.id
          WHERE assignment.bundle_id = ANY($1::int[])
          ORDER BY assignment.bundle_id, backend.name`,
        [inspectedBundleIds],
      )).rows
    : [];
  const allowedLoader = options.allowedToolNamesLoader
    ?? ((bundleIds: number[]) => loadAllowedToolNames(pool, bundleIds, { includeUnscoped: false }));
  const backendIdsLoader = options.toolBackendIdsLoader
    ?? ((bundleIds: number[], toolNames: string[]) => loadBundleToolBackendIds(pool, bundleIds, toolNames));
  const executionAllowedToolNames = Array.isArray(options.allowedToolNames)
    ? new Set(options.allowedToolNames.map(name => name.trim()).filter(Boolean))
    : null;
  const dynamicToolNames = (await loadDynamicTools(pool)).filter(tool => tool.enabled).map(tool => tool.name);
  const connectedRemoteToolNames = getAllRemoteTools().map(tool => tool.prefixedName);
  const availableBackendToolNames = new Set([...dynamicToolNames, ...connectedRemoteToolNames]);
  const allowedByBundle = new Map<number, Set<string>>();
  for (const bundle of bundleRows) allowedByBundle.set(bundle.id, await allowedLoader([bundle.id]));
  const relevantBackendIdsByBundle = new Map<number, Set<number> | null>();
  for (const bundle of bundleRows) {
    const toolNames = [...(allowedByBundle.get(bundle.id) ?? new Set<string>())]
      .filter(name => executionAllowedToolNames == null || executionAllowedToolNames.has(name));
    const resolvedBackendIds = executionAllowedToolNames != null && toolNames.length > 0
      ? await backendIdsLoader([bundle.id], toolNames)
      : new Set<number>();
    // Keep the existing fail-closed, bundle-wide behavior if an explicitly
    // granted tool cannot be mapped to its owning backend.
    relevantBackendIdsByBundle.set(
      bundle.id,
      executionAllowedToolNames == null
        ? null
        : toolNames.length === 0 || resolvedBackendIds.size > 0
          ? resolvedBackendIds
          : null,
    );
  }

  const bundles: AgentReadinessBundle[] = bundleRows.map(bundle => {
    const toolNames = [...(allowedByBundle.get(bundle.id) ?? new Set<string>())]
      .filter(name => executionAllowedToolNames == null || executionAllowedToolNames.has(name))
      .sort();
    const relevantBackendIds = relevantBackendIdsByBundle.get(bundle.id) ?? null;
    const rows = backendRows.filter(backend => backend.bundle_id === bundle.id
      && (relevantBackendIds == null || relevantBackendIds.has(backend.id)));
    const backends = rows.map<AgentReadinessBackend>(backend => {
      const connection = backend.backend_type === 'mcp' ? getRemoteConnection(backend.id) : undefined;
      let state: CapabilityState = 'ready';
      let detail = 'Enabled';
      if (!backend.enabled) {
        state = 'blocked'; detail = 'Connection is disabled';
        blockers.push(`${bundle.label}: connection '${backend.name}' is disabled`);
      } else if (backend.backend_type === 'mcp' && backend.trust_status !== 'trusted') {
        state = 'blocked'; detail = `Catalog trust is ${backend.trust_status ?? 'unverified'}`;
        blockers.push(`${bundle.label}: MCP catalog '${backend.name}' is ${backend.trust_status ?? 'unverified'}`);
      } else if (backend.backend_type === 'mcp' && (!connection || !connection.connected)) {
        state = 'blocked'; detail = connection?.lastError ? `Disconnected: ${connection.lastError.slice(0, 160)}` : 'Remote MCP connection is not active';
        blockers.push(`${bundle.label}: MCP connection '${backend.name}' is not active`);
      } else if (backend.backend_type === 'mcp') {
        detail = `Connected and trusted · ${connection?.tools.length ?? integer(backend.registry_tool_count)} discovered tools`;
      }
      return {
        id: backend.id, name: backend.name, type: backend.backend_type, enabled: backend.enabled,
        connected: backend.backend_type === 'mcp' ? Boolean(connection?.connected) : null,
        trustStatus: backend.backend_type === 'mcp' ? backend.trust_status : null,
        toolCount: backend.backend_type === 'mcp' ? connection?.tools.length ?? integer(backend.registry_tool_count) : toolNames.length,
        state, detail,
      };
    });
    const effectiveBundleToolCount = toolNames.filter(name => availableBackendToolNames.has(name)).length;
    const exactToollessExecution = executionAllowedToolNames != null && toolNames.length === 0;
    const toollessProviderScope = exactToollessExecution || (options.allowToollessBundles === true
      && toolNames.length === 0
      && rows.length > 0
      && rows.every(backend => backend.backend_type === 'http'));
    if (!toolNames.length && !toollessProviderScope) blockers.push(`${bundle.label}: no tools are allowed by the bundle policy`);
    else if (!effectiveBundleToolCount && !toollessProviderScope) blockers.push(`${bundle.label}: the allowed tools are not present in the active runtime catalog`);
    return {
      id: bundle.id,
      name: bundle.name,
      label: bundle.label,
      toolNames,
      backends,
      state: ((!effectiveBundleToolCount && !toollessProviderScope) || backends.some(backend => backend.state === 'blocked'))
        ? 'blocked'
        : 'ready',
    };
  });

  let bundleToolNames: string[] = [];
  if (explicitBundleIds.length) {
    bundleToolNames = [...await allowedLoader(explicitBundleIds)];
  } else if (compositeBundleIds.length) {
    bundleToolNames = [...await allowedLoader(compositeBundleIds)];
  }
  if (explicitBundleIds.length && compositeBundleIds.length) {
    const compositeAllowed = await allowedLoader(compositeBundleIds);
    bundleToolNames = bundleToolNames.filter(name => compositeAllowed.has(name));
  }
  if (!explicitBundleIds.length && !compositeBundleIds.length) {
    bundleToolNames = [...availableBackendToolNames];
  } else {
    bundleToolNames = bundleToolNames.filter(name => availableBackendToolNames.has(name));
  }
  if (executionAllowedToolNames != null) {
    bundleToolNames = bundleToolNames.filter(name => executionAllowedToolNames.has(name));
  }

  const ragToolNames = (await getAgentRagTools(pool, agent.id)).map(tool => tool.function.name);
  const workspaceToolNames = WORKSPACE_SECRET ? WORKSPACE_TOOLS.map(tool => tool.function.name) : [];
  const subagentToolNames = [SUBAGENT_TOOL_SINGLE, SUBAGENT_TOOL_PARALLEL];
  if (WORKSPACE_SECRET && inspectedBundleIds.length
    && (executionAllowedToolNames == null || workspaceToolNames.some(name => executionAllowedToolNames.has(name)))) {
    warnings.push('Workspace tools are local capabilities and remain available outside MCP bundle membership; use a composite deny/allow policy to constrain them');
  }
  let effectiveToolNames = [...bundleToolNames, ...workspaceToolNames, ...ragToolNames, ...subagentToolNames];
  if (composite) {
    effectiveToolNames = applyCompositePatterns(
      effectiveToolNames,
      composite.tool_allow_patterns ?? [],
      composite.tool_deny_patterns ?? [],
    );
  }
  if (executionAllowedToolNames != null) {
    effectiveToolNames = effectiveToolNames.filter(name => executionAllowedToolNames.has(name));
  }
  const tools = [...new Set(effectiveToolNames)].sort().map<AgentReadinessTool>(name => ({
    name,
    source: name.startsWith('workspace_') ? 'workspace'
      : name.startsWith('rag_') ? 'knowledge'
        : name === SUBAGENT_TOOL_SINGLE || name === SUBAGENT_TOOL_PARALLEL ? 'subagent'
          : 'bundle',
  }));

  const assignment = options.runtimeAssignment !== undefined
    ? options.runtimeAssignment
    : await getAgentRuntimeAssignment(pool, agent.id);
  const runtimeLoader = options.runtimeStatusLoader ?? defaultRuntimeStatusLoader;
  const runtime = assignment?.runtime_type === 'codex' || assignment?.runtime_type === 'claude-code'
    ? await inspectExternalRuntime(assignment, assignment.runtime_type, options.probeRuntime !== false, runtimeLoader, blockers, warnings)
    : assignment?.runtime_type === 'hermes'
      ? await inspectHermesRuntime(assignment, agent, options.probeRuntime !== false, blockers, warnings)
      : await inspectArgusRuntime(pool, agent, tools.length, blockers, warnings);
  // Attached Hermes does not receive Core's tool catalog. Managed Hermes,
  // however, receives the Bundle catalog plus the minimal workspace lease.
  // Projecting the ordinary Agent catalog here would overstate that boundary
  // with workspace_exec, RAG and subagent tools that the runtime lease never
  // grants.
  let runtimeTools = tools;
  if (assignment?.runtime_type === 'hermes') {
    if (assignment.execution_strategy !== 'managed') {
      runtimeTools = [];
    } else {
      const canWriteWorkspace = agent.agent_mode === 'worker'
        && ['implement_ticket', 'fix_pr', 'fix_ci', 'fix_security'].includes(agent.task_type ?? '');
      let managedToolNames = [
        ...bundleToolNames,
        'workspace_ls',
        'workspace_read',
        ...(canWriteWorkspace ? ['workspace_write'] : []),
      ];
      if (composite) {
        managedToolNames = applyCompositePatterns(
          managedToolNames,
          composite.tool_allow_patterns ?? [],
          composite.tool_deny_patterns ?? [],
        );
      }
      runtimeTools = [...new Set(managedToolNames)].sort().map(name => ({
        name,
        source: name.startsWith('workspace_') ? 'workspace' as const : 'bundle' as const,
      }));
    }
  }
  const uniqueBlockers = boundedUnique(blockers);
  const uniqueWarnings = boundedUnique(warnings);
  const status: AgentReadinessStatus = !agent.enabled ? 'disabled'
    : uniqueBlockers.length ? 'blocked'
      : uniqueWarnings.length ? 'degraded'
        : 'ready';
  return {
    agentId: agent.id,
    agentName: agent.name,
    status,
    ready: agent.enabled && uniqueBlockers.length === 0,
    checkedAt: new Date().toISOString(),
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    runtime,
    bundles,
    tools: runtimeTools,
    capabilities: {
      workspace: { available: workspaceToolNames.some(name => runtimeTools.some(tool => tool.name === name)), toolCount: runtimeTools.filter(tool => tool.source === 'workspace').length },
      knowledge: { available: ragToolNames.some(name => runtimeTools.some(tool => tool.name === name)), toolCount: runtimeTools.filter(tool => tool.source === 'knowledge').length },
      subagents: { available: subagentToolNames.some(name => runtimeTools.some(tool => tool.name === name)), toolCount: runtimeTools.filter(tool => tool.source === 'subagent').length },
      codegraph: { available: agent.codegraph_enabled && runtimeTools.some(tool => tool.name.startsWith('codegraph_')), toolCount: runtimeTools.filter(tool => tool.name.startsWith('codegraph_')).length },
    },
  };
}

export class AgentNotReadyError extends Error {
  readonly status = 409;
  constructor(readonly readiness: AgentCapabilityReadiness) {
    super(`Agent '${readiness.agentName}' is not ready: ${readiness.blockers.join('; ')}`);
    this.name = 'AgentNotReadyError';
  }
}

export async function assertAgentExecutionReady(
  pool: pg.Pool,
  agent: AgentWithRag,
  options: AgentReadinessOptions = {},
): Promise<AgentCapabilityReadiness> {
  const readiness = await assessAgentReadiness(pool, agent, options);
  if (!readiness.ready) throw new AgentNotReadyError(readiness);
  return readiness;
}
