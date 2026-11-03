import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesRuntimePanel } from './HermesRuntimePanel';

const api = vi.hoisted(() => ({
  cancelHermesManagedRun: vi.fn(),
  createHermesDevConnection: vi.fn(),
  decideHermesManagedMemoryProposal: vi.fn(),
  getHermesDevConnections: vi.fn(),
  getHermesManagedMemoryProposals: vi.fn(),
  getHermesManagedRun: vi.fn(),
  getHermesManagedRunEvents: vi.fn(),
  getHermesManagedRuns: vi.fn(),
  getHermesManagedRuntime: vi.fn(),
  preflightHermesManagedRuntime: vi.fn(),
  revokeHermesDevConnection: vi.fn(),
  rotateHermesDevConnection: vi.fn(),
  startHermesManagedRun: vi.fn(),
  testHermesDevConnection: vi.fn(),
}));

vi.mock('../api', () => api);

const run = {
  run: {
    id: '950610b9-97b4-41cb-908f-46cc80bd22a2', mode: 'managed' as const,
    rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', state: 'running' as const,
    acceptedAt: '2026-08-30T14:00:00.000Z', updatedAt: '2026-08-30T14:00:02.000Z',
  },
  lease: {
    leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1', packId: 'argus.hermes', adapterId: 'hermes-http',
    coreAgentId: 42, runId: '950610b9-97b4-41cb-908f-46cc80bd22a2', requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
    rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b', mode: 'managed' as const, status: 'active' as const,
    issuedAt: '2026-08-30T14:00:00.000Z', activatedAt: '2026-08-30T14:00:00.000Z', expiresAt: '2026-08-30T14:15:00.000Z',
    revokedAt: null, terminalAt: null,
  },
};

function renderPanel(memoryProposals: Array<Record<string, unknown>> = []) {
  api.getHermesManagedRuntime.mockResolvedValue({
    identity: { id: 7, displayName: 'Hermes Developer', role: 'developer', authentication: 'sso' },
    pack: { connected: true, version: '0.1.0' },
    adapter: { id: 'hermes-http', state: 'ready', modes: [{ mode: 'managed', state: 'ready', detail: 'Isolated runner ready' }], capabilities: ['runs', 'mcp-fabric'] },
    managed: { ready: true, detail: 'Isolated runner ready', approvedBundleIds: [3], agents: [{ id: 42, name: 'researcher', label: 'Researcher' }] },
    limits: { deadlineSeconds: { default: 600, min: 30, max: 900 }, maxToolCalls: { default: 64, min: 1, max: 1_000 } },
  });
  api.getHermesDevConnections.mockResolvedValue({
    identity: { id: 7, username: 'entra:developer-7', displayName: 'Hermes Developer', role: 'developer', authentication: 'sso' },
    connections: [], bundles: [{ id: 3, name: 'code-intelligence', label: 'Code Intelligence', toolCount: 2 }],
  });
  api.getHermesManagedRuns.mockResolvedValue({ runs: [] });
  api.getHermesManagedMemoryProposals.mockResolvedValue({ proposals: memoryProposals });
  api.preflightHermesManagedRuntime.mockResolvedValue({ ready: true, errors: [] });
  api.startHermesManagedRun.mockResolvedValue(run);
  api.getHermesManagedRun.mockResolvedValue(run);
  api.getHermesManagedRunEvents.mockResolvedValue({
    run: run.run,
    events: [{ apiVersion: 'argus-runtime-v1alpha1', eventId: 'event-1', sequence: 1, occurredAt: '2026-08-30T14:00:02.000Z', run: { id: run.run.id, rootTraceId: run.run.rootTraceId, state: 'running' }, type: 'run.started' }],
  });
  api.cancelHermesManagedRun.mockResolvedValue({ ...run, run: { ...run.run, state: 'cancelling' }, lease: { ...run.lease, status: 'revoking' } });
  api.decideHermesManagedMemoryProposal.mockResolvedValue({ id: '31', status: 'accepted' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HermesRuntimePanel /></QueryClientProvider>);
}

describe('HermesRuntimePanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('preflights and starts an SSO-owned Managed Hermes run with live trace controls', async () => {
    renderPanel();
    expect(await screen.findByText('Managed Hermes ready')).toBeInTheDocument();
    expect(screen.getByText('SSO · Hermes Developer')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Managed Hermes Core Agent')).toHaveValue('researcher'));
    await waitFor(() => expect(screen.getByText('Code Intelligence').closest('label')?.querySelector('input')).toBeChecked());

    fireEvent.click(screen.getByRole('button', { name: 'Run preflight' }));
    await waitFor(() => expect(api.preflightHermesManagedRuntime).toHaveBeenCalledWith({ coreAgentName: 'researcher', bundleIds: [3] }));
    const start = screen.getByRole('button', { name: 'Start Managed Hermes' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(api.startHermesManagedRun).toHaveBeenCalledWith(expect.objectContaining({
      coreAgentName: 'researcher', bundleIds: [3], input: expect.objectContaining({ text: expect.stringContaining('Inspect') }),
    })));
    expect(await screen.findByText(`TRACE ${run.run.rootTraceId}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open logs/ })).toHaveAttribute('href', `/observe/logs?root_trace=${run.run.rootTraceId}`);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(api.cancelHermesManagedRun).toHaveBeenCalledWith(run.run.id));
  });

  it('keeps existing-Hermes onboarding one click away without duplicating product navigation', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('tab', { name: 'Existing Hermes' }));
    expect(await screen.findByRole('heading', { name: 'Use your personal Hermes with Argus Dev' })).toBeInTheDocument();
  });

  it('keeps Hermes memory inactive until the SSO owner accepts the proposal', async () => {
    renderPanel([{
      id: '31', kind: 'semantic', content: 'The repository uses pnpm.', importance: 0.8,
      validDays: 90, status: 'pending', workspaceLabel: 'ARGUS-42',
      sourceTraceId: run.run.rootTraceId, sourceRuntimeRunId: run.run.id,
      proposalCount: 1, createdAt: '2026-08-30T14:00:02.000Z', reviewedAt: null,
    }]);

    expect(await screen.findByText('The repository uses pnpm.')).toBeInTheDocument();
    expect(screen.getByText(/only your explicit decision/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept memory proposal 31' }));
    await waitFor(() => expect(api.decideHermesManagedMemoryProposal).toHaveBeenCalledWith('31', 'accepted'));
  });
});
