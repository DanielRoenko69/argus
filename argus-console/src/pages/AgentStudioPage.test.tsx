import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentStudioCatalog } from '../types';
import { AgentStudioPage } from './AgentStudioPage';

const api = vi.hoisted(() => ({
  deleteAgentStudioAgent: vi.fn(),
  deleteAgentTemplateDraft: vi.fn(),
  getAgentHookConfig: vi.fn(),
  getAgentSessions: vi.fn(),
  getAgentStudio: vi.fn(),
  getAgentTemplateUpgradePreview: vi.fn(),
  installAgentTemplate: vi.fn(),
  previewAgentTemplate: vi.fn(),
  previewAgentTemplateDraft: vi.fn(),
  publishAgentTemplateDraft: vi.fn(),
  applyAgentTemplateUpgrade: vi.fn(),
  resyncAgentIdentity: vi.fn(),
  saveAgentStudioAgent: vi.fn(),
  saveAgentTemplateDraft: vi.fn(),
}));

vi.mock('../api', () => api);

const catalog: AgentStudioCatalog = {
  templates: [],
  drafts: [],
  credentialProfiles: [],
  agents: [{
    id: 7,
    name: 'platform-engineer',
    label: 'Platform Engineer',
    description: 'Builds and reviews platform changes.',
    model: 'gpt-5.1',
    supports_vision: false,
    temperature: 0.4,
    max_tokens: 4096,
    system_prompt: 'Work safely.',
    agent_role: 'platform-engineer',
    composite_id: 2,
    composite_name: 'engineering',
    gitea_project: null,
    enabled: true,
    max_iterations: 12,
    created_at: '2026-07-30T10:00:00.000Z',
    updated_at: '2026-07-31T10:00:00.000Z',
    agent_mode: 'worker',
    task_type: 'feature',
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: ['src/**'],
    bitbucket_repo: 'argus/platform',
    bundle_ids: [3],
    llm_api_key: '********',
    llm_credential_profile_id: null,
    thinking_budget: 0,
    untrusted_tool_output_enforcement: true,
    codegraph_enabled: true,
    visibility: 'internal',
    min_role: 'developer',
    risk_level: 'medium',
    human_oversight_required: true,
    entra_object_id: null,
    entra_app_id: null,
    entra_blueprint_id: null,
    entra_synced_at: null,
    entra_sync_error: null,
    rag_indexes: [{ id: 4, name: 'runbooks', label: 'Runbooks', priority: 0 }],
    code_indexes: [{
      id: 31,
      repository_key: 'argus/platform',
      branch_name: 'main',
      commit_sha: 'abc123def456',
      provider: 'graphify',
      file_count: 420,
      symbol_count: 1_900,
      edge_count: 3_600,
      priority: 0,
    }],
    skills: [{ id: 5, name: 'review', label: 'Code review', icon: '✦', category: 'engineering', position: 0 }],
    readiness: {
      agentId: 7,
      agentName: 'platform-engineer',
      status: 'ready',
      ready: true,
      checkedAt: '2026-08-18T10:00:00.000Z',
      blockers: [],
      warnings: [],
      runtime: {
        type: 'codex', profileId: 4, profileName: 'codex-terra', profileLabel: 'Codex Terra',
        model: 'gpt-5.6-terra', state: 'ready', authenticated: true,
        activeRuns: 0, maxConcurrentRuns: 2, availableSlots: 2,
        detail: 'Codex runtime is authenticated with 2 free slots',
      },
      bundles: [{
        id: 3, name: 'platform', label: 'Platform', toolNames: ['github_read'], state: 'ready',
        backends: [{ id: 8, name: 'github', type: 'mcp', enabled: true, connected: true, trustStatus: 'trusted', toolCount: 7, state: 'ready', detail: 'Connected and trusted' }],
      }],
      tools: [
        { name: 'github_read', source: 'bundle' },
        { name: 'workspace_read', source: 'workspace' },
        { name: 'rag_runbooks', source: 'knowledge' },
        { name: '__call_agent__', source: 'subagent' },
      ],
      capabilities: {
        workspace: { available: true, toolCount: 1 },
        knowledge: { available: true, toolCount: 1 },
        subagents: { available: true, toolCount: 1 },
        codegraph: { available: false, toolCount: 0 },
      },
    },
  }],
  models: [{ model_name: 'gpt-5.1', provider: 'openai', enabled: true, supports_vision: false }],
  composites: [{ id: 2, name: 'engineering', description: '', enabled: true }],
  bundles: [{ id: 3, name: 'platform', label: 'Platform', description: '', icon: '◫', backend_count: 2, tool_count: 18 }],
  ragIndexes: [{ id: 4, name: 'runbooks', label: 'Runbooks', description: '', provider: 'pgvector', endpoint: '', index_name: '', api_key: null, semantic_config: null, top_k: 5, enabled: true }],
  codeIndexes: [{
    id: 31,
    repositoryKey: 'argus/platform',
    branchName: 'main',
    commitSha: 'abc123def456',
    provider: 'graphify',
    sourceGraphDigest: 'sha256:graph',
    parserVersion: '1.0.0',
    graphSchemaVersion: '1',
    embeddingModel: null,
    status: 'ready',
    fileCount: 420,
    symbolCount: 1_900,
    edgeCount: 3_600,
    documentCount: 420,
    errorMessage: null,
    metadata: {},
    createdAt: '2026-08-18T10:00:00.000Z',
    finishedAt: '2026-08-18T10:01:00.000Z',
    bundleNames: ['Argus Code Intelligence · Read'],
    languages: { TypeScript: 320 },
  }],
  skills: [{ id: 5, name: 'review', label: 'Code review', description: '', content: '# Review', category: 'engineering', icon: '✦' }],
};

