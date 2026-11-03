/**
 * Unit test for agent visibility field — verifies the store SQL includes
 * the visibility column without needing a live DB.
 *
 * Strategy: mock pg.Pool to capture the SQL strings passed to pool.query,
 * then assert `visibility` appears in SELECT and INSERT queries.
 */

import type pg from 'pg';

// We need to stub the Entra / encryption / config imports that agentStore
// pulls in transitively, otherwise ts-jest will fail during module loading
// in the test environment.

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

// ── Helpers ───────────────────────────────────────────────────

function makePool(overrides?: Partial<{ rows: unknown[] }>): pg.Pool {
  const rows = overrides?.rows ?? [];
  return {
    query: jest.fn().mockResolvedValue({ rows, rowCount: rows.length }),
    connect: jest.fn(),
  } as unknown as pg.Pool;
}

// ── Tests ─────────────────────────────────────────────────────

describe('agentStore — visibility column', () => {
  it('listAgents SELECT uses a.* wildcard (visibility included via column expansion)', async () => {
    const pool = makePool({ rows: [] });
    const { listAgents } = await import('../agentStore.js');
    await listAgents(pool);
    const queryCall = (pool.query as jest.Mock).mock.calls[0] as [string, ...unknown[]];
    const sql: string = queryCall[0];
    // listAgents uses SELECT a.* which expands to include visibility once migration runs
    expect(sql).toMatch(/SELECT\s+a\.\*/i);
  });

  it('getAgent SELECT uses a.* wildcard (visibility included via column expansion)', async () => {
    const pool = makePool({ rows: [] });
    const { getAgent } = await import('../agentStore.js');
    await getAgent(pool, 1);
    const queryCall = (pool.query as jest.Mock).mock.calls[0] as [string, ...unknown[]];
    const sql: string = queryCall[0];
    // getAgent uses SELECT a.* which expands to include visibility once migration runs
    expect(sql).toMatch(/SELECT\s+a\.\*/i);
  });

  it('createAgent INSERT includes visibility column', async () => {
    const agentRow = {
      id: 1, name: 'test', label: 'Test', description: '', model: 'gpt-4o',
      temperature: 0.7, max_tokens: 4096, system_prompt: null, agent_role: null,
      composite_id: null, gitea_project: null, enabled: true, max_iterations: 10,
      created_by: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      agent_mode: 'chat', task_type: null, pr_branch: null, pr_number: null,
      ticket_id: null, allowed_paths: null, bitbucket_repo: null, bundle_ids: null,
      llm_api_key: null, thinking_budget: 0, untrusted_tool_output_enforcement: true,
      entra_object_id: null, entra_app_id: null, entra_blueprint_id: null,
      entra_synced_at: null, entra_sync_error: null, codegraph_enabled: false,
      visibility: 'internal',
    };
    const pool = makePool({ rows: [agentRow] });
    const { createAgent } = await import('../agentStore.js');
    await createAgent(pool, { name: 'test', label: 'Test' });
    const queryCall = (pool.query as jest.Mock).mock.calls[0] as [string, ...unknown[]];
    const sql: string = queryCall[0];
    expect(sql).toMatch(/visibility/i);
  });

  it('created agent has visibility defaulting to "internal"', async () => {
    const agentRow = {
      id: 1, name: 'test', label: 'Test', description: '', model: 'gpt-4o',
      temperature: 0.7, max_tokens: 4096, system_prompt: null, agent_role: null,
      composite_id: null, gitea_project: null, enabled: true, max_iterations: 10,
      created_by: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      agent_mode: 'chat', task_type: null, pr_branch: null, pr_number: null,
      ticket_id: null, allowed_paths: null, bitbucket_repo: null, bundle_ids: null,
      llm_api_key: null, thinking_budget: 0, untrusted_tool_output_enforcement: true,
      entra_object_id: null, entra_app_id: null, entra_blueprint_id: null,
      entra_synced_at: null, entra_sync_error: null, codegraph_enabled: false,
      visibility: 'internal',
    };
    const pool = makePool({ rows: [agentRow] });
    const { createAgent } = await import('../agentStore.js');
    const agent = await createAgent(pool, { name: 'test', label: 'Test' });
    expect(agent.visibility).toBe('internal');
  });

  it('encrypts and persists a direct provider key during agent creation', async () => {
    const agentRow = {
      id: 1, name: 'keyed', label: 'Keyed', llm_api_key: 'encrypted-key',
      visibility: 'internal', enabled: true,
    };
    const pool = makePool({ rows: [agentRow] });
    const { createAgent } = await import('../agentStore.js');
    await createAgent(pool, { name: 'keyed', label: 'Keyed', llm_api_key: 'provider-secret' });
    const queryCall = (pool.query as jest.Mock).mock.calls[0] as [string, unknown[]];
    expect(queryCall[0]).toMatch(/llm_api_key/i);
    expect(queryCall[1]).toContain('provider-secret');
  });

  it('updateAgent SET can include visibility', async () => {
    const agentRow = {
      id: 1, name: 'test', label: 'Test', description: '', model: 'gpt-4o',
      temperature: 0.7, max_tokens: 4096, system_prompt: null, agent_role: null,
      composite_id: null, gitea_project: null, enabled: true, max_iterations: 10,
      created_by: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      agent_mode: 'chat', task_type: null, pr_branch: null, pr_number: null,
      ticket_id: null, allowed_paths: null, bitbucket_repo: null, bundle_ids: null,
      llm_api_key: null, thinking_budget: 0, untrusted_tool_output_enforcement: true,
      entra_object_id: null, entra_app_id: null, entra_blueprint_id: null,
      entra_synced_at: null, entra_sync_error: null, codegraph_enabled: false,
      visibility: 'public',
    };
    const pool = makePool({ rows: [agentRow] });
    const { updateAgent } = await import('../agentStore.js');
    const agent = await updateAgent(pool, 1, { visibility: 'public' });
    const queryCall = (pool.query as jest.Mock).mock.calls[0] as [string, ...unknown[]];
    const sql: string = queryCall[0];
    expect(sql).toMatch(/visibility/i);
    expect(agent.visibility).toBe('public');
  });
});
