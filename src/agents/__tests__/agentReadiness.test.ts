import type pg from 'pg';
import {
  AgentNotReadyError,
  assessAgentReadiness,
  assertAgentExecutionReady,
} from '../agentReadiness.js';
import type { AgentWithRag } from '../types.js';
import { configureAgentRuntimeExecutor } from '../runtimeExecutor.js';

function agent(overrides: Partial<AgentWithRag> = {}): AgentWithRag {
  return {
    id: 42,
    name: 'github-reader',
    label: 'GitHub reader',
    description: '',
    model: 'managed-model',
    temperature: 0.2,
    max_tokens: 4096,
    system_prompt: null,
    agent_role: null,
    composite_id: null,
    composite_name: null,
    gitea_project: null,
    enabled: true,
    max_iterations: 5,
    created_by: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    agent_mode: 'chat',
    task_type: null,
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: null,
    bitbucket_repo: null,
    bundle_ids: [7],
    llm_api_key: null,
    llm_credential_profile_id: null,
    runtime_profile_id: null,
    thinking_budget: 0,
    untrusted_tool_output_enforcement: true,
    entra_object_id: null,
    entra_app_id: null,
    entra_blueprint_id: null,
    entra_synced_at: null,
    entra_sync_error: null,
    codegraph_enabled: false,
    visibility: 'internal',
    min_role: null,
    risk_level: 'low',
    human_oversight_required: false,
    rag_indexes: [],
    skills: [],
    ...overrides,
  };
}

function poolFixture(options: {
  backendType?: 'http' | 'mcp' | 'builtin';
  backendEnabled?: boolean;
  trustStatus?: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
  runtimeAssignment?: Record<string, unknown>;
  dynamicTools?: Array<Record<string, unknown>>;
  compositeBundleIds?: Array<number | null>;
  backendRows?: Array<Record<string, unknown>>;
} = {}): pg.Pool {
  const query = jest.fn(async (sqlValue: unknown) => {
    const sql = String(sqlValue).replace(/\s+/g, ' ');
    if (sql.includes('FROM mcp_composites')) {
      return { rows: [{
        enabled: true,
        included_bundle_ids: options.compositeBundleIds ?? [],
        tool_allow_patterns: [],
        tool_deny_patterns: [],
      }] };
    }
    if (sql.includes('FROM mcp_service_bundles')) {
      return { rows: [{ id: 7, name: 'github-readonly', label: 'GitHub read only' }] };
    }
    if (sql.includes('FROM mcp_backend_bundles assignment')) {
      return { rows: options.backendRows ?? [{
        bundle_id: 7,
        id: 12,
        name: 'github',
        backend_type: options.backendType ?? 'http',
        enabled: options.backendEnabled ?? true,
        trust_status: options.trustStatus ?? null,
        registry_tool_count: 1,
      }] };
    }
    if (sql.includes('FROM mcp_tools t WHERE t.enabled = true')) {
      return { rows: options.dynamicTools ?? [{ id: 1, name: 'github_read', enabled: true, bundle_ids: [7] }] };
    }
    if (sql.includes('FROM mcp_rag_indexes r')) return { rows: [] };
    if (sql.includes('FROM mcp_agents a') && sql.includes('LEFT JOIN mcp_agent_runtime_profiles')) {
      return { rows: [options.runtimeAssignment ?? {
        agent_id: 42,
        agent_name: 'github-reader',
        runtime_type: null,
        profile_id: null,
        profile_name: null,
        profile_label: null,
        auth_mode: null,
        auth_ref: null,
        model: null,
        reasoning_effort: null,
        profile_enabled: null,
      }] };
    }
    if (sql.includes('FROM mcp_models model') && sql.includes('LEFT JOIN mcp_llm_providers provider')) {
      return { rows: [{
        model_enabled: true,
        supports_tools: true,
        provider_enabled: true,
        provider_label: 'Managed local',
        auth_type: 'none',
        provider_credential_configured: false,
        provider_profile_enabled: null,
        provider_profile_expired: null,
        provider_profile_configured: null,
        agent_direct_credential_configured: false,
        agent_profile_enabled: null,
        agent_profile_expired: null,
        agent_profile_configured: null,
        last_test_status: 'healthy',
        last_test_error: null,
      }] };
    }
    throw new Error(`Unexpected query: ${sql}`);
  });
  return { query } as unknown as pg.Pool;
}

