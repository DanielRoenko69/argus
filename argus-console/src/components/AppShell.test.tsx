import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse } from '../types';
import { AppShell } from './AppShell';

const api = vi.hoisted(() => ({
  getConsoleUser: vi.fn(),
  getOverview: vi.fn(),
  getConsoleNavigationCapabilities: vi.fn(),
  searchWorkspace: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  user: { id: 1, username: 'argus', displayName: 'Argus User', role: 'viewer' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};

function renderShell(role: string, path = '/home') {
  api.getConsoleUser.mockResolvedValue({ ...overview.user, role });
  api.getConsoleNavigationCapabilities.mockResolvedValue({
    schemaVersion: 1,
    generatedAt: '2026-09-13T10:00:00.000Z',
    actor: { id: 1, role },
    permissions: role === 'platform_admin'
      ? ['agents.read', 'workflows.read', 'integrations.read', 'runs.read_all', 'governance.read', 'observability.read', 'agents.run', 'aiops.service_profile.read', 'compliance.read', 'workspace.search']
      : ['agents.read', 'workflows.read', 'integrations.read', 'runs.read_own', 'governance.read', 'observability.read', 'workspace.search'],
    modules: [
      { id: 'argus.core', installed: true, entitled: true, available: true, reason: 'available' },
      { id: 'argus.dev', installed: true, entitled: true, available: true, reason: 'available' },
      { id: 'argus.aiops', installed: role === 'platform_admin', entitled: true, available: role === 'platform_admin', reason: role === 'platform_admin' ? 'available' : 'not_installed' },
      { id: 'argus.hermes', installed: false, entitled: true, available: false, reason: 'not_installed' },
      { id: 'public-channels', installed: true, entitled: true, available: true, reason: 'available' },
      { id: 'compliance', installed: role === 'platform_admin', entitled: true, available: role === 'platform_admin', reason: role === 'platform_admin' ? 'available' : 'not_installed' },
    ],
    navigation: {
      canUseArgusDev: role === 'platform_admin', canBuildWorkflows: role === 'platform_admin',
      canManageAgents: role === 'platform_admin', canManageIntegrations: role === 'platform_admin',
      canManageKnowledge: role === 'platform_admin', canRunEvaluations: role === 'platform_admin',
      canReviewApprovals: role === 'platform_admin', canObservePlatform: true,
      canReadAuditEvidence: role === 'platform_admin', canManageRuntimePolicy: role === 'platform_admin',
      canUseCompliance: role === 'platform_admin', canManagePublicChannels: role === 'platform_admin',
      canSearchWorkspaceResources: true, canAdminPlatform: role === 'platform_admin',
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <AppShell><div>Console content</div></AppShell>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('AppShell route visibility', () => {
  afterEach(() => vi.clearAllMocks());

  it('does not advertise platform-admin routes to a viewer', async () => {
    renderShell('viewer');
    expect(await screen.findByText('Argus User')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open agent chat' })).toHaveAttribute('href', '/chat');
    expect(screen.queryByRole('link', { name: 'Argus AIOps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Compliance' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'MCP Fabric' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Runs & Approvals' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Observe' })).toBeInTheDocument();
  });

  it('exposes platform administration routes to a platform admin', async () => {
    renderShell('platform_admin');
    expect(await screen.findByRole('link', { name: 'Compliance' })).toHaveAttribute('href', '/solutions/compliance');
    expect(screen.getByRole('link', { name: 'Agent Studio' })).toHaveAttribute('href', '/build/agents');
    expect(screen.getByRole('link', { name: 'Workflows' })).toHaveAttribute('href', '/build/workflows');
    expect(screen.getByRole('link', { name: 'Argus AIOps' })).toHaveAttribute('href', '/solutions/argus.aiops');
    expect(screen.queryByRole('link', { name: 'Argus Hermes' })).not.toBeInTheDocument();
  });

  it('opens the global quick create dialog from the plus button', async () => {
    renderShell('viewer');
    expect(await screen.findByText('Argus User')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open quick create' }));

    expect(screen.getByRole('dialog', { name: 'Create a resource' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create bundle (Admin access required)' })).toBeDisabled();
  });

  it('renders the role-aware shell without starting the heavy Overview request', async () => {
    renderShell('platform_admin');

    expect(await screen.findByRole('link', { name: 'Argus AIOps' })).toBeInTheDocument();
    expect(api.getOverview).not.toHaveBeenCalled();
  });

  it('links a nested page breadcrumb back to its workspace', async () => {
    renderShell('platform_admin', '/build/workflows/studio/161');

    const breadcrumb = await screen.findByLabelText('Workflows, Workflow Studio');
    expect(within(breadcrumb).getByRole('link', { name: 'Workflows' })).toHaveAttribute('href', '/build/workflows');
    expect(within(breadcrumb).getByText('Workflow Studio')).toBeInTheDocument();
  });
});
