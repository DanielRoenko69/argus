import { buildWorkflowRetryPlan } from '../executionRetry.js';
import type { StepResult, WorkflowStep } from '../types.js';

const steps: WorkflowStep[] = [
  { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
  {
    id: 'read_issue', label: 'Read issue', type: 'argus.tool', tool: 'github_issue_read', depends_on: ['start'],
    args: { owner: '{{ input.repository_owner }}', repo: '{{ input.repository_name }}' },
  },
  {
    id: 'triage', label: 'Triage', type: 'argus.agent', agent_id: 4, depends_on: ['read_issue'],
    args: { prompt: '{{ steps.read_issue.result }}' },
  },
  {
    id: 'notify', label: 'Notify', type: 'argus.tool', tool: 'slack_post_message', depends_on: ['triage'],
    args: { channel: '{{ input.notification_channel }}', text: '{{ steps.triage.result }}' },
  },
  { id: 'response', label: 'Response', type: 'logic.response', depends_on: ['notify'], args: { value: '{{ steps.notify.result }}' } },
];

const completed = (result: string): StepResult => ({ status: 'completed', result, duration_ms: 1 });
const sourceResults: Record<string, StepResult> = {
  start: completed('{}'),
  read_issue: completed('issue'),
  triage: completed('triage'),
  notify: { status: 'failed', error: 'channel_not_found', duration_ms: 2 },
};
const sourceInputs = {
  repository_owner: 'argus-project',
  repository_name: 'argus_core',
  notification_channel: 'C_ARGUS_INVALID_E2E',
};

describe('buildWorkflowRetryPlan', () => {
  it('reuses successful predecessors and retries the failed step plus its descendants', () => {
    const plan = buildWorkflowRetryPlan(steps, sourceResults, sourceInputs, sourceInputs);

    expect(plan.failedStepIds).toEqual(['notify']);
    expect(plan.reusedStepIds).toEqual(['start', 'read_issue', 'triage']);
    expect(plan.retryStepIds).toEqual(['notify', 'response']);
    expect(Object.keys(plan.checkpoint)).toEqual(['start', 'read_issue', 'triage']);
  });

  it('keeps the GitHub and Agent checkpoints when only the Slack channel changes', () => {
    const plan = buildWorkflowRetryPlan(steps, sourceResults, sourceInputs, {
      ...sourceInputs,
      notification_channel: 'C0123456789',
    });

    expect(plan.changedInputNames).toEqual(['notification_channel']);
    expect(plan.reusedStepIds).toEqual(['start', 'read_issue', 'triage']);
    expect(plan.retryStepIds).toEqual(['notify', 'response']);
  });

  it('invalidates an affected upstream step and all downstream steps', () => {
    const plan = buildWorkflowRetryPlan(steps, sourceResults, sourceInputs, {
      ...sourceInputs,
      repository_owner: 'another-owner',
    });

    expect(plan.reusedStepIds).toEqual(['start']);
    expect(plan.retryStepIds).toEqual(['read_issue', 'triage', 'notify', 'response']);
  });

  it('refuses a retry after the failed node was removed from the workflow', () => {
    expect(() => buildWorkflowRetryPlan(
      steps.filter(step => step.id !== 'notify'),
      sourceResults,
      sourceInputs,
      sourceInputs,
    )).toThrow('workflow changed after the failed run');
  });
});
