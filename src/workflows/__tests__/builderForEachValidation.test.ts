import { describe, expect, it } from '@jest/globals';
import { validateWorkflowSteps } from '../builderRoutes.js';
import type { WorkflowStep } from '../types.js';

function validate(step: WorkflowStep) {
  return validateWorkflowSteps([step]);
}

describe('visual For Each validation', () => {
  it('accepts a bounded transform and a dynamic item binding', () => {
    const result = validate({
      id: 'foreach', label: 'Transform items', type: 'logic.for_each',
      function_code: 'return { index, item };',
      args: {
        mode: 'transform', items: '{{ steps.table.result }}', concurrency: 4,
        retries: 0, on_item_error: 'continue',
      },
    });
    expect(result.valid).toBe(true);
  });

  it('requires mode-specific configuration and bounded execution controls', () => {
    const result = validate({
      id: 'foreach', label: 'Broken loop', type: 'logic.for_each',
      args: {
        mode: 'subworkflow', items: '{}', target_workflow_id: 0,
        child_inputs: '[]', concurrency: 17, retries: 4, on_item_error: 'ignore',
      },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map(error => error.issue)).toEqual(expect.arrayContaining([
      'For Each items must resolve to a JSON array',
      'For Each subworkflow mode missing valid `target_workflow_id`',
      'Variables must resolve to a JSON object',
      'For Each concurrency must be an integer from 1 to 16',
      'For Each retries must be an integer from 0 to 3',
      "For Each on_item_error must be 'stop' or 'continue'",
    ]));
  });

  it('warns when a sub-workflow retry may repeat non-idempotent effects', () => {
    const result = validate({
      id: 'foreach', label: 'Retry children', type: 'logic.for_each',
      args: {
        mode: 'subworkflow', items: '[1,2]', target_workflow_id: 44,
        concurrency: 2, retries: 1, on_item_error: 'stop',
      },
    });
    expect(result.valid).toBe(true);
    expect(result.warnings.map(warning => warning.issue)).toContain(
      'For Each sub-workflow retries require an idempotent child workflow',
    );
  });
});
