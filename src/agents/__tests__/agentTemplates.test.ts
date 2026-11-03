import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { AgentCapabilityReadiness, AgentReadinessOptions } from '../agentReadiness.js';
import { diffAgentTemplateSnapshots, installAgentTemplate, listAgentTemplates, previewAgentTemplate, type AgentTemplateManagedSnapshot } from '../agentTemplates.js';
import type { AgentWithRag } from '../types.js';

const templateRow = {
  id: 4,
  name: 'reviewer',
  label: 'Reviewer',
  description: 'Reviews implementation output.',
  category: 'ai-development',
  agent_mode: 'reviewer',
  config: { temperature: 0.2, maxTokens: 4096 },
  composite_name: null,
  skill_names: ['review'],
  recommended_capabilities: ['tool-calling'],
  required_by: ['LangGraph AI development workflow'],
  required_tool_patterns: [],
  minimum_bundle_count: 0,
  version: 1,
  installed: false,
  installed_agent_id: null,
  installed_version: null,
  created_at: '2026-08-01T10:00:00.000Z',
  updated_at: '2026-08-01T10:00:00.000Z',
};

function poolWithRows(...results: Array<{ rows: unknown[] }>): pg.Pool {
  let index = 0;
  return {
    query: async () => results[index++] ?? { rows: [] },
  } as unknown as pg.Pool;
}

