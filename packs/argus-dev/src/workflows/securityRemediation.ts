/**
 * Security and dependency remediation workflow.
 *
 * A finding is triaged before any write. The coder may only change the
 * affected dependency/code path, local verification is required, and both
 * the push and final PR handoff have human gates.
 */

import { END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { callAgent, resolveAgentId } from '../argus.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { WorkflowState } from '../state.js';
import { postWorkflowScore, upsertWorkflowTrace } from '../utils/langfuse.js';
import {
  codingCheckpointer,
  externalCiGateNode,
  finalizeBuildNode,
  finalizePrNode,
  setupWorkspaceNode,
} from './coding.js';

const AGENT_ID_ENV = {
  researcher: process.env['RESEARCHER_AGENT_ID'],
  coder: process.env['CODER_AGENT_ID'],
};

export const MAX_SECURITY_REMEDIATION_RETRIES = 3;

function findingLabel(state: typeof WorkflowState.State): string {
  return state.security_finding_id || state.security_package || state.ticket_id || 'security finding';
}

async function seedSecurityFindingNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: state.ticket_id || `SEC-${state.security_finding_id}`,
      workflow: 'security_remediation',
    });
  }
  return {
    log: [{ step: 'seed_security_finding', summary: `Loaded ${state.security_severity} finding ${findingLabel(state)}` }],
  };
}

async function triageSecurityFindingNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `You are a read-only security and dependency triage agent.\n\n` +
    `Repository: ${state.repository}\nBase branch: ${state.source_branch}\n` +
    `Finding: ${findingLabel(state)}\nTool: ${state.security_tool}\nSeverity: ${state.security_severity}\n` +
    `Package: ${state.security_package}\nCurrent version: ${state.security_current_version}\n` +
    `Known fixed version: ${state.security_fixed_version || 'not provided'}\n\n` +
    `Finding evidence:\n${state.security_finding_context}\n\n` +
    `Inspect the scoped repository and dependency manifests without editing. Assess exploitability, affected paths, ` +
    `upgrade compatibility, lockfile impact and the smallest safe remediation. Do not approve or push. ` +
    `Return a structured triage with a clear recommendation: remediate, defer with rationale, or escalate.`;
  const agentId = await resolveAgentId('researcher', AGENT_ID_ENV.researcher);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'inspect_security',
    state.workspace_dir || '/workspace',
  );
  return {
    context: result.response,
    plan: `Remediate ${findingLabel(state)} with the smallest compatible change.`,
    review: result.response,
    log: [{ step: 'security_triage', summary: result.response.slice(0, 180) }],
  };
}

async function fixSecurityFindingNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const attempt = state.retry_count + 1;
  const prompt =
    `You are the implementation agent preparing a security remediation.\n\n` +
    `Finding: ${findingLabel(state)}\nTool: ${state.security_tool}\nSeverity: ${state.security_severity}\n` +
    `Package: ${state.security_package}\nCurrent version: ${state.security_current_version}\n` +
    `Fixed version: ${state.security_fixed_version || 'choose the safest supported version'}\n\n` +
    `Triage:\n${state.context}\n\n` +
    formatHumanChangeRequestForReviewer(state.human_change_request) +
    `This is remediation attempt ${attempt} of ${MAX_SECURITY_REMEDIATION_RETRIES}. Inspect the repository first. ` +
    `Change only the dependency/code needed to address this finding, preserve unrelated work, and use workspace_write for every file. ` +
    `Update lockfiles when required and run a focused security/test check. Do not commit, push, merge or approve. ` +
    `At the end output exactly SECURITY_FIX_VERDICT: APPLIED when the remediation was written, otherwise SECURITY_FIX_VERDICT: BLOCKED.`;
  const agentId = await resolveAgentId('coder', AGENT_ID_ENV.coder);
  const result = await callAgent(
    agentId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'fix_security',
    state.workspace_dir || '/workspace',
  );
  const applied = /SECURITY_FIX_VERDICT:\s*APPLIED/i.test(result.response);
  return {
    fix_output: result.response,
    fix_applied: applied,
    retry_count: attempt,
    tests_passed: false,
    security_passed: false,
    human_approved: false,
    pr_approved: false,
    log: [{ step: 'security_fix', summary: `${applied ? '✓' : '✗'} remediation attempt ${attempt} ${applied ? 'applied' : 'blocked'}` }],
  };
}