const codexRuntimeProfiles: NonNullable<AgentStudioCatalog['runtimeProfiles']> = [
  {
    id: 9, name: 'codex-subscription-local', label: 'Codex Fast', description: '', runtime_type: 'codex',
    auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.3-codex-spark', reasoning_effort: 'xhigh',
    code_context_mode: 'metadata_only', code_context_max_results: 8, code_context_max_bytes: 24_000,
    enabled: true, max_concurrent_runs: 2, allowed_task_types: [], assigned_agent_count: 1,
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z',
  },
  {
    id: 10, name: 'codex-subscription-deep', label: 'Codex Deep', description: '', runtime_type: 'codex',
    auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.6-terra', reasoning_effort: 'xhigh',
    code_context_mode: 'metadata_only', code_context_max_results: 8, code_context_max_bytes: 24_000,
    enabled: true, max_concurrent_runs: 2, allowed_task_types: [], assigned_agent_count: 0,
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-01T10:00:00.000Z',
  },
];

function renderPage(data: AgentStudioCatalog = catalog, initialEntry = '/build/agents/manage?view=agents') {
  api.getAgentStudio.mockResolvedValue(data);
  api.getAgentHookConfig.mockResolvedValue({ agent_id: 7, extra_destructive_patterns: ['\\brm\\s+-rf\\b'], max_tool_calls: 20 });
  api.saveAgentStudioAgent.mockResolvedValue(data.agents[0]);
  api.installAgentTemplate.mockResolvedValue(data.agents[0]);
  api.previewAgentTemplate.mockResolvedValue({
    templateName: 'reviewer', selectionValid: true, errors: [],
    readiness: { ...(data.agents[0]?.readiness ?? catalog.agents[0].readiness!), agentId: -11, agentName: 'reviewer' },
  });
  api.saveAgentTemplateDraft.mockImplementation(async definition => ({
    name: definition.name,
    definition,
    baseVersion: 0,
    targetVersion: 1,
    existingTemplate: false,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  }));
  api.previewAgentTemplateDraft.mockResolvedValue({
    templateName: 'custom_agent', selectionValid: true, errors: [],
    readiness: { ...(data.agents[0]?.readiness ?? catalog.agents[0].readiness!), agentId: -11, agentName: 'custom_agent' },
  });
  api.publishAgentTemplateDraft.mockResolvedValue({
    id: 99, name: 'custom_agent', label: 'Custom agent', description: '', category: 'custom', agentMode: 'worker',
    config: {}, compositeName: null, skillNames: [], recommendedCapabilities: [], requiredBy: [], requiredToolPatterns: [],
    minimumBundleCount: 0, compatibleBundleIds: [], version: 1, installed: false, installedAgentId: null,
    installedVersion: null, upgradeAvailable: false, createdAt: '2026-08-18T10:00:00.000Z', updatedAt: '2026-08-18T10:00:00.000Z',
  });
  api.deleteAgentTemplateDraft.mockResolvedValue(undefined);
  api.getAgentSessions.mockResolvedValue([]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={[initialEntry]}><QueryClientProvider client={queryClient}><AgentStudioPage /></QueryClientProvider></MemoryRouter>);
}

