import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowState, WorkflowAgentPreflight } from '@/api/workflows';
import type { WorkflowResourcePreflight } from '@/api/builder';
import { RunModal } from './RunModal';

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  retry: vi.fn(),
  packRun: vi.fn(),
  refetch: vi.fn(),
  resourceRefetch: vi.fn(),
  navigateToReplay: vi.fn(),
  preflight: null as WorkflowAgentPreflight | null,
  resourcePreflight: null as WorkflowResourcePreflight | null,
  flow: {
    id: 9, name: 'delivery', description: '',
    steps: [
      { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: {} },
      { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['plan'], args: { value: '{{ steps.plan.result }}' } },
    ],
    input_params: [], canvas_state: {}, trigger_config: {}, block_definitions: [],
    source: 'visual', enabled: true, updated_at: '2026-08-20T10:00:00.000Z',
  } as FlowState,
}));

vi.mock('@/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/workflows')>();
  return {
    ...actual,
    useFlow: () => ({ data: mocks.flow }),
    useWorkflowAgentPreflight: () => ({
      data: mocks.preflight,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: mocks.refetch,
    }),
  };
});

vi.mock('@/api/execution', () => ({
  useExecuteWorkflow: () => ({ mutateAsync: mocks.execute, isPending: false, isError: false }),
  useRetryWorkflow: () => ({ mutateAsync: mocks.retry, isPending: false, isError: false }),
  usePackRunWorkflow: () => ({ mutateAsync: mocks.packRun, isPending: false, isError: false }),
}));

vi.mock('@/api/builder', () => ({
  useWorkflowResourcePreflight: () => ({
    data: mocks.resourcePreflight,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: mocks.resourceRefetch,
  }),
}));

vi.mock('@/api/stats', () => ({
  useCostPredict: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/studioBridge', () => ({
  navigateToWorkflowReplay: mocks.navigateToReplay,
}));

function preflight(ready: boolean): WorkflowAgentPreflight {
  return {
    workflowId: 9, workflowName: 'delivery', checkedAt: '2026-08-20T10:00:00.000Z',
    ready, inferredLegacyContract: false,
    blockers: ready ? [] : ['Planner runtime is not authenticated'], warnings: [],
    assignments: ready ? [{
      role: 'planner', label: 'Planner', stepIds: ['plan'], status: 'ready',
      agentId: 4, agentName: 'planner', agentLabel: 'Planner', agentMode: 'worker',
      model: 'gpt-5.6-terra', presetName: null, installedPresetVersion: null,
      requiredPresetVersion: null, skillNames: [], bundleIds: [], toolNames: [],
      runtime: { type: 'codex', profileLabel: 'Codex Terra', state: 'ready', detail: 'Ready' },
      blockers: [], warnings: [],
    }] : [],
  };
}

function resourcePreflight(ready = true): WorkflowResourcePreflight {
  return {
    workflowId: 9, workflowName: 'delivery', checkedAt: '2026-08-20T10:00:00.000Z', ready,
    errors: [], warnings: [], blockers: ready ? [] : ['Notify: Slack is not connected in MCP Fabric.'],
    tools: ready ? [] : [{
      stepId: 'notify', stepLabel: 'Notify Slack', status: 'blocked', toolName: 'slack_post_message',
      actionLabel: 'Post Message', integrationId: 'slack', integrationLabel: 'Slack', integrationBrand: null,
      connectionName: null, access: 'write', riskLevel: 'medium', missingParameters: [],
      issue: 'Slack is not connected in MCP Fabric.', configureHref: '/mcp-fabric?catalog=ref-slack',
    }],
  };
}

