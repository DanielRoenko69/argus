import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeDependencyMapResponse, NativeSlosResponse, OverviewResponse } from '../types';
import { SlosPage } from './SlosPage';

const api = vi.hoisted(() => ({
  createNativeSlo: vi.fn(), deleteNativeSlo: vi.fn(), getNativeDependencyMap: vi.fn(),
  getNativeSlos: vi.fn(), getOverview: vi.fn(), updateNativeSlo: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: new Date().toISOString(), user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [], stats: { activeRuns: 0, successRate24h: 96, completed24h: 96, failed24h: 4, workflowsInReview: 0, connectedTools: 1, agents: 1 },
  health: { state: 'healthy', healthy: 1, total: 1, degraded: 0 }, runs: [],
};
const slos: NativeSlosResponse = {
  generatedAt: new Date().toISOString(), summary: { enabled: 1, met: 1, breached: 0, noData: 0 },
  slos: [{ id: 1, name: 'Planner reliability', description: 'Production planning runs.', metric: 'success_rate', target: 95, windowMinutes: 1440, minSamples: 20, scopeKind: 'agent', scopeValue: '7', enabled: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), evaluation: { state: 'met', actual: 96, sampleCount: 100, errorBudgetRemainingPercent: 20, burnRate: .8, evaluatedAt: new Date().toISOString() } }],
};
const dependencies: NativeDependencyMapResponse = {
  generatedAt: new Date().toISOString(), hours: 24,
  nodes: [{ id: 'agent:7', kind: 'agent', name: 'planner', detail: 'Planner', state: 'healthy', calls: 10, failures: 0 }],
  edges: [], summary: { nodes: 1, edges: 0, configuredEdges: 0, observedEdges: 0, unhealthyNodes: 0 },
};

function renderPage(role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getNativeSlos.mockResolvedValue(slos);
  api.getNativeDependencyMap.mockResolvedValue(dependencies);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><SlosPage /></QueryClientProvider></MemoryRouter>);
}

describe('SlosPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows evaluated objectives and offers graph-backed component targets', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Service-level objectives' })).toBeInTheDocument();
    expect(screen.getByText('Planner reliability')).toBeInTheDocument();
    expect(screen.getByText('20% error budget remaining · 0.80× burn')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New objective' }));
    fireEvent.change(screen.getByLabelText('Component type'), { target: { value: 'agent' } });
    expect(screen.getByRole('option', { name: 'planner' })).toHaveValue('7');
  });

  it('blocks non-admin users', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('alert')).toHaveTextContent('Platform administrator access required');
  });
});
