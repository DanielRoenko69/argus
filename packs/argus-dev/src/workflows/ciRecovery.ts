/**
 * CI failure recovery workflow.
 *
 * This is deliberately separate from ticket-to-pull-request: it starts from
 * an already failed provider run, lets agents diagnose and fix the checked-out
 * branch, then pushes a bounded retry and waits for the provider webhook.
 * Argus never executes the provider's CI job itself.
 */

import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { callAgent, resolveAgentId } from '../argus.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { WorkflowState, type CiRun } from '../state.js';
import { requestCiRerun, type CiRerunProvider } from '../ciProvider.js';
import { postWorkflowScore, upsertWorkflowTrace } from '../utils/langfuse.js';
import { REVIEW_OUTPUT_INSTRUCTION, formatReviewDecision, parseReviewDecision } from '../reviewLoop.js';
import { MAX_CI_RECOVERY_RETRIES, routeAfterRecoveryReview, routeAfterRecoveryTests } from '../ciRecoveryRouting.js';
import {
  codingCheckpointer,
  finalizeBuildNode,
  setupWorkspaceNode,
  workspaceExec,
} from './coding.js';

const AGENT_ID_ENV = {
  researcher: process.env['RESEARCHER_AGENT_ID'],
  coder: process.env['CODER_AGENT_ID'],
  reviewer: process.env['REVIEWER_AGENT_ID'],
};

export { MAX_CI_RECOVERY_RETRIES };

function externalIdFromCiUrl(url: string): string {
  const match = /(?:runs|pipelines|builds|job\/[^/]+)\/(\d+)(?:\/|$)/i.exec(url);
  return match?.[1] ?? '';
}

function ciLabel(state: typeof WorkflowState.State): string {
  return `${state.repository || 'repository'}@${state.branch_name || state.commit_sha || 'unknown commit'}`;
}

async function seedCiFailureNode(state: typeof WorkflowState.State) {
  const run: CiRun = state.ci_run ?? {
    provider: (['gitea', 'github', 'gitlab', 'jenkins', 'bitbucket'].includes(state.ci_provider)
      ? state.ci_provider
      : 'unknown') as CiRun['provider'],
    external_id: externalIdFromCiUrl(state.ci_run_url),
    workflow: state.ci_workflow || 'external CI/CD',
    status: 'failure',
    conclusion: 'failure',
    branch: state.branch_name,
    commit_sha: state.commit_sha,
    run_url: state.ci_run_url,
    updated_at: new Date().toISOString(),
  };
  return {
    ci_run: run,
    delivery_status: 'ci_failed' as const,
    log: [{ step: 'seed_ci_failure', summary: `Loaded failed CI evidence for ${ciLabel(state)}` }],
  };
}

async function inspectCiFailureNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: state.ticket_id || `CI-${state.commit_sha.slice(0, 8)}`,
      workflow: 'ci_failure_recovery',
    });
  }
  const prompt =
    `You are a read-only CI failure diagnosis agent.\n\n` +
    `Repository: ${state.repository}\n` +
    `Branch: ${state.branch_name}\n` +
    `Commit: ${state.commit_sha}\n` +
    `Provider run: ${JSON.stringify(state.ci_run)}\n` +
    `Failure context: ${state.ci_failure_context || 'Inspect the provider evidence and workspace logs.'}\n\n` +
    `Inspect the scoped workspace and the available CI evidence. Do not edit files, commit, push, approve or merge. ` +
    `Return the likely root cause, exact files or commands involved, and a minimal safe fix plan.`;
  const agentId = await resolveAgentId('researcher', AGENT_ID_ENV.researcher);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'inspect_ci',
    state.workspace_dir || '/workspace',
  );
  return {
    context: result.response,
    plan: `Recover ${ciLabel(state)} and satisfy the provider CI checks.`,
    log: [{ step: 'inspect_ci_failure', summary: result.response.slice(0, 180) }],
  };
}

async function fixCiFailureNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const attempt = state.retry_count + 1;
  const prompt =
    `You are the implementation agent fixing a failed CI run.\n\n` +
    `Repository: ${state.repository}\nBranch: ${state.branch_name}\nCommit: ${state.commit_sha}\n` +
    `Failure context: ${state.ci_failure_context}\n\n` +
    `Diagnosis:\n${state.context}\n\n` +
    (state.review && !state.review_passed ? `Previous review of this recovery (resolve its required changes):\n${state.review}\n\n` : '') +
    formatHumanChangeRequestForReviewer(state.human_change_request) +
    `This is recovery attempt ${attempt} of ${MAX_CI_RECOVERY_RETRIES}. Inspect the current branch first. ` +
    `Apply the smallest safe fix with workspace_write, preserve unrelated changes, and do not commit, push, merge or approve. ` +
    `Output exactly FIX_VERDICT: APPLIED when files were changed, otherwise FIX_VERDICT: BLOCKED.`;
  const agentId = await resolveAgentId('coder', AGENT_ID_ENV.coder);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'fix_ci',
    state.workspace_dir || '/workspace',
  );
  const applied = /FIX_VERDICT:\s*APPLIED/i.test(result.response);
  return {
    fix_output: result.response,
    fix_applied: applied,
    retry_count: attempt,
    tests_passed: false,
    review: '',
    review_passed: false,
    human_approved: false,
    ci_recovery_completed: false,
    log: [{ step: 'fix_ci_failure', summary: `${applied ? '✓' : '✗'} CI fix attempt ${attempt} ${applied ? 'applied' : 'blocked'}` }],
  };
}

