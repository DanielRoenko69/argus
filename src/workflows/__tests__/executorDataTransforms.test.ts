import { describe, expect, it } from '@jest/globals';
import { executeWorkflow } from '../executor.js';
import type { ToolRunner, WorkflowRow, WorkflowStep } from '../types.js';

const noTools: ToolRunner = async () => {
  throw new Error('data transformation workflow must not call a tool');
};

function workflow(steps: WorkflowStep[]): WorkflowRow {
  return {
    id: 710,
    name: 'data_transform_e2e',
    description: 'Variables, Function, Table and Response validation',
    steps,
    input_params: [],
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

describe('workflow data transformations', () => {
  it('retains typed values through Variables, Function, Table and Response', async () => {
    const result = await executeWorkflow({
      workflow: workflow([
        { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
        {
          id: 'variables',
          label: 'Normalize inputs',
          type: 'logic.variables',
          args: {
            variables: {
              owner: '{{ input.repository_owner }}',
              issue_count: '{{ input.issue_count }}',
              multiplier: 2,
            },
          },
          depends_on: ['start'],
        },
        {
          id: 'transform',
          label: 'Build priority rows',
          type: 'logic.function',
          function_code: `
            return [
              { repository: input.owner, issues: input.issue_count },
              { repository: input.owner + '-docs', issues: input.issue_count + 1 }
            ].map((row, index) => ({
              ...row,
              position: index + 1,
              priority: row.issues * input.multiplier
            }));
          `,
          args: {},
          depends_on: ['variables'],
        },
        {
          id: 'table',
          label: 'Priority table',
          type: 'logic.table',
          args: { rows: '{{ steps.transform.result }}' },
          depends_on: ['transform'],
        },
        {
          id: 'response',
          label: 'Result',
          type: 'logic.response',
          args: { value: '{{ steps.table.result }}' },
          depends_on: ['table'],
        },
      ]),
      inputs: { repository_owner: 'argus', issue_count: 3 },
      toolRunner: noTools,
      executionId: 7101,
      triggeredBy: 'test',
    });

    const expected = [
      { repository: 'argus', issues: 3, position: 1, priority: 6 },
      { repository: 'argus-docs', issues: 4, position: 2, priority: 8 },
    ];
    expect(result.status).toBe('completed');
    expect(result.stepResults['variables']?.result).toEqual({ owner: 'argus', issue_count: 3, multiplier: 2 });
    expect(result.stepResults['transform']?.result).toEqual(expected);
    expect(result.stepResults['table']?.result).toEqual(expected);
    expect(result.stepResults['response']?.result).toEqual(expected);
  });

  it('fails visibly instead of swallowing malformed Variables JSON', async () => {
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'variables',
        label: 'Broken variables',
        type: 'logic.variables',
        args: { variables: '{ invalid' },
      }]),
      inputs: {},
      toolRunner: noTools,
      executionId: 7102,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.stepResults['variables']?.error).toContain('Variables contains invalid JSON');
  });

  it('requires Table data to resolve to an array', async () => {
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'table',
        label: 'Broken table',
        type: 'logic.table',
        args: { rows: { not: 'rows' } },
      }]),
      inputs: {},
      toolRunner: noTools,
      executionId: 7103,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.stepResults['table']?.error).toBe('Table rows must resolve to a JSON array');
  });

  it('blocks Node globals and mutation of Function input snapshots', async () => {
    const globalAccess = await executeWorkflow({
      workflow: workflow([{
        id: 'transform',
        label: 'Unsafe access',
        type: 'logic.function',
        function_code: 'return process.env;',
        args: {},
      }]),
      inputs: {},
      toolRunner: noTools,
      executionId: 7104,
      triggeredBy: 'test',
    });
    const mutation = await executeWorkflow({
      workflow: workflow([{
        id: 'transform',
        label: 'Unsafe mutation',
        type: 'logic.function',
        function_code: 'input.owner = "changed"; return input;',
        args: {},
      }]),
      inputs: { owner: 'argus' },
      toolRunner: noTools,
      executionId: 7105,
      triggeredBy: 'test',
    });

    expect(globalAccess.status).toBe('failed');
    expect(globalAccess.stepResults['transform']?.error).toContain('process is not defined');
    expect(mutation.status).toBe('failed');
    expect(mutation.stepResults['transform']?.error).toContain('read only');
  });

  it('terminates runaway Function code at the controlled timeout', async () => {
    const result = await executeWorkflow({
      workflow: workflow([{
        id: 'transform',
        label: 'Runaway transform',
        type: 'logic.function',
        function_code: 'while (true) {}',
        args: {},
      }]),
      inputs: {},
      toolRunner: noTools,
      executionId: 7106,
      triggeredBy: 'test',
    });

    expect(result.status).toBe('failed');
    expect(result.stepResults['transform']?.error).toContain('timed out after 250ms');
  });
});
