import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AuditDrawer } from './AuditDrawer';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
}));

vi.mock('@/api/client', () => ({ api: { get: mocks.get } }));
vi.mock('@/api/stats', () => ({
  useRunAudit: () => ({ data: { entries: [] }, isLoading: false }),
}));
vi.mock('./InspectorPanel', () => ({
  InspectorPanel: ({ kind }: { kind: string }) => <div>Inspector {kind}</div>,
}));

describe('AuditDrawer', () => {
  it('opens a persisted execution log with expandable full step output', async () => {
    mocks.get.mockResolvedValue({
      id: 17,
      status: 'completed',
      started_at: '2026-08-22T09:00:00.000Z',
      completed_at: '2026-08-22T09:00:01.000Z',
      duration_ms: 1_000,
      triggered_by: 'alex',
      input_args: { issue: 42 },
      error_message: null,
      step_results: {
        planner: {
          status: 'completed',
          duration_ms: 875,
          result: 'A complete planner response that remains available without truncation.',
        },
      },
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <AuditDrawer open workflowId={9} runId={17} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Execution #17')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/api/workflows/9/runs/17');
    expect(screen.getByText('planner')).toBeInTheDocument();
    fireEvent.click(screen.getByText('planner'));
    expect(screen.getByText(/complete planner response/)).toBeInTheDocument();
  });

  it('keeps audit, hook and memory evidence available as sibling tabs', async () => {
    mocks.get.mockResolvedValue({
      id: 18, status: 'completed', started_at: '2026-08-22T09:00:00.000Z', completed_at: null,
      duration_ms: null, triggered_by: null, input_args: {}, step_results: {}, error_message: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <AuditDrawer open workflowId={9} runId={18} onClose={vi.fn()} />
      </QueryClientProvider>,
    );

    await screen.findByText('Execution #18');
    fireEvent.click(screen.getByRole('button', { name: 'Hooks' }));
    expect(screen.getByText('Inspector hooks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Memory' }));
    expect(screen.getByText('Inspector memories')).toBeInTheDocument();
  });
});