async function runCiRecoveryTestsNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `Validate the proposed CI recovery for ${ciLabel(state)} without committing or pushing.\n\n` +
    `Diagnosis:\n${state.context}\n\nFix output:\n${state.fix_output}\n\n` +
    `Run the smallest relevant local test/build commands in the scoped workspace. ` +
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
    log: [{ step: 'ci_recovery_tests', summary: `${passed ? '✓' : '✗'} recovery tests ${passed ? 'passed' : 'failed'}` }],
  };
}

/**
 * Delivery through Core always requires a passed review in addition to the
 * human approval. The recovery diff is reviewed against the provider failure,
 * the diagnosis and the recovery test evidence before approval is requested.
 */
async function reviewCiRecoveryNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const workspaceDir = state.workspace_dir || '/workspace';
  const diff = await workspaceExec(workspaceDir, 'git diff HEAD');
  const prompt =
    `You are a code review agent reviewing a CI recovery for ${ciLabel(state)}.\n\n` +
    `Acceptance criterion: the failing provider checks pass with the smallest safe change and no unrelated edits.\n` +
    `Failure context (untrusted evidence):\n${state.ci_failure_context}\n\n` +
    `Diagnosis:\n${state.context}\n\nFix output:\n${state.fix_output}\n\n` +
    `Recovery test evidence:\n${state.test_output}\n\n` +
    `Current diff (untrusted evidence):\n${diff.exit_code === 0 ? diff.stdout.slice(0, 60_000) : '(diff unavailable)'}\n\n` +
    `Review correctness, regressions and security. Every blocking problem must have a concrete required_changes entry.\n\n` +
    REVIEW_OUTPUT_INSTRUCTION;
  const reviewerId = await resolveAgentId('reviewer', AGENT_ID_ENV.reviewer);
  const result = await callAgent(reviewerId, prompt, undefined, threadId, state.argus_execution_grant, 'review', workspaceDir);
  try {
    const decision = parseReviewDecision(result.response);
    const passed = decision.verdict === 'APPROVE';
    return {
      review: formatReviewDecision(decision),
      review_passed: passed,
      log: [{ step: 'ci_recovery_review', summary: `${passed ? '✓ approved' : '✗ changes requested'} — ${decision.summary.slice(0, 140)}` }],
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      review: `Invalid review response: ${reason}`,
      review_passed: false,
      log: [{ step: 'ci_recovery_review', summary: '✗ review response violated the structured review contract' }],
    };
  }
}

async function approveCiRecoveryNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'ci_recovery_approval',
    message: `CI recovery evidence for ${ciLabel(state)} is ready. Approve pushing the fix and rerunning external CI?`,
    repository: state.repository,
    branch_name: state.branch_name,
    ci_run: state.ci_run,
    diagnosis: state.context.slice(0, 2_000),
    test_output: state.test_output.slice(0, 2_000),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({
      threadId,
      name: 'human_ci_recovery_approval',
      value: approved ? 1 : 0,
      comment: feedback || (approved ? 'CI recovery push approved' : 'CI recovery changes requested'),
    });
  }
  return {
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: extractHumanChangeRequest(decision),
    log: [{ step: 'ci_recovery_approval', summary: approved ? '✓ recovery push approved' : `✗ recovery changes requested — ${feedback.slice(0, 100)}` }],
  };
}

