import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SolutionPacksResponse } from '../types';
import { HermesSolutionPackPage } from './HermesSolutionPackPage';
import { SolutionPackPage } from './SolutionPackPage';

const api = vi.hoisted(() => ({
  getAttachedHermesRun: vi.fn(),
  getSolutionPackRuntimeAdapterCapabilities: vi.fn(),
  getSolutionPackRuntimeAdapterStatus: vi.fn(),
  getSolutionPacks: vi.fn(),
  refreshSolutionPacks: vi.fn(),
  startAttachedHermesRun: vi.fn(),
  stopAttachedHermesRun: vi.fn(),
}));

vi.mock('../api', () => api);

const catalog: SolutionPacksResponse = {
  total: 1,
  packs: [{
    configuredId: 'argus.hermes',
    endpoint: 'http://argus-hermes:2040',
    state: 'ready',
    checkedAt: '2026-08-30T10:00:00.000Z',
    health: { ok: true, status: 200, latencyMs: 5 },
    readiness: { ok: true, status: 200, latencyMs: 9 },
    manifest: {
      apiVersion: 'argus.eu/v1alpha1',
      kind: 'SolutionPack',
      metadata: {
        id: 'argus.hermes',
        version: '0.1.0',
        displayName: 'Argus Hermes',
        description: 'Hermes runtime bridge for attached services.',
      },
      spec: {
        delivery: { type: 'container', protocol: 'argus-pack-v1alpha1', healthPath: '/healthz', readinessPath: '/readyz' },
        requires: { core: '>=1.0.0', capabilities: ['runtime.execute'], credentials: [] },
        components: {
          agents: [],
          runtimeAdapters: [{
            id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime/v1',
            modes: ['attached', 'managed'], capabilities: ['approval', 'cancel', 'events-sse', 'health', 'mcp-fabric', 'runs'],
          }],
          skills: [], bundles: [], workflows: [], knowledgeSources: [], dashboards: [], policies: ['managed-runtime-isolation'],
        },
        readiness: { smokeTests: ['runtime-capability-handshake'] },
      },
    },
  }],
};

