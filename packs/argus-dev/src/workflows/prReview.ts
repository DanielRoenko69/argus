/**
 * Pull-request review workflow.
 *
 * Starts from an existing PR instead of a ticket and produces governed review,
 * test and human-approval evidence. The final node deliberately creates a
 * release handoff rather than merging by itself; repository writes remain an
 * explicit future workflow with its own policy boundary.
 */

import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { callAgent, resolveAgentId } from '../argus.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { WorkflowState } from '../state.js';
import { postWorkflowScore, upsertWorkflowTrace } from '../utils/langfuse.js';
import { codingCheckpointer } from './coding.js';

const AGENT_ID_ENV = {
  researcher: process.env['RESEARCHER_AGENT_ID'],
  coder: process.env['CODER_AGENT_ID'],
  reviewer: process.env['REVIEWER_AGENT_ID'],
};

/** Bound the interactive fix/re-review loop so a PR cannot run forever. */
export const MAX_PR_REVIEW_RETRIES = 3;

function prLabel(state: typeof WorkflowState.State): string {
  return `${state.repository}#${state.pull_request_number}`;
}

async function inspectPullRequestNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: `PR-${state.pull_request_number}`,
      workflow: 'pull_request_review',
    });
  }
  const prompt =
    `You are a read-only pull-request inspection agent.\n\n` +
    `Repository: ${state.repository}\n` +
    `Pull request: #${state.pull_request_number}\n` +
    `Review goal: ${state.review_goal || 'Validate correctness, safety and release readiness.'}\n\n` +
    `Use only the scoped Git and repository-read capabilities available to you. ` +
    `Inspect the PR metadata, changed files, commits and diff. Do not modify, approve, merge or comment on the PR. ` +
    `Return a concise evidence report with changed files, risk areas and recommended tests.`;

  const agentId = await resolveAgentId('researcher', AGENT_ID_ENV.researcher);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'inspect_pr',
    state.workspace_dir || '/workspace',
  );
  return {
    context: result.response,
    plan: `Review ${prLabel(state)} against: ${state.review_goal || 'correctness, safety and release readiness'}`,
    log: [{ step: 'inspect_pull_request', summary: result.response.slice(0, 140) + '…' }],
  };
}

async function runPullRequestTestsNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `Validate the existing pull request ${prLabel(state)} without changing its code.\n\n` +
    `Inspection evidence:\n${state.context}\n\n` +
    `Use the scoped workspace and repository tools to check out the PR revision and run the smallest relevant test set. ` +
    `Do not commit, push, approve or merge anything. Summarize commands and results. ` +
    `At the very end output exactly TEST_VERDICT: PASS or TEST_VERDICT: FAIL.`;

  const agentId = await resolveAgentId('coder', AGENT_ID_ENV.coder);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'run_tests',
    state.workspace_dir || '/workspace',
  );
  const passed = /TEST_VERDICT:\s*PASS/i.test(result.response);
  return {
    test_output: result.response,
    tests_passed: passed,
    log: [{ step: 'run_tests', summary: `${passed ? '✓' : '✗'} PR tests ${passed ? 'passed' : 'failed'}` }],
  };
}

