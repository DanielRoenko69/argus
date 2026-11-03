import { describe, expect, it } from '@jest/globals';
import { validateWorkflowSteps } from '../builderRoutes.js';
import type { WorkflowStep } from '../types.js';

function validate(step: WorkflowStep) {
  return validateWorkflowSteps([step]);
}

describe('visual data transformation validation', () => {
  it('rejects malformed literal Variables and Table data before execution', () => {
    const variables = validate({
      id: 'variables', label: 'Variables', type: 'logic.variables', args: { variables: '[1, 2]' },
    });
    const table = validate({
      id: 'table', label: 'Table', type: 'logic.table', args: { rows: '{"not":"rows"}' },
    });

    expect(variables.valid).toBe(false);
    expect(variables.errors[0]?.issue).toBe('Variables must resolve to a JSON object');
    expect(table.valid).toBe(false);
    expect(table.errors[0]?.issue).toBe('Table rows must resolve to a JSON array');
  });

  it('accepts valid literals and runtime template bindings', () => {
    expect(validate({
      id: 'variables', label: 'Variables', type: 'logic.variables', args: { variables: '{"limit":5}' },
    }).valid).toBe(true);
    expect(validate({
      id: 'table', label: 'Table', type: 'logic.table', args: { rows: '{{ steps.transform.result }}' },
    }).valid).toBe(true);
  });
});
