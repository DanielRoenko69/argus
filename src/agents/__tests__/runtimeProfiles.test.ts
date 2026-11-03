import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  AgentRuntimeProfileAssignmentError,
  AgentRuntimeProfileMutationError,
  createAgentRuntimeProfile,
  deleteAgentRuntimeProfile,
  getAgentRuntimeAssignment,
  listAgentRuntimeAssignments,
  listAgentRuntimeProfiles,
  normalizeAgentRuntimeCodeContextPolicy,
  normalizeAgentRuntimeProfile,
  updateAgentRuntimeProfile,
  updateAgentRuntimeCodeContextPolicy,
  validateAgentRuntimeProfileAssignment,
} from '../runtimeProfiles.js';

function poolWith(rows: unknown[]): pg.Pool {
  return { query: jest.fn(async () => ({ rows, rowCount: rows.length })) } as unknown as pg.Pool;
}

describe('agent runtime profiles', () => {
  it('lists profiles without requiring a secret field', async () => {
    const pool = poolWith([{ id: 2, name: 'codex-subscription-local', runtime_type: 'codex', auth_mode: 'chatgpt' }]);
    const rows = await listAgentRuntimeProfiles(pool);
    expect(rows[0].name).toBe('codex-subscription-local');
    expect((rows[0] as unknown as Record<string, unknown>).api_key).toBeUndefined();
  });

  it('accepts a configured Codex runtime reference', async () => {
    await expect(validateAgentRuntimeProfileAssignment(
      poolWith([{ runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: 'codex-auth', enabled: true }]),
      2,
    )).resolves.toBeUndefined();
  });

  it('accepts Hermes only with a complete runtime adapter binding', async () => {
    await expect(validateAgentRuntimeProfileAssignment(
      poolWith([{
        runtime_type: 'hermes', auth_mode: 'runtime_adapter', enabled: true, auth_ref: 'argus.hermes/hermes-http',
        adapter_pack_id: 'argus.hermes', adapter_id: 'hermes-http', execution_strategy: 'attached',
      }]),
      12,
    )).resolves.toBeUndefined();

    await expect(validateAgentRuntimeProfileAssignment(
      poolWith([{
        runtime_type: 'hermes', auth_mode: 'runtime_adapter', enabled: true, auth_ref: null,
        adapter_pack_id: null, adapter_id: null, execution_strategy: null,
      }]),
      12,
    )).rejects.toThrow('Adapter-Bindung');
  });

  it('exposes the Core-owned model policy in runtime assignments', async () => {
    const query = jest.fn(async (_sql: string) => ({
      rows: [{
        agent_id: 5,
        agent_name: 'coder',
        runtime_type: 'codex',
        profile_id: 2,
        profile_name: 'codex-subscription-local',
        profile_label: 'Codex · ChatGPT Subscription',
        auth_mode: 'chatgpt',
        auth_ref: 'codex-auth',
        model: 'gpt-5.6-terra',
        reasoning_effort: 'xhigh',
        code_context_mode: 'metadata_only',
        code_context_max_results: 4,
        code_context_max_bytes: 12000,
        profile_enabled: true,
      }],
      rowCount: 1,
    }));
    const rows = await listAgentRuntimeAssignments({ query } as unknown as pg.Pool);
    expect(rows[0]).toMatchObject({
      model: 'gpt-5.6-terra', reasoning_effort: 'xhigh',
      code_context_mode: 'metadata_only', code_context_max_results: 4,
    });
    expect(String(query.mock.calls[0]?.[0])).toContain('p.reasoning_effort');
    expect(String(query.mock.calls[0]?.[0])).toContain('mcp_runtime_adapter_profiles');
  });

  it('resolves a task profile without changing the Agent assignment', async () => {
    const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{
      agent_id: 5, agent_name: 'coder', runtime_type: 'hermes', profile_id: 37,
      profile_name: 'hermes-managed-dev', profile_enabled: true,
    }] }));
    const assignment = await getAgentRuntimeAssignment({ query } as unknown as pg.Pool, 5, 37);
    expect(assignment).toMatchObject({ agent_id: 5, profile_id: 37, runtime_type: 'hermes' });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('COALESCE($2::integer, a.runtime_profile_id)'), [5, 37]);
  });

  it('normalizes bounded source limits and rejects widened policy fields', () => {
    expect(normalizeAgentRuntimeCodeContextPolicy({
      mode: 'bounded_source', maxResults: 3, maxBytes: 8192,
    })).toEqual({ mode: 'bounded_source', maxResults: 3, maxBytes: 8192 });
    expect(() => normalizeAgentRuntimeCodeContextPolicy({
      mode: 'bounded_source', maxResults: 9, maxBytes: 8192,
    })).toThrow('maxResults');
    expect(() => normalizeAgentRuntimeCodeContextPolicy({
      mode: 'metadata_only', maxResults: 4, maxBytes: 12000, bypass: true,
    })).toThrow('unsupported');
  });

  it('normalizes safe custom runtimes and keeps Hermes module-managed', () => {
    expect(normalizeAgentRuntimeProfile({
      name: 'team-codex', label: 'Team Codex', description: '', runtimeType: 'codex',
      model: 'gpt-5.6-terra', reasoningEffort: 'xhigh', enabled: true, maxConcurrentRuns: 2,
      allowedTaskTypes: ['review', 'run_tests'], codeContextMode: 'bounded_source',
      codeContextMaxResults: 3, codeContextMaxBytes: 8192,
    })).toMatchObject({ runtimeType: 'codex', reasoningEffort: 'xhigh', codeContextMode: 'bounded_source' });
    expect(() => normalizeAgentRuntimeProfile({
      name: 'team-hermes', label: 'Team Hermes', description: '', runtimeType: 'hermes',
    })).toThrow('argus, codex or claude-code');
  });

  it('creates custom profiles with server-selected auth references', async () => {
    const query = jest.fn(async (_sql: string, params?: unknown[]) => ({ rows: [{
      id: 42, name: params?.[0], label: params?.[1], runtime_type: params?.[3],
      auth_mode: params?.[4], auth_ref: params?.[5], assigned_agent_count: 0, managed: false,
    }], rowCount: 1 }));
    const created = await createAgentRuntimeProfile({ query } as unknown as pg.Pool, {
      name: 'team-claude', label: 'Team Claude', description: '', runtimeType: 'claude-code',
      model: null, reasoningEffort: null, enabled: true, maxConcurrentRuns: 1,
      allowedTaskTypes: [], codeContextMode: 'metadata_only', codeContextMaxResults: 4,
      codeContextMaxBytes: 12000,
    }, 7);
    expect(created).toMatchObject({ runtime_type: 'claude-code', auth_mode: 'claude_subscription', auth_ref: 'claude-auth' });
    expect(query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['claude_subscription', 'claude-auth', 7]));
  });

  it('protects managed profiles and assigned custom profiles from mutation', async () => {
    const managedPool = poolWith([{ id: 1, runtime_type: 'argus', managed: true, assigned_agent_count: 0 }]);
    await expect(updateAgentRuntimeProfile(managedPool, 1, {
      name: 'argus-default', label: 'Argus', description: '', runtimeType: 'argus', model: null,
      reasoningEffort: null, enabled: true, maxConcurrentRuns: 8, allowedTaskTypes: [],
      codeContextMode: 'metadata_only', codeContextMaxResults: 4, codeContextMaxBytes: 12000,
    })).rejects.toBeInstanceOf(AgentRuntimeProfileMutationError);
    await expect(deleteAgentRuntimeProfile(
      poolWith([{ id: 9, runtime_type: 'codex', managed: false, assigned_agent_count: 2 }]),
      9,
    )).rejects.toThrow('assignments');
  });

  it('updates an external runtime policy but rejects source sharing for the Argus runtime', async () => {
    const codexProfile = {
      id: 2, name: 'codex-subscription-local', label: 'Codex', description: '',
      runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh', code_context_mode: 'metadata_only', code_context_max_results: 4,
      code_context_max_bytes: 12000, enabled: true, max_concurrent_runs: 1,
      allowed_task_types: [], assigned_agent_count: 2, created_at: '', updated_at: '',
    };
    const query = jest.fn(async (sql: string) => ({
      rows: sql.includes('UPDATE mcp_agent_runtime_profiles')
        ? [{ ...codexProfile, code_context_mode: 'bounded_source', code_context_max_results: 3, code_context_max_bytes: 8192 }]
        : [codexProfile],
      rowCount: 1,
    }));
    const updated = await updateAgentRuntimeCodeContextPolicy(
      { query } as unknown as pg.Pool,
      2,
      { mode: 'bounded_source', maxResults: 3, maxBytes: 8192 },
    );
    expect(updated.profile).toMatchObject({ code_context_mode: 'bounded_source', code_context_max_results: 3 });

    await expect(updateAgentRuntimeCodeContextPolicy(
      poolWith([{ ...codexProfile, id: 1, runtime_type: 'argus' }]),
      1,
      { mode: 'bounded_source', maxResults: 3, maxBytes: 8192 },
    )).rejects.toThrow('out-of-process');
  });

  it('rejects disabled or unreferenced Codex profiles', async () => {
    await expect(validateAgentRuntimeProfileAssignment(
      poolWith([{ runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: 'codex-auth', enabled: false }]),
      2,
    )).rejects.toThrow('deaktiviert');

    const err = await validateAgentRuntimeProfileAssignment(
      poolWith([{ runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: null, enabled: true }]),
      2,
    ).catch(reason => reason);
    expect(err).toBeInstanceOf(AgentRuntimeProfileAssignmentError);
    expect(err.message).toContain('Runtime-Referenz');
  });
});
