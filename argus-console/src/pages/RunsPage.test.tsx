import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsPage } from './RunsPage';

const api = vi.hoisted(() => ({ getRunFamilies: vi.fn() }));
vi.mock('../api', () => api);

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><RunsPage /></QueryClientProvider>);
}

const root = {
  id: '42',
  kind: 'workflow',
  title: 'Golden path triage',
  status: 'waiting_for_approval',
  displayStatus: 'action_required',
  attentionReason: 'Approval required for bounded Slack write',
  currentPhase: 'approval',
  startedAt: '2026-09-13T10:00:00.000Z',
  updatedAt: '2026-09-13T10:01:00.000Z',
  durationMs: 60_000,
  rootTraceId: 'trace-42',
  parentRunId: null,
  childCounts: { running: 0, waiting: 1, completed: 1, failed: 0, cancelled: 0 },
  resourceRefs: [{
    type: 'workflow', id: '7', label: 'Golden Path workflow', href: '/build/workflows/studio/7', version: '3',
    tags: [{ id: '9', label: 'golden-path', color: '#8b5cf6' }], capturedAt: '2026-09-13T10:00:00.000Z',
  }],
  evidenceCompleteness: 'frozen',
  allowedActions: ['open', 'cancel', 'review_approval'],
  href: '/runs/workflow/42',
  orphaned: false,
  children: [{
    id: 'agent-child', kind: 'agent', title: 'Planner', status: 'completed', displayStatus: 'succeeded',
    attentionReason: null, currentPhase: 'analysis', startedAt: '2026-09-13T10:00:02.000Z', updatedAt: '2026-09-13T10:00:20.000Z',
    durationMs: 18_000, rootTraceId: 'trace-42', parentRunId: '42', childCounts: { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
    resourceRefs: [], evidenceCompleteness: 'frozen', allowedActions: ['open'], href: '/runs/agent/agent-child', orphaned: false, children: [],
  }],
};

describe('RunsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getRunFamilies.mockResolvedValue({
      schemaVersion: 2, generatedAt: '2026-09-13T10:01:00.000Z', view: 'root', includeChildren: 'full',
      items: [root, {
        ...root,
        id: '43',
        title: 'Completed release',
        status: 'completed',
        displayStatus: 'succeeded',
        attentionReason: null,
        childCounts: { running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
        resourceRefs: [],
        evidenceCompleteness: 'missing',
        allowedActions: ['open'],
        children: [],
      }],
      nextCursor: null, orphanCount: 0,
    });
  });

  it('presents one governed root with children, evidence and approval action', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Golden path triage' })).toBeInTheDocument();
    expect(screen.getAllByText('Frozen evidence').length).toBeGreaterThan(1);
    expect(screen.getByText('golden-path')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Review approval/ })).toHaveAttribute('href', '/governance?run=42&kind=workflow&workflowExecutionId=42');
    expect(screen.getByText('Execution lineage')).toBeInTheDocument();
    expect(screen.getByText('Planner')).toBeInTheDocument();
  });

  it('filters root families with user-facing statuses and resource search', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Completed release' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Action required' }));
    expect(screen.queryByRole('heading', { name: 'Completed release' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    fireEvent.change(screen.getByPlaceholderText('Search runs, resources or tags'), { target: { value: 'golden-path' } });
    expect(screen.getByRole('heading', { name: 'Golden path triage' })).toBeInTheDocument();
  });
});
