import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { AgentCapabilityReadiness } from '../agentReadiness.js';
import {
  previewAgentTemplateDraft,
  publishAgentTemplateDraft,
  saveAgentTemplateDraft,
  type AgentTemplateDraftInput,
} from '../agentTemplateDrafts.js';

const now = '2026-08-18T10:00:00.000Z';

function definition(): AgentTemplateDraftInput {
  return {
    name: 'release_analyst',
    label: 'Release Analyst',
    description: 'Reviews release evidence.',
    category: 'delivery',
    agentMode: 'reviewer',
    config: {
      temperature: 0.2,
      maxTokens: 4096,
      maxIterations: 6,
      systemPrompt: 'Review evidence without writes.',
      agentRole: 'release-analyst',
      enabled: true,
      thinkingBudget: 0,
      untrustedToolOutputEnforcement: true,
      codegraphEnabled: false,
      visibility: 'internal',
      riskLevel: 'low',
      humanOversightRequired: false,
    },
    compositeName: null,
    skillNames: [],
    recommendedCapabilities: ['evidence'],
    requiredBy: ['release workflow'],
    requiredToolPatterns: [],
    minimumBundleCount: 0,
  };
}

function draftRow(overrides: Record<string, unknown> = {}) {
  return {
    name: 'release_analyst',
    definition: definition(),
    base_version: 0,
    published_version: null,
    preflight_definition_sha256: null,
    preflight_evidence: null,
    preflight_checked_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function ready(): AgentCapabilityReadiness {
  return {
    agentId: 1,
    agentName: 'release_analyst',
    status: 'ready',
    ready: true,
    checkedAt: now,
    blockers: [],
    warnings: [],
    runtime: {
      type: 'argus', profileId: null, profileName: null, profileLabel: null,
      model: 'managed-model', state: 'ready', authenticated: true,
      activeRuns: null, maxConcurrentRuns: null, availableSlots: null, detail: 'Configured',
    },
    bundles: [],
    tools: [],
    capabilities: {
      workspace: { available: false, toolCount: 0 },
      knowledge: { available: false, toolCount: 0 },
      subagents: { available: false, toolCount: 0 },
      codegraph: { available: false, toolCount: 0 },
    },
  };
}

describe('Agent preset drafts', () => {
  it('normalizes and stores a draft against the current published version', async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
        const sql = String(sqlValue);
        queries.push({ sql, params });
        if (sql.includes('SELECT version FROM mcp_agent_templates')) return { rows: [{ version: 3 }] };
        const stored = JSON.parse(String(params[1])) as AgentTemplateDraftInput;
        return { rows: [draftRow({ definition: stored, base_version: 3, published_version: 3 })] };
      }),
    } as unknown as pg.Pool;

    const saved = await saveAgentTemplateDraft(pool, {
      ...definition(),
      label: '  Release Analyst  ',
      recommendedCapabilities: ['evidence', 'evidence'],
    }, 9);

    expect(saved).toMatchObject({ baseVersion: 3, targetVersion: 4, existingTemplate: true });
    expect(saved.definition.label).toBe('Release Analyst');
    expect(saved.definition.recommendedCapabilities).toEqual(['evidence']);
    expect(queries[1]?.sql).toContain('preflight_definition_sha256=NULL');
    expect(queries[1]?.params[3]).toBe(9);
  });

  it('persists successful execution proof against the exact draft definition', async () => {
    let index = 0;
    const query = jest.fn(async (_sqlValue: unknown, params: unknown[] = []) => {
      index += 1;
      if (index === 1) return { rows: [draftRow()] };
      if (index === 2) return { rows: [{ model_name: 'managed-model' }] };
      expect(String(params[1])).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.parse(String(params[2]))).toMatchObject({ selectionValid: true, readiness: { ready: true } });
      expect(JSON.parse(String(params[4]))).toEqual(definition());
      return { rows: [], rowCount: 1 };
    });
    const pool = { query } as unknown as pg.Pool;

    const preview = await previewAgentTemplateDraft(
      pool,
      'release_analyst',
      { model: 'managed-model', bundleIds: [] },
      { readinessAssessor: async () => ready() },
    );

    expect(preview).toMatchObject({ selectionValid: true, readiness: { ready: true } });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('publishes a proved draft in one version-checked transaction', async () => {
    let previewIndex = 0;
    let proofHash = '';
    let proofEvidence: unknown = null;
    const previewPool = {
      query: jest.fn(async (_sqlValue: unknown, params: unknown[] = []) => {
        previewIndex += 1;
        if (previewIndex === 1) return { rows: [draftRow()] };
        if (previewIndex === 2) return { rows: [{ model_name: 'managed-model' }] };
        proofHash = String(params[1]);
        proofEvidence = JSON.parse(String(params[2]));
        return { rows: [], rowCount: 1 };
      }),
    } as unknown as pg.Pool;
    await previewAgentTemplateDraft(
      previewPool,
      'release_analyst',
      { model: 'managed-model', bundleIds: [] },
      { readinessAssessor: async () => ready() },
    );

    let insertParams: unknown[] = [];
    const client = {
      query: jest.fn(async (sqlValue: unknown, params: unknown[] = []) => {
        const sql = String(sqlValue);
        if (sql.includes('FROM mcp_agent_template_drafts')) {
          return { rows: [draftRow({
            preflight_definition_sha256: proofHash,
            preflight_evidence: proofEvidence,
            preflight_checked_at: new Date().toISOString(),
          })] };
        }
        if (sql.includes('SELECT version FROM mcp_agent_templates')) return { rows: [] };
        if (sql.includes('INSERT INTO mcp_agent_templates')) insertParams = params;
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const publishedRow = {
      id: 41,
      name: 'release_analyst',
      label: 'Release Analyst',
      description: 'Reviews release evidence.',
      category: 'delivery',
      agent_mode: 'reviewer',
      config: definition().config,
      composite_name: null,
      skill_names: [],
      recommended_capabilities: ['evidence'],
      required_by: ['release workflow'],
      required_tool_patterns: [],
      minimum_bundle_count: 0,
      version: 1,
      installed: false,
      installed_agent_id: null,
      installed_version: null,
      created_at: now,
      updated_at: now,
    };
    const pool = {
      connect: async () => client,
      query: async () => ({ rows: [publishedRow] }),
    } as unknown as pg.Pool;

    const published = await publishAgentTemplateDraft(pool, 'release_analyst');

    expect(published).toMatchObject({ name: 'release_analyst', version: 1 });
    expect(insertParams[12]).toBe(1);
    expect(client.query).toHaveBeenCalledWith('DELETE FROM mcp_agent_template_drafts WHERE name=$1', ['release_analyst']);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects publishing a draft without current hash-bound execution proof', async () => {
    const client = {
      query: jest.fn(async (sqlValue: unknown) => {
        const sql = String(sqlValue);
        if (sql.includes('FROM mcp_agent_template_drafts')) return { rows: [draftRow()] };
        if (sql.includes('SELECT version FROM mcp_agent_templates')) return { rows: [] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;

    await expect(publishAgentTemplateDraft(pool, 'release_analyst')).rejects.toMatchObject({
      status: 409,
      message: 'Run a successful draft preflight within 24 hours before publishing',
    });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale draft when the published preset version advanced', async () => {
    const client = {
      query: jest.fn(async (sqlValue: unknown) => {
        const sql = String(sqlValue);
        if (sql.includes('FROM mcp_agent_template_drafts')) return { rows: [draftRow({ base_version: 1 })] };
        if (sql.includes('SELECT version FROM mcp_agent_templates')) return { rows: [{ version: 2 }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: async () => client } as unknown as pg.Pool;

    await expect(publishAgentTemplateDraft(pool, 'release_analyst')).rejects.toMatchObject({
      status: 409,
      message: 'Preset changed after this draft was created (draft v1, current v2)',
    });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
