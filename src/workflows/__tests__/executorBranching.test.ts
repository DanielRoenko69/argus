import { describe, expect, it } from '@jest/globals';
import { executeWorkflow } from '../executor.js';
import type { ToolRunner, WorkflowRow, WorkflowStep } from '../types.js';

function branchingWorkflow(): WorkflowRow {
  const steps: WorkflowStep[] = [
    { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
    {
      id: 'condition',
      label: 'Approved?',
      type: 'logic.condition',
      condition: 'input.approved === true',
      args: { true_target: 'router', false_target: 'rejected' },
      depends_on: ['start'],
    },
    {
      id: 'router',
      label: 'Route mode',
      type: 'logic.router',
      args: {
        route_on: '{{ input.route }}',
        routes: { alpha: 'parallel', beta: 'route_b' },
        default_route: 'route_b',
      },
      depends_on: ['condition'],
    },
    {
      id: 'rejected',
      label: 'Rejected path',
      type: 'logic.response',
      args: { value: 'rejected' },
      depends_on: ['condition'],
    },
    { id: 'parallel', label: 'Parallel fan-out', type: 'logic.parallel', args: {}, depends_on: ['router'] },
    {
      id: 'route_b',
      label: 'Beta path',
      type: 'logic.response',
      args: { value: 'beta' },
      depends_on: ['router'],
    },
    {
      id: 'branch_a',
      label: 'Parallel A',
      type: 'argus.tool',
      tool: 'branch_a',
      args: {},
      depends_on: ['parallel'],
    },
    {
      id: 'branch_b',
      label: 'Parallel B',
      type: 'argus.tool',
      tool: 'branch_b',
      args: {},
      depends_on: ['parallel'],
    },
    {
      id: 'join',
      label: 'Join',
      type: 'logic.response',
      args: { value: 'joined' },
      depends_on: ['branch_a', 'branch_b', 'route_b', 'rejected'],
    },
  ];
  return {
    id: 700,
    name: 'branching_e2e',
    description: 'Condition, Router, Parallel and Join validation',
    steps,
    input_params: [],
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

describe('workflow Condition, Router and Parallel semantics', () => {
  it('executes only the selected route and runs fan-out siblings concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const toolRunner: ToolRunner = async tool => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return { content: [{ type: 'text', text: tool }] };
    };

    const result = await executeWorkflow({
      workflow: branchingWorkflow(),
      inputs: { approved: true, route: 'alpha' },
      toolRunner,
      executionId: 7001,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['condition']?.result).toEqual({ matched: true, selected_target: 'router' });
    expect(result.stepResults['router']?.result).toEqual({ route: 'alpha', selected_target: 'parallel' });
    expect(result.stepResults['rejected']?.status).toBe('skipped');
    expect(result.stepResults['route_b']?.status).toBe('skipped');
    expect(result.stepResults['branch_a']?.status).toBe('completed');
    expect(result.stepResults['branch_b']?.status).toBe('completed');
    expect(result.stepResults['join']?.status).toBe('completed');
    expect(maxActive).toBe(2);
  });

  it('propagates an unselected condition branch while allowing the join to complete', async () => {
    let toolCalls = 0;
    const toolRunner: ToolRunner = async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: 'unexpected' }] };
    };

    const result = await executeWorkflow({
      workflow: branchingWorkflow(),
      inputs: { approved: false, route: 'alpha' },
      toolRunner,
      executionId: 7002,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['condition']?.result).toEqual({ matched: false, selected_target: 'rejected' });
    expect(result.stepResults['rejected']?.status).toBe('completed');
    expect(result.stepResults['router']?.status).toBe('skipped');
    expect(result.stepResults['parallel']?.status).toBe('skipped');
    expect(result.stepResults['route_b']?.status).toBe('skipped');
    expect(result.stepResults['branch_a']?.status).toBe('skipped');
    expect(result.stepResults['branch_b']?.status).toBe('skipped');
    expect(result.stepResults['join']?.status).toBe('completed');
    expect(toolCalls).toBe(0);
  });

  it('uses the configured Router default without executing the other branch', async () => {
    let toolCalls = 0;
    const toolRunner: ToolRunner = async () => {
      toolCalls += 1;
      return { content: [{ type: 'text', text: 'unexpected' }] };
    };

    const result = await executeWorkflow({
      workflow: branchingWorkflow(),
      inputs: { approved: true, route: 'unknown' },
      toolRunner,
      executionId: 7003,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['router']?.result).toEqual({ route: 'unknown', selected_target: 'route_b' });
    expect(result.stepResults['parallel']?.status).toBe('skipped');
    expect(result.stepResults['route_b']?.status).toBe('completed');
    expect(result.stepResults['branch_a']?.status).toBe('skipped');
    expect(result.stepResults['branch_b']?.status).toBe('skipped');
    expect(result.stepResults['join']?.status).toBe('completed');
    expect(toolCalls).toBe(0);
  });
});