describe('agent starter templates', () => {
  it('returns provider-neutral template metadata and installation state', async () => {
    const templates = await listAgentTemplates(poolWithRows({ rows: [templateRow] }));

    expect(templates).toEqual([expect.objectContaining({
      name: 'reviewer',
      agentMode: 'reviewer',
      config: { temperature: 0.2, maxTokens: 4096 },
      skillNames: ['review'],
      requiredToolPatterns: [],
      minimumBundleCount: 0,
      compatibleBundleIds: [],
      installed: false,
    })]);
    expect(templates[0]).not.toHaveProperty('model');
    expect(templates[0]).not.toHaveProperty('apiKey');
  });

  it('returns every installed model variant for lifecycle selection', async () => {
    const templates = await listAgentTemplates(poolWithRows(
      { rows: [{ ...templateRow, installed: true, installed_agent_id: 12, installed_version: 2 }] },
      { rows: [
        { template_name: 'reviewer', id: 12, name: 'reviewer', label: 'Reviewer · GPT', model: 'gpt-4o', installed_version: 2 },
        { template_name: 'reviewer', id: 13, name: 'reviewer-gemini', label: 'Reviewer · Gemini', model: 'gemini-2.5', installed_version: 1 },
      ] },
    ));

    expect(templates[0]?.installedAgents).toEqual([
      expect.objectContaining({ id: 12, model: 'gpt-4o', installedVersion: 2 }),
      expect.objectContaining({ id: 13, model: 'gemini-2.5', installedVersion: 1 }),
    ]);
  });

  it('requires an explicit model when installing a starter', async () => {
    await expect(installAgentTemplate(poolWithRows({ rows: [templateRow] }), 'reviewer', ''))
      .rejects.toEqual(expect.objectContaining({
        status: 400,
        message: 'Select a catalog model',
      }));
  });

  it('rejects models that are not enabled in the local catalog', async () => {
    await expect(installAgentTemplate(
      poolWithRows({ rows: [templateRow] }, { rows: [] }),
      'reviewer',
      'unregistered-model',
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'Selected model is missing or disabled',
    }));
  });

  it('reuses a canonical starter agent even when its lifecycle row is missing', async () => {
    const existingAgent = {
      id: 12,
      name: 'reviewer',
      label: 'Reviewer',
      description: 'Reviews implementation output.',
      model: 'managed-model',
    };
    const installed = await installAgentTemplate(
      poolWithRows(
        { rows: [{ ...templateRow, installed: true, installed_agent_id: 12 }] },
        { rows: [{ model_name: 'managed-model' }] },
        { rows: [{ id: 12 }] },
        { rows: [existingAgent] },
      ),
      'reviewer',
      { model: 'managed-model' },
      undefined,
      { allowMultiple: true },
    );

    expect(installed).toMatchObject(existingAgent);
  });

  it('does not expose non-chat templates through onboarding installation', async () => {
    await expect(installAgentTemplate(
      poolWithRows(
        { rows: [templateRow] },
        { rows: [{ model_name: 'managed-model' }] },
      ),
      'reviewer',
      { model: 'managed-model' },
      undefined,
      { allowMultiple: true, allowedAgentModes: ['chat'] },
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'This starter is not available in the onboarding flow',
    }));
  });

  it('requires an explicit MCP bundle for capability-scoped presets', async () => {
    const scopedTemplate = {
      ...templateRow,
      required_tool_patterns: ['*_pull_request_read'],
      minimum_bundle_count: 1,
    };
    await expect(installAgentTemplate(
      poolWithRows({ rows: [scopedTemplate] }),
      'reviewer',
      { model: 'managed-model', bundleIds: [] },
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'Select at least 1 MCP bundle for this preset',
    }));
  });

  it('rejects a selected bundle that lacks a required tool capability', async () => {
    const scopedTemplate = {
      ...templateRow,
      required_tool_patterns: ['*_pull_request_read'],
      minimum_bundle_count: 1,
    };
    await expect(installAgentTemplate(
      poolWithRows(
        { rows: [scopedTemplate] },
        { rows: [{ model_name: 'managed-model' }] },
        { rows: [{ id: 7, label: 'Metrics only' }] },
        { rows: [{ name: 'prometheus_query' }] },
      ),
      'reviewer',
      { model: 'managed-model', bundleIds: [7] },
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'Selected MCP bundle scope is missing required capabilities: *_pull_request_read',
    }));
  });

  it('rejects a disabled execution runtime profile', async () => {
    await expect(installAgentTemplate(
      poolWithRows(
        { rows: [templateRow] },
        { rows: [{ model_name: 'managed-model' }] },
        { rows: [] },
      ),
      'reviewer',
      { model: 'managed-model', runtimeProfileId: 9 },
    )).rejects.toEqual(expect.objectContaining({
      status: 400,
      message: 'Selected runtime profile is missing or disabled',
    }));
  });

  it('reports only bundles whose effective tools satisfy every preset requirement', async () => {
    const scopedTemplate = {
      ...templateRow,
      required_tool_patterns: ['*_pull_request_read', '*_get_file_contents'],
      minimum_bundle_count: 1,
    };
    const templates = await listAgentTemplates(poolWithRows(
      { rows: [scopedTemplate] },
      { rows: [{ id: 7 }, { id: 8 }] },
      { rows: [{ name: 'github_pull_request_read' }, { name: 'github_get_file_contents' }] },
      { rows: [{ name: 'prometheus_query' }] },
    ));

    expect(templates[0]?.compatibleBundleIds).toEqual([7]);
  });

  it('previews the exact selected Agent without persisting it', async () => {
    const readinessAssessor = jest.fn(async (
      _pool: pg.Pool,
      agent: AgentWithRag,
      _options: AgentReadinessOptions,
    ): Promise<AgentCapabilityReadiness> => ({
      agentId: agent.id,
      agentName: agent.name,
      status: 'ready' as const,
      ready: true,
      checkedAt: '2026-08-18T12:00:00.000Z',
      blockers: [],
      warnings: [],
      runtime: {
        type: 'argus' as const, profileId: null, profileName: null, profileLabel: null,
        model: agent.model, state: 'ready' as const, authenticated: true,
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
    }));
    const preview = await previewAgentTemplate(
      poolWithRows(
        { rows: [templateRow] },
        { rows: [{ model_name: 'managed-model' }] },
      ),
      'reviewer',
      { model: 'managed-model', bundleIds: [] },
      { readinessAssessor },
    );

    expect(preview).toMatchObject({ templateName: 'reviewer', selectionValid: true, errors: [], readiness: { ready: true } });
    expect(readinessAssessor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: -4, name: 'reviewer', model: 'managed-model', bundle_ids: [] }),
      expect.objectContaining({ bundleIds: [], runtimeAssignment: null }),
    );
  });

  it('returns selection evidence instead of mutating when preflight input is incomplete', async () => {
    const readinessAssessor = jest.fn(async (
      _pool: pg.Pool,
      _agent: AgentWithRag,
      _options: AgentReadinessOptions,
    ): Promise<AgentCapabilityReadiness> => { throw new Error('Readiness assessor must not run'); });
    const scopedTemplate = { ...templateRow, required_tool_patterns: ['*_read'], minimum_bundle_count: 1 };
    const preview = await previewAgentTemplate(
      poolWithRows({ rows: [scopedTemplate] }),
      'reviewer',
      { model: 'managed-model', bundleIds: [] },
      { readinessAssessor },
    );

    expect(preview).toEqual({
      templateName: 'reviewer',
      selectionValid: false,
      errors: ['Select at least 1 MCP bundle for this preset'],
      readiness: null,
    });
    expect(readinessAssessor).not.toHaveBeenCalled();
  });

  it('distinguishes safe preset changes from conflicting local Agent drift', () => {
    const baseline: AgentTemplateManagedSnapshot = {
      label: 'Reviewer', description: 'Reviews code.', temperature: 0.2, maxTokens: 4096,
      systemPrompt: 'Review safely.', agentRole: 'reviewer', compositeName: null, skillNames: ['review'],
      giteaProject: null, maxIterations: 10, agentMode: 'reviewer', taskType: null,
      allowedPaths: null, bitbucketRepo: null, thinkingBudget: 0,
      untrustedToolOutputEnforcement: true, codegraphEnabled: false, visibility: 'internal',
      minRole: null, riskLevel: 'medium', humanOversightRequired: true,
    };
    const diffs = diffAgentTemplateSnapshots(
      baseline,
      { ...baseline, systemPrompt: 'Locally hardened review.' },
      { ...baseline, systemPrompt: 'New upstream review.', maxTokens: 8192 },
    );

    expect(diffs.find(diff => diff.field === 'systemPrompt')).toMatchObject({
      templateChanged: true, locallyChanged: true, conflict: true,
    });
    expect(diffs.find(diff => diff.field === 'maxTokens')).toMatchObject({
      templateChanged: true, locallyChanged: false, conflict: false,
    });
  });
});
