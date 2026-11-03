import { describe, expect, it } from '@jest/globals';
import { executeWorkflow, SubWorkflowExecutionError } from '../executor.js';
import type { StepRunners } from '../executor.js';
import type { ToolRunner, WorkflowRow, WorkflowStep } from '../types.js';

const noTools: ToolRunner = async () => {
  throw new Error('For Each workflow must not call a tool');
};

function workflow(steps: WorkflowStep[]): WorkflowRow {
  return {
    id: 720,
    name: 'for_each_e2e',
    description: 'Bounded item processing validation',
    steps,
    input_params: [],
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

function transformStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'foreach',
    label: 'Process items',
    type: 'logic.for_each',
    function_code: 'return { id: item.id, position: index + 1, score: item.score * input.multiplier };',
    args: {
      mode: 'transform',
      items: '{{ input.items }}',
      concurrency: 2,
      retries: 0,
      on_item_error: 'stop',
    },
    ...overrides,
  };
}

describe('For Each workflow execution', () => {
  it('transforms items and retains deterministic input order', async () => {
    const result = await executeWorkflow({
      workflow: workflow([
        transformStep(),
        {
          id: 'table', label: 'Results', type: 'logic.table',
          args: { rows: '{{ steps.foreach.result.results }}' }, depends_on: ['foreach'],
        },
        {
          id: 'response', label: 'Response', type: 'logic.response',
          args: { value: '{{ steps.foreach.result.values }}' }, depends_on: ['table'],
        },
      ]),
      inputs: {
        multiplier: 3,
        items: [{ id: 'api', score: 2 }, { id: 'worker', score: 5 }, { id: 'web', score: 1 }],
      },
      toolRunner: noTools,
      executionId: 7201,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['foreach']?.result).toMatchObject({ total: 3, succeeded: 3, failed: 0 });
    expect((result.stepResults['foreach']?.result as { values: unknown[] }).values).toEqual([
      { id: 'api', position: 1, score: 6 },
      { id: 'worker', position: 2, score: 15 },
      { id: 'web', position: 3, score: 3 },
    ]);
    expect(result.stepResults['response']?.result).toEqual([
      { id: 'api', position: 1, score: 6 },
      { id: 'worker', position: 2, score: 15 },
      { id: 'web', position: 3, score: 3 },
    ]);
  });

  it('records item failures and continues when configured', async () => {
    const result = await executeWorkflow({
      workflow: workflow([transformStep({
        function_code: 'if (item.fail) throw new Error("invalid item"); return item.id;',
        args: {
          mode: 'transform', items: '{{ input.items }}', concurrency: 2,
          retries: 0, on_item_error: 'continue',
        },
      })]),
      inputs: { items: [{ id: 'first' }, { id: 'bad', fail: true }, { id: 'last' }] },
      toolRunner: noTools,
      executionId: 7202,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['foreach']?.result).toEqual({
      total: 3,
      succeeded: 2,
      failed: 1,
      results: [
        { index: 0, status: 'completed', attempts: 1, value: 'first' },
        { index: 1, status: 'failed', attempts: 1, error: 'invalid item' },
        { index: 2, status: 'completed', attempts: 1, value: 'last' },
      ],
      values: ['first', null, 'last'],
    });
  });

  it('fails the workflow on the first terminal item error in stop mode', async () => {
    const result = await executeWorkflow({
      workflow: workflow([transformStep({
        function_code: 'throw new Error(`broken-${index}`);',
        args: { mode: 'transform', items: '[1,2]', concurrency: 1, retries: 1, on_item_error: 'stop' },
      })]),
      inputs: {},
      toolRunner: noTools,
      executionId: 7203,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.stepResults['foreach']?.error).toContain('For Each item 0 failed after 2 attempts: broken-0');
  });

  it('limits concurrent sub-workflows and passes isolated item context', async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: Array<{ targetId: number; input: Record<string, unknown> }> = [];
    const subWorkflowRunner: NonNullable<StepRunners['subWorkflowRunner']> = async (targetId, input) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      calls.push({ targetId, input });
      const index = Number(input['index']);
      await new Promise(resolve => setTimeout(resolve, 12 - index * 2));
      active -= 1;
      return `child-${String(input['item'])}`;
    };
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'foreach', label: 'Child workflows', type: 'logic.for_each',
        args: {
          mode: 'subworkflow', items: ['a', 'b', 'c', 'd'], target_workflow_id: 91,
          child_inputs: { source: 'parent' }, concurrency: 2, retries: 0, on_item_error: 'stop',
        },
      }]),
      inputs: { tenant: 'argus' },
      toolRunner: noTools,
      runners: { subWorkflowRunner },
      executionId: 7204,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(maximumActive).toBe(2);
    expect(calls).toHaveLength(4);
    expect(calls[0]).toEqual({
      targetId: 91,
      input: { source: 'parent', parent_input: { tenant: 'argus' }, item: 'a', index: 0 },
    });
    expect((result.stepResults['foreach']?.result as { values: unknown[] }).values).toEqual([
      'child-a', 'child-b', 'child-c', 'child-d',
    ]);
  });

  it('retries an idempotent sub-workflow per item before succeeding', async () => {
    const attempts = new Map<number, number>();
    const subWorkflowRunner: NonNullable<StepRunners['subWorkflowRunner']> = async (_targetId, input) => {
      const index = Number(input['index']);
      const attempt = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, attempt);
      if (attempt === 1) throw new Error('transient child failure');
      return `ok-${index}`;
    };
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'foreach', label: 'Retry children', type: 'logic.for_each',
        args: {
          mode: 'subworkflow', items: [1, 2], target_workflow_id: 92,
          concurrency: 2, retries: 1, on_item_error: 'stop',
        },
      }]),
      inputs: {},
      toolRunner: noTools,
      runners: { subWorkflowRunner },
      executionId: 7205,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect((result.stepResults['foreach']?.result as { results: Array<{ attempts: number }> }).results)
      .toEqual(expect.arrayContaining([{ index: 0, status: 'completed', attempts: 2, value: 'ok-0' }, { index: 1, status: 'completed', attempts: 2, value: 'ok-1' }]));
  });

  it('keeps child execution evidence separate from the downstream item value', async () => {
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'foreach', label: 'Persist child runs', type: 'logic.for_each',
        args: {
          mode: 'subworkflow', items: ['api', 'worker'], target_workflow_id: 93,
          concurrency: 2, retries: 0, on_item_error: 'stop',
        },
      }]),
      inputs: {},
      toolRunner: noTools,
      runners: {
        subWorkflowRunner: async (targetId, input, invocation) => ({
          output: `processed-${String(input['item'])}`,
          evidence: {
            workflow_id: targetId,
            execution_id: 8100 + Number(input['index']),
            trace_id: `trace-${String(input['index'])}`,
            root_trace_id: 'parent-trace',
            status: 'completed',
          },
          invocation,
        }),
      },
      executionId: 7206,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    const output = result.stepResults['foreach']?.result as {
      results: Array<{ value: string; evidence: { execution_id: number } }>;
      values: string[];
    };
    expect(output.values).toEqual(['processed-api', 'processed-worker']);
    expect(output.results.map(item => item.evidence.execution_id)).toEqual([8100, 8101]);
  });

  it('retains failed child trace evidence for a continued item failure', async () => {
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'foreach', label: 'Persist child failures', type: 'logic.for_each',
        args: {
          mode: 'subworkflow', items: ['broken'], target_workflow_id: 94,
          concurrency: 1, retries: 0, on_item_error: 'continue',
        },
      }]),
      inputs: {},
      toolRunner: noTools,
      runners: {
        subWorkflowRunner: async targetId => {
          throw new SubWorkflowExecutionError('child failed', {
            workflow_id: targetId,
            execution_id: 8200,
            trace_id: 'failed-child-trace',
            root_trace_id: 'parent-trace',
            status: 'failed',
          });
        },
      },
      executionId: 7207,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['foreach']?.result).toMatchObject({
      total: 1,
      failed: 1,
      results: [{
        index: 0,
        status: 'failed',
        evidence: { execution_id: 8200, trace_id: 'failed-child-trace', status: 'failed' },
        attempt_evidence: [{ execution_id: 8200 }],
      }],
    });
  });

  it('keeps an ordinary sub-workflow output backward compatible while storing lineage separately', async () => {
    const result = await executeWorkflow({
      workflow: workflow([
        { id: 'child', label: 'Call child', type: 'argus.workflow', args: { target_workflow_id: 95 } },
        { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['child'], args: { value: '{{ steps.child.result }}' } },
      ]),
      inputs: {},
      toolRunner: noTools,
      runners: {
        subWorkflowRunner: async targetId => ({
          output: 'unchanged-business-output',
          evidence: {
            workflow_id: targetId,
            execution_id: 8300,
            trace_id: 'ordinary-child-trace',
            root_trace_id: 'ordinary-parent-trace',
            status: 'completed',
          },
        }),
      },
      executionId: 7208,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['child']?.result).toBe('unchanged-business-output');
    expect(result.stepResults['response']?.result).toBe('unchanged-business-output');
    expect(result.stepResults['child']?.evidence).toMatchObject({ execution_id: 8300, trace_id: 'ordinary-child-trace' });
  });

  it('keeps an ordinary structured sub-workflow response JSON-compatible', async () => {
    const result = await executeWorkflow({
      workflow: workflow([
        { id: 'child', label: 'Call child', type: 'argus.workflow', args: { target_workflow_id: 96 } },
        { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['child'], args: { value: '{{ steps.child.result }}' } },
      ]),
      inputs: {},
      toolRunner: noTools,
      runners: {
        subWorkflowRunner: async targetId => ({
          output: { status: 'ok', count: 2 },
          evidence: {
            workflow_id: targetId,
            execution_id: 8400,
            trace_id: 'structured-child-trace',
            root_trace_id: 'structured-parent-trace',
            status: 'completed',
          },
        }),
      },
      executionId: 7209,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('completed');
    expect(result.stepResults['child']?.result).toBe('{"status":"ok","count":2}');
    expect(result.stepResults['response']?.result).toBe('{"status":"ok","count":2}');
    expect(result.stepResults['child']?.evidence).toMatchObject({ execution_id: 8400 });
  });
});
