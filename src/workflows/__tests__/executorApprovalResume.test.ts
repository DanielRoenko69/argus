import { describe, expect, it } from '@jest/globals';
import { executeWorkflow } from '../executor.js';
import type { ToolRunner, WorkflowRow } from '../types.js';

function workflow(onError: 'stop' | 'continue' = 'stop'): WorkflowRow {
  return {
    id: 91,
    name: 'approval checkpoint',
    description: '',
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
    input_params: [],
    steps: [
      {
        id: 'vars',
        label: 'Set region',
        type: 'logic.variables',
        args: { variables: { region: 'eu-central-1' } },
      },
      {
        id: 'inspect',
        label: 'Inspect',
        type: 'argus.tool',
        tool: 'inspect_target',
        args: { region: '{{input.region}}' },
        depends_on: ['vars'],
      },
      {
        id: 'deploy',
        label: 'Deploy',
        type: 'argus.tool',
        tool: 'deploy_target',
        args: {
          region: '{{input.region}}',
          inspected: '{{steps.inspect.result}}',
        },
        depends_on: ['inspect'],
        on_error: onError,
      },
      {
        id: 'response',
        label: 'Response',
        type: 'logic.response',
        args: { value: 'deployed {{steps.deploy.result}}' },
        depends_on: ['deploy'],
      },
    ],
  };
}

describe('workflow runtime-approval checkpoints', () => {
  it('pauses and resumes an explicit visual approval step before downstream work', async () => {
    const explicitWorkflow: WorkflowRow = {
      ...workflow(),
      id: 92,
      steps: [
        { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
        {
          id: 'approval', label: 'Approve notification', type: 'argus.approval',
          args: { message: 'Post the triage result?' }, depends_on: ['start'],
        },
        {
          id: 'notify', label: 'Notify', type: 'argus.tool', tool: 'post_message',
          args: { text: 'approved evidence' }, depends_on: ['approval'],
        },
      ],
    };
    let approvalAttempts = 0;
    let notificationCalls = 0;
    const toolRunner: ToolRunner = async () => {
      notificationCalls += 1;
      return { content: [{ type: 'text', text: 'sent' }] };
    };
    const approvalRunner = jest.fn(async () => ({
      decision: approvalAttempts++ === 0 ? 'pending' as const : 'allow' as const,
      requestId: 99,
    }));

    const first = await executeWorkflow({
      workflow: explicitWorkflow,
      inputs: {},
      toolRunner,
      runners: { approvalRunner },
      executionId: 702,
      triggeredBy: 'test',
    });

    expect(first.status).toBe('waiting_for_approval');
    expect(first.approvalRequestId).toBe(99);
    expect(first.waitingStepId).toBe('approval');
    expect(first.stepResults.approval?.status).toBe('waiting');
    expect(notificationCalls).toBe(0);

    const resumed = await executeWorkflow({
      workflow: explicitWorkflow,
      inputs: {},
      toolRunner,
      runners: { approvalRunner },
      executionId: 702,
      triggeredBy: 'test',
      initialStepResults: first.stepResults,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.stepResults.approval?.result).toMatchObject({ approved: true, request_id: 99 });
    expect(resumed.stepResults.notify?.result).toBe('sent');
    expect(approvalRunner).toHaveBeenCalledTimes(2);
    expect(notificationCalls).toBe(1);
  });

  it('resumes only the waiting step and restores variables from the checkpoint', async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown>; stepId?: string }> = [];
    let deployAttempts = 0;
    const runner: ToolRunner = async (tool, args, _cred, meta) => {
      calls.push({ tool, args, stepId: meta?.stepId });
      if (tool === 'deploy_target' && deployAttempts++ === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Runtime human approval #77 is pending' }],
          isError: true,
          approvalRequestId: 77,
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: tool === 'inspect_target' ? 'ready' : 'release-42',
        }],
      };
    };

    const first = await executeWorkflow({
      workflow: workflow(),
      inputs: {},
      toolRunner: runner,
      executionId: 700,
      triggeredBy: 'test',
    });

    expect(first.status).toBe('waiting_for_approval');
    expect(first.approvalRequestId).toBe(77);
    expect(first.waitingStepId).toBe('deploy');
    expect(first.stepResults.vars?.status).toBe('completed');
    expect(first.stepResults.inspect?.status).toBe('completed');
    expect(first.stepResults.deploy?.status).toBe('waiting');
    expect(first.stepResults.response).toBeUndefined();

    const resumed = await executeWorkflow({
      workflow: workflow(),
      inputs: {},
      toolRunner: runner,
      executionId: 700,
      triggeredBy: 'test',
      initialStepResults: first.stepResults,
    });

    expect(resumed.status).toBe('completed');
    expect(resumed.stepResults.response?.result).toBe('deployed release-42');
    expect(calls.filter((call) => call.tool === 'inspect_target')).toHaveLength(1);
    expect(calls.filter((call) => call.tool === 'deploy_target')).toHaveLength(2);
    expect(calls.at(-1)).toEqual({
      tool: 'deploy_target',
      args: { region: 'eu-central-1', inspected: 'ready' },
      stepId: 'deploy',
    });
  });

  it('pauses for approval even when the step error strategy is continue', async () => {
    const runner: ToolRunner = async () => ({
      content: [{ type: 'text', text: 'Runtime human approval #88 is pending' }],
      isError: true,
      approvalRequestId: 88,
    });

    const result = await executeWorkflow({
      workflow: workflow('continue'),
      inputs: {},
      toolRunner: runner,
      executionId: 701,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('waiting_for_approval');
    expect(result.approvalRequestId).toBe(88);
    expect(result.stepResults.response).toBeUndefined();
  });
});