describe('Agent capability readiness', () => {
  afterEach(() => configureAgentRuntimeExecutor('hermes', undefined));
  it('projects the effective bundle and local capability catalog for an executable Agent', async () => {
    const readiness = await assessAgentReadiness(poolFixture(), agent(), {
      allowedToolNamesLoader: async () => new Set(['github_read']),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.bundles[0]).toMatchObject({ label: 'GitHub read only', state: 'ready' });
    expect(readiness.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'github_read', source: 'bundle' }),
      expect.objectContaining({ name: '__call_agent__', source: 'subagent' }),
    ]));
    expect(readiness.runtime).toMatchObject({ type: 'argus', state: 'ready' });
  });

  it('blocks a scoped Agent when its MCP catalog is unverified and unavailable', async () => {
    const target = agent();
    const readiness = await assessAgentReadiness(poolFixture({
      backendType: 'mcp',
      trustStatus: 'unverified',
      dynamicTools: [],
    }), target, {
      allowedToolNamesLoader: async () => new Set(['github_get_file']),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.status).toBe('blocked');
    expect(readiness.blockers.join(' ')).toContain("MCP catalog 'github' is unverified");
    expect(readiness.blockers.join(' ')).toContain('not present in the active runtime catalog');
    await expect(assertAgentExecutionReady(poolFixture({
      backendType: 'mcp', trustStatus: 'unverified', dynamicTools: [],
    }), target, {
      allowedToolNamesLoader: async () => new Set(['github_get_file']),
      probeRuntime: false,
    })).rejects.toBeInstanceOf(AgentNotReadyError);
  });

  it('allows a tool-less HTTP provider scope only for an explicitly granted workspace run', async () => {
    const readiness = await assessAgentReadiness(poolFixture({ dynamicTools: [] }), agent(), {
      allowedToolNamesLoader: async () => new Set(),
      allowToollessBundles: true,
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.bundles[0]).toMatchObject({ label: 'GitHub read only', state: 'ready', toolNames: [] });
    expect(readiness.blockers).not.toContain('GitHub read only: no tools are allowed by the bundle policy');
  });

  it('keeps a tool-less scoped Agent blocked without the workspace grant', async () => {
    const readiness = await assessAgentReadiness(poolFixture({ dynamicTools: [] }), agent(), {
      allowedToolNamesLoader: async () => new Set(),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain('GitHub read only: no tools are allowed by the bundle policy');
  });

  it('blocks before execution when a Codex subscription runtime is disabled', async () => {
    const runtimeAssignment = {
      agent_id: 42,
      agent_name: 'github-reader',
      runtime_type: 'codex',
      profile_id: 9,
      profile_name: 'codex-terra',
      profile_label: 'Codex Terra',
      auth_mode: 'chatgpt',
      auth_ref: 'codex-auth',
      model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh',
      profile_enabled: true,
    };
    const readiness = await assessAgentReadiness(poolFixture({ runtimeAssignment }), agent({ runtime_profile_id: 9 }), {
      allowedToolNamesLoader: async () => new Set(['github_read']),
      runtimeStatusLoader: async () => ({ enabled: false, authenticated: true, activeRuns: 0, maxConcurrentRuns: 1 }),
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.runtime).toMatchObject({ type: 'codex', state: 'blocked', availableSlots: 1 });
    expect(readiness.blockers).toContain('Codex runtime is disabled in agent-workspace');
  });

  it('ignores an unrelated blocked Bundle backend for an exact execution tool grant', async () => {
    const target = agent();
    const readiness = await assessAgentReadiness(poolFixture({
      backendRows: [
        {
          bundle_id: 7, id: 12, name: 'kubernetes', backend_type: 'mcp', enabled: true,
          trust_status: 'changed', registry_tool_count: 1,
        },
        {
          bundle_id: 7, id: 99, name: 'github', backend_type: 'http', enabled: true,
          trust_status: null, registry_tool_count: 1,
        },
      ],
      dynamicTools: [{ id: 1, name: 'github_read', enabled: true, bundle_ids: [7] }],
    }), target, {
      allowedToolNames: ['github_read'],
      allowedToolNamesLoader: async () => new Set(['github_read', 'kubernetes_apply']),
      toolBackendIdsLoader: async () => new Set([99]),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.bundles[0]).toMatchObject({
      state: 'ready',
      toolNames: ['github_read'],
      backends: [expect.objectContaining({ id: 99, name: 'github', state: 'ready' })],
    });
    expect(readiness.blockers.join(' ')).not.toContain("MCP catalog 'kubernetes' is changed");
    expect(readiness.tools).toEqual([expect.objectContaining({ name: 'github_read', source: 'bundle' })]);
  });

  it('retains bundle-wide fail-closed readiness when a granted tool owner cannot be resolved', async () => {
    const readiness = await assessAgentReadiness(poolFixture({
      backendType: 'mcp',
      trustStatus: 'changed',
      dynamicTools: [{ id: 1, name: 'github_read', enabled: true, bundle_ids: [7] }],
    }), agent(), {
      allowedToolNames: ['github_read'],
      allowedToolNamesLoader: async () => new Set(['github_read']),
      toolBackendIdsLoader: async () => new Set(),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.join(' ')).toContain("MCP catalog 'github' is changed");
  });

  it('allows an explicit model-only execution without inspecting unused Bundle backends', async () => {
    const readiness = await assessAgentReadiness(poolFixture({
      backendType: 'mcp',
      trustStatus: 'changed',
      dynamicTools: [],
    }), agent(), {
      allowedToolNames: [],
      allowedToolNamesLoader: async () => new Set(['github_read']),
      probeRuntime: false,
    });

    expect(readiness.ready).toBe(true);
    expect(readiness.bundles[0]).toMatchObject({ state: 'ready', toolNames: [], backends: [] });
    expect(readiness.tools).toEqual([]);
    expect(readiness.blockers).toEqual([]);
  });

  it('reports attached Hermes as external-attested and blocks worker assignment', async () => {
    const runtimeAssignment = {
      agent_id: 42, agent_name: 'github-reader', runtime_type: 'hermes' as const,
      profile_id: 12, profile_name: 'hermes-attached-local', profile_label: 'Hermes · Existing service',
      auth_mode: 'runtime_adapter' as const, auth_ref: 'argus.hermes/hermes-http', model: 'hermes-upstream',
      reasoning_effort: null, code_context_mode: 'metadata_only' as const, code_context_max_results: 4,
      code_context_max_bytes: 12000, max_concurrent_runs: 1, profile_enabled: true,
      adapter_pack_id: 'argus.hermes', adapter_id: 'hermes-http', execution_strategy: 'attached' as const,
      adapter_credential_ref: 'pack-service-token', native_profile_ref: null, workspace_policy: 'context_only' as const,
      memory_policy: 'none' as const, native_tool_policy: 'external_attested' as const,
      session_policy: 'clean' as const, adapter_config: {},
    };
    configureAgentRuntimeExecutor('hermes', {
      readiness: async () => ({
        enabled: true, authenticated: true, activeRuns: null, maxConcurrentRuns: 1,
        detail: 'Attached Hermes is ready; native tools are externally attested', trust: 'external_attested',
      }),
      execute: async () => ({ output: '', externalRunId: 'unused', trust: 'external_attested' }),
    });

    const chat = await assessAgentReadiness(poolFixture({ runtimeAssignment }), agent({ runtime_profile_id: 12 }), {
      allowedToolNamesLoader: async () => new Set(['github_read']),
    });
    expect(chat.ready).toBe(true);
    expect(chat.status).toBe('degraded');
    expect(chat.runtime).toMatchObject({ type: 'hermes', state: 'ready', trust: 'external_attested' });
    expect(chat.warnings.join(' ')).toContain('externally attested');
    expect(chat.tools).toEqual([]);
    expect(chat.capabilities.workspace.available).toBe(false);

    const worker = await assessAgentReadiness(
      poolFixture({ runtimeAssignment }),
      agent({ runtime_profile_id: 12, agent_mode: 'worker' }),
      { allowedToolNamesLoader: async () => new Set(['github_read']) },
    );
    expect(worker.ready).toBe(false);
    expect(worker.blockers.join(' ')).toContain('require Managed Hermes');
  });

  it('projects Managed Hermes as an optional scoped Dev worker without transferring Argus capabilities', async () => {
    const runtimeAssignment = {
      agent_id: 42, agent_name: 'github-reader', runtime_type: 'hermes' as const,
      profile_id: 19, profile_name: 'hermes-managed-dev', profile_label: 'Hermes · Managed Dev worker',
      auth_mode: 'runtime_adapter' as const, auth_ref: 'argus.hermes/hermes-http', model: 'hermes-upstream',
      reasoning_effort: null, code_context_mode: 'metadata_only' as const, code_context_max_results: 4,
      code_context_max_bytes: 12000, max_concurrent_runs: 1, profile_enabled: true,
      adapter_pack_id: 'argus.hermes', adapter_id: 'hermes-http', execution_strategy: 'managed' as const,
      adapter_credential_ref: 'pack-service-token', native_profile_ref: null, workspace_policy: 'checkout' as const,
      memory_policy: 'propose_write' as const, native_tool_policy: 'managed_mcp_only' as const,
      session_policy: 'clean' as const, adapter_config: {},
    };
    configureAgentRuntimeExecutor('hermes', {
      readiness: async () => ({
        enabled: true, authenticated: true, activeRuns: 0, maxConcurrentRuns: 1,
        detail: 'Managed Hermes is ready', trust: 'core_governed',
      }),
      execute: async () => ({ output: '', externalRunId: 'unused', trust: 'core_governed' }),
    });

    const readiness = await assessAgentReadiness(
      poolFixture({ runtimeAssignment }),
      agent({ runtime_profile_id: 19, agent_mode: 'worker', task_type: 'implement_ticket' }),
      { allowedToolNamesLoader: async () => new Set(['github_read']) },
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.status).toBe('degraded');
    expect(readiness.runtime).toMatchObject({ type: 'hermes', state: 'ready', trust: 'core_governed' });
    expect(readiness.warnings.join(' ')).toContain('Argus Dev retains tests, Git, branch, PR and approval ownership');
    expect(readiness.tools).toEqual(expect.arrayContaining([
      { name: 'github_read', source: 'bundle' },
      { name: 'workspace_ls', source: 'workspace' },
      { name: 'workspace_read', source: 'workspace' },
      { name: 'workspace_write', source: 'workspace' },
    ]));
    expect(readiness.tools.find(tool => tool.name === 'workspace_exec')).toBeUndefined();
    expect(readiness.tools.find(tool => tool.source === 'subagent')).toBeUndefined();
    expect(readiness.tools.find(tool => tool.source === 'knowledge')).toBeUndefined();
  });

  it('ignores stale NULL entries in composite bundle assignments', async () => {
    const readiness = await assessAgentReadiness(
      poolFixture({ compositeBundleIds: [null, 7, 0, 7] }),
      agent({ composite_id: 5, bundle_ids: null }),
      {
        allowedToolNamesLoader: async () => new Set(['github_read']),
        probeRuntime: false,
      },
    );

    expect(readiness.ready).toBe(true);
    expect(readiness.bundles).toHaveLength(1);
    expect(readiness.blockers.join(' ')).not.toContain('bundle null');
    expect(readiness.blockers.join(' ')).not.toContain('bundle 0');
  });
});