async function reviewPullRequestNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are the final code-review agent for ${prLabel(state)}.\n\n` +
    `Goal: ${state.review_goal || 'Validate correctness, safety and release readiness.'}\n\n` +
    `Inspection evidence:\n${state.context}\n\n` +
    `Test evidence:\n${state.test_output}\n\n` +
    formatHumanChangeRequestForReviewer(state.human_change_request) +
    `Produce a concise governed review with blockers, non-blocking findings and a release recommendation. ` +
    `At the very end output exactly VERDICT: APPROVED or VERDICT: REJECTED.`;

  const agentId = await resolveAgentId('reviewer', AGENT_ID_ENV.reviewer);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'review',
    state.workspace_dir || '/workspace',
  );
  const passed = result.response.includes('VERDICT: APPROVED');
  return {
    review: result.response,
    review_passed: passed,
    log: [{ step: 'review_pull_request', summary: `${passed ? '✓' : '✗'} reviewer ${passed ? 'approved' : 'rejected'} the PR` }],
  };
}

async function fixPullRequestNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const attempt = state.retry_count + 1;
  const prompt =
    `You are the implementation agent fixing an existing pull request after human review.\n\n` +
    `Repository: ${state.repository}\n` +
    `Pull request: #${state.pull_request_number}\n` +
    `Review goal: ${state.review_goal || 'Validate correctness, safety and release readiness.'}\n\n` +
    `Human change request (mandatory):\n${state.human_change_request || state.human_feedback || 'Re-check the reviewer findings and make the smallest safe correction.'}\n\n` +
    `Previous inspection evidence:\n${state.context}\n\n` +
    `Previous reviewer evidence:\n${state.review}\n\n` +
    `This is fix attempt ${attempt} of ${MAX_PR_REVIEW_RETRIES}. Work only in the scoped PR workspace/repository. ` +
    `Inspect the current PR revision first, then make the smallest focused changes that satisfy the human request. ` +
    `Use workspace_write for every changed file and leave a concise summary. Do not commit, push, merge, approve or create a new PR. ` +
    `If the request cannot be safely implemented in the available workspace, explain why and output exactly FIX_VERDICT: BLOCKED. ` +
    `Otherwise output exactly FIX_VERDICT: APPLIED at the very end.`;

  const agentId = await resolveAgentId('coder', AGENT_ID_ENV.coder);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'fix_pr',
    state.workspace_dir || '/workspace',
  );
  const applied = /FIX_VERDICT:\s*APPLIED/i.test(result.response);
  return {
    fix_output: result.response,
    fix_applied: applied,
    retry_count: attempt,
    tests_passed: false,
    review_passed: false,
    human_approved: false,
    pr_approved: false,
    log: [{ step: 'fix_pull_request', summary: `${applied ? 'âœ“' : 'âœ—'} PR fix attempt ${attempt} ${applied ? 'applied' : 'blocked'}` }],
  };
}

async function approvePullRequestNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'pr_review_approval',
    message: `Review evidence for ${prLabel(state)} is ready. Approve the governed continuation?`,
    repository: state.repository,
    pull_request_number: state.pull_request_number,
    tests_passed: state.tests_passed,
    review_passed: state.review_passed,
    review_summary: state.review.slice(0, 600),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = decision?.feedback ?? '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({
      threadId,
      name: 'human_pr_review_approval',
      value: approved ? 1 : 0,
      comment: feedback || (approved ? 'PR continuation approved' : 'PR continuation rejected'),
    });
  }
  return {
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: extractHumanChangeRequest(decision),
    log: [{ step: 'human_approval', summary: approved ? '✓ continuation approved' : `✗ continuation rejected — ${feedback.slice(0, 100)}` }],
  };
}

async function createReleaseHandoffNode(state: typeof WorkflowState.State) {
  const action = state.next_action === 'approval_evidence' ? 'approval evidence' : 'release handoff';
  const summary = `${prLabel(state)} passed the governed review boundary. Argus produced ${action}; no merge was executed automatically.`;
  return {
    pr_approved: true,
    delivery_summary: summary,
    log: [{ step: 'release_handoff', summary: `✓ ${summary}` }],
  };
}

function routeAfterApproval(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'release_handoff';
  if (state.human_change_request && state.retry_count < MAX_PR_REVIEW_RETRIES) return 'fix_pull_request';
  return END;
}

function routeAfterFix(state: typeof WorkflowState.State): string {
  return state.fix_applied ? 'run_tests' : END;
}

export { routeAfterApproval };

export const pullRequestReviewWorkflow = new StateGraph(WorkflowState)
  .addNode('inspect_pull_request', inspectPullRequestNode)
  .addNode('run_tests', runPullRequestTestsNode)
  .addNode('review_pull_request', reviewPullRequestNode)
  .addNode('human_approval', approvePullRequestNode)
  .addNode('fix_pull_request', fixPullRequestNode)
  .addNode('release_handoff', createReleaseHandoffNode)
  .addEdge(START, 'inspect_pull_request')
  .addEdge('inspect_pull_request', 'run_tests')
  .addEdge('run_tests', 'review_pull_request')
  .addEdge('review_pull_request', 'human_approval')
  .addConditionalEdges('human_approval', routeAfterApproval)
  .addConditionalEdges('fix_pull_request', routeAfterFix)
  .addEdge('release_handoff', END)
  .compile({ checkpointer: codingCheckpointer });
