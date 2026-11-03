import { describe, it, expect } from '@jest/globals';
import type { WorkflowStep } from '../types.js';

describe('WorkflowStep.cred_ref', () => {
  it('accepts an optional cred_ref with bundle_id', () => {
    const step: WorkflowStep = {
      id: 's1',
      label: 'Jira get',
      type: 'argus.tool',
      tool: 'atlassian_jira_get_issue',
      args: { issueKey: '{{input.key}}' },
      cred_ref: { bundle_id: 7 },
    };
    expect(step.cred_ref?.bundle_id).toBe(7);
  });

  it('accepts cred_ref with backend_cred_id and allows omission', () => {
    const withBackend: WorkflowStep = {
      id: 's2', label: 'x', tool: 't', args: {},
      cred_ref: { backend_cred_id: 3 },
    };
    const without: WorkflowStep = { id: 's3', label: 'y', tool: 't', args: {} };
    expect(withBackend.cred_ref?.backend_cred_id).toBe(3);
    expect(without.cred_ref).toBeUndefined();
  });
});
