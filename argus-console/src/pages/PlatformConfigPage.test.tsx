import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformConfigResponse } from '../types';
import { PlatformConfigPage } from './PlatformConfigPage';

const api = vi.hoisted(() => ({
  getPlatformConfig: vi.fn(),
  saveHydeConfig: vi.fn(),
  saveK8sImpersonationConfig: vi.fn(),
  saveOtelConfig: vi.fn(),
  saveUpstreamTokenExchangeConfig: vi.fn(),
  saveVaultConfig: vi.fn(),
  testVaultConfig: vi.fn(),
}));

vi.mock('../api', () => api);

const config: PlatformConfigResponse = {
  vault: {
    type: 'hashicorp',
    hashicorpUrl: 'https://vault.argus.local',
    hashicorpMount: 'secret',
    mappings: { OPENAI_API_KEY: 'argus/prod/openai' },
    azureClientSecretConfigured: false,
    hashicorpTokenConfigured: true,
  },
  otel: {
    endpoint: 'http://otel-collector:4318',
    sampling: 0.25,
    serviceName: 'argus-mcp-server',
    headers: { 'x-tenant': 'platform' },
  },
  hyde: { model: 'gpt-4o-mini', maxTokens: 200, prompt: 'Question: {query}\nAnswer:' },
  k8s_impersonation: { enabled: false, userSource: 'username', groupMap: {} },
  upstream_token_exchange: { enabled: false },
};

function renderPage(entry = '/settings/platform') {
  api.getPlatformConfig.mockResolvedValue(config);
  api.saveVaultConfig.mockResolvedValue({ ok: true });
  api.testVaultConfig.mockResolvedValue({ ok: true, latencyMs: 18 });
  api.saveOtelConfig.mockResolvedValue({ ok: true });
  api.saveHydeConfig.mockResolvedValue({ ok: true });
  api.saveK8sImpersonationConfig.mockResolvedValue({ ok: true });
  api.saveUpstreamTokenExchangeConfig.mockResolvedValue({ ok: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter initialEntries={[entry]}><QueryClientProvider client={queryClient}><PlatformConfigPage /></QueryClientProvider></MemoryRouter>);
}

describe('PlatformConfigPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('keeps stored Vault credentials opaque while preserving them on save and supports a connection test', async () => {
    renderPage();
    const token = await screen.findByLabelText(/Token configured/);
    expect(token).toHaveValue('');
    expect(screen.queryByText('root-secret')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Save secret provider/ }));

    await waitFor(() => expect(api.saveVaultConfig).toHaveBeenCalledTimes(1));
    const payload = api.saveVaultConfig.mock.calls[0][0];
    expect(payload).toEqual(expect.objectContaining({
      type: 'hashicorp',
      hashicorpUrl: 'https://vault.argus.local',
      mappings: { OPENAI_API_KEY: 'argus/prod/openai' },
    }));
    expect(payload.hashicorpToken).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /Test saved configuration/ }));
    await waitFor(() => expect(api.testVaultConfig).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Vault connection succeeded in 18 ms.')).toBeInTheDocument();
  });

  it('validates structured OTLP headers before saving tracing configuration', async () => {
    renderPage('/settings/platform?tab=otel');
    const headers = await screen.findByLabelText('OTLP headers');
    fireEvent.change(headers, { target: { value: '{broken' } });
    fireEvent.click(screen.getByRole('button', { name: /Save tracing configuration/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON');
    expect(api.saveOtelConfig).not.toHaveBeenCalled();

    fireEvent.change(headers, { target: { value: '{"authorization":"opaque"}' } });
    fireEvent.click(screen.getByRole('button', { name: /Save tracing configuration/ }));
    await waitFor(() => expect(api.saveOtelConfig).toHaveBeenCalledWith(expect.objectContaining({
      sampling: 0.25,
      headers: { authorization: 'opaque' },
    })));
  });

  it('navigates all five governed sections and enables delegated identity explicitly', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Secret provider' });
    expect(screen.getByRole('button', { name: /OpenTelemetry/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /RAG HyDE/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kubernetes identity/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Token exchange/ }));
    const toggle = await screen.findByRole('checkbox', { name: /Enable delegated upstream identity/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /Save token exchange/ }));
    await waitFor(() => expect(api.saveUpstreamTokenExchangeConfig).toHaveBeenCalledWith({ enabled: true }));
  });
});
