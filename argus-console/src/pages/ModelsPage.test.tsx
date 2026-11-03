import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntimeProfile, LlmCatalog } from '../types';
import { ModelsPage } from './ModelsPage';

const api = vi.hoisted(() => ({
  cancelRuntimeAuthSession: vi.fn(),
  deleteAgentRuntimeProfile: vi.fn(),
  deleteLlmCredentialProfile: vi.fn(),
  deleteLlmModel: vi.fn(),
  deleteLlmProvider: vi.fn(),
  getAgentRuntimeProfiles: vi.fn(),
  getClaudeRuntimeStatus: vi.fn(),
  getCodexRuntimeStatus: vi.fn(),
  getLlmCatalog: vi.fn(),
  getRuntimeAuthSession: vi.fn(),
  saveLlmCredentialProfile: vi.fn(),
  saveAgentRuntimeProfile: vi.fn(),
  saveLlmModel: vi.fn(),
  saveLlmProvider: vi.fn(),
  startRuntimeAuthSession: vi.fn(),
  submitRuntimeAuthCode: vi.fn(),
  testLlmProvider: vi.fn(),
  updateAgentRuntimeCodeContextPolicy: vi.fn(),
}));

vi.mock('../api', () => api);

const catalog: LlmCatalog = {
  summary: { enabledProviders: 1, enabledModels: 1, healthyProviders: 0, configuredCredentials: 1 },
  providers: [{
    id: 4, name: 'litellm-local', label: 'LiteLLM Local', providerType: 'openai-compatible',
    baseUrl: 'http://litellm:4000/v1', authType: 'bearer', secretName: 'LITELLM_API_KEY',
    enabled: true, credentialConfigured: true, inlineCredentialConfigured: false,
    credentialProfileId: null, credentialProfileLabel: null,
    lastTestStatus: null, lastTestedAt: null, lastTestError: null, modelCount: 1,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }],
  models: [{
    id: 7, modelName: 'argus-coder', displayName: 'Argus Coder', providerId: 4,
    upstreamModelName: 'openai/gpt-5.1', enabled: true, supportsVision: false,
    supportsTools: true, supportsReasoning: true, maxInputTokens: 128000,
    maxOutputTokens: 16384, inputCostPer1k: null, outputCostPer1k: null,
    providerLabel: 'LiteLLM Local', providerType: 'openai-compatible', providerEnabled: true,
    assignedAgents: 2, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }],
  credentialProfiles: [],
};

