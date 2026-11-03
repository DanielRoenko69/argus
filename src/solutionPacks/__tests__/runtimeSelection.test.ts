import { describe, expect, it } from '@jest/globals';
import { resolveSolutionPackRuntimeSelection } from '../runtimeSelection.js';
import { runtimeSelectionMetricAttributes } from '../runtimeSelectionTelemetry.js';

describe('Solution Pack runtime selection', () => {
  const codingWorkflow = {
    id: 'ticket-to-pull-request',
    requiredAgents: ['planner', 'coder', 'reviewer'],
    stages: [{ id: 'implement', kind: 'code' }],
  };

  it('routes an automatic coder write stage to Managed Hermes when it is available', () => {
    expect(resolveSolutionPackRuntimeSelection('auto', codingWorkflow, { managedHermesAvailable: true }))
      .toMatchObject({
        requestedMode: 'auto',
        effectiveMode: 'managed-hermes',
        reason: 'workflow_requires_coder_workspace_write',
      });
  });

  it('keeps Auto usable through the normal Agent path when Hermes is not installed', () => {
    expect(resolveSolutionPackRuntimeSelection('auto', codingWorkflow, { managedHermesAvailable: false }))
      .toMatchObject({
        requestedMode: 'auto',
        effectiveMode: 'default',
        reason: 'managed_hermes_unavailable_use_agent_default',
      });
  });

  it('does not allocate Managed Hermes to a read-only planning workflow', () => {
    expect(resolveSolutionPackRuntimeSelection('auto', {
      id: 'backlog-grooming',
      requiredAgents: ['planner', 'researcher'],
      stages: [{ id: 'plan', kind: 'plan' }],
    }, { managedHermesAvailable: true })).toMatchObject({
      effectiveMode: 'default',
      reason: 'workflow_uses_agent_default',
    });
  });

  it('exports only bounded routing dimensions to the OTEL metric', () => {
    const selection = resolveSolutionPackRuntimeSelection('auto', codingWorkflow, { managedHermesAvailable: true });

    expect(runtimeSelectionMetricAttributes(selection, 'workflow.start')).toEqual({
      'argus.runtime.requested': 'auto',
      'argus.runtime.effective': 'managed-hermes',
      'argus.runtime.reason': 'workflow_requires_coder_workspace_write',
      'argus.solution_pack.operation': 'workflow.start',
    });
    expect(runtimeSelectionMetricAttributes(selection, 'workflow.start'))
      .not.toHaveProperty('argus.solution_pack.workflow_id');
  });
});
