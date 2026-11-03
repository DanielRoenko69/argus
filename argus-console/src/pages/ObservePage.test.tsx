import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservabilityAnalyticsResponse, OverviewResponse, RunsResponse } from '../types';
import { ObservePage } from './ObservePage';

const api = vi.hoisted(() => ({
  getLiveActivity: vi.fn(),
  getObservabilityAnalytics: vi.fn(),
  getOverview: vi.fn(),
  getRuns: vi.fn(),
}));

vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: new Date().toISOString(),
  user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 1, successRate24h: 92, completed24h: 11, failed24h: 1, workflowsInReview: 0, connectedTools: 18, agents: 4 },
  health: { state: 'healthy', healthy: 3, total: 3, degraded: 0 },
  runs: [],
};

const runs: RunsResponse = {
  generatedAt: new Date().toISOString(),
  runs: [{
    id: 'run-42', kind: 'agent', title: 'Cluster investigator', subtitle: 'Investigate failed deployment', status: 'running',
    risk: 'medium', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), durationMs: 3200, href: '/runs/agent/run-42',
  }],
};

const analytics: ObservabilityAnalyticsResponse = {
  generatedAt: new Date().toISOString(),
  hours: 24,
  summary: {
    totalTraces: 31, completedTraces: 29, failedTraces: 1, activeTraces: 1, waitingTraces: 0,
    successRate: 96.7, errorRate: 3.3, avgDurationMs: 820, p50DurationMs: 510, p95DurationMs: 2800,
    totalInputTokens: 12000, totalOutputTokens: 3600, totalCostUsd: 1.42, llmCalls: 18, toolCalls: 44,
  },
  timeline: [{ bucket: new Date().toISOString(), count: 31, completed: 29, failed: 1, costUsd: 1.42, avgDurationMs: 820 }],
  models: [{ provider: 'openai', model: 'gpt-5.1', calls: 18, failures: 0, inputTokens: 12000, outputTokens: 3600, costUsd: 1.42, avgDurationMs: 700, p95DurationMs: 1900 }],
  tools: [{ tool: 'kubernetes_get_pods', calls: 14, failures: 1, avgDurationMs: 210, p95DurationMs: 440 }],
  agents: [{ id: 2, name: 'Cluster investigator', executions: 20, failures: 1, successRate: 95, tokens: 15600, costUsd: 1.42, p95DurationMs: 2800 }],
  workflows: [{ id: 4, name: 'release_guard', executions: 11, failures: 0, successRate: 100, p95DurationMs: 1600 }],
};

function renderPage(role = 'platform_admin', overviewOverride: OverviewResponse = overview) {
  api.getOverview.mockResolvedValue({ ...overviewOverride, user: { ...overviewOverride.user, role } });
  api.getRuns.mockResolvedValue(runs);
  api.getObservabilityAnalytics.mockResolvedValue(analytics);
  api.getLiveActivity.mockResolvedValue({
    sessions: [], counts: { total: 0, thinking: 0, tool: 0, streaming: 0, done: 0, error: 0 }, ts: Date.now(),
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter initialEntries={['/observe']}><QueryClientProvider client={client}><ObservePage /></QueryClientProvider></MemoryRouter>);
}

describe('ObservePage', () => {
  afterEach(() => vi.clearAllMocks());

  it('connects platform signals to a filterable execution trace', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Observability' })).toBeInTheDocument();
    expect(screen.getByText('31')).toBeInTheDocument();
    expect(screen.getByText('kubernetes_get_pods')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.1')).toBeInTheDocument();
    expect(screen.getAllByText('$1.42').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Cluster investigator').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('link', { name: /Cluster investigator/ })).toHaveAttribute('href', '/runs/agent/run-42');
    expect(screen.getByRole('link', { name: /Live sessions/ })).toBeInTheDocument();
    await waitFor(() => expect(api.getLiveActivity).toHaveBeenCalled());
  });

  it('does not query or expose cross-user live activity for a viewer', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('heading', { name: 'Observability' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Live sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Audit trail/ })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Logs/ })).toBeInTheDocument();
    expect(api.getLiveActivity).not.toHaveBeenCalled();
  });

  it('explains degraded health and deep-links to the affected backend', async () => {
    renderPage('platform_admin', {
      ...overview,
      health: {
        state: 'degraded', healthy: 2, total: 3, degraded: 1,
        issues: [{ id: 'slack', name: 'Slack', state: 'degraded', error: 'channel_not_found', href: '/mcp-fabric?view=backends&server=Slack' }],
      },
    });

    expect(await screen.findByText('Why Argus is degraded')).toBeInTheDocument();
    expect(screen.getByText('channel_not_found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Slack/ })).toHaveAttribute('href', '/mcp-fabric?view=backends&server=Slack');
  });
});
