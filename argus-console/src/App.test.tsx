import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse } from './types';
import App from './App';

const api = vi.hoisted(() => ({
  getConsoleUser: vi.fn(),
  getOverview: vi.fn(),
  getConsoleNavigationCapabilities: vi.fn(),
}));
vi.mock('./api', () => api);
vi.mock('./pages/HomePage', () => ({ HomePage: () => <h1>Lazy command center</h1> }));
vi.mock('./pages/ServiceHealthPage', () => ({ ServiceHealthPage: () => <h1>Lazy service health</h1> }));

const overview: OverviewResponse = {
  generatedAt: '2026-08-02T10:00:00.000Z',
  user: { id: 1, username: 'admin', displayName: 'Argus Admin', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};

function renderApp(path: string) {
  api.getConsoleUser.mockResolvedValue(overview.user);
  api.getConsoleNavigationCapabilities.mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '2026-09-13T10:00:00.000Z',
    actor: { id: overview.user.id, role: overview.user.role },
    permissions: ['observability.read', 'workspace.search'],
    modules: [
      { id: 'argus.core', installed: true, entitled: true, available: true, reason: 'available' },
    ],
    navigation: {
      canUseArgusDev: false,
      canBuildWorkflows: false,
      canManageAgents: false,
      canManageIntegrations: false,
      canManageKnowledge: false,
      canRunEvaluations: false,
      canReviewApprovals: false,
      canObservePlatform: true,
      canReadAuditEvidence: false,
      canManageRuntimePolicy: false,
      canUseCompliance: false,
      canManagePublicChannels: false,
      canSearchWorkspaceResources: true,
      canAdminPlatform: false,
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}><App /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('App lazy routes', () => {
  afterEach(() => vi.clearAllMocks());

  it('loads a nested operational deep link without leaving the Console shell', async () => {
    renderApp('/observe/health');
    expect(await screen.findByRole('heading', { name: 'Lazy service health' })).toBeInTheDocument();
    expect(screen.getByLabelText('Observe, Service health')).toBeInTheDocument();
  });

  it('keeps the existing unknown-route redirect after code splitting', async () => {
    renderApp('/not-a-console-route');
    expect(await screen.findByRole('heading', { name: 'Lazy command center' })).toBeInTheDocument();
  });
});