function renderPage(data: SolutionPacksResponse = catalog) {
  api.getSolutionPacks.mockResolvedValue(data);
  api.refreshSolutionPacks.mockResolvedValue(data);
  api.getSolutionPackRuntimeAdapterCapabilities.mockResolvedValue({
    adapter: data.packs[0]?.manifest?.spec.components.runtimeAdapters?.[0],
    capabilities: {
      adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
      modes: ['attached', 'managed'],
      capabilities: ['approval', 'cancel', 'events-sse', 'health', 'mcp-fabric', 'runs'],
    },
  });
  api.getSolutionPackRuntimeAdapterStatus.mockResolvedValue({
    adapter: data.packs[0]?.manifest?.spec.components.runtimeAdapters?.[0],
    status: {
      adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' },
      state: 'ready', checkedAt: '2026-08-30T10:01:00.000Z',
      modes: [
        { mode: 'attached', state: 'ready', detail: 'Attached Hermes service reached through the Pack bridge.' },
        { mode: 'managed', state: 'degraded', detail: 'No managed runner profile has been installed.' },
      ],
    },
  });
  api.startAttachedHermesRun.mockResolvedValue({
    apiVersion: 'argus-runtime-v1alpha1', trust: 'external_attested',
    governance: { coreMcpLease: false, nativeToolsExternallyGoverned: true },
    run: { id: 'run_smoke-1', mode: 'attached', state: 'running', updatedAt: '2026-08-31T12:00:00.000Z' },
  });
  api.getAttachedHermesRun.mockResolvedValue({
    apiVersion: 'argus-runtime-v1alpha1', trust: 'external_attested',
    governance: { coreMcpLease: false, nativeToolsExternallyGoverned: true },
    run: { id: 'run_smoke-1', mode: 'attached', state: 'completed', updatedAt: '2026-08-31T12:00:01.000Z', output: 'Smoke complete.' },
  });
  api.stopAttachedHermesRun.mockResolvedValue(undefined);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/solutions/argus.hermes']}>
      <QueryClientProvider client={queryClient}>
        <HermesSolutionPackPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('HermesSolutionPackPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders a discovered runtime declaration with independently checked mode readiness', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Argus Hermes', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'hermes-http' })).toBeInTheDocument();
    expect(screen.getByText('argus-runtime-v1alpha1')).toBeInTheDocument();
    expect(screen.getByText('http://argus-hermes:2040/runtime/v1')).toBeInTheDocument();
    expect(await screen.findByText('Verified capabilities')).toBeInTheDocument();
    expect(screen.getByText('events-sse')).toBeInTheDocument();
    expect(screen.getByText('Attached Hermes service reached through the Pack bridge.')).toBeInTheDocument();
    expect(screen.getByText('No managed runner profile has been installed.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect in Argus Dev/ })).toHaveAttribute('href', '/solutions/argus.dev#hermes-connector');
    expect(screen.getByText('Runtime Pack connected')).toBeInTheDocument();
    expect(screen.getByText('Read-only status')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start attached smoke test' })).toBeDisabled();

    await waitFor(() => expect(api.getSolutionPackRuntimeAdapterCapabilities).toHaveBeenCalledWith('argus.hermes', 'hermes-http'));
    expect(api.getSolutionPackRuntimeAdapterStatus).toHaveBeenCalledWith('argus.hermes', 'hermes-http');
  });

  it('fails closed to a pack setup state and does not probe an absent Hermes pack', async () => {
    renderPage({ total: 0, packs: [] });

    expect(await screen.findByText('Argus Hermes is not connected')).toBeInTheDocument();
    expect(screen.getByText(/Configure argus\.hermes through ARGUS_SOLUTION_PACK_ENDPOINTS/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Connect in Argus Dev/ })).toHaveAttribute('href', '/solutions/argus.dev#hermes-connector');
    expect(screen.getByText('Runtime Pack not connected')).toBeInTheDocument();
    expect(api.getSolutionPackRuntimeAdapterCapabilities).not.toHaveBeenCalled();
    expect(api.getSolutionPackRuntimeAdapterStatus).not.toHaveBeenCalled();
  });

  it('requires explicit external-trust acknowledgement before starting an attached smoke run', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Argus Hermes', level: 1 });
    const start = screen.getByRole('button', { name: 'Start attached smoke test' });
    expect(start).toBeDisabled();
    fireEvent.click(screen.getByText(/I understand that attached Hermes tools/));
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(api.startAttachedHermesRun).toHaveBeenCalledWith(
      'argus.hermes', 'hermes-http', expect.stringContaining('Do not call tools'),
    ));
    expect(await screen.findByText('run_smoke-1')).toBeInTheDocument();
    expect(screen.getByText('external attested')).toBeInTheDocument();
  });

  it('routes the Hermes pack to its status page instead of the Argus Dev control plane', async () => {
    api.getSolutionPacks.mockResolvedValue(catalog);
    api.getSolutionPackRuntimeAdapterCapabilities.mockResolvedValue({
      adapter: catalog.packs[0]?.manifest?.spec.components.runtimeAdapters?.[0],
      capabilities: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, modes: ['attached', 'managed'], capabilities: ['health'] },
    });
    api.getSolutionPackRuntimeAdapterStatus.mockResolvedValue({
      adapter: catalog.packs[0]?.manifest?.spec.components.runtimeAdapters?.[0],
      status: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, state: 'ready', modes: [] },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter initialEntries={['/solutions/argus.hermes']}>
        <QueryClientProvider client={queryClient}>
          <Routes><Route path="/solutions/:packId" element={<SolutionPackPage />} /></Routes>
        </QueryClientProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Argus Hermes', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New development run' })).not.toBeInTheDocument();
  });
});