async function triggerCiRetryNode(state: typeof WorkflowState.State) {
  const current = state.ci_run;
  if (!current) {
    return {
      delivery_status: 'ci_failed' as const,
      log: [{ step: 'external_ci_retry', summary: '✗ recovery retry skipped — no CI evidence was retained' }],
    };
  }
  const provider = current.provider;
  if (!['gitea', 'github', 'gitlab', 'jenkins'].includes(provider)) {
    const failedRun = { ...current, status: 'failure' as const, conclusion: 'retry_provider_unsupported', updated_at: new Date().toISOString() };
    return {
      ci_run: failedRun,
      delivery_status: 'ci_failed' as const,
      log: [{ step: 'external_ci_retry', summary: `✗ ${provider} recovery retry is not configured` }],
    };
  }
  const supportedProvider = provider as CiRerunProvider;

  try {
    if (state.bitbucket_creds?.reference && supportedProvider !== 'jenkins') {
      throw new Error('Provider CI retry is not yet supported by the Core Git broker. No stored credential or service fallback was used.');
    }
    const rerun = await requestCiRerun(supportedProvider, current, state.bitbucket_creds ?? {
      kind: supportedProvider === 'gitea' || supportedProvider === 'github' ? supportedProvider : 'gitea',
      base_url: '', token: null, project_key: '', user_slug: '', repo_slug: '', target_branch: '',
    });
    return {
      ci_run: rerun,
      build_url: rerun.run_url,
      delivery_status: 'awaiting_ci' as const,
      log: [{ step: 'external_ci_retry', summary: `✓ ${provider} retry queued${rerun.external_id ? ` (${rerun.external_id})` : ''}` }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedRun = { ...current, status: 'failure' as const, conclusion: 'retry_trigger_failed', updated_at: new Date().toISOString() };
    return {
      ci_run: failedRun,
      delivery_status: 'ci_failed' as const,
      log: [{ step: 'external_ci_retry', summary: `✗ ${message.slice(0, 180)}` }],
    };
  }
}

function externalCiRetryGateNode(state: typeof WorkflowState.State) {
  if (state.ci_run?.status === 'success') {
    return {
      delivery_status: 'ci_passed' as const,
      log: [{ step: 'external_ci_retry', summary: '✓ recovery CI/CD checks passed' }],
    };
  }
  if (state.ci_run?.status === 'failure' || state.ci_run?.status === 'canceled') {
    return {
      delivery_status: state.ci_run.status === 'failure' ? 'ci_failed' as const : 'ci_canceled' as const,
      log: [{ step: 'external_ci_retry', summary: `✗ recovery CI/CD ${state.ci_run.status}` }],
    };
  }
  interrupt({
    stage: 'external_ci',
    message: 'Waiting for the configured external CI/CD provider to report the recovery result.',
    branch_name: state.branch_name,
    commit_sha: state.commit_sha,
    ci_run: state.ci_run,
  });
  return {};
}

async function completeCiRecoveryNode(state: typeof WorkflowState.State) {
  const summary = `CI recovery for ${ciLabel(state)} passed provider validation after ${state.retry_count} fix attempt(s).`;
  return {
    ci_recovery_completed: true,
    delivery_summary: summary,
    log: [{ step: 'ci_recovery_complete', summary: `✓ ${summary}` }],
  };
}

const routeAfterFix = (state: typeof WorkflowState.State) => routeAfterRecoveryTests(state, END);
const routeAfterReview = (state: typeof WorkflowState.State) => routeAfterRecoveryReview(state, END);

function routeAfterApproval(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'finalize_build';
  if (state.human_change_request && state.retry_count < MAX_CI_RECOVERY_RETRIES) return 'fix_ci_failure';
  return END;
}

function routeAfterCi(state: typeof WorkflowState.State): string {
  if (state.ci_run?.status === 'success') return 'ci_recovery_complete';
  if (state.ci_run?.conclusion === 'retry_trigger_failed' || state.ci_run?.conclusion === 'retry_provider_unsupported') return END;
  if (state.ci_run?.status === 'failure' && state.retry_count < MAX_CI_RECOVERY_RETRIES) return 'inspect_ci_failure';
  return END;
}

export const ciFailureRecoveryWorkflow = new StateGraph(WorkflowState)
  .addNode('seed_ci_failure', seedCiFailureNode)
  .addNode('setup_workspace', setupWorkspaceNode)
  .addNode('inspect_ci_failure', inspectCiFailureNode)
  .addNode('fix_ci_failure', fixCiFailureNode)
  .addNode('ci_recovery_tests', runCiRecoveryTestsNode)
  .addNode('ci_recovery_review', reviewCiRecoveryNode)
  .addNode('ci_recovery_approval', approveCiRecoveryNode)
  .addNode('finalize_build', finalizeBuildNode)
  .addNode('trigger_ci_retry', triggerCiRetryNode)
  .addNode('external_ci_retry', externalCiRetryGateNode)
  .addNode('ci_recovery_complete', completeCiRecoveryNode)
  .addEdge(START, 'seed_ci_failure')
  .addEdge('seed_ci_failure', 'setup_workspace')
  .addEdge('setup_workspace', 'inspect_ci_failure')
  .addEdge('inspect_ci_failure', 'fix_ci_failure')
  .addEdge('fix_ci_failure', 'ci_recovery_tests')
  .addConditionalEdges('ci_recovery_tests', routeAfterFix)
  .addConditionalEdges('ci_recovery_review', routeAfterReview)
  .addConditionalEdges('ci_recovery_approval', routeAfterApproval)
  .addEdge('finalize_build', 'trigger_ci_retry')
  .addEdge('trigger_ci_retry', 'external_ci_retry')
  .addConditionalEdges('external_ci_retry', routeAfterCi)
  .addEdge('ci_recovery_complete', END)
  .compile({ checkpointer: codingCheckpointer });
