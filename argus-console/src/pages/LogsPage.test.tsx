import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPage } from './LogsPage';

const api = vi.hoisted(() => ({
  getConsoleUser: vi.fn().mockResolvedValue({ role:'platform_admin' }),
  getLogIndices: vi.fn(),
  getOverview: vi.fn(),
  getTraceEvidence: vi.fn(),
  searchLogs: vi.fn(),
}));

vi.mock('../api', () => api);

function renderPage(initialEntry = '/observe/logs?root_trace=12345678-1234-4234-9234-123456789abc') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}><LogsPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('LogsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOverview.mockResolvedValue({ user: { role: 'platform_admin' } });
    api.getLogIndices.mockResolvedValue({ indices: [] });
    api.searchLogs.mockResolvedValue({ hits: [], total: '0' });
    api.getTraceEvidence.mockResolvedValue({
      generatedAt: '2026-08-17T12:00:00.000Z',
      family: {
        rootTraceId: '12345678-1234-4234-9234-123456789abc',
        currentTraceId: '12345678-1234-4234-9234-123456789abc',
        truncated: false,
        spansTruncated: false,
        runs: [{
          id: '22345678-1234-4234-9234-123456789abc', agentId: 6, taskType: 'plan',
          parentTraceId: '12345678-1234-4234-9234-123456789abc', parentSpanId: null,
          kind: 'agent', title: 'planner', subtitle: 'Codex · gpt-5.6-terra', status: 'completed',
          startedAt: '2026-08-17T12:00:01.000Z', endedAt: '2026-08-17T12:00:05.000Z', durationMs: 4_000,
          outputPreview: 'Inspect the API boundary, update the route and add a regression test.', error: null,
          href: '/runs/agent/22345678-1234-4234-9234-123456789abc',
        }],
        spans: [],
        analysis: { criticalPath: [], bottleneck: null, totalDurationMs: 4_000, maxConcurrency: 1, failedNodes: 0 },
        historicalBaseline: {
          selectedWindowDays: null, confidence: 'none', sampleCount: 0, currentDurationMs: 4_000,
          currentCostUsd: 0, durationDeltaPercent: null, costDeltaPercent: null,
          durationState: 'no_data', costState: 'no_data', selected: null, windows: [],
        },
        comparison: null,
      },
    });
  });

  it('shows redacted agent outputs next to correlated operational logs', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Agent outputs' })).toBeVisible();
    expect(screen.getByText('planner')).toBeVisible();
    expect(screen.getByText('Inspect the API boundary, update the route and add a regression test.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open full agent trace/ })).toHaveAttribute(
      'href',
      '/runs/agent/22345678-1234-4234-9234-123456789abc',
    );
    expect(api.getTraceEvidence).toHaveBeenCalledWith('12345678-1234-4234-9234-123456789abc');
  });

  it('shows the complete selected span id in the investigation scope', async () => {
    renderPage('/observe/logs?trace=12345678-1234-4234-9234-123456789abc&span=7f478b03-20e7-4adb-a444-e0f8617b56f8');

    expect(await screen.findByText('7f478b03-20e7-4adb-a444-e0f8617b56f8')).toBeVisible();
  });

  it('expands and collapses a retained agent response without changing its content', async () => {
    const longOutput = `Reviewer evidence:\n${'Complete retained response. '.repeat(30)}`;
    api.getTraceEvidence.mockResolvedValue({
      generatedAt: '2026-08-17T12:00:00.000Z',
      family: {
        runs: [{
          id: '32345678-1234-4234-9234-123456789abc', agentId: 7, taskType: 'review',
          parentTraceId: '12345678-1234-4234-9234-123456789abc', parentSpanId: null,
          kind: 'agent', title: 'reviewer', subtitle: 'Codex · gpt-5.6-terra', status: 'completed',
          startedAt: '2026-08-17T12:00:01.000Z', endedAt: '2026-08-17T12:00:05.000Z', durationMs: 4_000,
          outputPreview: longOutput, error: null,
          href: '/runs/agent/32345678-1234-4234-9234-123456789abc',
        }],
      },
    });
    renderPage();

    fireEvent.click(await screen.findByText('reviewer'));
    const output = screen.getByText(/Reviewer evidence:/);
    const expand = screen.getByRole('button', { name: 'Show complete response' });
    expect(output.textContent).toBe(longOutput);
    expect(output).not.toHaveClass('is-expanded');

    fireEvent.click(expand);
    expect(output).toHaveClass('is-expanded');
    expect(screen.getByRole('button', { name: 'Collapse response' })).toHaveAttribute('aria-expanded', 'true');
  });
});
