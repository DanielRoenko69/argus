import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NativeDependencyMapResponse, NativeServiceTopologyResponse, OverviewResponse } from '../types';
import { DependencyMapPage } from './DependencyMapPage';

const api = vi.hoisted(() => ({ getNativeDependencyMap: vi.fn(), getNativeServiceTopology: vi.fn(), getOverview: vi.fn() }));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: new Date().toISOString(), user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [], stats: { activeRuns: 0, successRate24h: 100, completed24h: 1, failed24h: 0, workflowsInReview: 0, connectedTools: 1, agents: 1 },
  health: { state: 'healthy', healthy: 1, total: 1, degraded: 0 }, runs: [],
};
const graph: NativeDependencyMapResponse = {
  generatedAt: new Date().toISOString(), hours: 24,
  nodes: [
    { id: 'agent:7', kind: 'agent', name: 'planner', detail: 'Planner agent', state: 'degraded', calls: 12, failures: 1 },
    { id: 'model:gpt-5.1', kind: 'model', name: 'gpt-5.1', detail: 'openai', state: 'healthy', calls: 12, failures: 1 },
  ],
  edges: [{ id: 'edge', source: 'agent:7', target: 'model:gpt-5.1', relation: 'uses', evidence: 'both', calls: 12, failures: 1 }],
  summary: { nodes: 2, edges: 1, configuredEdges: 1, observedEdges: 1, unhealthyNodes: 1 },
};
const serviceTopology: NativeServiceTopologyResponse = {
  generatedAt: new Date().toISOString(),
  nodes: [
    { id: 'cluster:demo', kind: 'cluster', name: 'argus-kind', detail: 'demo-kind', environment: 'demo', state: 'no_data', current: true, signals: ['kubernetes'], evidenceCount: 1, events: 0, calls: 0, failures: 0 },
    { id: 'service:checkout', kind: 'service', name: 'checkout-api', detail: 'demo · 4 evidence records', environment: 'demo', state: 'critical', current: true, signals: ['alerts', 'kubernetes', 'logs', 'traces'], evidenceCount: 4, events: 1, calls: 3, failures: 1 },
    { id: 'dependency:postgres', kind: 'dependency', name: 'postgresql', detail: 'database', environment: 'demo', state: 'degraded', current: true, signals: ['traces'], evidenceCount: 0, events: 0, calls: 3, failures: 1 },
    { id: 'alert:latency', kind: 'alert', name: 'Checkout latency', detail: 'critical · firing', environment: 'demo', state: 'critical', current: true, signals: ['alerts'], evidenceCount: 1, events: 1, calls: 0, failures: 0 },
  ],
  edges: [
    { id: 'service-dependency', source: 'service:checkout', target: 'dependency:postgres', relation: 'queries', evidence: 'observed', current: true, calls: 3, failures: 1, p95DurationMs: 45000, lastSeenAt: new Date().toISOString() },
    { id: 'service-alert', source: 'service:checkout', target: 'alert:latency', relation: 'monitored_by', evidence: 'configured', current: true, calls: 0, failures: 0, p95DurationMs: null, lastSeenAt: null },
  ],
  summary: { clusters: 1, namespaces: 0, workloads: 0, services: 1, alerts: 1, firingAlerts: 1, traceServices: 1, logServices: 1, runtimeDependencies: 1, calls: 3, failures: 1 },
};

function renderPage(role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getNativeDependencyMap.mockResolvedValue(graph);
  api.getNativeServiceTopology.mockResolvedValue(serviceTopology);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={client}><DependencyMapPage /></QueryClientProvider></MemoryRouter>);
}

describe('DependencyMapPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('renders topology evidence and opens a component inspector', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Dependency map' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Argus runtime dependency graph' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'agent planner' }));
    expect(screen.getByRole('heading', { name: 'Component detail' })).toBeInTheDocument();
    expect(screen.getByText('Planner agent')).toBeInTheDocument();
    expect(screen.getByText(/gpt-5.1 · both · 12 calls/)).toBeInTheDocument();
  });

  it('blocks non-admin users', async () => {
    renderPage('viewer');
    expect(await screen.findByRole('alert')).toHaveTextContent('Platform administrator access required');
  });

  it('switches to evidence-backed service and infrastructure topology', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Services & infrastructure' }));
    expect(await screen.findByRole('img', { name: 'Argus service and infrastructure topology graph' })).toBeInTheDocument();
    expect(screen.getByText('1 traced · 1 logged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'service checkout-api' }));
    expect(screen.getByRole('heading', { name: 'Topology detail' })).toBeInTheDocument();
    expect(screen.getByLabelText('Signal coverage')).toHaveTextContent('kubernetes');
    expect(screen.getByLabelText('Signal coverage')).toHaveTextContent('traces');
    expect(screen.getByText('monitored by')).toBeInTheDocument();
    expect(screen.getByText(/postgresql · observed · 3 calls · 1 failed · p95 45000 ms/)).toBeInTheDocument();
  });
});
