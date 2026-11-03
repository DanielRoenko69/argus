import { afterEach, describe, expect, it } from '@jest/globals';
import type pg from 'pg';
import {
  listLlmCredentialProfiles,
  normalizeLlmCredentialProfileInput,
  resolveLlmCredentialProfile,
} from '../credentialProfiles.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 9,
    name: 'platform-openai',
    label: 'Platform OpenAI',
    description: 'Shared Platform Engineering credential',
    provider_type: 'openai',
    api_key: 'profile-secret',
    secret_name: null,
    department: 'Platform Engineering',
    cost_center: 'CC-42',
    monthly_budget_usd: '250.0000',
    budget_mode: 'alert',
    enabled: true,
    expires_at: null,
    last_rotated_at: '2026-08-01T00:00:00.000Z',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    assigned_agents: 2,
    assigned_providers: 1,
    current_month_spend_usd: '62.5000',
    ...overrides,
  };
}

function poolWithRows(rows: Record<string, unknown>[]): pg.Pool {
  return {
    query: async () => ({ rows, rowCount: rows.length }),
  } as unknown as pg.Pool;
}

describe('LLM credential profiles', () => {
  it('normalizes ownership, provider and budget policy fields', () => {
    expect(normalizeLlmCredentialProfileInput({
      name: ' Platform_OpenAI ',
      label: 'Platform OpenAI',
      description: '',
      providerType: 'openai',
      secretName: 'PLATFORM_OPENAI_API_KEY',
      department: 'Platform Engineering',
      costCenter: 'CC-42',
      monthlyBudgetUsd: '250',
      budgetMode: 'block',
      enabled: true,
      expiresAt: '2027-01-01',
    })).toMatchObject({
      name: 'platform_openai',
      providerType: 'openai',
      secretName: 'PLATFORM_OPENAI_API_KEY',
      department: 'Platform Engineering',
      costCenter: 'CC-42',
      monthlyBudgetUsd: 250,
      budgetMode: 'block',
      enabled: true,
    });

    expect(() => normalizeLlmCredentialProfileInput({
      name: 'invalid profile', label: 'Invalid', providerType: 'openai',
      budgetMode: 'alert', enabled: true,
    })).toThrow('Technischer Name');
  });

  it('returns usage and assignments but never returns the API key', async () => {
    const profiles = await listLlmCredentialProfiles(poolWithRows([credentialRow()]));
    expect(profiles[0]).toMatchObject({
      id: 9,
      credentialConfigured: true,
      inlineCredentialConfigured: true,
      assignedAgents: 2,
      assignedProviders: 1,
      currentMonthSpendUsd: 62.5,
      budgetUsedPercent: 25,
    });
    expect(profiles[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify(profiles)).not.toContain('profile-secret');
  });

  it('resolves the secret only for the matching provider protocol', async () => {
    const pool = poolWithRows([credentialRow()]);
    const resolved = await resolveLlmCredentialProfile(pool, 9, 'openai');
    expect(resolved.apiKey).toBe('profile-secret');
    expect(resolved.profile).not.toHaveProperty('apiKey');
    await expect(resolveLlmCredentialProfile(pool, 9, 'anthropic')).rejects.toThrow('not anthropic');
  });

  it('blocks new calls after a hard monthly budget is exhausted', async () => {
    const pool = poolWithRows([credentialRow({
      monthly_budget_usd: '10.0000',
      current_month_spend_usd: '10.2500',
      budget_mode: 'block',
    })]);
    await expect(resolveLlmCredentialProfile(pool, 9, 'openai')).rejects.toThrow('budget');
  });
});
