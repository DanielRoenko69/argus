import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunsDrawer } from './RunsDrawer';

const mocks = vi.hoisted(() => ({
  coreRefetch: vi.fn(),
  packRefetch: vi.fn(),
  cancelWorkflowReplay: vi.fn(),
}));

vi.mock('@/api/builder', () => ({
  useRuns: () => ({
    data: { runs: [{
      id: 17, workflow_id: 9, status: 'completed', started_at: '2026-08-21T09:00:00.000Z',
      completed_at: '2026-08-21T09:00:01.000Z', duration_ms: 1_000, triggered_by: 'alex', error_message: null,
    }] },
    isLoading: false,
    refetch: mocks.coreRefetch,
  }),
  usePackRuns: () => ({
    data: { runs: [{
      traceId: '927d3c7a-4b82-4693-bf67-9e96159990c1',
      taskId: '22222222-2222-4222-8222-222222222222', title: 'Governed release', status: 'interrupted',
      error: null, currentStage: 'response', completed: true, stepCount: 5, agentStepCount: 2,
      createdAt: '2026-08-21T10:00:00.000Z', updatedAt: '2026-08-21T10:01:15.000Z', durationMs: 75_000,
      canCancel: true, canResume: true, approvalStage: 'approval',
      replayHref: '/build/workflows/studio/9?replay=927d3c7a-4b82-4693-bf67-9e96159990c1',
    }] },
    isLoading: false,
    isError: false,
    refetch: mocks.packRefetch,
  }),
}));

vi.mock('@/api/replay', () => ({ cancelWorkflowReplay: mocks.cancelWorkflowReplay }));

vi.mock('./RunModal', () => ({ RunModal: () => null }));
vi.mock('./AuditDrawer', () => ({
  AuditDrawer: ({ open, runId }: { open: boolean; runId: number | null }) => open ? <div>Inspector run #{runId}</div> : null,
}));

describe('RunsDrawer', () => {
  it('separates durable Visual Runs, exposes checkpoint controls and opens their evidence', async () => {
    mocks.cancelWorkflowReplay.mockResolvedValue({ ok: true });
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RunsDrawer open workflowId={9} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('ARGUS.DEV · VISUAL RUNS')).toBeInTheDocument();
    expect(screen.getByText('ARGUS CORE · API EXECUTIONS')).toBeInTheDocument();
    expect(screen.getByText('Governed release')).toBeInTheDocument();
    expect(screen.getByText('Execution #17')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Evidence/ })).toHaveAttribute(
      'href', '/build/workflows/studio/9?replay=927d3c7a-4b82-4693-bf67-9e96159990c1',
    );
    expect(screen.getByRole('button', { name: /Wiederholen/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Run log/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fortsetzen/ })).toHaveAttribute(
      'href', '/build/workflows/studio/9?replay=927d3c7a-4b82-4693-bf67-9e96159990c1',
    );
    fireEvent.click(screen.getByRole('button', { name: /Abbrechen/ }));
    await waitFor(() => expect(mocks.cancelWorkflowReplay).toHaveBeenCalledWith(
      9, '927d3c7a-4b82-4693-bf67-9e96159990c1',
    ));
  });

  it('opens the requested persisted execution in the inspector', () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <RunsDrawer open workflowId={9} initialRunId={17} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(screen.getByText('Inspector run #17')).toBeInTheDocument();
  });
});