async function securityVerificationNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `Verify the security remediation for ${findingLabel(state)} without committing or pushing.\n\n` +
    `Triage:\n${state.context}\n\nRemediation output:\n${state.fix_output}\n\n` +
    `Run the smallest relevant project tests plus a dependency/security check (for example npm audit, pip-audit, or the repository's configured scanner). ` +
    `Confirm the vulnerable package/path is addressed and no high-confidence regression was introduced. ` +
    `At the end output exactly TEST_VERDICT: PASS or TEST_VERDICT: FAIL and SECURITY_VERDICT: PASS or SECURITY_VERDICT: FAIL.`;
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
  const testsPassed = /TEST_VERDICT:\s*PASS/i.test(result.response);
  const securityPassed = /SECURITY_VERDICT:\s*PASS/i.test(result.response);
  return {
    test_output: result.response,
    tests_passed: testsPassed,
    security_passed: securityPassed,
    log: [{ step: 'security_verification', summary: `${testsPassed && securityPassed ? '✓' : '✗'} tests/security ${testsPassed && securityPassed ? 'passed' : 'failed'}` }],
  };
}

async function approveSecurityFixNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'security_fix_approval',
    message: `Security remediation evidence for ${findingLabel(state)} is ready. Approve pushing the remediation branch?`,
    finding: { id: state.security_finding_id, severity: state.security_severity, package: state.security_package },
    triage: state.context.slice(0, 2_000),
    verification: state.test_output.slice(0, 2_000),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({ threadId, name: 'human_security_fix_approval', value: approved ? 1 : 0, comment: feedback });
  }
  return {
    human_approved: approved,
    human_feedback: approved ? '' : feedback,
    human_change_request: extractHumanChangeRequest(decision),
    log: [{ step: 'security_fix_approval', summary: approved ? '✓ remediation push approved' : `✗ remediation changes requested — ${feedback.slice(0, 100)}` }],
  };
}

async function approveSecurityPrNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const decision = interrupt({
    stage: 'security_pr_approval',
    message: `External CI passed for ${findingLabel(state)}. Approve creation of the remediation pull request?`,
    branch_name: state.branch_name,
    ci_run: state.ci_run,
    finding: { id: state.security_finding_id, severity: state.security_severity, package: state.security_package },
    triage: state.context.slice(0, 1_500),
  }) as { approved?: boolean; feedback?: string };
  const approved = decision?.approved === true;
  const feedback = typeof decision?.feedback === 'string' ? decision.feedback.trim() : '';
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void postWorkflowScore({ threadId, name: 'human_security_pr_approval', value: approved ? 1 : 0, comment: feedback });
  }
  return {
    pr_approved: approved,
    pr_feedback: feedback,
    log: [{ step: 'security_pr_approval', summary: approved ? '✓ remediation PR approved' : `✗ remediation PR rejected — ${feedback.slice(0, 100)}` }],
  };
}

function routeAfterVerification(state: typeof WorkflowState.State): string {
  if (state.tests_passed && state.security_passed) return 'security_fix_approval';
  if (state.retry_count < MAX_SECURITY_REMEDIATION_RETRIES) return 'security_fix';
  return END;
}

function routeAfterFixApproval(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'finalize_build';
  if (state.human_change_request && state.retry_count < MAX_SECURITY_REMEDIATION_RETRIES) return 'security_fix';
  return END;
}

function routeAfterPrApproval(state: typeof WorkflowState.State): string {
  return state.pr_approved ? 'finalize_pr' : END;
}

export const securityRemediationWorkflow = new StateGraph(WorkflowState)
  .addNode('seed_security_finding', seedSecurityFindingNode)
  .addNode('setup_workspace', setupWorkspaceNode)
  .addNode('security_triage', triageSecurityFindingNode)
  .addNode('security_fix', fixSecurityFindingNode)
  .addNode('security_verification', securityVerificationNode)
  .addNode('security_fix_approval', approveSecurityFixNode)
  .addNode('finalize_build', finalizeBuildNode)
  .addNode('external_ci', externalCiGateNode)
  .addNode('security_pr_approval', approveSecurityPrNode)
  .addNode('finalize_pr', finalizePrNode)
  .addEdge(START, 'seed_security_finding')
  .addEdge('seed_security_finding', 'setup_workspace')
  .addEdge('setup_workspace', 'security_triage')
  .addEdge('security_triage', 'security_fix')
  .addEdge('security_fix', 'security_verification')
  .addConditionalEdges('security_verification', routeAfterVerification)
  .addConditionalEdges('security_fix_approval', routeAfterFixApproval)
  .addEdge('finalize_build', 'external_ci')
  .addEdge('external_ci', 'security_pr_approval')
  .addConditionalEdges('security_pr_approval', routeAfterPrApproval)
  .addEdge('finalize_pr', END)
  .compile({ checkpointer: codingCheckpointer });

