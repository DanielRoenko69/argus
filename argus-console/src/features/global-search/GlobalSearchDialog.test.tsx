import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleNavigationCapabilityResponse } from '../../types';
import { GlobalSearchDialog } from './GlobalSearchDialog';

const api = vi.hoisted(() => ({ searchWorkspace: vi.fn() }));
vi.mock('../../api', () => api);

const capabilities: ConsoleNavigationCapabilityResponse = {
  schemaVersion: 1,
  generatedAt: '2026-09-13T10:00:00.000Z',
  actor: { id: 7, role: 'developer' },
  permissions: ['agents.read', 'workflows.read', 'integrations.read', 'runs.read_all', 'governance.read', 'observability.read', 'agents.run', 'workspace.search'],
  modules: [
    { id: 'argus.core', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'argus.dev', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'argus.aiops', installed: false, entitled: true, available: false, reason: 'not_installed' },
    { id: 'argus.hermes', installed: false, entitled: true, available: false, reason: 'not_installed' },
    { id: 'public-channels', installed: true, entitled: true, available: true, reason: 'available' },
    { id: 'compliance', installed: false, entitled: true, available: false, reason: 'not_installed' },
  ],
  navigation: {
    canUseArgusDev: true, canBuildWorkflows: true, canManageAgents: true,
    canManageIntegrations: false, canManageKnowledge: true, canRunEvaluations: true,
    canReviewApprovals: true, canObservePlatform: true, canReadAuditEvidence: false,
    canManageRuntimePolicy: false, canUseCompliance: false, canManagePublicChannels: false,
    canSearchWorkspaceResources: true, canAdminPlatform: false,
  },
};

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <GlobalSearchDialog capabilities={capabilities} canAdmin={false} onClose={vi.fn()} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('GlobalSearchDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps navigation available and loads authorized resources after a bounded debounce', async () => {
    api.searchWorkspace.mockResolvedValue({
      schemaVersion: 1, generatedAt: '2026-09-13T10:00:00.000Z', query: 'planner',
      counts: { agent: 1 }, truncated: false, durationMs: 12,
      results: [{
        type: 'agent', id: '4', title: 'Planner', subtitle: 'planner',
        description: 'Plans implementation work', href: '/build/agents/manage?agent=4',
        status: 'Ready', score: 100,
      }],
    });
    renderDialog();
    expect(screen.getByRole('link', { name: /Agent Studio/ })).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText(/Search agents/), { target: { value: 'planner' } });

    expect(await screen.findByRole('link', { name: /Planner/ })).toHaveAttribute('href', '/build/agents/manage?agent=4');
    expect(api.searchWorkspace).toHaveBeenCalledWith('planner');
    expect(screen.getByText('Results respect your role and Bundle scope.')).toBeInTheDocument();
  });

  it('does not send one-character searches to the server', () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/Search agents/), { target: { value: 'a' } });
    expect(api.searchWorkspace).not.toHaveBeenCalled();
  });
});
