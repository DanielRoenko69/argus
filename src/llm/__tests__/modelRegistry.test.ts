import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  normalizeLlmModelInput,
  normalizeLlmProviderInput,
  listLlmOnboardingCatalog,
  resolveRegisteredLlmTarget,
  testLlmProvider,
  deleteLlmModel,
} from '../modelRegistry.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

function providerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 4,
    name: 'local-runtime',
    label: 'Local Runtime',
    provider_type: 'openai-compatible',
    base_url: 'http://runtime:11434/v1',
    auth_type: 'bearer',
    api_key: 'provider-secret',
    secret_name: null,
    credential_profile_id: null,
    credential_profile_label: null,
    credential_profile_configured: false,
    enabled: true,
    config: {},
    last_test_status: null,
    last_tested_at: null,
    last_test_error: null,
    model_count: 1,
    supports_reasoning: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('LLM model registry', () => {
  it.each([0, 1])('deletes only unassigned API models atomically (dependencies: %s)', async count => {
    const calls:string[]=[];
    const query=jest.fn(async (sql:string) => {
      calls.push(sql);
      if (sql.includes('count(*)::text')) return { rows:[{ count:String(count) }],rowCount:1 };
      return { rows:[],rowCount:1 };
    });
    const release=jest.fn();
    const pool={ connect:async () => ({ query,release }) } as unknown as pg.Pool;
    if (count) await expect(deleteLlmModel(pool,3)).rejects.toThrow('API-Modell');
    else await expect(deleteLlmModel(pool,3)).resolves.toBe(true);
    expect(calls[0]).toBe('BEGIN');
    expect(calls.at(-1)).toBe(count ? 'ROLLBACK' : 'COMMIT');
    expect(calls.some(sql => sql.startsWith('DELETE'))).toBe(!count);
    expect(calls.some(sql => sql.startsWith('LOCK TABLE'))).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(calls.filter(sql => /UPDATE|INSERT/.test(sql))).toEqual([]);
  });

  it('rolls back and releases when deletion fails', async () => {
    const query=jest.fn(async (sql:string) => {
      if (sql.startsWith('DELETE')) throw new Error('fixture failure');
      return { rows:[{ count:'0' }],rowCount:0 };
    });
    const release=jest.fn();
    await expect(deleteLlmModel({ connect:async () => ({ query,release }) } as unknown as pg.Pool,3))
      .rejects.toThrow('fixture failure');
    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('normalizes provider endpoints without accepting credentials in URLs', () => {
    expect(normalizeLlmProviderInput({
      name: 'LiteLLM_Local',
      label: 'LiteLLM Local',
      providerType: 'openai-compatible',
      baseUrl: 'http://litellm:4000/v1/',
      authType: 'bearer',
      secretName: 'LITELLM_API_KEY',
      enabled: true,
    })).toMatchObject({ name: 'litellm_local', baseUrl: 'http://litellm:4000/v1' });

    expect(() => normalizeLlmProviderInput({
      name: 'unsafe', label: 'Unsafe', providerType: 'openai',
      baseUrl: 'https://token@example.com/v1', authType: 'bearer', enabled: true,
    })).toThrow('Credentials');
  });

  it('validates model capabilities and optional cost metadata', () => {
    expect(normalizeLlmModelInput({
      modelName: 'coder', displayName: 'Coder', providerId: 4,
      upstreamModelName: 'openai/gpt-5.1', enabled: true,
      supportsVision: false, supportsTools: true, supportsReasoning: true,
      maxInputTokens: '128000', maxOutputTokens: '', inputCostPer1k: '0.002', outputCostPer1k: null,
    })).toMatchObject({ maxInputTokens: 128000, maxOutputTokens: null, inputCostPer1k: 0.002 });
  });

  it('resolves a model alias to its provider endpoint and upstream name', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({
      rows: [providerRow({ model_enabled: true, upstream_model_name: 'qwen2.5-coder:32b' })],
      rowCount: 1,
      command: 'SELECT',
      oid: 0,
      fields: [],
    } as never);
    const target = await resolveRegisteredLlmTarget({ query } as unknown as pg.Pool, 'local-coder');
    expect(target).toMatchObject({
      provider: 'openai-compatible',
      baseUrl: 'http://runtime:11434/v1',
      apiKey: 'provider-secret',
      model: 'qwen2.5-coder:32b',
      supportsReasoning: false,
    });
  });

  it('prefers an agent credential profile and reports it on the runtime target', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({
        rows: [providerRow({ model_enabled: true, upstream_model_name: 'gpt-5.1' })],
        rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 9,
          name: 'engineering-openai',
          label: 'Engineering OpenAI',
          description: '',
          provider_type: 'openai-compatible',
          api_key: 'agent-profile-secret',
          secret_name: null,
          department: 'Engineering',
          cost_center: 'CC-42',
          monthly_budget_usd: null,
          budget_mode: 'alert',
          enabled: true,
          expires_at: null,
          last_rotated_at: null,
          created_at: '2026-08-01T00:00:00.000Z',
          updated_at: '2026-08-01T00:00:00.000Z',
          assigned_agents: 1,
          assigned_providers: 0,
          current_month_spend_usd: 0,
        }],
        rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as never);

    const target = await resolveRegisteredLlmTarget(
      { query } as unknown as pg.Pool,
      'argus-coder',
      null,
      9,
    );
    expect(target).toMatchObject({
      apiKey: 'agent-profile-secret',
      credentialProfileId: 9,
      credentialProfileName: 'engineering-openai',
    });
  });

  it('tests provider discovery without returning its credential', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({ rows: [providerRow()], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as never);
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ id: 'qwen2.5-coder:32b' }, { id: 'llama3.3' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const result = await testLlmProvider({ query } as unknown as pg.Pool, 4);
    expect(result).toMatchObject({ ok: true, models: ['llama3.3', 'qwen2.5-coder:32b'] });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect((fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>).Authorization).toBe('Bearer provider-secret');
  });

  it('returns safe onboarding metadata and marks provider test ownership', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({
        rows: [{
          id: 4, name: 'local-runtime', label: 'Local Runtime', provider_type: 'openai-compatible',
          base_url: 'http://runtime:11434/v1', auth_type: 'bearer', enabled: true,
          credential_configured: true, last_test_status: 'healthy', model_count: '1', can_test: true,
          api_key: 'provider-secret', secret_name: 'LOCAL_RUNTIME_KEY',
        }], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as never)
      .mockResolvedValueOnce({
        rows: [{
          id: 8, model_name: 'local-coder', display_name: 'Local Coder', provider_id: 4,
          provider_label: 'Local Runtime', provider_type: 'openai-compatible', enabled: true,
          provider_enabled: true, supports_vision: false, supports_tools: true, supports_reasoning: false,
        }], rowCount: 1, command: 'SELECT', oid: 0, fields: [],
      } as never);

    const catalog = await listLlmOnboardingCatalog({ query } as unknown as pg.Pool);
    expect(catalog).toEqual({
      providers: [expect.objectContaining({ id: 4, label: 'Local Runtime', canTest: true, modelCount: 1 })],
      models: [expect.objectContaining({ id: 8, modelName: 'local-coder', providerId: 4 })],
    });
    expect(JSON.stringify(catalog)).not.toContain('provider-secret');
    expect(JSON.stringify(catalog)).not.toContain('LOCAL_RUNTIME_KEY');
  });
});
