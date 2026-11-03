import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useExecutionStore } from '@/stores/executionStore';
import { ExecutionLog } from './ExecutionLog';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/client')>();
  return { ...actual, api: { ...actual.api, get: mocks.get, post: mocks.post } };
});
vi.mock('@/stores/builderStore', () => ({
  useBuilderStore: (selector: (state: unknown) => unknown) => selector({
    nodes: [
      { id: 'start', type: 'trigger.manual', data: { label: 'Triage request' } },
      { id: 'triage', type: 'argus.agent', data: { label: 'Analyze and prioritize' } },
      { id: 'foreach', type: 'logic.for_each', data: { label: 'Process child workflows' } },
    ],
  }),
}));
vi.mock('./RunModal', () => ({
  RunModal: ({ open, retryRunId, retryStepIds, prefill }: {
    open: boolean;
    retryRunId?: number | null;
    retryStepIds?: string[];
    prefill?: Record<string, unknown> | null;
  }) => open ? (
    <div aria-label="Retry modal test double">
      Retry modal {retryRunId} · {retryStepIds?.join(',')} · {String(prefill?.notification_channel ?? '')}
    </div>
  ) : null,
}));

function renderLog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ExecutionLog workflowId={161} />
    </QueryClientProvider>,
  );
}

describe('ExecutionLog', () => {
  afterEach(() => {
    useExecutionStore.getState().reset();
    useExecutionStore.getState().setLogOpen(false);
    vi.clearAllMocks();
  });

  it('recovers persisted step output when the live SSE buffer is no longer available', async () => {
    const rootTraceId = '11111111-1111-4111-8111-111111111111';
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [{
        id: 9, workflow_id: 161, status: 'completed', started_at: '2026-08-22T11:23:22.690Z',
        completed_at: '2026-08-22T11:23:36.521Z', duration_ms: 13_831,
        triggered_by: 'builder:Alex', error_message: null, trace_id: rootTraceId, root_trace_id: rootTraceId,
      }] };
      return {
        id: 9, workflow_id: 161, status: 'completed', started_at: '2026-08-22T11:23:22.690Z',
        completed_at: '2026-08-22T11:23:36.521Z', duration_ms: 13_831,
        triggered_by: 'builder:Alex', error_message: null, input_args: {}, trace_id: rootTraceId, root_trace_id: rootTraceId,
        step_results: {
          start: { status: 'completed', duration_ms: 1, result: '{}' },
          triage: { status: 'completed', duration_ms: 12_500, result: 'Full planner evidence' },
        },
      };
    });
    useExecutionStore.getState().start(9);
    renderLog();

    expect(await screen.findByText('Analyze and prioritize')).toBeInTheDocument();
    await waitFor(() => expect(useExecutionStore.getState().running).toBe(false));
    expect(screen.getAllByText('completed')).toHaveLength(2);
    fireEvent.click(screen.getByText('Analyze and prioritize'));
    expect(screen.getByText('Full planner evidence')).toBeInTheDocument();
    expect(screen.getByLabelText('Selected run trace')).toHaveTextContent(rootTraceId);
    expect(screen.getByRole('link', { name: /Open logs/ })).toHaveAttribute(
      'href', `/observe/logs?root_trace=${rootTraceId}`,
    );
  });

  it('lists concurrent active runs with IDs and start times and switches the live selection', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [
        {
          id: 12, workflow_id: 161, status: 'running', started_at: '2026-08-22T12:00:12.000Z',
          completed_at: null, duration_ms: null, triggered_by: 'builder:Alex', error_message: null,
        },
        {
          id: 11, workflow_id: 161, status: 'running', started_at: '2026-08-22T12:00:05.000Z',
          completed_at: null, duration_ms: null, triggered_by: 'webhook', error_message: null,
        },
      ] };
      const id = path.endsWith('/11') ? 11 : 12;
      return {
        id, workflow_id: 161, status: 'running', started_at: '2026-08-22T12:00:05.000Z',
        completed_at: null, duration_ms: null, triggered_by: 'builder:Alex', error_message: null,
        input_args: {}, step_results: {},
      };
    });
    useExecutionStore.getState().start(12);
    renderLog();

    expect(await screen.findByText('2 active')).toBeInTheDocument();
    const secondRun = screen.getByRole('button', { name: /Open run 11, running, started/ });
    expect(secondRun).toHaveTextContent('Run #11');
    expect(secondRun).toHaveTextContent('webhook');
    fireEvent.click(secondRun);

    await waitFor(() => expect(useExecutionStore.getState().executionId).toBe(11));
    expect(screen.getByLabelText('Run 11 events')).toBeInTheDocument();
  });

  it('keeps runtime approvals scoped to the selected run and approves the correct request', async () => {
    mocks.post.mockResolvedValue({ ok: true, status: 'approved', resumeScheduled: true });
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [
        {
          id: 11, workflow_id: 161, status: 'waiting_for_approval', started_at: '2026-08-22T12:00:11.000Z',
          completed_at: null, duration_ms: 14_000, triggered_by: 'builder:Alex',
          error_message: "Workflow is waiting for runtime approval #7 at step 'approval'",
          waiting_approval_id: 7, waiting_step_id: 'approval',
        },
        {
          id: 10, workflow_id: 161, status: 'waiting_for_approval', started_at: '2026-08-22T12:00:10.000Z',
          completed_at: null, duration_ms: 13_000, triggered_by: 'builder:Alex',
          error_message: "Workflow is waiting for runtime approval #6 at step 'approval'",
          waiting_approval_id: 6, waiting_step_id: 'approval',
        },
      ] };
      const id = path.endsWith('/10') ? 10 : 11;
      const approvalId = id === 10 ? 6 : 7;
      return {
        id, workflow_id: 161, status: 'waiting_for_approval', started_at: '2026-08-22T12:00:10.000Z',
        completed_at: null, duration_ms: 13_000, triggered_by: 'builder:Alex',
        error_message: `Workflow is waiting for runtime approval #${approvalId} at step 'approval'`,
        waiting_approval_id: approvalId, waiting_step_id: 'approval', input_args: {},
        step_results: {
          approval: {
            status: 'waiting', duration_ms: 8,
            result: JSON.stringify({ decision: 'pending', request_id: String(approvalId), message: `Approve run ${id}?` }),
          },
        },
      };
    });
    useExecutionStore.getState().selectRun(11, 'waiting_for_approval', '2026-08-22T12:00:11.000Z');
    renderLog();

    expect(await screen.findByLabelText('Runtime approval 7')).toHaveTextContent('Run #11 wartet auf Approval #7');
    fireEvent.click(screen.getByRole('button', { name: /Open run 10, waiting_for_approval/ }));
    expect(await screen.findByLabelText('Runtime approval 6')).toHaveTextContent('Run #10 wartet auf Approval #6');
    expect(await screen.findByText('Approve run 10?')).toBeInTheDocument();
    expect(screen.queryByText("Workflow is waiting for runtime approval #6 at step 'approval'")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      '/api/ui/governance/runtime-approvals/6/approve',
      { comment: '' },
    ));
  });

  it('offers a checkpoint retry for the failed step with the source inputs', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [{
        id: 16, workflow_id: 161, status: 'failed', started_at: '2026-08-22T14:00:00.000Z',
        completed_at: '2026-08-22T14:00:12.000Z', duration_ms: 12_000,
        triggered_by: 'builder:Alex', error_message: "Step 'notify' failed: channel_not_found",
      }] };
      return {
        id: 16, workflow_id: 161, status: 'failed', started_at: '2026-08-22T14:00:00.000Z',
        completed_at: '2026-08-22T14:00:12.000Z', duration_ms: 12_000,
        triggered_by: 'builder:Alex', error_message: "Step 'notify' failed: channel_not_found",
        input_args: { notification_channel: 'C_ARGUS_INVALID_E2E' },
        step_results: {
          start: { status: 'completed', duration_ms: 1, result: '{}' },
          triage: { status: 'completed', duration_ms: 10_000, result: 'Triage evidence' },
          notify: { status: 'failed', duration_ms: 20, error: 'channel_not_found' },
        },
      };
    });
    useExecutionStore.getState().selectRun(16, 'failed', '2026-08-22T14:00:00.000Z');
    renderLog();

    expect(await screen.findByLabelText('Failed run recovery')).toHaveTextContent('Fehler: notify');
    fireEvent.click(screen.getByRole('button', { name: 'Retry ab notify' }));

    expect(await screen.findByLabelText('Retry modal test double')).toHaveTextContent(
      'Retry modal 16 · notify · C_ARGUS_INVALID_E2E',
    );
  });

  it('shows persisted webhook provenance and the normalized workflow inputs', async () => {
    const triggerEvidence = {
      source: 'github',
      event_id: 'delivery-42',
      event_type: 'issues',
      received_at: '2026-08-22T14:30:00.000Z',
      payload_sha256: 'a'.repeat(64),
      event_id_source: 'x-github-delivery',
      path: '/webhooks/wf/github-issues',
      mode: 'local_test' as const,
    };
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [{
        id: 19, workflow_id: 161, status: 'completed', started_at: '2026-08-22T14:30:00.000Z',
        completed_at: '2026-08-22T14:30:02.000Z', duration_ms: 2_000,
        triggered_by: 'webhook:github:github-issues', error_message: null, trigger_evidence: triggerEvidence,
      }] };
      return {
        id: 19, workflow_id: 161, status: 'completed', started_at: '2026-08-22T14:30:00.000Z',
        completed_at: '2026-08-22T14:30:02.000Z', duration_ms: 2_000,
        triggered_by: 'webhook:github:github-issues', error_message: null,
        trigger_evidence: triggerEvidence,
        input_args: { repository_owner: 'argus-project', issue_number: 1 },
        step_results: { start: { status: 'completed', duration_ms: 1, result: '{}' } },
      };
    });
    useExecutionStore.getState().selectRun(19, 'completed', '2026-08-22T14:30:00.000Z');
    renderLog();

    const evidence = await screen.findByLabelText('Trigger evidence');
    expect(evidence).toHaveTextContent('github');
    expect(evidence).toHaveTextContent('issues');
    expect(evidence).toHaveTextContent('Local test');
    expect(evidence).toHaveTextContent('delivery-42');
    fireEvent.click(screen.getByText('Show normalized workflow inputs'));
    expect(evidence).toHaveTextContent('argus-project');
  });

  it('shows persisted child executions and direct trace links for For Each items', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [{
        id: 31, workflow_id: 161, status: 'completed', started_at: '2026-08-22T15:00:00.000Z',
        completed_at: '2026-08-22T15:00:03.000Z', duration_ms: 3_000,
        triggered_by: 'builder:Alex', error_message: null,
      }] };
      return {
        id: 31, workflow_id: 161, status: 'completed', started_at: '2026-08-22T15:00:00.000Z',
        completed_at: '2026-08-22T15:00:03.000Z', duration_ms: 3_000,
        triggered_by: 'builder:Alex', error_message: null, input_args: {},
        step_results: {
          foreach: {
            status: 'completed', duration_ms: 2_900,
            result: {
              total: 1, succeeded: 1, failed: 0, values: ['processed-api'],
              results: [{
                index: 0, status: 'completed', attempts: 1, value: 'processed-api',
                evidence: {
                  workflow_id: 88, execution_id: 401,
                  trace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                  root_trace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'completed',
                },
              }],
            },
          },
        },
      };
    });
    useExecutionStore.getState().selectRun(31, 'completed', '2026-08-22T15:00:00.000Z');
    renderLog();

    expect(await screen.findByText('1 child run')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Process child workflows'));
    const evidence = await screen.findByLabelText('Child workflow runs');
    expect(evidence).toHaveTextContent('Item #1');
    expect(evidence).toHaveTextContent('Run #401');
    expect(screen.getByRole('link', { name: /Trace/ })).toHaveAttribute(
      'href', '/runs/workflow/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    expect(screen.getByRole('link', { name: /Logs/ })).toHaveAttribute(
      'href', '/observe/logs?trace=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
  });

  it('retries only the failed child item and renders its persisted recovery attempt', async () => {
    let recovered = false;
    mocks.get.mockImplementation(async (path: string) => {
      if (path === '/api/workflows/161/runs') return { runs: [{
        id: 36, workflow_id: 161, status: 'completed', started_at: '2026-08-22T16:00:00.000Z',
        completed_at: '2026-08-22T16:00:03.000Z', duration_ms: 3_000,
        triggered_by: 'builder:Alex', error_message: null,
      }] };
      return {
        id: 36, workflow_id: 161, status: 'completed', started_at: '2026-08-22T16:00:00.000Z',
        completed_at: '2026-08-22T16:00:03.000Z', duration_ms: 3_000,
        triggered_by: 'builder:Alex', error_message: null, input_args: {},
        step_results: {
          foreach: {
            status: 'completed', duration_ms: 2_900,
            result: {
              total: 2, succeeded: 1, failed: 1, values: ['processed-api', null],
              results: [
                { index: 0, status: 'completed', attempts: 1, value: 'processed-api' },
                {
                  index: 1, status: 'failed', attempts: 1, error: 'temporary child failure',
                  evidence: {
                    workflow_id: 88, execution_id: 402,
                    trace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
                    root_trace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'failed',
                  },
                },
              ],
            },
          },
        },
        child_executions: {
          foreach: [
            {
              workflow_id: 88, execution_id: 402, status: 'failed', parent_item_index: 1,
              trace_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
              root_trace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', error: 'temporary child failure',
              started_at: '2026-08-22T16:00:01.000Z', retry_of_execution_id: null,
            },
            ...(recovered ? [{
              workflow_id: 88, execution_id: 403, status: 'completed', parent_item_index: 1,
              trace_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              root_trace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', error: null,
              started_at: '2026-08-22T16:01:00.000Z', retry_of_execution_id: 402,
            }] : []),
          ],
        },
      };
    });
    mocks.post.mockImplementation(async (path: string) => {
      expect(path).toBe('/api/workflows/161/runs/36/steps/foreach/items/1/retry');
      recovered = true;
      return {
        executionId: 403,
        traceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        status: 'running',
      };
    });
    useExecutionStore.getState().selectRun(36, 'completed', '2026-08-22T16:00:00.000Z');
    renderLog();

    fireEvent.click(await screen.findByText('Process child workflows'));
    expect(await screen.findByRole('button', { name: 'Retry item 2' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry item 2' }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('recovered')).toBeInTheDocument();
    expect(screen.getByText('Run #403')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry item 2' })).not.toBeInTheDocument();
  });
});
