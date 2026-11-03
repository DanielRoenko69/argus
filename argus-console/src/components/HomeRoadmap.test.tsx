import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingCatalog } from '../types';
import { HomeRoadmap } from './HomeRoadmap';

const api = vi.hoisted(() => ({
  createOnboardingAgent: vi.fn(),
  createOnboardingModel: vi.fn(),
  createOnboardingProvider: vi.fn(),
  getOnboardingCatalog: vi.fn(),
  installOnboardingStarterAgent: vi.fn(),
  testOnboardingProvider: vi.fn(),
}));

vi.mock('../api', () => api);

const catalog: OnboardingCatalog = {
  generatedAt: '2026-08-23T10:00:00.000Z',
  providers: [{
    id: 4, name: 'openai', label: 'OpenAI', providerType: 'openai',
    baseUrl: 'https://api.openai.com/v1', authType: 'bearer', enabled: true,
    credentialConfigured: true, lastTestStatus: 'healthy', modelCount: 1, canTest: true,
  }],
  models: [{
    id: 8, modelName: 'gpt-4o-mini', displayName: 'GPT-4o mini', providerId: 4,
    providerLabel: 'OpenAI', providerType: 'openai', enabled: true, providerEnabled: true,
    supportsVision: true, supportsTools: true, supportsReasoning: false,
  }],
  agents: [{
    id: 12, name: 'support', label: 'Support Agent', description: 'Hilft im Support', model: 'gpt-4o-mini',
  }],
  starterAgents: [{
    id: 21, name: 'support-starter', label: 'Support starter', description: 'A ready-to-use support agent',
    category: 'general', agentMode: 'chat', recommendedCapabilities: [], requiredToolPatterns: [],
    minimumBundleCount: 0, compatibleBundleIds: [], installed: true, installedAgentId: 12,
    installedAgents: [{ id: 12, name: 'support', label: 'Support Agent', description: 'Hilft im Support', model: 'gpt-4o-mini' }], version: 1,
  }],
  bundles: [],
};

function renderRoadmap(value: OnboardingCatalog = catalog, entry = '/home') {
  api.getOnboardingCatalog.mockResolvedValue(value);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={[entry]}><QueryClientProvider client={queryClient}><HomeRoadmap /></QueryClientProvider></MemoryRouter>);
}

async function openSetup() {
  fireEvent.click(await screen.findByRole('button', { name: 'Open setup' }));
  return screen.findByRole('dialog');
}

function QuickCreateTrigger() {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate('/home?quickCreate=model')}>Trigger model quick create</button>;
}

