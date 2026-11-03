import { describe, expect, it } from '@jest/globals';
import {
  buildRetryInput,
  sanitizeWorkflowInput,
  workflowInputFromState,
} from '../codingRetry.js';

describe('workflow-neutral Argus Dev retries', () => {
  it('preserves pull-request review inputs without promoting historical failures into instructions', () => {
    const original = sanitizeWorkflowInput('pull-request-review', {
      repository: 'argus/core',
      pull_request_number: 42,
      review_goal: 'Check release readiness.',
      next_action: 'release_handoff',
      argus_bundle_id: 7,
      apiToken: 'must-not-persist',
    });

    expect(original).toEqual({
      repository: 'argus/core',
      pull_request_number: 42,
      review_goal: 'Check release readiness.',
      next_action: 'release_handoff',
      argus_bundle_id: 7,
    });
    expect(buildRetryInput('pull-request-review', original, 'Reviewer found a missing migration.')).toMatchObject({
      repository: 'argus/core',
      pull_request_number: 42,
      next_action: 'release_handoff',
      argus_bundle_id: 7,
    });
    expect(buildRetryInput('pull-request-review', original, 'Reviewer found a missing migration.').review_goal)
      .toBe('Check release readiness.');
  });

  it('removes legacy generated retry suffixes without modifying the original object', () => {
    const original = { issue_body: 'Plan GEM.\n\n---\nPrevious attempt failure:\n403\n\nPlease address the failure and rerun the relevant checks.' };
    expect(buildRetryInput('backlog-grooming', original, 'new error').issue_body).toBe('Plan GEM.');
    expect(original.issue_body).toContain('403');
    expect(buildRetryInput('backlog-grooming', { issue_body: 'Explain Previous attempt failure: in the UI.' }, '').issue_body)
      .toBe('Explain Previous attempt failure: in the UI.');
  });

  it('reconstructs legacy CI input from persisted state and retains bundle scope', () => {
    const input = workflowInputFromState('ci-failure-recovery', {
      metadata: { argus_bundle_id: 9 },
      values: {
        ticket_id: 'ARGUS-CI-9',
        repository: 'argus/core',
        branch_name: 'feature/ci-9',
        commit_sha: 'abc123',
        ci_provider: 'gitea',
        ci_workflow: 'checks',
        ci_failure_context: 'test failed',
        argus_execution_grant: 'secret-runtime-token',
      },
    });

    expect(input).toMatchObject({
      ticket_id: 'ARGUS-CI-9',
      repository: 'argus/core',
      branch_name: 'feature/ci-9',
      commit_sha: 'abc123',
      ci_provider: 'gitea',
      ci_workflow: 'checks',
      argus_bundle_id: 9,
    });
    expect(input).not.toHaveProperty('argus_execution_grant');
  });
});