describe('AgentStudioPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('edits an agent without exposing or overwriting its configured provider key', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Platform Engineer' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(await screen.findByRole('heading', { name: 'Configure Platform Engineer' })).toBeInTheDocument();
    expect(screen.getByText('DIRECT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep current' })).toBeInTheDocument();
    expect(screen.queryByDisplayValue('********')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Senior Platform Engineer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(api.saveAgentStudioAgent).toHaveBeenCalledTimes(1));
    const [payload, id] = api.saveAgentStudioAgent.mock.calls[0];
    expect(id).toBe(7);
    expect(payload.agent.label).toBe('Senior Platform Engineer');
    expect(payload.agent.llm_api_key).toBeUndefined();
    expect(payload.agent).toMatchObject({ risk_level: 'medium', human_oversight_required: true });
    expect(payload.ragIndexIds).toEqual([4]);
    expect(payload.codeIndexIds).toEqual([31]);
    expect(payload.skillIds).toEqual([5]);
    expect(payload.hookConfig).toEqual({ extra_destructive_patterns: ['\\brm\\s+-rf\\b'], max_tool_calls: 20 });
  });

  it('shows the runtime, Bundle connection and effective tools from the shared readiness decision', async () => {
    renderPage();
    expect(await screen.findByText('4 effective tools')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(await screen.findByLabelText('Agent capability readiness')).toHaveTextContent('Codex runtime is authenticated with 2 free slots');
    expect(screen.getByLabelText('Agent capability readiness')).toHaveTextContent('github · Connected and trusted');
    fireEvent.click(screen.getByText('Show effective tool catalog'));
    expect(screen.getByText('github_read')).toBeInTheDocument();
    expect(screen.getByText('workspace_read')).toBeInTheDocument();
  });

  it('labels attached Hermes as externally attested instead of a provider fallback', async () => {
    renderPage({
      ...catalog,
      agents: [{
        ...catalog.agents[0],
        runtime_profile_id: 19,
        readiness: {
          ...catalog.agents[0].readiness!,
          tools: [],
          capabilities: {
            workspace: { available: false, toolCount: 0 },
            knowledge: { available: false, toolCount: 0 },
            subagents: { available: false, toolCount: 0 },
            codegraph: { available: false, toolCount: 0 },
          },
          runtime: {
            ...catalog.agents[0].readiness!.runtime,
            type: 'hermes',
            profileId: 19,
            profileName: 'hermes-attached-local',
            profileLabel: 'Hermes · Existing service',
            model: 'hermes-upstream',
            trust: 'external_attested',
            detail: 'Attached Hermes is ready; native tools are externally attested',
          },
        },
      }],
      runtimeProfiles: [{
        id: 19, name: 'hermes-attached-local', label: 'Hermes · Existing service', description: '',
        runtime_type: 'hermes', auth_mode: 'runtime_adapter', auth_ref: 'argus.hermes/hermes-http',
        model: 'hermes-upstream', reasoning_effort: null, code_context_mode: 'metadata_only',
        code_context_max_results: 4, code_context_max_bytes: 12000, enabled: true,
        max_concurrent_runs: 1, allowed_task_types: ['chat'], assigned_agent_count: 1,
        execution_strategy: 'attached', native_tool_policy: 'external_attested',
        created_at: '2026-08-31T10:00:00.000Z', updated_at: '2026-08-31T10:00:00.000Z',
      }],
    });

    expect(await screen.findByText(/EXTERNAL ATTESTED/)).toBeInTheDocument();
    expect(screen.getAllByText('hermes-upstream').length).toBeGreaterThan(0);
    expect(screen.queryByText('PROVIDER FALLBACK')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(await screen.findByText(/Attached v1 runs chat only/)).toBeInTheDocument();
  });

  it('configures governance risk and human oversight through the normal agent editor', async () => {
    renderPage({
      ...catalog,
      agents: [{ ...catalog.agents[0], risk_level: 'low', human_oversight_required: false }],
    });
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.change(screen.getByLabelText(/Governance risk level/), { target: { value: 'high' } });
    fireEvent.click(screen.getByLabelText('Require human approval for sensitive writes'));
    const saveButton = screen.getByRole('button', { name: 'Save agent' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.saveAgentStudioAgent).toHaveBeenCalledTimes(1));
    expect(api.saveAgentStudioAgent.mock.calls[0][0].agent).toMatchObject({
      risk_level: 'high',
      human_oversight_required: true,
    });
  });

  it('assigns a compatible reusable credential profile to an agent', async () => {
    renderPage({
      ...catalog,
      credentialProfiles: [{
        id: 12,
        name: 'platform-openai',
        label: 'Platform OpenAI',
        description: '',
        providerType: 'openai',
        secretName: null,
        department: 'Platform Engineering',
        costCenter: 'CC-42',
        monthlyBudgetUsd: 250,
        budgetMode: 'alert',
        enabled: true,
        expiresAt: null,
        credentialConfigured: true,
        inlineCredentialConfigured: true,
        assignedAgents: 0,
        assignedProviders: 0,
        currentMonthSpendUsd: 20,
        budgetUsedPercent: 8,
        expired: false,
        lastRotatedAt: null,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    });
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.change(await screen.findByLabelText(/Credential profile/), { target: { value: '12' } });
    expect(screen.getByText('Platform Engineering · CC-42')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save agent' }));

    await waitFor(() => expect(api.saveAgentStudioAgent).toHaveBeenCalledTimes(1));
    expect(api.saveAgentStudioAgent.mock.calls[0][0].agent).toMatchObject({
      llm_credential_profile_id: 12,
    });
    expect(api.saveAgentStudioAgent.mock.calls[0][0].agent.llm_api_key).toBeUndefined();
  });

  it('chooses a complete subscription runtime without a second model override', async () => {
    renderPage({
      ...catalog,
      agents: [{ ...catalog.agents[0], runtime_profile_id: 9 }],
      runtimeProfiles: codexRuntimeProfiles,
    });
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    const execution = screen.getByLabelText('Execution setup');
    expect(execution).toHaveValue('runtime:9');
    expect(screen.getByText('gpt-5.3-codex-spark · xhigh · ChatGPT subscription')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Credential profile/)).not.toBeInTheDocument();

    fireEvent.change(execution, { target: { value: 'runtime:10' } });
    expect(screen.getByText('gpt-5.6-terra · xhigh · ChatGPT subscription')).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Save agent' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.saveAgentStudioAgent).toHaveBeenCalledTimes(1));
    expect(api.saveAgentStudioAgent.mock.calls[0][0].agent).toMatchObject({
      model: 'gpt-5.6-terra',
      runtime_profile_id: 10,
    });
  });

  it('defaults a new agent to the recommended Spark subscription runtime', async () => {
    renderPage({
      ...catalog,
      runtimeProfiles: codexRuntimeProfiles,
    });
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'New agent' }));

    expect(await screen.findByRole('heading', { name: 'Create agent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Execution setup')).toHaveValue('runtime:9');
    expect(screen.getByRole('option', { name: /Codex Fast.*recommended/ })).toBeInTheDocument();
    expect(screen.getByText('gpt-5.3-codex-spark · xhigh · ChatGPT subscription')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Credential profile/)).not.toBeInTheDocument();
  });

  it('reveals provider credentials only when switching to a direct API model', async () => {
    renderPage({
      ...catalog,
      agents: [{ ...catalog.agents[0], runtime_profile_id: 9 }],
      runtimeProfiles: codexRuntimeProfiles,
    });
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    fireEvent.change(screen.getByLabelText('Execution setup'), { target: { value: 'model:gpt-5.1' } });
    expect(screen.getByLabelText(/Credential profile/)).toBeInTheDocument();
    expect(screen.getByText('gpt-5.1', { selector: 'b' })).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Save agent' });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);

    await waitFor(() => expect(api.saveAgentStudioAgent).toHaveBeenCalledTimes(1));
    expect(api.saveAgentStudioAgent.mock.calls[0][0].agent.runtime_profile_id).toBeNull();
  });

  it('opens native session history instead of linking back to the legacy UI', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Platform Engineer' });
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByRole('heading', { name: /Sessions · Platform Engineer/ })).toBeInTheDocument();
    expect(await screen.findByText('No sessions yet')).toBeInTheDocument();
    expect(api.getAgentSessions).toHaveBeenCalledWith(7);
  });

  it('guides a clean workspace to model configuration before agent creation', async () => {
    renderPage({ ...catalog, agents: [], models: [] });

    expect(await screen.findByRole('heading', { name: 'Connect an AI model before building agents' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Configure AI models/ })).toHaveAttribute('href', '/settings/models');
    expect(screen.getByRole('button', { name: 'New agent' })).toBeDisabled();
    expect(screen.getByText('No agents installed')).toBeInTheDocument();
  });

  it('installs a provider-neutral starter with the explicitly selected catalog model', async () => {
    const template = {
      id: 11,
      name: 'reviewer',
      label: 'Reviewer',
      description: 'Reviews implementation output.',
      category: 'ai-development',
      agentMode: 'reviewer' as const,
      config: { temperature: 0.2, maxTokens: 4096 },
      compositeName: null,
      skillNames: ['review'],
      recommendedCapabilities: ['tool-calling'],
      requiredBy: ['LangGraph AI development workflow'],
      requiredToolPatterns: ['*_pull_request_read'],
      minimumBundleCount: 1,
      compatibleBundleIds: [3],
      version: 1,
      installed: false,
      installedAgentId: null,
      installedVersion: null,
      upgradeAvailable: false,
      createdAt: '2026-08-01T10:00:00.000Z',
      updatedAt: '2026-08-01T10:00:00.000Z',
    };
    const installed = { ...catalog.agents[0], name: 'reviewer', label: 'Reviewer', model: 'claude-opus-4-6' };
    renderPage({
      ...catalog,
      agents: [],
      templates: [template],
      models: [
        { model_name: 'gpt-5.1', provider: 'openai', enabled: true, supports_vision: false },
        { model_name: 'claude-opus-4-6', provider: 'anthropic', enabled: true, supports_vision: false },
      ],
      runtimeProfiles: [{
        id: 9, name: 'codex-terra', label: 'Codex Terra', description: '', runtime_type: 'codex',
        auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.6-terra', reasoning_effort: 'xhigh',
        code_context_mode: 'metadata_only', code_context_max_results: 8, code_context_max_bytes: 64_000,
        enabled: true, max_concurrent_runs: 2, allowed_task_types: [], assigned_agent_count: 0,
        created_at: '2026-08-01T10:00:00.000Z', updated_at: '2026-08-01T10:00:00.000Z',
      }],
    });
    api.installAgentTemplate.mockResolvedValue(installed);

    expect(await screen.findByRole('heading', { name: 'Reviewer' })).toBeInTheDocument();
    expect(screen.getByText('*_pull_request_read')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install preset' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Model for Reviewer'), { target: { value: 'claude-opus-4-6' } });
    fireEvent.change(screen.getByLabelText('Runtime for Reviewer'), { target: { value: '9' } });
    fireEvent.change(screen.getByLabelText('Bundle for Reviewer'), { target: { value: '3' } });
    expect(screen.getByRole('button', { name: 'Install preset' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Run preflight' }));

    await waitFor(() => expect(api.previewAgentTemplate).toHaveBeenCalledWith('reviewer', {
      model: 'claude-opus-4-6', runtimeProfileId: 9, bundleIds: [3],
    }));
    expect(await screen.findByText('Ready to install')).toBeInTheDocument();
    expect(screen.getByText('4 effective tools')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Install preset' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Install preset' }));

    await waitFor(() => expect(api.installAgentTemplate).toHaveBeenCalledWith('reviewer', {
      model: 'claude-opus-4-6', runtimeProfileId: 9, bundleIds: [3],
    }));
    expect(await screen.findByText('Reviewer installed with claude-opus-4-6.')).toBeInTheDocument();
  });

  it('reviews and applies a conflict-free versioned preset upgrade', async () => {
    const template = {
      id: 12, name: 'platform-engineer', label: 'Platform Engineer', description: 'Builds safely.',
      category: 'platform', agentMode: 'worker' as const, config: { temperature: 0.2, maxTokens: 8192 },
      compositeName: 'engineering', skillNames: ['review'], recommendedCapabilities: ['tool-calling'],
      requiredBy: [], requiredToolPatterns: [], minimumBundleCount: 0, compatibleBundleIds: [],
      version: 2, installed: true, installedAgentId: 7, installedVersion: 1, upgradeAvailable: true,
      createdAt: '2026-08-01T10:00:00.000Z', updatedAt: '2026-08-18T10:00:00.000Z',
    };
    const upgradePreview = {
      templateName: 'platform-engineer', templateLabel: 'Platform Engineer', agentId: 7,
      installedVersion: 1, targetVersion: 2, upgradeAvailable: true, safeToApply: true,
      proposedChanges: [{
        field: 'maxTokens', baseline: 4096, current: 4096, target: 8192,
        templateChanged: true, locallyChanged: false, conflict: false,
      }],
      localChanges: [], conflicts: [],
    };
    api.getAgentTemplateUpgradePreview.mockResolvedValue(upgradePreview);
    api.applyAgentTemplateUpgrade.mockResolvedValue({ agent: catalog.agents[0], preview: upgradePreview });
    renderPage({ ...catalog, templates: [template] });

    expect(await screen.findByText('v1 → v2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review lifecycle' }));
    await waitFor(() => expect(api.getAgentTemplateUpgradePreview).toHaveBeenCalledWith('platform-engineer'));
    expect(await screen.findByText('1 proposed')).toBeInTheDocument();
    expect(screen.getByText('Target: 8192')).toBeInTheDocument();
    const applyButton = screen.getByRole('button', { name: 'Apply v2' });
    expect(applyButton).toBeEnabled();
    fireEvent.click(applyButton);

    await waitFor(() => expect(api.applyAgentTemplateUpgrade).toHaveBeenCalledWith('platform-engineer'));
    expect(await screen.findByText('Platform Engineer upgraded to preset v2.')).toBeInTheDocument();
  });

  it('authors, proves and publishes an isolated Agent preset draft', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: 'Author blueprint' }));
    expect(await screen.findByRole('heading', { name: 'Create governed preset' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish v1' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Preset display name'), { target: { value: 'Release Analyst' } });
    fireEvent.change(screen.getByLabelText('Preset system prompt'), { target: { value: 'Assess release evidence without performing writes.' } });
    fireEvent.click(screen.getByText('Code review'));
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(api.saveAgentTemplateDraft).toHaveBeenCalledWith(expect.objectContaining({
      name: 'custom_agent',
      label: 'Release Analyst',
      skillNames: ['review'],
    })));
    fireEvent.click(await screen.findByRole('button', { name: 'Run draft preflight' }));
    await waitFor(() => expect(api.previewAgentTemplateDraft).toHaveBeenCalledWith('custom_agent', {
      model: 'gpt-5.1', runtimeProfileId: null, bundleIds: [],
    }));
    expect(await screen.findByText('Execution proof passed')).toBeInTheDocument();

    const publishButton = screen.getByRole('button', { name: 'Publish v1' });
    expect(publishButton).toBeEnabled();
    fireEvent.click(publishButton);
    await waitFor(() => expect(api.publishAgentTemplateDraft).toHaveBeenCalledWith('custom_agent'));
  });

  it('keeps the canonical Blueprints page free of the installed agent inventory', async () => {
    renderPage(catalog, '/build/agents/manage');

    expect(await screen.findByRole('heading', { name: 'Blueprints' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Managed agents' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New agent' })).not.toBeInTheDocument();
  });
});