describe('RunModal Agent preflight gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.flow = {
      id: 9, name: 'delivery', description: '',
      steps: [
        { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: {} },
        { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['plan'], args: { value: '{{ steps.plan.result }}' } },
      ],
      input_params: [], canvas_state: {}, trigger_config: {}, block_definitions: [],
      source: 'visual', enabled: true, updated_at: '2026-08-20T10:00:00.000Z',
    } as FlowState;
    mocks.preflight = preflight(true);
    mocks.resourcePreflight = resourcePreflight(true);
    mocks.refetch.mockImplementation(async () => ({ isError: false, data: mocks.preflight }));
    mocks.resourceRefetch.mockImplementation(async () => ({ isError: false, data: mocks.resourcePreflight }));
    mocks.execute.mockResolvedValue({ executionId: 12 });
    mocks.retry.mockResolvedValue({
      executionId: 17, retryOfExecutionId: 16, failedStepIds: ['notify'],
      retryStepIds: ['notify', 'response'], reusedStepIds: ['start', 'read_issue', 'triage'],
      changedInputNames: ['notification_channel'],
    });
    mocks.packRun.mockResolvedValue({
      taskId: '22222222-2222-4222-8222-222222222222',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      workflowThreadId: '11111111-1111-4111-8111-111111111111',
      status: 'TASK_STATE_WORKING',
      spec: { id: 'visual-9-delivery', label: 'Delivery', revision: 4 },
      publication: { workflowId: 'visual-9-delivery', revision: 4 },
      task: { id: '22222222-2222-4222-8222-222222222222', status: { state: 'TASK_STATE_WORKING' } },
    });
  });

  it('blocks execution and explains the first Agent contract blocker', () => {
    mocks.preflight = preflight(false);
    render(<RunModal open workflowId={9} onClose={() => undefined} />);

    expect(screen.getByText('Agent Contract blockiert')).toBeInTheDocument();
    expect(screen.getByText('Planner runtime is not authenticated')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Starten' })).toBeDisabled();
  });

  it('collects Fabric blockers and links to the affected connection', () => {
    mocks.resourcePreflight = resourcePreflight(false);
    render(<RunModal open workflowId={9} onClose={() => undefined} />);

    expect(screen.getByText('Start-Preflight blockiert')).toBeInTheDocument();
    expect(screen.getByText('Slack is not connected in MCP Fabric.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Fabric/ })).toHaveAttribute('href', '/mcp-fabric?catalog=ref-slack');
    expect(screen.getByRole('button', { name: 'Starten' })).toBeDisabled();
  });

  it('rechecks a ready contract immediately before starting execution', async () => {
    const onClose = vi.fn();
    render(<RunModal open workflowId={9} onClose={onClose} />);

    expect(screen.getByText('Agent Contract bereit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Starten' }));

    await waitFor(() => expect(mocks.refetch).toHaveBeenCalledTimes(1));
    expect(mocks.resourceRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.execute).toHaveBeenCalledWith({ workflowId: 9, input: {}, mock: false });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('publishes the saved graph and hands the accepted Pack thread to live replay', async () => {
    const onClose = vi.fn();
    render(<RunModal open workflowId={9} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: /Argus\.Dev/ }));
    fireEvent.click(screen.getByRole('button', { name: 'In Argus.Dev starten' }));

    await waitFor(() => expect(mocks.packRun).toHaveBeenCalledWith({ workflowId: 9, input: {} }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.navigateToReplay).toHaveBeenCalledWith(
      9,
      '11111111-1111-4111-8111-111111111111',
    );
  });

  it('runs a Fabric tool and approval workflow in Core instead of sending an incompatible Pack run', async () => {
    mocks.flow = {
      ...mocks.flow,
      name: 'github_issue_triage_slack',
      steps: [
        { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
        { id: 'read', label: 'Read issue', type: 'argus.tool', tool: 'github_issue_read', depends_on: ['start'], args: {} },
        { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', depends_on: ['read'], args: {} },
        { id: 'approval', label: 'Approve', type: 'argus.approval', depends_on: ['plan'], args: {} },
        { id: 'notify', label: 'Notify', type: 'argus.tool', tool: 'slack_post_message', depends_on: ['approval'], args: {} },
        { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['notify'], args: {} },
      ],
    } as FlowState;
    const onClose = vi.fn();
    render(<RunModal open workflowId={9} onClose={onClose} />);

    expect(screen.getByRole('button', { name: /Argus Core/ })).toBeEnabled();
    const packButton = screen.getByRole('button', { name: /Argus\.Dev/ });
    expect(packButton).toBeDisabled();
    expect(packButton).toHaveAttribute('title', expect.stringContaining('argus.tool'));

    fireEvent.click(screen.getByRole('button', { name: 'Starten' }));
    await waitFor(() => expect(mocks.execute).toHaveBeenCalledWith({ workflowId: 9, input: {}, mock: false }));
    expect(mocks.packRun).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts a checkpoint retry with corrected inputs instead of executing the full workflow', async () => {
    mocks.flow = {
      ...mocks.flow,
      input_params: [{
        name: 'notification_channel', type: 'string', required: true,
        description: 'Slack channel ID',
      }],
    } as FlowState;
    const onClose = vi.fn();
    render(
      <RunModal
        open
        workflowId={9}
        retryRunId={16}
        retryStepIds={['notify', 'response']}
        prefill={{ notification_channel: 'C_ARGUS_INVALID_E2E' }}
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Run #16 ab Fehler fortsetzen' })).toBeInTheDocument();
    expect(screen.getByLabelText('Checkpoint retry summary')).toHaveTextContent('notify, response');
    fireEvent.change(screen.getByRole('textbox', { name: /notification_channel/ }), {
      target: { value: 'C0123456789' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Retry starten' }));

    await waitFor(() => expect(mocks.retry).toHaveBeenCalledWith({
      workflowId: 9,
      runId: 16,
      input: { notification_channel: 'C0123456789' },
    }));
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.packRun).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