describe('HomeRoadmap', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses an installed starter variant and ends at the chat action', async () => {
    renderRoadmap();

    expect(await screen.findByRole('heading', { name: 'Build your agent' })).toBeInTheDocument();
    expect(api.getOnboardingCatalog).not.toHaveBeenCalled();
    expect(await openSetup()).toBeInTheDocument();
    expect(screen.getByText('4/4')).toBeInTheDocument();
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('4');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getAllByRole('combobox')[0]).toHaveValue('8');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: /Support starter/ })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Existing agent' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use starter' }));
    expect(screen.getByRole('link', { name: /Open agent chat/ })).toHaveAttribute('href', '/chat/12');
  });

  it('defers the catalog request until setup is opened', async () => {
    renderRoadmap();

    expect(api.getOnboardingCatalog).not.toHaveBeenCalled();
    await openSetup();
    expect(api.getOnboardingCatalog).toHaveBeenCalledTimes(1);
  });

  it('offers creation when the catalog is empty', async () => {
    api.createOnboardingProvider.mockResolvedValue({
      id: 20, name: 'my-provider', label: 'My Provider', providerType: 'openai',
      baseUrl: 'https://api.openai.com/v1', authType: 'bearer', enabled: true,
      credentialConfigured: false, lastTestStatus: null, modelCount: 0, canTest: true,
    });
    renderRoadmap({ generatedAt: '2026-08-23T10:00:00.000Z', providers: [], models: [], agents: [], starterAgents: [], bundles: [] });

    await openSetup();
    fireEvent.change(await screen.findByLabelText('Technical name'), { target: { value: 'my-provider' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'My Provider' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save provider and continue' }));

    await waitFor(() => expect(api.createOnboardingProvider.mock.calls[0]?.[0]).toMatchObject({
      name: 'my-provider', label: 'My Provider', providerType: 'openai',
    }));
  });

  it('offers chat starter agents after the model step', async () => {
    api.installOnboardingStarterAgent.mockResolvedValue({
      id: 30, name: 'github-reader', label: 'GitHub Reader', description: 'Read-only', model: 'gpt-4o-mini',
    });
    renderRoadmap({ ...catalog, starterAgents: [{
      id: 22, name: 'github-reader', label: 'GitHub Reader', description: 'Read-only repository analysis',
      category: 'source-control', agentMode: 'chat', recommendedCapabilities: ['github-read'],
      requiredToolPatterns: [], minimumBundleCount: 0, compatibleBundleIds: [], installed: false,
      installedAgentId: null, installedAgents: [], version: 1,
    }] });

    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Starter agent' }));
    expect(screen.getByRole('button', { name: /GitHub Reader/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /GitHub Reader/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Install starter' }));

    await waitFor(() => expect(api.installOnboardingStarterAgent.mock.calls[0]?.[0]).toBe('github-reader'));
  });

  it('opens the existing roadmap dialog for a normal-user quick model create', async () => {
    renderRoadmap(catalog, '/home?quickCreate=model');

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('New model for')).toBeInTheDocument();
    expect(screen.getByLabelText('Model alias')).toBeInTheDocument();
  });

  it('can reopen the same normal-user quick create flow after closing it', async () => {
    api.getOnboardingCatalog.mockResolvedValue(catalog);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<MemoryRouter initialEntries={['/home']}><QueryClientProvider client={queryClient}><HomeRoadmap /><QuickCreateTrigger /></QueryClientProvider></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Trigger model quick create' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close setup' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Trigger model quick create' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('creates a new starter variant when the selected model changes', async () => {
    api.installOnboardingStarterAgent.mockResolvedValue({
      id: 31, name: 'support-starter-qwen2-5', label: 'Support starter', description: 'A ready-to-use support agent', model: 'qwen2.5',
    });
    const secondModel = {
      id: 9, modelName: 'qwen2.5', displayName: 'Qwen 2.5', providerId: 4,
      providerLabel: 'OpenAI', providerType: 'openai' as const, enabled: true, providerEnabled: true,
      supportsVision: false, supportsTools: true, supportsReasoning: false,
    };
    renderRoadmap({ ...catalog, models: [...catalog.models, secondModel] });

    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText(/Installed with another model/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install starter' }));

    await waitFor(() => expect(api.installOnboardingStarterAgent).toHaveBeenCalledWith('support-starter', {
      model: 'qwen2.5', bundleIds: [],
    }));
  });

  it('offers upstream models discovered by the provider connection test', async () => {
    api.testOnboardingProvider.mockResolvedValue({ ok: true, latencyMs: 18, models: ['gpt-4o-mini', 'qwen2.5'] });
    api.createOnboardingModel.mockResolvedValue({
      id: 9, modelName: 'qwen2.5', displayName: 'qwen2.5', providerId: 4,
      providerLabel: 'OpenAI', providerType: 'openai', enabled: true, providerEnabled: true,
      supportsVision: false, supportsTools: true, supportsReasoning: false,
    });
    renderRoadmap();

    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Discover models' }));
    await waitFor(() => expect(api.testOnboardingProvider).toHaveBeenCalledWith(4, expect.anything()));

    expect(await screen.findByText('Discover upstream models')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /qwen2\.5/ }));
    expect(screen.getByLabelText('Upstream model name')).toHaveValue('qwen2.5');
    fireEvent.click(screen.getByRole('button', { name: 'Save model and continue' }));

    await waitFor(() => expect(api.createOnboardingModel.mock.calls[0]?.[0]).toMatchObject({
      providerId: 4, modelName: 'qwen2.5', upstreamModelName: 'qwen2.5',
    }));
  });

  it('keeps upstream discovery visible in the roadmap model step', async () => {
    api.testOnboardingProvider.mockResolvedValue({ ok: true, latencyMs: 12, models: [] });
    renderRoadmap();

    await openSetup();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(screen.getByRole('tab', { name: 'Discover models' })).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(screen.getByRole('tab', { name: 'Discover models' }));
    expect(await screen.findByText('Discover upstream models')).toBeInTheDocument();
    expect(await screen.findByText('No upstream models discovered yet. Switch to another tab and back to retry.')).toBeInTheDocument();
  });
});
