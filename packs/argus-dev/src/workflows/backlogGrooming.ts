/**
 * Backlog and issue planning workflow.
 *
 * Turns a broad issue/epic into implementation-ready vertical slices without
 * modifying the repository or creating tickets automatically.
 */

import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { callAgent, resolveAgentId } from '../argus.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { WorkflowState } from '../state.js';
import { backlogReviewFeedback, backlogReviewPrompt, BACKLOG_PLANNING_BOUNDARY } from '../backlogReviewFeedback.js';
import { postWorkflowScore, upsertWorkflowTrace } from '../utils/langfuse.js';
import { codingCheckpointer, setupWorkspaceNode } from './coding.js';
import { BACKLOG_REVIEW_MAX_ATTEMPTS } from '../workflowCatalog.js';

const AGENT_ID_ENV = {
  researcher: process.env['RESEARCHER_AGENT_ID'],
  planner: process.env['PLANNER_AGENT_ID'],
  reviewer: process.env['REVIEWER_AGENT_ID'],
};

export const MAX_BACKLOG_GROOMING_RETRIES = BACKLOG_REVIEW_MAX_ATTEMPTS;

function backlogLabel(state: typeof WorkflowState.State): string {
  return state.issue_title || state.backlog_id || 'backlog item';
}

async function seedBacklogNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: state.backlog_id,
      workflow: 'backlog_grooming',
    });
  }
  return {
    ticket_id: state.backlog_id,
    log: [{ step: 'seed_backlog', summary: `Loaded ${backlogLabel(state)}` }],
  };
}

async function researchBacklogNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are a read-only backlog research agent.\n\n` +
    `Repository: ${state.repository}\nBranch: ${state.source_branch}\n` +
    `Issue: ${state.issue_title}\n\nDescription:\n${state.issue_body}\n\n` +
    `Constraints:\n${state.backlog_constraints || 'None provided'}\n` +
    `Audience: ${state.backlog_audience || 'Engineering team'}\n\n` +
    `Inspect the relevant repository structure, existing patterns, tests, interfaces and operational constraints. ` +
    `Do not edit files, create tickets or approve work. Return evidence about likely affected areas, dependencies, unknowns, risks and existing tests.`;
  const agentId = await resolveAgentId('researcher', AGENT_ID_ENV.researcher);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'inspect_backlog',
    state.workspace_dir || '/workspace',
  );
  return {
    context: result.response,
    plan: `Break down ${backlogLabel(state)} into small, independently verifiable slices.`,
    log: [{ step: 'research_backlog', summary: result.response.slice(0, 180) }],
  };
}

async function decomposeBacklogNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are a staff engineer decomposing an issue into implementation-ready work items.\n\n` +
    BACKLOG_PLANNING_BOUNDARY +
    `Issue: ${state.issue_title}\nDescription:\n${state.issue_body}\n\n` +
    `Repository evidence:\n${state.context}\n\n` +
    `Constraints:\n${state.backlog_constraints || 'None provided'}\n` +
    formatHumanChangeRequestForReviewer(state.human_change_request) +
    backlogReviewFeedback(state) +
    `Produce a Markdown plan with: goal, non-goals, assumptions, dependencies, risks, and a numbered list of vertical tasks. ` +
    `For every task include scope, likely files/modules, acceptance criteria, test strategy, dependencies and an estimate (S/M/L). ` +
    `Keep the complete plan below 30000 characters. Put a complete, actionable first Dev assignment (scope, allowed paths, acceptance criteria and test strategy) before the detailed backlog. ` +
    `Keep tasks independently reviewable and avoid inventing implementation details not supported by the evidence. Do not edit the repository.`;
  const agentId = await resolveAgentId('planner', AGENT_ID_ENV.planner);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'decompose_backlog',
    state.workspace_dir || '/workspace',
  );
  return {
    backlog_tasks: result.response,
    plan: result.response,
    retry_count: state.human_change_request ? state.retry_count + 1 : state.retry_count,
    backlog_completed: false,
    log: [{ step: 'decompose_backlog', summary: `Produced implementation plan for ${backlogLabel(state)}` }],
  };
}

async function reviewBacklogNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt = backlogReviewPrompt(state);
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
  const passed = /VERDICT:\s*APPROVED/i.test(result.response);
  return {
    review: result.response,
    review_passed: passed,
    retry_count: passed ? state.retry_count : state.retry_count + 1,
    log: [{ step: 'review_backlog', summary: `${passed ? '✓' : '✗'} backlog plan ${passed ? 'approved' : 'rejected'}` }],
  };
}

async function approveBacklogNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'backlog_approval',
    message: `The implementation plan for ${backlogLabel(state)} is ready. Approve the implementation handoff?`,
    repository: state.repository,
    issue_title: state.issue_title,
    backlog_tasks: state.backlog_tasks,
    review_summary: state.review.slice(0, 2_000),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({ threadId, name: 'human_backlog_approval', value: approved ? 1 : 0, comment: feedback });
  }
  return {
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: extractHumanChangeRequest(decision),
    log: [{ step: 'backlog_approval', summary: approved ? '✓ implementation handoff approved' : `✗ backlog changes requested — ${feedback.slice(0, 100)}` }],
  };
}

async function completeBacklogNode(state: typeof WorkflowState.State) {
  const summary = `${backlogLabel(state)} was decomposed into reviewed, independently actionable implementation tasks. No repository or issue mutation was performed.`;
  return {
    backlog_completed: true,
    delivery_summary: summary,
    log: [{ step: 'backlog_handoff', summary: `✓ ${summary}` }],
  };
}

function routeAfterReview(state: typeof WorkflowState.State): string {
  if (state.review_passed) return 'backlog_approval';
  if (state.retry_count < MAX_BACKLOG_GROOMING_RETRIES) return 'decompose_backlog';
  return END;
}

function routeAfterApproval(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'backlog_handoff';
  if (state.human_change_request && state.retry_count < MAX_BACKLOG_GROOMING_RETRIES) return 'decompose_backlog';
  return END;
}

export const backlogGroomingWorkflow = new StateGraph(WorkflowState)
  .addNode('seed_backlog', seedBacklogNode)
  .addNode('setup_workspace', setupWorkspaceNode)
  .addNode('research_backlog', researchBacklogNode)
  .addNode('decompose_backlog', decomposeBacklogNode)
  .addNode('review_backlog', reviewBacklogNode)
  .addNode('backlog_approval', approveBacklogNode)
  .addNode('backlog_handoff', completeBacklogNode)
  .addEdge(START, 'seed_backlog')
  .addEdge('seed_backlog', 'setup_workspace')
  .addEdge('setup_workspace', 'research_backlog')
  .addEdge('research_backlog', 'decompose_backlog')
  .addEdge('decompose_backlog', 'review_backlog')
  .addConditionalEdges('review_backlog', routeAfterReview)
  .addConditionalEdges('backlog_approval', routeAfterApproval)
  .addEdge('backlog_handoff', END)
  .compile({ checkpointer: codingCheckpointer });
