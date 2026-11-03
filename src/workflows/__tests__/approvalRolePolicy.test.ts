import {
  canDecideWorkflowReview,
  canOverrideWorkflowFourEyes,
  canSubmitWorkflowForReview,
} from '../approvalRoutes.js';

describe('workflow approval role policy', () => {
  it('requires developer rights to submit a workflow', () => {
    expect(canSubmitWorkflowForReview('developer')).toBe(true);
    expect(canSubmitWorkflowForReview('agent_operator')).toBe(false);
    expect(canSubmitWorkflowForReview('viewer')).toBe(false);
  });

  it('lets operators and higher roles decide reviews', () => {
    expect(canDecideWorkflowReview('agent_operator')).toBe(true);
    expect(canDecideWorkflowReview('developer')).toBe(true);
    expect(canDecideWorkflowReview('viewer')).toBe(false);
    expect(canDecideWorkflowReview('chat_user')).toBe(false);
  });

  it('reserves four-eyes overrides for platform admins', () => {
    expect(canOverrideWorkflowFourEyes('platform_admin')).toBe(true);
    expect(canOverrideWorkflowFourEyes('admin')).toBe(true);
    expect(canOverrideWorkflowFourEyes('operations_admin')).toBe(false);
  });
});
