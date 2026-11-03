import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CiProviderCanaryOperationsResponse, NativeServiceHealthResponse, OverviewResponse, SyntheticCanaryOperationsResponse } from '../types';
import { ServiceHealthPage } from './ServiceHealthPage';

const api = vi.hoisted(() => ({
  getNativeServiceHealth: vi.fn(),
  getOverview: vi.fn(),
  getSyntheticCanaries: vi.fn(),
  getCiProviderCanaries: vi.fn(),
  runSyntheticCanaries: vi.fn(),
  runCiProviderCanaries: vi.fn(),
  saveSyntheticCanaryConfig: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: new Date().toISOString(),
  user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [], stats: { activeRuns: 0, successRate24h: 96, completed24h: 96, failed24h: 4, workflowsInReview: 0, connectedTools: 2, agents: 1 },
  health: { state: 'healthy', healthy: 2, total: 2, degraded: 0 }, runs: [],
};

const health: NativeServiceHealthResponse = {
  generatedAt: new Date().toISOString(), hours: 24, state: 'healthy', score: 97,
  summary: { totalExecutions: 100, successRate: 96, p95DurationMs: 4000, totalCostUsd: 2.5, firingIncidents: 0, criticalIncidents: 0 },
  errorBudget: { objective: 95, terminalExecutions: 100, allowedFailures: 5, actualFailures: 4, remainingPercent: 20, state: 'met' },
  slos: [
    { id: 'reliability', name: 'Execution reliability', state: 'met', target: '≥ 95%', actual: '96.0%', description: 'Completed executions.' },
    { id: 'latency', name: 'Interaction latency', state: 'met', target: 'P95 ≤ 30s', actual: '4.0s', description: 'End-to-end duration.' },
    { id: 'incidents', name: 'Critical incidents', state: 'met', target: '0 open', actual: '0 open', description: 'Open critical incidents.' },
  ],
  customSlos: [],
  components: [
    { id: 'agent:1', kind: 'agent', name: 'Cluster investigator', detail: 'Agent executions', state: 'healthy', executions: 60, failures: 2, successRate: 96.7, p95DurationMs: 3800, costUsd: 2.5 },
    { id: 'tool:kubernetes_get_pods', kind: 'tool', name: 'kubernetes_get_pods', detail: 'MCP capability', state: 'healthy', executions: 120, failures: 1, successRate: 99.2, p95DurationMs: 500, costUsd: 0 },
  ],
  openIncidents: [],
  recommendations: [{ severity: 'info', title: 'Objectives are within target', description: 'No immediate action is required.', href: '/observe' }],
};

const canaries: SyntheticCanaryOperationsResponse = {
  generatedAt: '2026-08-02T12:00:00.000Z',
  config: {
    enabled: true, intervalMinutes: 15, timeoutSeconds: 30, retentionDays: 30, agentIds: [1],
    source: 'database', updatedAt: '2026-08-02T10:00:00.000Z', credentialConfigured: true, targetMode: 'selected',
  },
  state: {
    status: 'healthy', totalTargets: 1, passingTargets: 1, failingTargets: 0,
    lastRunAt: '2026-08-02T11:59:00.000Z', nextRunAt: '2026-08-02T12:14:00.000Z', running: false,
  },
  availableAgents: [{ id: 1, name: 'cluster-investigator', label: 'Cluster Investigator' }],
  canaries: [{
    agentId: 1, agentName: 'Cluster Investigator', total: 12, okCount: 12, failCount: 0,
    successRate: 100, p95LatencyMs: 4200, lastStatus: 'ok', lastAt: '2026-08-02T11:59:00.000Z',
  }],
  history: [{
    id: 14, agentId: 1, agentName: 'Cluster Investigator', timestamp: '2026-08-02T11:58:55.000Z',
    completedAt: '2026-08-02T11:59:00.000Z', status: 'ok', latencyMs: 4200,
    source: 'scheduled', triggeredBy: null,
  }],
};

const ciCanaries: CiProviderCanaryOperationsResponse = {
  generatedAt: '2026-08-02T12:00:00.000Z',
  state: { status: 'no_data', totalRuns: 0, passingRuns: 0, failingRuns: 0, lastRunAt: null },
  history: [],
};

function renderPage(role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getNativeServiceHealth.mockResolvedValue(health);
  api.getSyntheticCanaries.mockResolvedValue(canaries);
  api.getCiProviderCanaries.mockResolvedValue(ciCanaries);
  api.runSyntheticCanaries.mockResolvedValue({ results: [], operations: canaries });
  api.runCiProviderCanaries.mockResolvedValue({ results: [], operations: ciCanaries });
  api.saveSyntheticCanaryConfig.mockResolvedValue(canaries.config);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><ServiceHealthPage /></QueryClientProvider></MemoryRouter>);
}

describe('ServiceHealthPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows the health score, SLOs, budget, and filters runtime components', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Service health' })).toBeInTheDocument();
    expect(screen.getByText('97')).toBeInTheDocument();
    expect(screen.getByText('Execution reliability')).toBeInTheDocument();
    expect(screen.getByText('Cluster investigator')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'tool' }));
    expect(screen.queryByText('Cluster investigator')).not.toBeInTheDocument();
    expect(screen.getByText('kubernetes_get_pods')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Agent canaries' })).toBeInTheDocument();
    expect(screen.getByText('All targets passing')).toBeInTheDocument();
    expect(screen.getAllByText('Cluster Investigator').length).toBeGreaterThan(0);
  });

  it('runs real targets explicitly and saves bounded runtime configuration', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Agent canaries' });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(api.runSyntheticCanaries).toHaveBeenCalledWith(undefined));

    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(screen.getByText(/may incur model usage costs/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Canary interval minutes'), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText('Canary retention days'), { target: { value: '14' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(api.saveSyntheticCanaryConfig).toHaveBeenCalledWith({
      enabled: true, intervalMinutes: 30, timeoutSeconds: 30, retentionDays: 14, agentIds: [1],
    }));
  });

  it('blocks non-admin users from cross-platform service health', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('alert')).toHaveTextContent('Platform administrator access required');
  });
});
