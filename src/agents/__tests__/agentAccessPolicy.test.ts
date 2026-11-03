/**
 * Tests for per-user/group agent-access filtering in listChatVisibleAgents.
 *
 * Strategy: mock all side-effect imports (Entra, encryption, config, logger,
 * userPolicyStore) so no live DB or external calls are needed.
 */

import type pg from 'pg';
import type { AgentWithRag } from '../types.js';

// ── Stable mocks (must run before any import of agentStore) ──

jest.mock('../../identity/entra.js', () => ({
  EntraSidecarClient: class {
    createAgentSP() { return Promise.resolve({ objectId: 'o', appId: 'a', blueprintId: 'b' }); }
    deleteAgentSP() { return Promise.resolve(); }
  },
}));

jest.mock('../../identity/blueprint.js', () => ({
  resolveBlueprintId: () => null,
}));

jest.mock('../../lib/encryption.js', () => ({
  encrypt: (v: string | null) => v,
  decrypt: (v: string | null) => v,
}));

jest.mock('../../config/env.js', () => ({
  loadConfig: () => ({
    entraAgentRegistration: false,
    entraSidecarUrl: '',
    entraEnvSlug: '',
    entraBlueprintMap: {},
  }),
}));

jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Mock fetchUserAgentPolicyData so tests control what rules come back
const mockFetchUserAgentPolicyData = jest.fn();
jest.mock('../../auth/userPolicyStore.js', () => ({
  ...jest.requireActual('../../auth/userPolicyStore.js'),
  fetchUserAgentPolicyData: (...args: unknown[]) => mockFetchUserAgentPolicyData(...args),
}));

// ── Helper to build a minimal AgentWithRag row ────────────────

function makeAgent(
  id: number,
  overrides: Partial<AgentWithRag> = {},
): AgentWithRag {
  return {
    id,
    name: `agent-${id}`,
    label: `Agent ${id}`,
    description: '',
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 4096,
    system_prompt: null,
    agent_role: null,
    composite_id: null,
    composite_name: null,
    gitea_project: null,
    enabled: true,
    max_iterations: 10,
    created_by: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    agent_mode: 'chat',
    task_type: null,
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: null,
    bitbucket_repo: null,
    bundle_ids: null,
    llm_api_key: null,
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
    rag_indexes: [],
    skills: [],
    ...overrides,
  } as unknown as AgentWithRag;
}

function makePool(agentRows: AgentWithRag[]): pg.Pool {
  return {
    query: jest.fn().mockResolvedValue({ rows: agentRows, rowCount: agentRows.length }),
    connect: jest.fn(),
  } as unknown as pg.Pool;
}

// ── Tests ─────────────────────────────────────────────────────

describe('listChatVisibleAgents — agent-access policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('no rules → all enabled internal agents returned (backward-compat)', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set<number>(),
      agentDenyIds: new Set<number>(),
    });

    const agents = [makeAgent(1), makeAgent(2), makeAgent(3)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    expect(result.map(a => a.id).sort()).toEqual([1, 2, 3]);
  });

  it('allow{2} → only agent 2 returned', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set([2]),
      agentDenyIds: new Set<number>(),
    });

    const agents = [makeAgent(1), makeAgent(2), makeAgent(3)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    expect(result.map(a => a.id)).toEqual([2]);
  });

  it('deny{1} → all except agent 1', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set<number>(),
      agentDenyIds: new Set([1]),
    });

    const agents = [makeAgent(1), makeAgent(2), makeAgent(3)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    expect(result.map(a => a.id).sort()).toEqual([2, 3]);
  });

  it('allow{1,3} + deny{3} → only agent 1', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set([1, 3]),
      agentDenyIds: new Set([3]),
    });

    const agents = [makeAgent(1), makeAgent(2), makeAgent(3)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    expect(result.map(a => a.id)).toEqual([1]);
  });

  it('disabled agents are never returned regardless of allow rules', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set([1, 2]),
      agentDenyIds: new Set<number>(),
    });

    // agent 2 is disabled
    const agents = [makeAgent(1), makeAgent(2, { enabled: false }), makeAgent(3)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    // agent 2 excluded (disabled), agent 3 excluded (not in allow set)
    expect(result.map(a => a.id)).toEqual([1]);
  });

  it('non-internal agents still excluded for chat_user regardless of allow rules', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set([1, 2]),
      agentDenyIds: new Set<number>(),
    });

    // agent 2 is public — chat_user should NOT see it
    const agents = [makeAgent(1), makeAgent(2, { visibility: 'public' })];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, {
      id: 99, username: 'test', display_name: 'Test', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });

    expect(result.map(a => a.id)).toEqual([1]);
  });

  it('no user passed → no fetch, all enabled returned', async () => {
    const agents = [makeAgent(1), makeAgent(2)];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');
    const result = await listChatVisibleAgents(pool, undefined);

    expect(result.map(a => a.id).sort()).toEqual([1, 2]);
    expect(mockFetchUserAgentPolicyData).not.toHaveBeenCalled();
  });

  it('passes user entra_groups to fetchUserAgentPolicyData', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set<number>(),
      agentDenyIds: new Set<number>(),
    });

    const pool = makePool([makeAgent(1)]);
    const { listChatVisibleAgents } = await import('../agentStore.js');
    await listChatVisibleAgents(pool, {
      id: 7, username: 'u', display_name: 'U', role: 'developer',
      allowed_bundles: null, entra_groups: ['my-group'],
    });

    expect(mockFetchUserAgentPolicyData).toHaveBeenCalledWith(pool, 7, ['my-group']);
  });

  it('min_role gate: chat_user sees only null-min_role agent; developer sees both', async () => {
    mockFetchUserAgentPolicyData.mockResolvedValue({
      agentAllowIds: new Set<number>(),
      agentDenyIds: new Set<number>(),
    });

    // agent 10: min_role=developer (requires developer+), agent 11: min_role=null (all)
    const agents = [
      makeAgent(10, { min_role: 'developer', visibility: 'internal' }),
      makeAgent(11, { min_role: null, visibility: 'internal' }),
    ];
    const pool = makePool(agents);

    const { listChatVisibleAgents } = await import('../agentStore.js');

    // chat_user: weight 5, developer gate weight 30 → only agent 11 passes
    const asChat = await listChatVisibleAgents(pool, {
      id: 1, username: 'chat', display_name: 'Chat', role: 'chat_user',
      allowed_bundles: null, entra_groups: [],
    });
    expect(asChat.map(a => a.id)).toEqual([11]);

    // developer: weight 30 >= 30 → both pass
    const asDev = await listChatVisibleAgents(pool, {
      id: 2, username: 'dev', display_name: 'Dev', role: 'developer',
      allowed_bundles: null, entra_groups: [],
    });
    expect(asDev.map(a => a.id).sort()).toEqual([10, 11]);
  });
});
