import { describe, expect, it } from '@jest/globals';
import { validateWorkflowSteps } from '../builderRoutes.js';

describe('workflow Agent binding validation', () => {
  it('accepts a portable Agent role without a pinned database id', () => {
    const result = validateWorkflowSteps([{
      id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: {},
    }]);

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a concrete positive Agent id', () => {
    const result = validateWorkflowSteps([{
      id: 'code', label: 'Code', type: 'argus.agent', agent_id: 42, args: {},
    }]);

    expect(result.valid).toBe(true);
  });

  it('blocks an unassigned Agent step and malformed portable roles', () => {
    const missing = validateWorkflowSteps([{
      id: 'review', label: 'Review', type: 'argus.agent', args: {},
    }]);
    const malformed = validateWorkflowSteps([{
      id: 'review', label: 'Review', type: 'argus.agent', agent_role: 'Reviewer Role', args: {},
    }]);

    expect(missing.valid).toBe(false);
    expect(missing.errors[0]?.issue).toContain('agent_role');
    expect(malformed.valid).toBe(false);
    expect(malformed.errors[0]?.issue).toContain('invalid');
  });

  it('validates structured output contracts and their bounded retry budget', () => {
    const valid = validateWorkflowSteps([{
      id: 'review', label: 'Review', type: 'argus.agent', agent_role: 'reviewer', args: {},
      output_contract: 'review_verdict', output_contract_retries: 2,
    }]);
    const invalidContract = validateWorkflowSteps([{
      id: 'review', label: 'Review', type: 'argus.agent', agent_role: 'reviewer', args: {},
      output_contract: 'free_form' as never,
    }]);
    const invalidRetries = validateWorkflowSteps([{
      id: 'review', label: 'Review', type: 'argus.agent', agent_role: 'reviewer', args: {},
      output_contract: 'review_verdict', output_contract_retries: 3,
    }]);

    expect(valid.valid).toBe(true);
    expect(invalidContract.errors[0]?.issue).toContain('output_contract');
    expect(invalidRetries.errors[0]?.issue).toContain('0 to 2');
  });
});
