/**
 * Release notes and changelog workflow.
 *
 * Reads a bounded release scope, drafts human-readable notes, reviews them,
 * and produces approval-backed handoff evidence. It never tags, publishes or
 * deploys a release by itself.
 */

import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { callAgent, resolveAgentId } from '../argus.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { WorkflowState } from '../state.js';
import { postWorkflowScore, upsertWorkflowTrace } from '../utils/langfuse.js';
import { codingCheckpointer } from './coding.js';

const AGENT_ID_ENV = {
  researcher: process.env['RESEARCHER_AGENT_ID'],
  reviewer: process.env['REVIEWER_AGENT_ID'],
};

export const MAX_RELEASE_NOTES_RETRIES = 2;

function releaseLabel(state: typeof WorkflowState.State): string {
  return state.release_version || state.release_id || 'release';
}

async function seedReleaseNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: state.release_id || `REL-${state.release_version}`,
      workflow: 'release_notes',
    });
  }
  return {
    log: [{ step: 'seed_release', summary: `Loaded release scope for ${releaseLabel(state)}` }],
  };
}

async function inspectReleaseScopeNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are a read-only release scope analyst.\n\n` +
    `Repository: ${state.repository}\nBase branch: ${state.source_branch}\nRelease: ${releaseLabel(state)}\n` +
    `Scope:\n${state.release_scope}\n\nGoal:\n${state.release_goal}\n\n` +
    `Inspect the scoped commits, merged pull requests, changed areas and relevant migration/configuration notes. ` +
    `Do not edit, tag, publish, deploy or approve. Return concise evidence grouped into user-visible changes, ` +
    `internal changes, breaking changes, upgrade/migration notes and known risks.`;
  const agentId = await resolveAgentId('researcher', AGENT_ID_ENV.researcher);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'inspect_release',
    state.workspace_dir || '/workspace',
  );
  return {
    context: result.response,
    plan: `Prepare ${releaseLabel(state)} notes from the approved release scope.`,
    log: [{ step: 'inspect_release_scope', summary: result.response.slice(0, 180) }],
  };
}

async function generateReleaseNotesNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are a release communications writer. Produce a Markdown release note draft for ${releaseLabel(state)}.\n\n` +
    `Repository: ${state.repository}\nRelease goal: ${state.release_goal}\n\n` +
    `Scope evidence:\n${state.context}\n\n` +
    formatHumanChangeRequestForReviewer(state.human_change_request) +
    `Use clear headings: Highlights, Fixed/Changed, Breaking changes, Upgrade notes, Security, and Known limitations. ` +
    `Do not invent changes that are not supported by the evidence. Do not tag, publish or deploy. ` +
    `Return only the Markdown draft and keep it suitable for a changelog/release page.`;
  const agentId = await resolveAgentId('reviewer', AGENT_ID_ENV.reviewer);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'generate_release',
    state.workspace_dir || '/workspace',
  );
  return {
    release_notes: result.response,
    retry_count: state.human_change_request ? state.retry_count + 1 : state.retry_count,
    release_completed: false,
    log: [{ step: 'generate_release_notes', summary: `Generated ${releaseLabel(state)} release notes` }],
  };
}

async function reviewReleaseNotesNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are the final release-notes reviewer for ${releaseLabel(state)}.\n\n` +
    `Evidence:\n${state.context}\n\nDraft:\n${state.release_notes}\n\n` +
    `Check factual grounding, completeness, audience clarity, breaking-change visibility, security wording and accidental secrets. ` +
    `At the end output exactly VERDICT: APPROVED or VERDICT: REJECTED, followed by concise actionable feedback.`;
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
    log: [{ step: 'review_release_notes', summary: `${passed ? '✓' : '✗'} release notes ${passed ? 'approved' : 'rejected'}` }],
  };
}

async function approveReleaseNotesNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'release_approval',
    message: `Release notes for ${releaseLabel(state)} are ready. Approve the release handoff?`,
    repository: state.repository,
    release_version: state.release_version,
    release_notes: state.release_notes.slice(0, 20_000),
    review_summary: state.review.slice(0, 2_000),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({ threadId, name: 'human_release_approval', value: approved ? 1 : 0, comment: feedback });
  }
  return {
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: extractHumanChangeRequest(decision),
    log: [{ step: 'release_approval', summary: approved ? '✓ release handoff approved' : `✗ release notes changes requested — ${feedback.slice(0, 100)}` }],
  };
}

async function completeReleaseNode(state: typeof WorkflowState.State) {
  const summary = `${releaseLabel(state)} release notes passed review and human approval. Argus produced handoff evidence; no tag, publish or deploy was executed.`;
  return {
    release_completed: true,
    delivery_summary: summary,
    log: [{ step: 'release_handoff', summary: `✓ ${summary}` }],
  };
}

function routeAfterReview(state: typeof WorkflowState.State): string {
  if (!state.review_passed && state.retry_count < MAX_RELEASE_NOTES_RETRIES) return 'generate_release_notes';
  return state.review_passed ? 'release_approval' : END;
}

function routeAfterApproval(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'release_handoff';
  if (state.human_change_request && state.retry_count < MAX_RELEASE_NOTES_RETRIES) return 'generate_release_notes';
  return END;
}

export const releaseNotesWorkflow = new StateGraph(WorkflowState)
  .addNode('seed_release', seedReleaseNode)
  .addNode('inspect_release_scope', inspectReleaseScopeNode)
  .addNode('generate_release_notes', generateReleaseNotesNode)
  .addNode('review_release_notes', reviewReleaseNotesNode)
  .addNode('release_approval', approveReleaseNotesNode)
  .addNode('release_handoff', completeReleaseNode)
  .addEdge(START, 'seed_release')
  .addEdge('seed_release', 'inspect_release_scope')
  .addEdge('inspect_release_scope', 'generate_release_notes')
  .addEdge('generate_release_notes', 'review_release_notes')
  .addConditionalEdges('review_release_notes', routeAfterReview)
  .addConditionalEdges('release_approval', routeAfterApproval)
  .addEdge('release_handoff', END)
  .compile({ checkpointer: codingCheckpointer });