function renderPage(runtimeProfiles: AgentRuntimeProfile[] = []) {
  api.getLlmCatalog.mockResolvedValue(catalog);
  api.getAgentRuntimeProfiles.mockResolvedValue(runtimeProfiles);
  api.getCodexRuntimeStatus.mockResolvedValue({ enabled: true, authenticated: false, authMethod: 'none', activeRuns: 0, maxConcurrentRuns: 2, runs: [] });
  api.getClaudeRuntimeStatus.mockResolvedValue({ enabled: true, authenticated: false, authMethod: 'none', activeRuns: 0, maxConcurrentRuns: 2, runs: [] });
  api.cancelRuntimeAuthSession.mockImplementation(async (_provider: string, _sessionId: string) => ({
    id: _sessionId, provider: _provider, state: 'canceled', verificationUri: null, userCode: null,
    requiresCodeSubmission: false, message: 'Canceled.', startedAt: '2026-09-02T10:00:00.000Z',
    updatedAt: '2026-09-02T10:00:01.000Z', expiresAt: '2026-09-02T10:16:00.000Z',
  }));
  api.testLlmProvider.mockResolvedValue({ ok: true, latencyMs: 18, models: ['qwen2.5-coder:32b'] });
  api.saveLlmModel.mockImplementation(async (input: Record<string, unknown>) => ({ ...catalog.models[0], ...input, id: 8, assignedAgents: 0 }));
  api.saveLlmCredentialProfile.mockImplementation(async (input: Record<string, unknown>) => ({
    ...input, id: 9, credentialConfigured: true, inlineCredentialConfigured: true,
    assignedAgents: 0, assignedProviders: 0, currentMonthSpendUsd: 0,
    budgetUsedPercent: 0, expired: false, lastRotatedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }));
  api.updateAgentRuntimeCodeContextPolicy.mockImplementation(async (_id: number, input: Record<string, unknown>) => ({
    ...runtimeProfiles[0],
    code_context_mode: input['mode'],
    code_context_max_results: input['maxResults'],
    code_context_max_bytes: input['maxBytes'],
  }));
  api.saveAgentRuntimeProfile.mockImplementation(async (input: Record<string, unknown>) => ({
    id: 44, name: input['name'], label: input['label'], description: input['description'],
    runtime_type: input['runtimeType'], auth_mode: input['runtimeType'] === 'codex' ? 'chatgpt' : input['runtimeType'] === 'claude-code' ? 'claude_subscription' : 'none',
    auth_ref: input['runtimeType'] === 'codex' ? 'codex-auth' : input['runtimeType'] === 'claude-code' ? 'claude-auth' : null,
    model: input['model'], reasoning_effort: input['reasoningEffort'], enabled: input['enabled'],
    max_concurrent_runs: input['maxConcurrentRuns'], allowed_task_types: input['allowedTaskTypes'],
    code_context_mode: input['codeContextMode'], code_context_max_results: input['codeContextMaxResults'],
    code_context_max_bytes: input['codeContextMaxBytes'], assigned_agent_count: 0, managed: false,
    created_at: '2026-09-13T00:00:00.000Z', updated_at: '2026-09-13T00:00:00.000Z',
  }));
  api.deleteAgentRuntimeProfile.mockResolvedValue({ deleted: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={['/settings/models']}><QueryClientProvider client={queryClient}><ModelsPage /></QueryClientProvider></MemoryRouter>);
}

describe('ModelsPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders the provider-neutral route and keeps credentials opaque', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Models & execution runtimes' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'LiteLLM Local' })).toBeInTheDocument();
    expect(screen.getByText('Argus Coder')).toBeInTheDocument();
    expect(screen.getByText('LITELLM_API_KEY')).toBeInTheDocument();
    expect(screen.queryByText(/provider-secret/)).not.toBeInTheDocument();
    expect(screen.getByRole('button',{ name:'Delete argus-coder' })).toBeDisabled();
  });

  it('allows removing an API alias with no effective API assignments after confirmation',async () => {
    api.getLlmCatalog.mockResolvedValueOnce({ ...catalog,models:[{ ...catalog.models[0],assignedAgents:0 }] });
    api.deleteLlmModel.mockResolvedValue({ deleted:true });
    const confirm=vi.spyOn(window,'confirm').mockReturnValue(true);
    try {
      renderPage();
      const remove=await screen.findByRole('button',{ name:'Delete argus-coder' });
      expect(remove).not.toBeDisabled();
      fireEvent.click(remove);
      await waitFor(() => expect(api.deleteLlmModel).toHaveBeenCalledWith(7,expect.anything()));
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(api.deleteAgentRuntimeProfile).not.toHaveBeenCalled();
      expect(api.deleteLlmProvider).not.toHaveBeenCalled();
    } finally { confirm.mockRestore(); }
  });

  it('creates a custom subscription runtime and keeps Hermes out of the model catalog', async () => {
    renderPage([{
      id: 30, name: 'hermes-managed-dev', label: 'Hermes Managed', description: 'Module runtime.',
      runtime_type: 'hermes', auth_mode: 'runtime_adapter', auth_ref: 'argus.hermes/hermes-http', model: null,
      reasoning_effort: null, code_context_mode: 'metadata_only', code_context_max_results: 4,
      code_context_max_bytes: 12000, enabled: true, max_concurrent_runs: 1,
      allowed_task_types: [], assigned_agent_count: 0, managed: true,
      created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    }]);

    expect(await screen.findByRole('heading', { name: 'Agent runtime profiles' })).toBeInTheDocument();
    expect(screen.queryByText('Hermes Managed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add runtime profile' }));
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Team Claude' } });
    fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'team-claude' } });
    fireEvent.change(screen.getByLabelText('Execution engine'), { target: { value: 'claude-code' } });
    fireEvent.change(screen.getByLabelText(/^Model/), { target: { value: 'claude-sonnet-4-5' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add runtime profile' }).at(-1)!);

    await waitFor(() => expect(api.saveAgentRuntimeProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'team-claude', runtimeType: 'claude-code', model: 'claude-sonnet-4-5',
      reasoningEffort: null,
    }), undefined));
  });

  it('shows the Core-owned Codex model and reasoning policy', async () => {
    renderPage([{
      id: 2,
      name: 'codex-subscription-local',
      label: 'Codex · ChatGPT Subscription',
      description: 'Governed by Argus Core.',
      runtime_type: 'codex',
      auth_mode: 'chatgpt',
      auth_ref: 'codex-auth',
      model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh',
      code_context_mode: 'metadata_only',
      code_context_max_results: 4,
      code_context_max_bytes: 12000,
      enabled: true,
      max_concurrent_runs: 1,
      allowed_task_types: ['implement_ticket'],
      assigned_agent_count: 5,
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z',
    }]);

    expect(await screen.findByText('gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.getByText('xhigh')).toBeInTheDocument();
    expect(screen.getByText('5 agents')).toBeInTheDocument();
    expect(screen.getAllByText('Metadata only')).toHaveLength(2);
  });

  it('requires an explicit save before an external runtime can receive bounded source', async () => {
    renderPage([{
      id: 2, name: 'codex-subscription-local', label: 'Codex runtime', description: 'Governed.',
      runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh', code_context_mode: 'metadata_only', code_context_max_results: 4,
      code_context_max_bytes: 12000, enabled: true, max_concurrent_runs: 1,
      allowed_task_types: ['implement_ticket'], assigned_agent_count: 1,
      created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    }]);

    const policy = await screen.findByLabelText('Code context policy for Codex runtime');
    fireEvent.change(policy, { target: { value: 'bounded_source' } });
    fireEvent.change(screen.getByLabelText('Max code references for Codex runtime'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Max code context bytes for Codex runtime'), { target: { value: '8192' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save code policy' }));

    await waitFor(() => expect(api.updateAgentRuntimeCodeContextPolicy).toHaveBeenCalledWith(2, {
      mode: 'bounded_source', maxResults: 3, maxBytes: 8192,
    }));
  });

  it('guides Codex subscription authentication without exposing a Docker command', async () => {
    renderPage([{
      id: 2, name: 'codex-subscription-local', label: 'Codex runtime', description: 'Governed.',
      runtime_type: 'codex', auth_mode: 'chatgpt', auth_ref: 'codex-auth', model: 'gpt-5.6-terra',
      reasoning_effort: 'xhigh', code_context_mode: 'metadata_only', code_context_max_results: 4,
      code_context_max_bytes: 12000, enabled: true, max_concurrent_runs: 1,
      allowed_task_types: ['implement_ticket'], assigned_agent_count: 1,
      created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    }]);
    api.startRuntimeAuthSession.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', provider: 'codex', state: 'waiting_for_user',
      verificationUri: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345',
      requiresCodeSubmission: false, message: 'Open the sign-in page.',
      startedAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:01.000Z',
      expiresAt: '2026-09-02T10:16:00.000Z',
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect runtime' }));
    expect(await screen.findByRole('heading', { name: 'Connect Codex runtime' })).toBeInTheDocument();
    expect(screen.queryByText(/docker (exec|compose|run)/i)).not.toBeInTheDocument();
    expect(await screen.findByText('Sign-in required')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));

    expect(await screen.findByText('ABCD-12345')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open sign-in page' })).toHaveAttribute('href', 'https://auth.openai.com/codex/device');
    expect(api.startRuntimeAuthSession).toHaveBeenCalledWith('codex', {});
  });

  it('passes a Claude browser-flow code directly to its waiting runtime session', async () => {
    renderPage([{
      id: 3, name: 'claude-subscription-local', label: 'Claude Code runtime', description: 'Governed.',
      runtime_type: 'claude-code', auth_mode: 'claude_subscription', auth_ref: 'claude-auth', model: 'claude-sonnet-4-5',
      reasoning_effort: null, code_context_mode: 'metadata_only', code_context_max_results: 4,
      code_context_max_bytes: 12000, enabled: true, max_concurrent_runs: 1,
      allowed_task_types: [], assigned_agent_count: 0,
      created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z',
    }]);
    const waiting = {
      id: '22222222-2222-4222-8222-222222222222', provider: 'claude-code' as const, state: 'waiting_for_user' as const,
      verificationUri: 'https://claude.com/cai/oauth/authorize?code=true', userCode: null,
      requiresCodeSubmission: true, message: 'Complete authentication.',
      startedAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:01.000Z',
      expiresAt: '2026-09-02T10:16:00.000Z',
    };
    api.startRuntimeAuthSession.mockResolvedValue(waiting);
    api.submitRuntimeAuthCode.mockResolvedValue({ ...waiting, state: 'code_submitted', message: 'Waiting for Claude Code.' });

    fireEvent.click(await screen.findByRole('button', { name: 'Connect runtime' }));
    expect(await screen.findByText('Sign-in required')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Start sign-in' }));
    fireEvent.change(await screen.findByLabelText('Claude authorization code'), { target: { value: 'temporary-oauth-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit code' }));

    await waitFor(() => expect(api.submitRuntimeAuthCode).toHaveBeenCalledWith('claude-code', waiting.id, 'temporary-oauth-code'));
    expect(screen.queryByDisplayValue('temporary-oauth-code')).not.toBeInTheDocument();
  });

  it('discovers an upstream model and registers it as an Argus alias', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'LiteLLM Local' });
    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('Connected in 18 ms')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /qwen2.5-coder:32b/ }));
    expect(await screen.findByRole('heading', { name: 'Register model' })).toBeInTheDocument();
    expect(screen.getByLabelText(/Upstream model name/)).toHaveValue('qwen2.5-coder:32b');
    fireEvent.click(screen.getAllByRole('button', { name: 'Register model' }).at(-1)!);
    await waitFor(() => expect(api.saveLlmModel).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'qwen2.5-coder:32b',
      upstreamModelName: 'qwen2.5-coder:32b',
      providerId: 4,
    }), undefined));
  });

  it('creates a reusable credential profile without exposing its secret', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Credential profiles' });
    fireEvent.click(screen.getByRole('button', { name: 'Add credential profile' }));
    expect(await screen.findByRole('heading', { name: 'Add credential profile' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: 'Platform Engineering' } });
    fireEvent.change(screen.getByLabelText(/Technical name/), { target: { value: 'platform-openai' } });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Platform' } });
    fireEvent.change(screen.getByLabelText('Cost center'), { target: { value: 'CC-42' } });
    fireEvent.change(screen.getByLabelText(/Inline API key/), { target: { value: 'secret-never-returned' } });
    fireEvent.change(screen.getByLabelText(/Monthly budget/), { target: { value: '250' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add credential profile' }).at(-1)!);

    await waitFor(() => expect(api.saveLlmCredentialProfile).toHaveBeenCalledWith(expect.objectContaining({
      name: 'platform-openai', department: 'Platform', costCenter: 'CC-42',
      monthlyBudgetUsd: 250, budgetMode: 'alert', apiKey: 'secret-never-returned',
    }), undefined));
    expect(screen.queryByText('secret-never-returned')).not.toBeInTheDocument();
  });
});
