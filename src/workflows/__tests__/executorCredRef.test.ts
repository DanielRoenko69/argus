import { describe, it, expect, jest } from '@jest/globals';
import { executeWorkflow, type StepCredResolver } from '../executor.js';
import type { WorkflowRow, ToolRunner, WorkflowStep } from '../types.js';

function wf(step: WorkflowStep): WorkflowRow {
  return {
    id: 1, name: 'wf', description: '', steps: [step], input_params: [],
    enabled: true, bundle_ids: [], created_by: null, created_at: '', updated_at: '',
  };
}
const okRunner = (): ReturnType<ToolRunner> =>
  Promise.resolve({ content: [{ type: 'text' as const, text: 'ok' }] });

describe('executor cred_ref resolution', () => {
  it('cred_ref absent → toolRunner called WITHOUT a cred override (service creds)', async () => {
    const calls: Array<unknown[]> = [];
    const toolRunner: ToolRunner = (...args) => { calls.push(args); return okRunner(); };
    const credResolver = jest.fn<StepCredResolver>();

    const res = await executeWorkflow({
      workflow: wf({ id: 's', label: 'l', type: 'argus.tool', tool: 'jira_get', args: {} }),
      inputs: {}, toolRunner, executionId: 1, triggeredBy: null, credResolver,
    });

    expect(res.status).toBe('completed');
    expect(credResolver).not.toHaveBeenCalled();
    expect(calls[0]).toEqual(['jira_get', {}, undefined, { stepId: 's' }]);
  });

  it('cred_ref present + resolver returns token → override passed to toolRunner', async () => {
    const calls: Array<unknown[]> = [];
    const toolRunner: ToolRunner = (...args) => { calls.push(args); return okRunner(); };
    const credResolver = jest.fn<StepCredResolver>(async () => ({ token: 'bundle-tok' }));

    const res = await executeWorkflow({
      workflow: wf({ id: 's', label: 'l', type: 'argus.tool', tool: 'jira_get', args: {}, cred_ref: { bundle_id: 7 } }),
      inputs: {}, toolRunner, executionId: 1, triggeredBy: null, credResolver,
    });

    expect(res.status).toBe('completed');
    expect(credResolver).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(['jira_get', {}, { token: 'bundle-tok' }, { stepId: 's' }]);
  });

  it('cred_ref present but no resolver wired → no override (default path)', async () => {
    const calls: Array<unknown[]> = [];
    const toolRunner: ToolRunner = (...args) => { calls.push(args); return okRunner(); };

    const res = await executeWorkflow({
      workflow: wf({ id: 's', label: 'l', type: 'argus.tool', tool: 'jira_get', args: {}, cred_ref: { bundle_id: 7 } }),
      inputs: {}, toolRunner, executionId: 1, triggeredBy: null,
    });

    expect(res.status).toBe('completed');
    expect(calls[0]).toEqual(['jira_get', {}, undefined, { stepId: 's' }]);
  });
});
