import { interrupt } from '@langchain/langgraph';
import { WorkflowState } from '../state.js';
import { usesQaAcceptance, assertQaCurrent } from '../qaAcceptance.js';
import { resolveAgentId } from '../argus.js';
import { postWorkflowScore } from '../utils/langfuse.js';
import { normalizeRevisionFeedback, normalizeDecisionEvidence } from '../reviewLoop.js';
import { extractHumanChangeRequest } from '../humanFeedback.js';
import { recordRevisionHumanDecision } from '../revisionHistory.js';
import { isImageReviewDelivery } from '../reviewOnlyDelivery.js';
export async function humanApprovalNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string; approvalGrant?: string } },
) {
  if (config?.configurable?.approvalGrant) state = { ...state, argus_execution_grant: config.configurable.approvalGrant };
  if (usesQaAcceptance(state)) await assertQaCurrent(state, config?.configurable?.thread_id ?? '', await resolveAgentId('reviewer', process.env['REVIEWER_AGENT_ID']));
  // Pause the workflow — resumes when caller POSTs to /threads/{id}/runs
  // with { command: { resume: { approved: true/false, feedback?: "..." } } }
  const decision = interrupt({
    message: isImageReviewDelivery(state.delivery_mode)
      ? 'Review the changed code and Reviewer findings. Automated tests were not run. Approval permits commit/push and a Jenkins image build, not merge or deployment.'
      : 'Review the code and test evidence. Approval permits commit/push to the workflow branch and configured CI, not merge or deployment.',
    ticket_id: state.ticket_id,
    plan_summary: state.plan.slice(0, 300),
    review_summary: state.review.slice(0, 300),
    human_change_request: state.human_change_request,
    file_diffs: state.file_diffs,
    review_annotations: state.review_annotations,
  }) as { approved: boolean; feedback?: string };

  if (state.bitbucket_creds?.reference && !config?.configurable?.approvalGrant) throw new Error('Core-bound approval renewal is required.');

  const approved = decision?.approved ?? false;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const changeRequest = normalizeRevisionFeedback(
    approved,
    extractHumanChangeRequest(decision),
    'Human code approval was rejected without additional feedback.',
  );

  // Score Stage 1 in Langfuse
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({
      threadId,
      name:    'human_code_approval',
      value:   approved ? 1 : 0,
      comment: feedback || (approved ? 'Stage 1: Code approved' : 'Stage 1: Code rejected'),
    });
    // Also score test + review quality for analytics
    void postWorkflowScore({ threadId, name: 'tests_passed',     value: state.tests_passed ? 1 : 0 });
    void postWorkflowScore({ threadId, name: 'reviewer_approved', value: state.review_passed ? 1 : 0 });
    void postWorkflowScore({ threadId, name: 'retry_count',       value: state.retry_count });
  }

  return {
    ...(config?.configurable?.approvalGrant ? { argus_execution_grant: config.configurable.approvalGrant } : {}),
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: changeRequest,
    revision_history: recordRevisionHumanDecision(state.revision_history, {
      stage: 'code',
      approved,
      feedback: approved ? feedback : changeRequest,
      recordedAt: new Date().toISOString(),
    }),
    log: [{
      step: 'human',
      summary: approved ? '✓ Human approved' : `✗ Human rejected — ${feedback.slice(0, 80)}`,
    }],
  };
}

/**
 * Stage 2 approval: User decides if the external CI/CD evidence is sufficient
 * and the PR should be created. Argus does not execute the provider pipeline.
 */
export async function humanApprovalPrNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string; approvalGrant?: string } },
) {
  const decision = interrupt({
    message: isImageReviewDelivery(state.delivery_mode)
      ? `Branch pushed: ${state.branch_name}. Verify the Jenkins image build and local image receipt. Automated tests were not run. Approve to create the PR or reject with feedback.`
      : `Branch pushed: ${state.branch_name}. Verify the external CI/CD run and its evidence, then approve to create the PR — or reject to send Coder back with feedback.`,
    stage: 'pr_approval',
    ticket_id: state.ticket_id,
    branch_name: state.branch_name,
    commit_sha: state.commit_sha,
  }) as { approved: boolean; feedback?: string };

  if (state.bitbucket_creds?.reference && !config?.configurable?.approvalGrant) throw new Error('Core-bound approval renewal is required.');

  const approved = decision?.approved ?? false;
  const decisionEvidence = normalizeDecisionEvidence(decision?.feedback);
  const feedback = approved
    ? decisionEvidence
    : normalizeRevisionFeedback(
      false,
      decisionEvidence,
      'Functional approval was rejected without additional feedback.',
    );

  // Score Stage 2 (Functional Approval) in Langfuse
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({
      threadId,
      name:    'human_functional_approval',
      value:   approved ? 1 : 0,
      comment: feedback || (approved
        ? `Stage 2: Functional approved — branch ${state.branch_name}`
        : `Stage 2: Functional rejected — image tested, failed`),
    });
    // Final overall score
    void postWorkflowScore({
      threadId,
      name:    'workflow_success',
      value:   approved ? 1 : 0,
      comment: `Ticket: ${state.ticket_id} | Branch: ${state.branch_name} | Retries: ${state.retry_count}`,
    });
  }

  return {
    ...(config?.configurable?.approvalGrant ? { argus_execution_grant: config.configurable.approvalGrant } : {}),
    pr_approved: approved,
    pr_feedback: feedback,
    revision_history: recordRevisionHumanDecision(state.revision_history, {
      stage: 'functional',
      approved,
      feedback,
      recordedAt: new Date().toISOString(),
    }),
    log: [{
      step: 'human_pr',
      summary: approved ? '✓ PR approved' : `✗ PR rejected — ${feedback.slice(0, 80)}`,
    }],
  };
}
