/**
 * Coding workflow: planner → knowledge → coder → tests → reviewer → human approval
 *
 * Environment variables:
 *   PLANNER_AGENT_ID    — Argus agent ID for the orchestrator  (default: 3)
 *   KNOWLEDGE_AGENT_ID  — Argus agent ID for knowledge lookup  (default: 5)
 *   CODER_AGENT_ID      — Argus agent ID for the dev worker    (default: 2)
 *   REVIEWER_AGENT_ID   — Argus agent ID for the reviewer      (default: 4)
 *   MAX_REVIEW_RETRIES  — max coder correction rounds          (default: 4)
 *   TEST_WEBHOOK_URL    — n8n webhook URL for test execution    (optional)
 *                         If unset, falls back to running `npm test` (or pytest)
 *                         inside the workspace via the coder agent.
 */

import { StateGraph, START, END, interrupt } from '@langchain/langgraph';
import { workflowCheckpointer } from '../workflowCheckpointer.js';
import { withRenewableGrant } from '../grantRenewal.js';
import { CODING_MAX_REVISIONS } from '../workflowCatalog.js';
import { isImageReviewDelivery, REVIEW_ONLY_TEST_POLICY } from '../reviewOnlyDelivery.js';
import { assertFollowUpCheckpoint } from '../followUpContract.js';
import type { FollowUpCheckpoint } from '../followUpContract.js';
import { usesQaAcceptance, qaBasis, parseQaArtifact, qaRequest, assertQaCurrent, QA_AUTHOR_INSTRUCTION, QA_ENVIRONMENT_INSTRUCTION, QA_ENVIRONMENT_REPAIR_INSTRUCTION, mayRepairQaEnvironment, parseEnvironmentRepair, type QaReceipt } from '../qaAcceptance.js';
import { usesGeneralStack, stackRequest, parseStackProposal, stackRepairEligible, stackExecutionSummary, STACK_PLAN_INSTRUCTION, STACK_REPAIR_INSTRUCTION, STACK_QA_INSTRUCTION, StackPlanError, stackPlanningFailure, type StackPlanningPhase } from '../stackClient.js';
import { mayRepairStack, reserveStackRepair, stackRepairLimit, stackRepairBudget, stackRepairContext,
  assertStackRepairWindow, assertStackRepairSource, assertStackRepairExecution, assertNewStackRecipe } from '../stackRepair.js';
import { stackHash, stackResultSchema } from '../stackEnvironment.js';
import { usesCodeGeneration, generateCode, codegenCoderContext, assertCodegenCurrent, codegenFailureMessage, CODEGEN_PLAN_INSTRUCTION } from '../codeGeneration.js';
import { workspaceSessionInstruction } from '../workspaceSession.js';
import { parseCodegenDecision, CodegenExecutionError, codegenHash } from '../codeGenerationContract.js';
import { mayRepairCodegen, reserveCodegenRepair, assertCodegenRepairSource, parseCodegenRepair, codegenRecipeHash,
  CODEGEN_REPAIR_INSTRUCTION, CODEGEN_MAX_REPAIRS, type CodegenFailedAttempt } from '../codeGenerationRepair.js';
import { callAgent, resolveAgentId, resolveAgentRuntimeAssignment, ReadOnlyRuntimeUnavailableError } from '../argus.js';
import { assertWorkflowNotCanceled } from '../workflowCancellation.js';
import { requirementsInputNode } from '../requirementsCheckpoint.js';
import { DEVELOPMENT_OUTCOME_INSTRUCTION, parseDevelopmentOutcome, parseFileScope, missingHandoffPlaceholder, validateRequirementsReply, testInfrastructureBlocker } from '../developmentContract.js';
import { DEVELOPMENT_V2_INSTRUCTION, designRefinementUpdate, planningSources,
  refinementExpired, expiredRefinementUpdate, systemDevelopmentBlocker, authoritativeDevelopmentBrief } from '../developmentDecisions.js';
import { retainQaResponse, qaResponseBasis, qaReviewCorrectionContext } from '../qaResponseRecovery.js';
import { createQaReviewBinding, applyBoundTechnicalReview, applyMissingQaReviewCorrection, responseRepairSummary } from '../technicalDesign.js';
import { experimentProposal, experimentContext, executeTechnicalExperiment, EXPERIMENT_INSTRUCTION } from '../technicalExperiment.js';
import { applyTechnicalProposal, reserveTechnicalInvestigation, technicalContractFailure, technicalResponseFailure,
  technicalDesignContext, technicalPlanningRoute, TECHNICAL_PROPOSAL_INSTRUCTION, TECHNICAL_REVIEW_INSTRUCTION, TECHNICAL_VERIFICATION_INSTRUCTION,
  usesTechnicalDesign } from '../technicalDesign.js';
import { WorkflowState, type FileDiff, type ReviewAnnotation, type GitCreds, type CiRun, type TestProfileEvidence, type RevisionTrigger } from '../state.js';
import { bundleResolutionCandidates } from '../bundleResolution.js';
import { fetchGitReference, devGitOperation, assertGitDeliveryApproval } from '../devGit.js';
import { authorizeJenkinsBundle } from '../devCi.js';
import { selectCheckoutTarget } from '../repositoryCheckout.js';
import { assertPlanningCheckout } from '../planningHandoff.js';
import { assertIssueCheckout, issuePrReference } from '../repositoryIssue.js';
import { repositoryScopeViolations, REPOSITORY_SCOPE_INSTRUCTION } from '../repositoryScope.js';
import { deliveryStatusForCi } from '../ciLifecycle.js';
import { jenkinsTarget, readJenkinsConfig } from '../jenkinsDispatch.js';
import { upsertWorkflowTrace } from '../utils/langfuse.js';
import { humanApprovalNode, humanApprovalPrNode } from './approvals.js';
import { parseTestFailures, formatTestEvidence } from '../testParser.js';
import {
  evaluateWorkspaceDiffStatus,
  extractTicketFileTargets,
  WORKSPACE_GIT_STATUS_COMMAND,
} from '../workspaceDiffGate.js';
import {
  buildCiUrl,
  buildCloneUrl as buildProviderCloneUrl,
  toBrowserProviderUrl,
} from '../gitProvider.js';
import { changedPathsFromGitStatus, runDetectedProjectTests } from '../projectTestRunner.js';
import { createWorkflowTestProgressReporter } from '../workflowProgress.js';
import { callCodexWorker, isCodexCoderRuntime } from '../codex.js';
import { callClaudeWorker, isClaudeCoderRuntime } from '../claude.js';
import { extractHumanChangeRequest, formatHumanChangeRequestForReviewer } from '../humanFeedback.js';
import { commitTitleFor, pullRequestTitleFor } from './titles.js';
import { resolveDeliveryBranch } from './branchNames.js';
import {
  REVIEW_OUTPUT_INSTRUCTION,
  buildReviewAcceptanceContext,
  canRequestAnotherRevision,
  formatReviewDecision,
  normalizeRevisionFeedback,
  parseReviewDecision,
  type ReviewDecision,
} from '../reviewLoop.js';
import {
  appendRevision,
  recordRevisionReview,
  recordRevisionTests,
} from '../revisionHistory.js';

// Agents are resolved by their STABLE NAME via the Argus internal resolver
// (resolveAgentId in argus.ts). The *_AGENT_ID env vars still work as an
// explicit override when set — otherwise the name→id map decides, so the
// workflow picks the right agents regardless of per-instance SERIAL ids.
const AGENT_NAME = {
  planner:    'planner',
  knowledge:  'knowledge',
  coder:      'coder',
  reviewer:   'reviewer',
  researcher: 'researcher',
} as const;
const AGENT_ID_ENV = {
  planner:    process.env['PLANNER_AGENT_ID'],
  knowledge:  process.env['KNOWLEDGE_AGENT_ID'],
  coder:      process.env['CODER_AGENT_ID'],
  reviewer:   process.env['REVIEWER_AGENT_ID'],
  researcher: process.env['RESEARCHER_AGENT_ID'],
};
// Catalog and graph must publish/use the same correction budget.
const MAX_RETRIES = CODING_MAX_REVISIONS;
const TEST_WEBHOOK = process.env['TEST_WEBHOOK_URL'] ?? '';

const WORKSPACE_URL    = process.env['AGENT_WORKSPACE_URL']     ?? 'http://agent-workspace:3001';
const WORKSPACE_SECRET = process.env['WORKSPACE_SECRET']         ?? '';

const MAX_DIFF_CHARS = 8000;       // truncate per-file diff to keep state manageable

/** Legacy name retained for internal imports; new resolution is metadata-only. */
export async function fetchGitCreds(bundleId: number, _workflowId: number, executionGrant = '', rootTraceId = ''): Promise<GitCreds | null> {
  if (!Number.isSafeInteger(bundleId) || bundleId < 1) throw new Error('Select a repository Bundle and start a new governed run. Workflow-wide credential export is not supported.');
  return fetchGitReference(bundleId, executionGrant, rootTraceId);
}

// ── Workspace helpers ──────────────────────────────────────────────────────

interface ExecResult { stdout: string; stderr: string; exit_code: number; }

export async function workspaceExec(
  cwd: string,
  cmd: string,
  timeoutSec = 60,
  environmentProfile?: 'isolated-test',
): Promise<ExecResult> {
  assertWorkflowNotCanceled();
  const res = await fetch(`${WORKSPACE_URL}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
    body: JSON.stringify({ cmd, cwd, timeoutSec, ...(environmentProfile ? { environmentProfile } : {}) }),
  });
  assertWorkflowNotCanceled();
  if (!res.ok) throw new Error(`workspace_exec ${res.status}: ${await res.text()}`);
  return await res.json() as ExecResult;
}

/** Compatibility for already approved, single-commit pre-dispatch runs. Read only. */
export async function resolveCiBaseCommit(values: Record<string, unknown>): Promise<string> {
  if (typeof values['base_commit_sha'] === 'string' && /^[a-f0-9]{40}$/.test(values['base_commit_sha'])) return values['base_commit_sha'];
  const commit = String(values['commit_sha'] ?? '');
  const dir = String(values['workspace_dir'] ?? '');
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^\/workspace\/[A-Za-z0-9_-]+$/.test(dir)) throw new Error('CI base identity unavailable');
  const result = await workspaceExec(dir, `git rev-parse ${commit}^`, 15);
  const base = result.stdout.trim();
  if (result.exit_code !== 0 || !/^[a-f0-9]{40}$/.test(base)) throw new Error('CI base identity unavailable');
  return base;
}

async function assertSourceCheckpointUnchanged(source: FollowUpCheckpoint): Promise<void> {
  const snapshot = await codingWorkflow.getState({ configurable: { thread_id: source.sourceThreadId } });
  const actual = (snapshot.config?.configurable as Record<string, unknown> | undefined)?.['checkpoint_id'];
  if (actual !== source.sourceCheckpointId) {
    throw new Error('The completed source checkpoint changed. Inspect its history before continuing; no automatic replay.');
  }
}

/** Pull `git diff` from the workspace and parse into FileDiff[]. */
async function captureWorkspaceDiff(workspaceDir: string): Promise<FileDiff[]> {
  try {
    const ns = await workspaceExec(workspaceDir, 'git diff --name-status HEAD');
    const stat = await workspaceExec(workspaceDir, 'git diff --numstat HEAD');
    const fullDiff = await workspaceExec(workspaceDir, 'git diff HEAD');

    const statusMap = new Map<string, 'added'|'modified'|'deleted'>();
    for (const line of ns.stdout.split('\n').filter(Boolean)) {
      const [code, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;
      if (code?.startsWith('A')) statusMap.set(path, 'added');
      else if (code?.startsWith('D')) statusMap.set(path, 'deleted');
      else statusMap.set(path, 'modified');
    }

    const numstatMap = new Map<string, { add: number; del: number }>();
    for (const line of stat.stdout.split('\n').filter(Boolean)) {
      const [add, del, ...rest] = line.split('\t');
      const path = rest.join('\t');
      if (!path) continue;
      numstatMap.set(path, { add: parseInt(add ?? '0', 10) || 0, del: parseInt(del ?? '0', 10) || 0 });
    }

    // Split full diff per-file (`diff --git a/path b/path`)
    const perFile = new Map<string, string>();
    let current: string | null = null;
    let buf: string[] = [];
    for (const line of fullDiff.stdout.split('\n')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) {
        if (current) perFile.set(current, buf.join('\n'));
        current = m[2] ?? m[1] ?? null;
        buf = [line];
      } else {
        buf.push(line);
      }
    }
    if (current) perFile.set(current, buf.join('\n'));

    // Include untracked files (??) — not in `git diff` but visible in status
    const status = await workspaceExec(workspaceDir, WORKSPACE_GIT_STATUS_COMMAND);
    for (const line of status.stdout.split('\n').filter(Boolean)) {
      if (line.startsWith('??')) {
        const path = line.slice(3).trim();
        statusMap.set(path, 'added');
        try {
          const content = await workspaceExec(workspaceDir, `cat -- "${path.replace(/"/g, '\\"')}"`);
          const lineCount = content.stdout.split('\n').length;
          numstatMap.set(path, { add: lineCount, del: 0 });
          // Synthesize a unified-diff-style block for untracked
          perFile.set(path, `diff --git a/${path} b/${path}\nnew file\n+++ b/${path}\n${content.stdout.split('\n').map(l => '+' + l).join('\n')}`);
        } catch { /* ignore unreadable */ }
      }
    }

    const out: FileDiff[] = [];
    for (const [path, st] of statusMap.entries()) {
      const ns = numstatMap.get(path) ?? { add: 0, del: 0 };
      const raw = perFile.get(path) ?? '';
      out.push({
        path,
        status: st,
        additions: ns.add,
        deletions: ns.del,
        diff: raw.length > MAX_DIFF_CHARS ? raw.slice(0, MAX_DIFF_CHARS) + '\n…(truncated)' : raw,
      });
    }
    return out;
  } catch (err) {
    console.error('captureWorkspaceDiff failed:', err);
    return [];
  }
}

function reviewAnnotationsFromDecision(decision: ReviewDecision): ReviewAnnotation[] {
  return decision.findings.map(finding => ({
    path: finding.file ?? 'review',
    ...(finding.line ? { line: finding.line } : {}),
    severity: finding.severity === 'critical' || finding.severity === 'high'
      ? 'concern'
      : finding.severity === 'medium'
        ? 'suggestion'
        : 'info',
    comment: finding.message.slice(0, 500),
  }));
}

/** Map a ticket id like "ARGUS-4943" to a workspace directory.
 *  Preserves case (e.g. ARGUS-4943), only sanitizes unsafe chars. */
function ticketToDir(ticketId: string): string {
  const safe = ticketId.replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return `/workspace/${safe || 'untitled'}`;
}

async function assertOrdinaryDevelopmentFiles(dir: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const result = await workspaceExec(dir, `for path in ${paths.map(shellQuote).join(' ')}; do if test -e "$path" || test -L "$path"; then test -f "$path" && test ! -L "$path" && test ! -x "$path" || exit 3; fi; done`);
  if (result.exit_code !== 0) throw new Error('Development changes must be ordinary non-executable files, not symlinks or submodules.');
}

// ── Nodes ──────────────────────────────────────────────────────────────────

/**
 * setup_workspace: First node in the graph. Ensures /workspace/<ticket_id> is
 *   - cloned from origin if it doesn't exist yet
 *   - reset to a clean copy of TARGET_BRANCH (default master) if it does exist
 *
 * Eliminates "workspace drift" where a previous ticket's branch leaks into
 * the new run. Skipped if no git-provider connection is assigned to the workflow.
 */
export async function setupWorkspaceNode(
  state: typeof WorkflowState.State,
  config?: { configurable?: { thread_id?: string } },
) {
  const dir = state.argus_workspace_root || ticketToDir(state.ticket_id);
  if (!/^\/workspace\/[A-Za-z0-9-]{1,600}$/.test(dir)) throw new Error('Invalid Core-bound workspace directory.');
  const environmentPreflight = async (sha: string) => {
    if (state.qa_environment_policy_version !== 1) return {};
    const checked = await qaRequest({ ...state, workspace_dir: dir, base_commit_sha: sha }, config?.configurable?.thread_id ?? '',
      await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer), 'inspect');
    if (!('python' in checked) || !checked.environment) throw new Error('Project environment preflight unavailable');
    return { qa_history: [{ phase: 'environment_preflight', plan: checked.environment }],
      ...(checked.environment.status === 'blocked' ? systemDevelopmentBlocker('environment',
        `Project environment blocked before planning: ${checked.environment.reasons.join(', ')}. Check the supported manifest, runtime and operator environment policy; no model call or package installation was started.`) : {}) };
  };

  // Resolve creds via every Core-authorized bundle. A run commonly combines
  // read-only code context with a repository/CI bundle, and browser selection
  // order is not a security or routing contract. Keep the single-ID field as
  // a backwards-compatible fallback for older persisted workflow state.
  const bundleIds = bundleResolutionCandidates(state.argus_bundle_ids, state.argus_bundle_id);
  let creds: GitCreds | null = null;
  const candidates: GitCreds[] = [];
  for (const bundleId of bundleIds) {
    creds = await fetchGitCreds(
      bundleId,
      0,
      state.argus_execution_grant,
      config?.configurable?.thread_id ?? '',
    );
    if (creds?.base_url && creds.repo_slug && (creds.project_key || creds.user_slug)) candidates.push(creds);
    creds = null;
  }
  if (candidates.length > 0) creds = selectCheckoutTarget(candidates, state.repository);
  if (!creds && bundleIds.length === 0 && state.argus_workflow_id > 0) {
    creds = await fetchGitCreds(
      0,
      state.argus_workflow_id,
      state.argus_execution_grant,
      config?.configurable?.thread_id ?? '',
    );
  }
  if (!creds || !creds.base_url || !creds.repo_slug || (!creds.project_key && !creds.user_slug)) {
    throw new Error(
      'Workspace provisioning requires a concrete Git checkout connection. '
      + 'Select a bundle configured with provider, owner and repository.',
    );
  }

  const targetBranch = state.source_branch || state.branch_name || creds.target_branch || 'master';
  parseFileScope(state.allowed_files);
  assertPlanningCheckout(state.planning_provenance, creds);
  assertIssueCheckout(state.issue_snapshot, creds);
  let jenkinsBinding = null;
  if (state.ci_provider === 'jenkins') {
    const jenkinsConfig = readJenkinsConfig();
    const target = jenkinsTarget(jenkinsConfig, creds, state.ci_job);
    if (!jenkinsConfig || !target) {
      throw new Error('Select an explicitly configured Jenkins job for this repository before implementation.');
    }
    jenkinsBinding = await authorizeJenkinsBundle(state, config?.configurable?.thread_id ?? '', creds, jenkinsConfig, target.job);
    if (jenkinsBinding.branchPrefix !== target.branchPrefix) throw new Error('Jenkins Bundle branch policy differs from dispatcher configuration.');
    const existingDeliveryBranch = state.follow_up_checkpoint
      ? assertFollowUpCheckpoint(state.follow_up_checkpoint).branch
      : state.branch_name;
    resolveDeliveryBranch(
      state.ticket_id || 'untitled',
      config?.configurable?.thread_id ?? '',
      existingDeliveryBranch,
      jenkinsBinding.branchPrefix,
    );
  }
  const cloneUrl = buildProviderCloneUrl(creds);
  if (!creds.reference || creds.token !== null) throw new Error('A token-free Core Git reference is required.');
  const remote = (operation: 'clone' | 'fetch') => devGitOperation(state, config?.configurable?.thread_id ?? '', creds!, operation, targetBranch);

  try {
    if (state.follow_up_checkpoint) {
      const source = assertFollowUpCheckpoint(state.follow_up_checkpoint);
      await assertSourceCheckpointUnchanged(source);
      if (source.repository !== `${creds.project_key || creds.user_slug}/${creds.repo_slug}`
        || source.repositoryBundleId !== creds.reference.bundleId || source.branch !== targetBranch
        || source.ciJob !== state.ci_job || state.ci_provider !== 'jenkins') {
        throw new Error('Follow-up checkout no longer matches the source repository, branch or Jenkins job.');
      }
      const existing = await workspaceExec('/workspace', `test -e "${dir}" && echo YES || echo NO`);
      if (existing.stdout.includes('YES')) throw new Error('Follow-up needs a fresh isolated workspace; existing files were not reset.');
      await devGitOperation(state, config?.configurable?.thread_id ?? '', creds, 'inspect-pr', targetBranch,
        { commitSha: source.commitSha, pullRequestNumber: source.pullRequestNumber });
      await remote('clone');
      const checkout = await workspaceExec(dir, `git checkout ${shellQuote(targetBranch)}`);
      if (checkout.exit_code !== 0) throw new Error('Pinned follow-up branch checkout failed.');
      const head = await workspaceExec(dir, 'git rev-parse HEAD');
      if (head.exit_code !== 0 || head.stdout.trim() !== source.commitSha) {
        throw new Error('Follow-up branch changed after PR verification. No files were changed.');
      }
      return {
        ...await environmentPreflight(source.commitSha), workspace_dir: dir, base_commit_sha: source.commitSha,
        bitbucket_creds: creds, jenkins_binding: jenkinsBinding,
        log: [{ step: 'setup_workspace', summary: `✓ continued ${source.repository} from ${source.branch}@${source.commitSha.slice(0, 7)} · source run ${source.sourceThreadId}` }],
      };
    }
    const exists = await workspaceExec('/workspace', `test -d "${dir}/.git" && echo OK || echo NO`);

    if (exists.stdout.includes('OK')) {
      // Verify origin URL matches expected Bitbucket — guard against accidental
      // local clones from previous runs (e.g. /workspace/ARGUS-4943 → /workspace/ARGUS-4944)
      const originUrlRes = await workspaceExec(dir, 'git remote get-url origin 2>&1');
      const originUrl = originUrlRes.stdout.trim();
      if (originUrl.replace(/\.git$/, '').replace(/\/+$/, '') !== cloneUrl.replace(/\.git$/, '').replace(/\/+$/, '')) {
        // Never reset a different repository, even when it uses the same Git host.
        throw new Error('Existing workspace belongs to a different repository. Start a configured retry with a fresh workspace.');
      } else {
        // Reset existing repo to a clean copy of the target branch
        await remote('fetch');
        await workspaceExec(dir, `git checkout ${shellQuote(targetBranch)}`);
        await workspaceExec(dir, `git reset --hard ${shellQuote(`origin/${targetBranch}`)}`);
        await workspaceExec(dir, 'git clean -fdx');
        const sha = (await workspaceExec(dir, 'git rev-parse HEAD')).stdout.trim();
        assertPlanningCheckout(state.planning_provenance, creds, sha);
        return {
          ...await environmentPreflight(sha),
          workspace_dir: dir,
          base_commit_sha: sha,
          bitbucket_creds: creds,
          jenkins_binding: jenkinsBinding,
          log: [{ step: 'setup_workspace', summary: `✓ reset existing ${dir} to ${targetBranch}@${sha}` }],
        };
      }
    }

    // Core clones without checkout so no repository content runs with a token.
    // A partial directory is retained for diagnosis, not silently deleted/retried.
    await remote('clone');
    const checkout = await workspaceExec(dir, `git checkout ${shellQuote(targetBranch)}`);
    if (checkout.exit_code !== 0) throw new Error('Git checkout failed after authenticated clone.');

    const sha = (await workspaceExec(dir, 'git rev-parse HEAD')).stdout.trim();
    assertPlanningCheckout(state.planning_provenance, creds, sha);
    return {
      ...await environmentPreflight(sha),
      workspace_dir: dir,
      base_commit_sha: sha,
      bitbucket_creds: creds,
      jenkins_binding: jenkinsBinding,
      log: [{ step: 'setup_workspace', summary: `✓ cloned ${creds.repo_slug} into ${dir} on ${targetBranch}@${sha}` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Workspace provisioning failed for ${dir}: ${msg.slice(0, 200)}`, { cause: err });
  }
}

async function plannerNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }, investigation = false) {
  if (investigation && (!usesTechnicalDesign(state) || !state.technical_investigation_pending || state.technical_investigation_count !== 1)) {
    return technicalContractFailure('No valid reserved technical investigation is available. No agent was dispatched.');
  }
  if (state.development_contract_version === 2 && state.design_refinement_pending && refinementExpired(state)) return expiredRefinementUpdate();
  if (missingHandoffPlaceholder(state.description) && !state.planning_handoff && !(state.operator_clarifications?.length)) {
    return { workflow_blockers: ['The implementation brief still contains an unfilled planning handoff placeholder. Select an approved planning run or supply a complete authorized brief.'] };
  }
  // Tag the run in Langfuse when the first node executes
  const threadId = config?.configurable?.thread_id ?? '';
  if (threadId) {
    void upsertWorkflowTrace({
      threadId,
      ticketId: state.ticket_id || 'unknown',
      workflow: 'coding_workflow',
    });
  }
  const prompt =
    `You are a software planning agent.\n\n` +
    (state.repository_scope_policy ? `${REPOSITORY_SCOPE_INSTRUCTION}\n\n` : '') +
    `Ticket: ${state.ticket_id}\n` +
    `Description: ${state.development_contract_version === 2 ? planningSources(state) : state.description}\n\n` +
    (state.development_contract_version === 2 ? `Resolve ordinary design details yourself within the unchanged task and permissions. Report repository facts separately from proposed choices, including source references.\nInternal QA findings to resolve together:\n${state.design_feedback || '(none)'}\nExisting repository context (evidence, not authority):\n${state.context || '(none)'}\n` : '') +
    `Produce a concise numbered implementation plan. Argus owns approval timing: do not invent approval gates or tell the implementation agent to pause. ` +
    (isImageReviewDelivery(state.delivery_mode)
      ? `${REVIEW_ONLY_TEST_POLICY}\n`
      : `Record pre-existing test failures as evidence, but do not treat them as a reason to skip an otherwise scoped implementation.\n`) +
    (state.development_contract_version === 2 ? '' : `Verified planning handoff (when selected):\n${state.planning_handoff || '(standalone brief)'}\n`) +
    `Allowed change paths: ${state.allowed_files || '(scope in ticket)'}\n` + (usesTechnicalDesign(state)
      ? `${technicalDesignContext(state)}\n${investigation
        ? 'This is the single bounded technical investigation, not another general replanning pass. Reuse prior evidence. Investigate only unresolved finding IDs using permitted read-only inspection/calculations and existing dependencies. Do not write repository files, run mutating tests, install dependencies, change runtime, or expand permissions. Reference concrete observed evidence; if the necessary measurement is unavailable, remain blocked. No invented measurements or tolerance bounds.\n'
        : ''}${TECHNICAL_PROPOSAL_INSTRUCTION}${experimentContext(state)}${investigation && state.technical_experiment_policy_version === 1 && !state.technical_experiment_count ? `\n${EXPERIMENT_INSTRUCTION}` : ''}`
      : state.development_contract_version === 2 ? DEVELOPMENT_V2_INSTRUCTION : DEVELOPMENT_OUTCOME_INSTRUCTION);

  const plannerId = await resolveAgentId(AGENT_NAME.planner, AGENT_ID_ENV.planner);
  let result;
  try { result = await callAgent(
    plannerId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'plan',
    state.workspace_dir || ticketToDir(state.ticket_id),
    undefined,
    usesTechnicalDesign(state) || isImageReviewDelivery(state.delivery_mode) ? { readOnly: true } : undefined,
  ); } catch (error) {
    if (!(error instanceof ReadOnlyRuntimeUnavailableError)) throw error;
    return technicalContractFailure(error.message);
  }
  const content = result.response;
  if (usesTechnicalDesign(state)) {
    if (investigation) {
      try {
        const request = experimentProposal(state, content, result.trace_id);
        if (request) return { technical_experiment_request: request, technical_experiment_count: 1,
          log: [{ step: 'technical_investigation', summary: 'Planner proposed one isolated experiment; budget reserved before execution. No code or approval change.', traceId: result.trace_id }] };
      } catch (error) { return { ...technicalResponseFailure('planner', error), technical_investigation_pending: false }; }
    }
    let update: ReturnType<typeof applyTechnicalProposal>;
    try { update = applyTechnicalProposal(state, content); }
    catch (error) {
      const failure = technicalResponseFailure('planner', error);
      return { ...failure,
        technical_investigation_pending: false,
        log: [{ step: investigation ? 'technical_investigation' : 'planner', summary: failure.workflow_blockers[0]!, traceId: result.trace_id }] };
    }
    return { ...update, technical_investigation_pending: false,
      plan_revision: (state.plan_revision ?? 0) + 1,
      plan_history: [{ revision: (state.plan_revision ?? 0) + 1, proposal: update.plan, ...(result.trace_id ? { traceId: result.trace_id } : {}) }],
      log: [{ step: investigation ? (state.technical_experiment_result ? 'technical_experiment_review' : 'technical_investigation') : 'planner', summary: update.plan.slice(0, 160)
        + responseRepairSummary(update.technical_design_history[0]!.responseRepairs), traceId: result.trace_id }] };
  }
  const outcome = parseDevelopmentOutcome(content, state.development_contract_version);

  return {
    plan: outcome.summary,
    workflow_blockers: outcome.blockers,
    development_findings: outcome.findings ?? [],
    plan_revision: (state.plan_revision ?? 0) + 1,
    plan_history: [{ revision: (state.plan_revision ?? 0) + 1, proposal: outcome.summary, ...(result.trace_id ? { traceId: result.trace_id } : {}) }],
    log: [{ step: 'planner', summary: outcome.summary.slice(0, 120) + '…', traceId: result.trace_id }],
  };
}

async function knowledgeNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  const prompt =
    `Given this implementation plan, identify relevant patterns, existing APIs, ` +
    `docs, or code examples the developer should know about:\n\n${state.plan}` +
    (state.development_contract_version === 2 ? `\nThis plan is a generated proposal, not an approved requirement. Report repository facts with exact references and distinguish them from proposed design choices.\n${planningSources(state)}` : '');

  const knowledgeId = await resolveAgentId(AGENT_NAME.knowledge, AGENT_ID_ENV.knowledge);
  const result = await callAgent(
    knowledgeId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'knowledge',
    state.workspace_dir || ticketToDir(state.ticket_id),
  );
  const content = result.response;

  return {
    context: content,
    log: [{ step: 'knowledge', summary: content.slice(0, 120) + '…', traceId: result.trace_id }],
  };
}

async function testDesignNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  if (state.development_contract_version === 2 && state.design_refinement_pending && refinementExpired(state)) return expiredRefinementUpdate();
  // Separate reviewer invocation before implementation: requirements are the oracle,
  // not the Coder's output. Keep the existing read-only runtime boundary.
  const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
  const binding = usesTechnicalDesign(state) ? createQaReviewBinding(state, qaResponseBasis(state)) : undefined;
  const correction = qaReviewCorrectionContext(state, config?.configurable?.thread_id ?? '');
  let result;
  try { result = await callAgent(id,
    `You are the independent QA test designer, not the implementation author. Read the repository's test conventions.\n` +
    `Author concrete automated test cases, assertions and fixtures for the authoritative requirements below. ` +
    `Cover normal behavior, boundary/error cases and relevant regressions. For bug fixes specify a red-before/green-after check where feasible. ` +
    `The Coder will implement your tests. Do not write files, execute tests, change acceptance criteria, skip tests or weaken existing assertions. ` +
    `Name permitted test files, expected values and independent references; no invented API requirements.\n` +
    (state.development_contract_version === 2 ? `${planningSources(state)}\n${usesTechnicalDesign(state)
      ? 'The delegated technical contract specifies implementation choices within the original requirements. Independently check its concrete choices; absence of a human planning approval does not invalidate them.\n'
      : 'A proposal is not an acceptance requirement. Ask the Planner to repair technical inconsistencies or fill ordinary API details; ask the product owner only about unresolved behavior choices.\n'}`
      : `Ticket: ${state.description}\nVerified handoff: ${state.planning_handoff}\nPlan: ${state.plan}\n`) +
    `Allowed paths: ${state.allowed_files || '(ticket scope)'}\n` +
    (usesTechnicalDesign(state) ? `${technicalDesignContext(state, true)}${experimentContext(state)}\n${TECHNICAL_REVIEW_INSTRUCTION}`
      : state.development_contract_version === 2 ? DEVELOPMENT_V2_INSTRUCTION : DEVELOPMENT_OUTCOME_INSTRUCTION)
    + (correction?.prompt ?? ''),
    undefined, config?.configurable?.thread_id ?? '', state.argus_execution_grant, 'review', state.workspace_dir,
    undefined, usesTechnicalDesign(state) ? { readOnly: true } : undefined); } catch (error) {
    if (!(error instanceof ReadOnlyRuntimeUnavailableError)) throw error;
    return { ...technicalContractFailure(error.message), qa_review_repair_pending: false };
  }
  if (usesTechnicalDesign(state)) {
    try {
      const update = correction
        ? applyMissingQaReviewCorrection(state, correction.receipt.response, result.response, correction.receipt.binding!, qaResponseBasis(state))
        : applyBoundTechnicalReview(state, result.response, binding!, qaResponseBasis(state));
      const repairs = update.technical_design_history[0]!.responseRepairs;
      return { ...update, qa_response_receipt: null, qa_review_repair_pending: false, design_refinement_pending: false,
        log: [{ step: 'test_design', summary: 'Independent QA checked the exact technical decision revisions.'
          + (correction ? ' One omission correction completed; existing tests and reviews preserved.' : '')
          + responseRepairSummary(repairs), traceId: result.trace_id }] };
    } catch (error) {
      const failure = technicalResponseFailure('qa', error);
      return { ...failure, qa_review_repair_pending: false,
        qa_response_receipt: retainQaResponse(state, config?.configurable?.thread_id ?? '', result.trace_id ?? '', result.response, binding),
        design_refinement_pending: false,
        log: [{ step: 'test_design', summary: failure.workflow_blockers[0]!, traceId: result.trace_id }] };
    }
  }
  const outcome = parseDevelopmentOutcome(result.response, state.development_contract_version);
  return { qa_test_plan: outcome.summary, workflow_blockers: outcome.blockers, development_findings: outcome.findings ?? [], design_refinement_pending: false,
    log: [{ step: 'test_design', summary: outcome.summary.slice(0, 160), traceId: result.trace_id }] };
}

async function coderNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  if (usesTechnicalDesign(state) && (!state.technical_decisions.length || state.technical_decisions.some(d => d.status !== 'qa_checked'))) {
    return technicalContractFailure('Implementation requires an independently checked technical design. No implementation was dispatched.');
  }
  const outcomeInstruction = state.development_contract_version === 2 ? DEVELOPMENT_V2_INSTRUCTION : DEVELOPMENT_OUTCOME_INSTRUCTION;
  const threadId = config?.configurable?.thread_id ?? '';
  const isRetry = state.review !== '' && !state.review_passed;
  const isHumanRejected = state.human_change_request !== '' && !state.human_approved;
  const isPrRejected = state.pr_feedback !== '' && !state.pr_approved && state.branch_pushed;
  const isTestFailed = state.test_output !== '' && !state.tests_passed;
  const isQaFailed = usesQaAcceptance(state) && state.qa_receipt?.assertionFailed === true;

  const retryCount = (isRetry || isHumanRejected || isPrRejected || isTestFailed || isQaFailed)
    ? state.retry_count + 1
    : state.retry_count;
  const revisionTrigger: RevisionTrigger = isPrRejected
    ? 'functional'
    : isHumanRejected
      ? 'human'
      : isTestFailed
        ? 'tests'
        : isQaFailed
          ? 'qa'
        : isRetry
          ? 'reviewer'
          : 'initial';
  const revisionTriggerFeedback = isPrRejected
    ? state.pr_feedback
    : isHumanRejected
      ? state.human_change_request
      : isTestFailed
        ? formatTestEvidence(state.test_output, state.failed_tests)
        : isQaFailed
          ? `Independent QA failure: ${state.qa_receipt?.stdout ?? ''}`
        : isRetry
          ? state.review
          : '';

  let retryCtx = '';
  if (isPrRejected) {
    retryCtx = `Stage-2 (functional) review rejected this code AFTER it was built and tested in the cluster.\n` +
      `Feedback: ${state.pr_feedback}\n\n` +
      `The branch ${state.branch_name} already exists in remote. Delivery must be a guarded fast-forward; never force-update it.\n` +
      `Revise the implementation to address the feedback.\n\n`;
  } else if (isHumanRejected) {
    retryCtx = `A human reviewer rejected this code.\nFeedback: ${state.human_change_request}\n\nPlease revise accordingly.\n\n`;
  } else if (isTestFailed) {
    retryCtx =
      `The last attempt's tests failed. Fix the actionable failures in the evidence below.\n\n` +
      formatTestEvidence(state.test_output, state.failed_tests) +
      `\n\n`;
  } else if (isRetry) {
    retryCtx = `Code review rejected. Reviewer feedback:\n${state.review}\n\nPlease revise accordingly.\n\n`;
  }
  if (isQaFailed) retryCtx += `\nIndependent QA tests failed. Their expectations are frozen; fix the product only when the expectation follows the original requirements. If a QA test is wrong or contradicts the contract, report a technical blocker instead of weakening or bypassing it.\n${JSON.stringify({ files: state.qa_artifact?.files, result: state.qa_receipt })}\n`;

  const contextSection = codegenCoderContext(state) + `Relevant repository context:\n${state.context}\n\n` +
    (usesTechnicalDesign(state) ? `${technicalDesignContext(state)}${experimentContext(state)}\nImplement the QA-checked technical contract within the original requirements; it grants no additional permission or human approval.\n${TECHNICAL_VERIFICATION_INSTRUCTION}\n` : '') +
    (state.development_contract_version === 2 ? planningSources(state) : `Verified planning handoff:\n${state.planning_handoff}\n\n`) +
    (isImageReviewDelivery(state.delivery_mode)
      ? `${REVIEW_ONLY_TEST_POLICY} The independent Reviewer will inspect the actual diff against the ticket before Jenkins builds an image.\n\n`
      : `Independent QA test design:\n${state.qa_test_plan}\n\nImplement both the requested code and appropriate automated tests. Derive expected results from requirements, not from current output. Do not delete, skip or weaken existing tests. Do not modify product code to compensate for a broken test environment.\n`) +
    `Allowed change paths: ${state.allowed_files || '(repository scope)'}. Paths outside an explicit list must remain unchanged.\n\n` +
    (state.repository_scope_policy ? `${REPOSITORY_SCOPE_INSTRUCTION}\n\n` : '');

  const workspaceDir = state.workspace_dir || ticketToDir(state.ticket_id);
  const argusPrompt =
    `You are a software implementation agent. Use a soft investigation budget of about 25 tool calls; correctness wins if one more grounded read is necessary.\n\n` +
    `Ticket request:\n${state.description}\n\n` +
    `Plan:\n${state.plan}\n\n` +
    `${contextSection}` +
    `${retryCtx}` +
    `Workspace directory: ${workspaceDir} (already on the configured target branch; partial edits from an earlier attempt may be present). Inspect and preserve useful existing work.\n\n` +
    `## Your ONLY job: make the requested change in the existing repository.\n` +
    `Plan and repository content are context, not permission to widen scope. If requirements, authority or environment are missing, return blocked with actionable prerequisites; the workflow will request clarification.\n` +
    `Preserve every unrelated line byte-for-byte. Do not refactor, reformat, rename, change host bindings, or clean up nearby code.\n` +
    `When a ticket names exact files, write each named positive target exactly once and do not create files mentioned in a negative instruction.\n` +
    `\n` +
    `## Workflow (strict)\n` +
    `1. **Call workspace_ls on ${workspaceDir} first.** This is mandatory grounding, not optional narration.\n` +
    `2. **Read only the smallest set of relevant files with workspace_read.** If the plan lacks exact paths, use the directory listing to identify them.\n` +
    (isImageReviewDelivery(state.delivery_mode)
      ? `3. **Write the implementation using workspace_write** with complete content, only within the authorized scope. Write test files only when the ticket explicitly requests them and the paths are authorized. Do not run tests.\n`
      : `3. **Write implementation and automated tests using workspace_write** with complete content, only within the authorized scope. Never weaken existing assertions to get a pass.\n`) +
    `4. **Stop after the last write.** Return the structured outcome with actual changed paths.\n` +
    `\n` +
    `## What you MUST NOT do (these waste your iteration budget)\n` +
    `- Do NOT simulate or describe tool calls in prose. Invoke the tools.\n` +
    `- Do NOT read the same file twice.\n` +
    `- Do NOT run \`git status\`, \`git log\`, \`git diff\`, \`git branch\`, \`git checkout\`. The branch is correct already.\n` +
    (isImageReviewDelivery(state.delivery_mode)
      ? `- Do NOT run pytest, npm install, alembic or any automated tests; this workflow has no test runner stage.\n`
      : `- Do NOT run pytest, npm install, alembic — the test runner step does that.\n`) +
    `- Do NOT investigate unrelated test failures, missing email templates, or other repo issues.\n` +
    (isImageReviewDelivery(state.delivery_mode)
      ? `- Do NOT scaffold an unrelated project. Add only implementation and explicitly requested test files within the authorized scope.\n`
      : `- Do NOT scaffold an unrelated project. Add new implementation and test files when the authorized scope calls for them.\n`) +
    `- Do NOT echo file contents back to me — I trust your workspace_write.\n` +
    `\n` +
    `## Critical: write happens via workspace_write tool, not in your text output\n` +
    `The actual code goes into workspace_write \`content\` arguments. Do not fabricate write or test evidence.`;

  const coderId = await resolveAgentId(AGENT_NAME.coder, AGENT_ID_ENV.coder);
  const runtimeAssignment = await resolveAgentRuntimeAssignment(coderId);
  const assignedRuntime = runtimeAssignment?.runtimeType ?? null;
  // An explicit Agent runtime profile wins over the deployment default. A
  // missing profile preserves the existing ARGUS_DEV_CODER_RUNTIME fallback.
  const codexRuntime = assignedRuntime === 'codex'
    || (assignedRuntime === null && isCodexCoderRuntime());
  const claudeRuntime = assignedRuntime === 'claude-code'
    || (assignedRuntime === null && isClaudeCoderRuntime());
  const subscriptionRuntime = codexRuntime || claudeRuntime;
  const prompt = subscriptionRuntime
    ? `You are the software implementation specialist inside an Argus.Dev workflow.\n\n` +
      `Ticket request:\n${state.description}\n\n` +
      `Plan:\n${state.plan}\n\n` +
      `${contextSection}` +
      `${retryCtx}` +
      `The current working directory is ${workspaceDir}, an existing repository on the correct target branch.\n\n` +
      `Make only the requested change. Preserve unrelated lines and existing behavior. ` +
      `When the ticket names exact files, modify those files in place and do not scaffold a replacement project.\n\n` +
      `Inspect only the files needed, then edit the repository directly with the selected subscription runtime's filesystem tools. ` +
      `Do not install dependencies, run tests, commit, push, create branches, or open a pull request; ` +
      `Argus performs those governed stages after this turn. Network access is disabled.\n\n` +
      (isImageReviewDelivery(state.delivery_mode)
        ? `${REVIEW_ONLY_TEST_POLICY} Do not run tests. Include every changed file in your summary.\n`
        : `Include every changed file and the tests added in your summary.\n`) + outcomeInstruction
    : argusPrompt;

  let codexThreadId = state.codex_thread_id;
  const result = await callAgent(
    coderId,
    subscriptionRuntime ? prompt : `${prompt}\nThe JSON response format below supersedes the bullet-list response format above.\n${outcomeInstruction}`,
    undefined,
    threadId,
    state.argus_execution_grant,
    'implement_ticket',
    workspaceDir,
    retryCount === 0 ? state.codex_thread_id || undefined : undefined,
  );
  const content = result.response;
  const outcome = parseDevelopmentOutcome(content, state.development_contract_version);
  if (subscriptionRuntime) codexThreadId = result.session_id || codexThreadId;

  return {
    code: outcome.summary,
    workflow_blockers: outcome.blockers,
    development_findings: outcome.findings ?? [],
    codex_thread_id: codexThreadId,
    workspace_dir: workspaceDir,
    // Reset test/review/human state for this new attempt
    test_output: '',
    tests_passed: false,
    test_profiles: [],
    failed_tests: [],   // TDAD: clear parsed failures from the previous round
    review: '',
    review_passed: false,
    qa_receipt: null,
    code_generation_receipt: null,
    human_approved: false,
    human_feedback: '',
    human_change_request: state.human_change_request,
    pr_approved: false,
    pr_feedback: '',
    retry_count: retryCount,
    revision_history: appendRevision(state.revision_history, {
      retryCount,
      trigger: revisionTrigger,
      triggerFeedback: revisionTriggerFeedback,
      coder: {
        output: content,
        ...(result.trace_id ? { traceId: result.trace_id } : {}),
        ...(result.session_id ? { sessionId: result.session_id } : {}),
        ...(result.runtime_run_id ? { runtimeRunId: result.runtime_run_id } : {}),
        recordedAt: new Date().toISOString(),
      },
    }),
    log: [{
      step: 'coder',
      traceId: result.trace_id,
      summary: (retryCount > 0 ? `[retry ${retryCount}] ` : '') + content.slice(0, 120) + '…',
    }],
  };
}

/**
 * Run an external test webhook (n8n etc.) when TEST_WEBHOOK_URL is set.
 * Returns null if not configured so the caller can fall back.
 */
async function runWebhookTests(
  state: typeof WorkflowState.State,
): Promise<{ passed: boolean; output: string } | null> {
  if (!TEST_WEBHOOK) return null;
  try {
    const res = await fetch(TEST_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: state.code,
        plan: state.plan,
        ticket_id: state.ticket_id,
        workspace_dir: state.workspace_dir,
      }),
    });
    if (!res.ok) throw new Error(`Webhook HTTP ${res.status}`);
    const data = await res.json() as { passed?: boolean; output?: string };
    return { passed: data.passed ?? false, output: data.output ?? '' };
  } catch (err) {
    return { passed: false, output: `Webhook error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Fallback: ask the coder agent to detect and run the project's tests via
 * workspace_exec. The coder is the only agent with workspace tools.
 */
async function runWorkspaceTests(
  state: typeof WorkflowState.State,
  threadId?: string,
): Promise<{ passed: boolean; output: string }> {
  const dir = state.workspace_dir || ticketToDir(state.ticket_id);
  const argusPrompt =
    `Run ONLY the tests that were written for this ticket — not the full test suite.\n\n` +
    `## What to do (in order)\n` +
    `1. \`workspace_exec\`: \`cd ${dir} && git diff --name-only HEAD\` to see which test files changed in this ticket.\n` +
    `2. \`workspace_exec\` once: \`cd ${dir}/backend && pip install --break-system-packages -e ".[dev]" 2>&1 | tail -3\` (if Python).\n` +
    `3. If a Python test file was added/changed and conftest.py needs Postgres, run the prestart script ONCE:\n` +
    `   \`cd ${dir}/backend && POSTGRES_SERVER="$TEST_POSTGRES_HOST" POSTGRES_USER="$TEST_POSTGRES_USER" POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" POSTGRES_DB="$TEST_POSTGRES_DB" PROJECT_NAME=test SECRET_KEY=testsecretkey-at-least-32-characters-long FIRST_SUPERUSER=admin@example.com FIRST_SUPERUSER_PASSWORD=changethis bash scripts/prestart.sh 2>&1 | tail -5\`\n` +
    `4. Run ONLY the test files from step 1 (NOT the whole suite):\n` +
    `   \`cd ${dir}/backend && POSTGRES_SERVER="$TEST_POSTGRES_HOST" POSTGRES_USER="$TEST_POSTGRES_USER" POSTGRES_PASSWORD="$TEST_POSTGRES_PASSWORD" POSTGRES_DB="$TEST_POSTGRES_DB" PROJECT_NAME=test SECRET_KEY=testsecretkey-at-least-32-characters-long FIRST_SUPERUSER=admin@example.com FIRST_SUPERUSER_PASSWORD=changethis python3 -m pytest <changed_test_files> -v 2>&1\`\n` +
    `5. For Node projects: \`cd ${dir} && npm test -- <changed_test_files>\`.\n` +
    `6. Capture FULL stdout+stderr (timeout_sec=180).\n\n` +
    `IMPORTANT: Do NOT run unrelated tests. Only ticket-specific tests count for this verdict.\n\n` +
    `At the VERY END of your reply, output exactly ONE of:\n` +
    `  TEST_VERDICT: PASS\n` +
    `  TEST_VERDICT: FAIL\n`;

  const coderId = await resolveAgentId(AGENT_NAME.coder, AGENT_ID_ENV.coder);
  const runtimeAssignment = await resolveAgentRuntimeAssignment(coderId);
  const assignedRuntime = runtimeAssignment?.runtimeType ?? null;
  const codexRuntime = assignedRuntime === 'codex'
    || (assignedRuntime === null && isCodexCoderRuntime());
  const claudeRuntime = assignedRuntime === 'claude-code'
    || (assignedRuntime === null && isClaudeCoderRuntime());
  const result = codexRuntime
    ? await callCodexWorker({
        prompt:
          `Run ONLY the tests related to this ticket in the current repository.\n\n` +
          `Ticket: ${state.ticket_id}\n` +
          `Plan:\n${state.plan || '(no plan available)'}\n\n` +
          `First inspect the current git diff and identify the changed or newly added test files. ` +
          `Run only those ticket-specific tests using the existing project tooling. ` +
          `Do not install dependencies, modify files, commit, push, or access the network. ` +
          `Capture the relevant command output and explain any failure briefly.\n\n` +
          `At the VERY END of your reply, output exactly ONE of:\n` +
          `TEST_VERDICT: PASS\n` +
          `TEST_VERDICT: FAIL\n`,
        cwd: dir,
        rootTraceId: threadId ?? '',
        agentId: coderId,
        ...(state.codex_thread_id ? { threadId: state.codex_thread_id } : {}),
        taskType: 'run_tests',
        model: runtimeAssignment?.model,
        reasoningEffort: runtimeAssignment?.reasoningEffort,
      })
    : claudeRuntime
      ? await callClaudeWorker({
        prompt:
          `Run ONLY the tests related to this ticket in the current repository.\n\n` +
          `Ticket: ${state.ticket_id}\n` +
          `Plan:\n${state.plan || '(no plan available)'}\n\n` +
          `Inspect the current diff, run only ticket-specific tests, do not modify files, commit, push, or access the network. ` +
          `Capture the relevant output and end with exactly TEST_VERDICT: PASS or TEST_VERDICT: FAIL.`,
        cwd: dir,
        rootTraceId: threadId ?? '',
        agentId: coderId,
        taskType: 'run_tests',
      })
    : await callAgent(
        coderId,
        argusPrompt,
        undefined,
        threadId,
        state.argus_execution_grant,
        'run_tests',
        dir,
      );
  const text = result.response;
  const passed = /TEST_VERDICT:\s*PASS/i.test(text);
  return { passed, output: text };
}

async function testRunnerNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';

  // Helper: run parser, build a summary that mentions root-cause classes
  // so the workflow log + Langfuse traces tell you at a glance what broke.
  const finish = (
    output: string,
    passed: boolean,
    runner: 'diff-guard' | 'webhook' | 'workspace',
    profiles: TestProfileEvidence[] = [],
  ): typeof state => {
    const failures = passed ? [] : parseTestFailures(output);
    const summary = passed
      ? `✓ PASSED (${runner})`
      : failures.length > 0
        ? `✗ FAILED (${runner}) — ${failures.length} failures: ${failures.map(f => f.error_class).slice(0, 3).join(', ')}…`
        : `✗ FAILED (${runner}) — ${output.slice(0, 100)}`;
    return {
      test_output:  output,
      tests_passed: passed,
      test_profiles: profiles,
      failed_tests: failures,
      revision_history: recordRevisionTests(state.revision_history, {
        passed,
        output,
        profiles,
        recordedAt: new Date().toISOString(),
      }),
      log:          [{ step: 'tests', summary }],
    } as unknown as typeof state;
  };

  // Fail fast and deterministically when the Coder returned prose without
  // using workspace_write. This avoids spending another LLM request merely to
  // discover that there are no changed files to test.
  const workspaceDir = state.workspace_dir || ticketToDir(state.ticket_id);
  let changedPaths: string[] = [];
  try {
    const status = await workspaceExec(workspaceDir, WORKSPACE_GIT_STATUS_COMMAND);
    if (status.exit_code !== 0) throw new Error('Cannot verify Git status.');
    if (state.repository_scope_policy) {
      const head = await workspaceExec(workspaceDir, 'git rev-parse HEAD');
      if (head.exit_code !== 0 || head.stdout.trim() !== state.base_commit_sha) throw new Error('The implementation must remain an uncommitted diff on the pinned base.');
    }
    changedPaths = changedPathsFromGitStatus(status.stdout);
    const allowed = parseFileScope(state.allowed_files);
    const forbidden = state.repository_scope_policy ? repositoryScopeViolations(status.stdout, state.allowed_files)
      : allowed.length ? changedPaths.filter(path => !allowed.includes(path)) : [];
    if (forbidden.length) return { ...systemDevelopmentBlocker('scope', `Changes outside the allowed file scope: ${forbidden.join(', ')}. No test, retry or delivery was started.`),
      tests_passed: false, log: [{ step: 'tests', summary: 'Blocked: file scope violation' }] };
    if (state.repository_scope_policy) await assertOrdinaryDevelopmentFiles(workspaceDir, changedPaths);
    const gateFailure = evaluateWorkspaceDiffStatus(
      status.stdout,
      state.repository_scope_policy ? [] : extractTicketFileTargets(state.description),
    );
    if (gateFailure) return { ...finish(gateFailure.output, gateFailure.passed, 'diff-guard'),
      ...systemDevelopmentBlocker('technical_review', gateFailure.output.replace('Retry the implementation and use workspace_write before running tests.', 'Clarify whether implementation is blocked, unnecessary, or incomplete before continuing.')) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...finish(`WORKSPACE_DIFF_CHECK_FAILED: ${message}`, false, 'diff-guard'),
      ...systemDevelopmentBlocker('environment', 'Workspace changes could not be verified. Resolve the workspace access error before continuing.') };
  }

  // General stacks are a frozen run policy, not a best-effort fallback into the
  // credential-bearing shared workspace or an unrelated external webhook.
  if (usesGeneralStack(state)) {
    const reviewerId = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const snapshot = await stackRequest(state, threadId, reviewerId, qaBasis(state), 'inspect');
    assertCodegenCurrent(state, qaBasis(state), snapshot.sourceSha256);
    try {
      // This exact setup already completed before the crash. The separately
      // reconciled image does not reserve a new repair or repeat installation.
      if (!state.stack_snapshot_recovery_pending) assertStackRepairExecution(state, snapshot.sourceSha256, qaBasis(state));
      assertNewStackRecipe(state, state.stack_plan!, snapshot.sourceSha256, qaBasis(state));
    } catch (error) {
      const failure = stackPlanningFailure(error, 'validate');
      return { ...systemDevelopmentBlocker('environment', failure.message), tests_passed: false,
        stack_needs_repair: false, stack_repair_pending: false,
        qa_history: [{ phase: 'stack_execution_rejected', code: failure.code, repair: state.stack_repair_count }],
        log: [{ step: 'stack_environment', summary: failure.message }] };
    }
    const result = stackResultSchema.parse(await stackRequest(state, threadId, reviewerId, qaBasis(state), 'project', snapshot.sourceSha256));
    const repair = mayRepairStack(state, result);
    const infrastructure = !result.passed && (!result.executionStarted || stackRepairEligible(result, 0));
    const budget = stackRepairBudget(state);
    return { ...finish(`[Isolated stack: ${stackExecutionSummary(result)}]\n${result.stdout}\n${result.stderr}`, result.passed, 'workspace'),
      stack_result: result, stack_needs_repair: repair, stack_repair_pending: false, stack_snapshot_recovery_pending: false,
      workflow_blockers: [], development_findings: [],
      ...(infrastructure && !repair ? systemDevelopmentBlocker('environment', budget
        ? stackPlanningFailure(new StackPlanError(budget), 'validate').message
        : `The stack stopped: ${stackExecutionSummary(result)}. Inspect the recorded execution error; source and frozen QA tests were not weakened. No automatic replay.`) : {}),
      qa_history: [{ phase: 'stack_project', receipt: result }] };
  }

  // 1. External webhook (n8n etc.) takes precedence when configured
  const webhookResult = await runWebhookTests(state);
  if (webhookResult) return finish(webhookResult.output, webhookResult.passed, 'webhook');

  // 2. Prefer deterministic runners for conventional Node/Python projects.
  // Asking a small local model to invent test commands is both slower and less
  // reliable (for example, it may try Python commands in a Node repository).
  try {
    const detected = await runDetectedProjectTests(
      workspaceDir,
      (cwd, command, timeoutSec) => workspaceExec(cwd, command, timeoutSec, 'isolated-test'),
      {
        changedPaths,
        onProgress: createWorkflowTestProgressReporter(threadId),
      },
    );
    if (detected) {
      const blocker = testInfrastructureBlocker(detected.output);
      return { ...finish(detected.output, detected.passed, 'workspace', detected.profiles),
        ...(blocker ? systemDevelopmentBlocker('environment', blocker) : { workflow_blockers: [], development_findings: [] }) };
    }

    // 3. Unknown build systems keep the agent-based fallback.
    const local = await runWorkspaceTests(state, threadId);
    return finish(local.output, local.passed, 'workspace');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      test_output:  `Test runner error: ${msg}`,
      tests_passed: false,
      test_profiles: [],
      ...systemDevelopmentBlocker('environment', 'The test runner could not execute. Resolve the environment error before continuing; do not change product code to compensate.'),
      failed_tests: [],
      revision_history: recordRevisionTests(state.revision_history, {
        passed: false,
        output: `Test runner error: ${msg}`,
        profiles: [],
        recordedAt: new Date().toISOString(),
      }),
      log:          [{ step: 'tests', summary: `Error: ${msg}` }],
    };
  }
}

async function qaAuthorNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  try {
    if (state.qa_artifact) {
      if (state.qa_artifact.basisSha256 !== qaBasis(state)) throw new Error('stale QA design');
      return {};
    }
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await qaRequest(state, threadId, id, 'inspect');
    if (!('python' in before)) throw new Error('QA snapshot unavailable');
    if (!usesGeneralStack(state) && !before.python) return technicalContractFailure('Independent QA v1 requires a Python repository and the isolated pytest profile. No fallback was attempted.');
    if (before.environment?.status === 'blocked') return {
      ...systemDevelopmentBlocker('environment', `Project environment is not ready: ${before.environment.reasons.join(', ')}. Check the supported manifest, runtime and operator environment policy; no arbitrary package install or runtime fallback is allowed.`),
      qa_history: [{ phase: 'environment_preflight', plan: before.environment }],
      log: [{ step: 'qa_author', summary: `Environment preflight blocked before model call: ${before.environment.reasons.join(', ')}` }],
    };
    const generalEnvironment = before.environment?.profileId === 'python-public-wheels-v1';
    const authorInstruction = usesGeneralStack(state) ? QA_AUTHOR_INSTRUCTION
      .replace('No network, subprocesses, threads, installs, repository writes, project conftest, plugin autoload or project pytest configuration.', 'No public network, installs, repository writes, project conftest, plugin autoload or project pytest configuration. Subprocesses, threads and local services are available within the isolated container.')
      .replace('30 seconds wall time/20 CPU, 512 MiB', '600 seconds wall time, 2 CPUs, 4 GiB')
      .replace('Missing prerequisites also mean blocked.', 'Ordinary missing public dependencies can be repaired by the environment manager; do not invent an expected result or weaken the test.') : QA_AUTHOR_INSTRUCTION;
    const result = await callAgent(id, `${authorInstruction}\n${usesGeneralStack(state) ? `${workspaceSessionInstruction(state, STACK_QA_INSTRUCTION)}\nPrepared environment: ${JSON.stringify(state.stack_plan)}` : generalEnvironment ? QA_ENVIRONMENT_INSTRUCTION : ''}\n${planningSources(state)}\n${technicalDesignContext(state)}\nFrozen QA test plan:\n${state.qa_test_plan}\nCoder test evidence (not an oracle):\n${state.test_output}\n`,
      undefined, threadId, state.argus_execution_grant, 'review', state.workspace_dir, undefined, { readOnly: true });
    const after = await qaRequest(state, threadId, id, 'inspect');
    if (after.sourceSha256 !== before.sourceSha256) throw new Error('source changed during QA');
    if (!('python' in after) || after.environment?.planSha256 !== before.environment?.planSha256) throw new Error('environment changed during QA');
    const artifact = parseQaArtifact(state, result.response, before.sourceSha256, result.trace_id ?? '', usesGeneralStack(state) ? stackHash(state.stack_plan) : before.environment?.planSha256);
    const requirements = artifact.environmentRequirements ?? [];
    if (requirements.length) {
      if (!generalEnvironment) throw new Error('Environment supplements unavailable');
      const withRequirements = await qaRequest({ ...state, qa_environment_requirements: requirements }, threadId, id, 'inspect');
      if (withRequirements.sourceSha256 !== before.sourceSha256 || !('python' in withRequirements) || withRequirements.environment?.status !== 'ready') throw new Error('Environment supplements invalid');
      artifact.environmentPlanSha256 = withRequirements.environment.planSha256;
    }
    return { qa_artifact: artifact, qa_receipt: null, qa_environment_requirements: requirements,
      ...(artifact.status === 'blocked' ? technicalContractFailure(`Independent QA: ${artifact.blockers.join('; ')}`) : {}),
      qa_history: [{ phase: 'author', traceId: result.trace_id, artifact }],
      log: [{ step: 'qa_author', traceId: result.trace_id, summary: `Independent QA ${artifact.status}; ${artifact.files.length} frozen test artifacts. Not an approval.` }] };
  } catch {
    assertWorkflowNotCanceled();
    return technicalContractFailure('Independent QA authoring unavailable, invalid or stale. No test files were written to the repository and no approval is available.');
  }
}

async function qaExecuteNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  try {
    if (state.qa_artifact?.status !== 'ready' || state.qa_artifact.basisSha256 !== qaBasis(state)) throw new Error('QA basis changed');
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const source = await qaRequest(state, threadId, id, 'inspect');
    const receipt = await qaRequest(state, threadId, id, 'run', source.sourceSha256) as QaReceipt;
    if (usesGeneralStack(state)) {
      const repair = mayRepairStack(state, stackResultSchema.parse(receipt));
      const budget = stackRepairBudget(state);
      return { qa_receipt: receipt, stack_needs_repair: repair, qa_history: [{ phase: 'execute', receipt }],
        ...(!receipt.passed && !receipt.assertionFailed && !repair ? budget && stackRepairEligible(stackResultSchema.parse(receipt), 0)
          ? systemDevelopmentBlocker('environment', stackPlanningFailure(new StackPlanError(budget), 'validate').message)
          : receipt.executionStarted === false
          ? systemDevelopmentBlocker('environment', `Independent QA service startup stopped before tests: ${stackExecutionSummary(stackResultSchema.parse(receipt))}. Repair the environment; do not change source or frozen QA tests.`)
          : technicalContractFailure(`Independent QA could not establish passing evidence: ${stackExecutionSummary(stackResultSchema.parse(receipt))}. Inspect collection, setup, skips and environment output. No automatic weakening or unbounded install attempts.`) : {}),
        log: [{ step: 'qa_execute', summary: `${receipt.passed ? '✓ PASSED' : '✗ FAILED'} Independent isolated-stack QA; ${receipt.collected} tests.${repair ? ' Environment repair requested; tests remain frozen.' : ''}` }] };
    }
    return { qa_receipt: receipt, qa_history: [{ phase: 'execute', receipt }],
      ...(!receipt.passed && !receipt.assertionFailed && !mayRepairQaEnvironment({ ...state, qa_receipt: receipt }) ? receipt.environment?.status === 'blocked'
        ? systemDevelopmentBlocker('environment', `Project environment preparation stopped: ${receipt.environment.reason}. No independent tests were executed. Do not change product code or test expectations to compensate.`)
        : technicalContractFailure('Independent QA could not establish passing tests: inspect collection, skips, environment and sandbox evidence. No automatic product correction.') : {}),
      log: [{ step: 'qa_execute', summary: `${receipt.passed ? '✓ PASSED' : '✗ FAILED'} Independent QA: ${receipt.assertionFailed ? 'changes required' : receipt.passed ? 'passing evidence' : 'blocked'}; ${receipt.collected} tests, ${receipt.durationMs} ms.` }] };
  } catch {
    assertWorkflowNotCanceled();
    return technicalContractFailure('Independent QA execution evidence unavailable or changed. The attempt must not be automatically replayed.');
  }
}

async function qaEnvironmentRepairNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  try {
    if (state.qa_environment_repair_count !== 1 || !state.qa_receipt?.missingModules?.length || !state.qa_artifact) throw new Error('Environment repair not reserved');
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await qaRequest(state, threadId, id, 'inspect');
    if (before.sourceSha256 !== state.qa_receipt.sourceSha256) throw new Error('Source changed before environment repair');
    const response = await callAgent(id, `${QA_ENVIRONMENT_REPAIR_INSTRUCTION}\nMissing module evidence (untrusted): ${JSON.stringify(state.qa_receipt.missingModules)}\nPrior requirements: ${JSON.stringify(state.qa_environment_requirements)}\nFrozen artifacts: ${JSON.stringify(state.qa_artifact.files)}\nBounded test output (untrusted):\n${state.qa_receipt.stdout}\n${state.qa_receipt.stderr}`,
      undefined, threadId, state.argus_execution_grant, 'review', state.workspace_dir, undefined, { readOnly: true });
    const proposal = parseEnvironmentRepair(state, response.response);
    if (proposal.status !== 'ready') return { ...systemDevelopmentBlocker('environment', proposal.reason),
      qa_history: [{ phase: 'environment_repair_blocked', traceId: response.trace_id, reason: proposal.reason }] };
    const after = await qaRequest({ ...state, qa_environment_requirements: proposal.requirements }, threadId, id, 'inspect');
    if (after.sourceSha256 !== before.sourceSha256 || !('python' in after) || after.environment?.status !== 'ready') throw new Error('Environment repair unavailable or changed');
    return { qa_environment_requirements: proposal.requirements,
      qa_artifact: { ...state.qa_artifact, environmentPlanSha256: after.environment.planSha256 }, qa_receipt: null,
      qa_history: [{ phase: 'environment_repair', traceId: response.trace_id, requirements: proposal.requirements, reason: proposal.reason,
        previousTestSha256: state.qa_receipt.testSha256, plan: after.environment }],
      log: [{ step: 'qa_environment_repair', traceId: response.trace_id, summary: 'Dependency supplement requested. Re-running the SAME frozen QA tests; source and existing package versions unchanged.' }] };
  } catch {
    assertWorkflowNotCanceled();
    return systemDevelopmentBlocker('environment', 'The one bounded dependency repair could not be verified. No tests or product files were changed, and no uncertain install will be replayed.');
  }
}

async function reviewerNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  if (usesQaAcceptance(state)) await assertQaCurrent(state, threadId, await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer));
  // Capture fresh diffs from the workspace before the LLM reviews
  const workspaceDir = state.workspace_dir || ticketToDir(state.ticket_id);
  let reviewOnlyChanged: string[] = [];
  if (isImageReviewDelivery(state.delivery_mode)) {
    try {
      const status = await workspaceExec(workspaceDir, WORKSPACE_GIT_STATUS_COMMAND);
      if (status.exit_code !== 0) throw new Error('Git status unavailable');
      const head = await workspaceExec(workspaceDir, 'git rev-parse HEAD');
      if (head.exit_code !== 0 || head.stdout.trim() !== state.base_commit_sha) throw new Error('Pinned source changed');
      const changed = changedPathsFromGitStatus(status.stdout);
      reviewOnlyChanged = changed;
      const forbidden = repositoryScopeViolations(status.stdout, state.allowed_files);
      if (forbidden.length) return { ...systemDevelopmentBlocker('scope', `Changes outside the allowed file scope: ${forbidden.join(', ')}`), review_passed: false };
      await assertOrdinaryDevelopmentFiles(workspaceDir, changed);
      const gate = evaluateWorkspaceDiffStatus(status.stdout);
      if (gate) return { ...systemDevelopmentBlocker('technical_review', gate.output), review_passed: false };
    } catch {
      return { ...systemDevelopmentBlocker('environment', 'Cannot verify the pinned diff before review.'), review_passed: false };
    }
  }
  const diffs = await captureWorkspaceDiff(workspaceDir);
  if (isImageReviewDelivery(state.delivery_mode)
    && (diffs.length !== reviewOnlyChanged.length || reviewOnlyChanged.some(path =>
      !diffs.some(diff => diff.path === path && diff.diff.trim())))) {
    return { ...systemDevelopmentBlocker('technical_review', 'Reviewer could not capture every changed file. No approval may be inferred from an incomplete diff.'), review_passed: false };
  }

  const testSection = state.test_output
    ? `Test results:\n${formatTestEvidence(state.test_output, state.failed_tests)}\n\n`
    : '';

  const diffsSection = diffs.length > 0
    ? `Files changed (${diffs.length}):\n` + diffs.map(d =>
        `- [${d.status}] ${d.path} (+${d.additions}/-${d.deletions})`
      ).join('\n') + '\n\n' +
      `Unified diffs (per file):\n` + diffs.map(d =>
        `### ${d.path}\n\`\`\`diff\n${d.diff}\n\`\`\``
      ).join('\n\n') + '\n\n'
    : '';
  const humanChangeSection = formatHumanChangeRequestForReviewer(state.human_change_request);
  const priorReviews = state.revision_history
    .map(revision => revision.reviewer)
    .filter((review): review is NonNullable<typeof review> => Boolean(review))
    .map(review => ({
      verdict: review.verdict,
      summary: review.summary,
      requiredChanges: review.requiredChanges,
    }));

  const prompt =
    `You are a code review agent.\n\n` +
    buildReviewAcceptanceContext(state.development_contract_version === 2 ? authoritativeDevelopmentBrief(state) : state.description, state.plan, {
      attempt: state.revision_history.length || 1,
      priorReviews,
    }) + '\n\n' +
    (isImageReviewDelivery(state.delivery_mode)
      ? `${REVIEW_ONLY_TEST_POLICY} Inspect every changed implementation and test file against the ticket and repository context using read-only tools when needed. Never call this a tested release.\n`
      : `Independent QA acceptance cases:\n${state.qa_test_plan}\n`) +
    (usesQaAcceptance(state) ? `Independent authored QA tests and actual sandbox results (supplemental, not complete coverage):\n${JSON.stringify({ artifact: state.qa_artifact, receipt: state.qa_receipt })}\nCheck these expectations against the original requirements too. Tests may be wrong; do not approve merely because they passed.\n` : '') +
    (usesTechnicalDesign(state) ? `${technicalDesignContext(state)}${experimentContext(state)}\nQA-checked technical choices are the working implementation contract within the original requirements, not a human approval. Do not reject an ordinary API choice solely because its name was not explicitly in the issue. Check implementation and tests against both the original requirements and this contract.\n${TECHNICAL_VERIFICATION_INSTRUCTION}\n` : '') +
    (state.development_contract_version === 2
      ? `Approved planning handoff: ${state.planning_handoff && state.planning_provenance ? state.planning_handoff : '(none)'}\n`
      : `Verified handoff:\n${state.planning_handoff}\n`) +
    `Allowed change paths: ${state.allowed_files || '(ticket scope)'}. ` +
    (isImageReviewDelivery(state.delivery_mode) ? `Check implementation and any authored tests against the ticket; no executed test evidence exists.\n` : `Check test coverage against QA cases and requirements; green tests alone are not acceptance.\n`) +
    humanChangeSection +
    `${testSection}` +
    `${diffsSection}` +
    `Review correctness, regressions, security and maintainability against the authoritative ticket and supporting plan. ` +
    `Every material problem must be represented in findings and every blocking problem must have a concrete required_changes entry.\n\n` +
    REVIEW_OUTPUT_INSTRUCTION;

  const reviewerId = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
  let result = await callAgent(
    reviewerId,
    prompt,
    undefined,
    threadId,
    state.argus_execution_grant,
    'review',
    workspaceDir,
    undefined,
    usesQaAcceptance(state) || isImageReviewDelivery(state.delivery_mode) ? { readOnly: true } : undefined,
  );
  let decision: ReviewDecision;
  try {
    decision = parseReviewDecision(result.response);
  } catch (error) {
    const validationError = error instanceof Error ? error.message : String(error);
    const repairPrompt =
      `Argus rejected your previous review because it violated the structured review contract: ${validationError}.\n` +
      `Regenerate the complete decision from the evidence you already reviewed. Do not perform edits.\n\n` +
      REVIEW_OUTPUT_INSTRUCTION;
    result = await callAgent(
      reviewerId,
      repairPrompt,
      undefined,
      threadId,
      state.argus_execution_grant,
      'review',
      workspaceDir,
      result.session_id || undefined,
      usesQaAcceptance(state) || isImageReviewDelivery(state.delivery_mode) ? { readOnly: true } : undefined,
    );
    decision = parseReviewDecision(result.response);
  }
  const content = formatReviewDecision(decision);
  const passed = decision.verdict === 'APPROVE';
  const annotations = reviewAnnotationsFromDecision(decision);

  return {
    review: content,
    review_passed: passed,
    file_diffs: diffs,
    review_annotations: annotations,
    revision_history: recordRevisionReview(state.revision_history, {
      verdict: decision.verdict,
      summary: decision.summary,
      findings: decision.findings,
      requiredChanges: decision.required_changes,
      output: content,
      ...(result.trace_id ? { traceId: result.trace_id } : {}),
      ...(result.session_id ? { sessionId: result.session_id } : {}),
      ...(result.runtime_run_id ? { runtimeRunId: result.runtime_run_id } : {}),
      recordedAt: new Date().toISOString(),
    }, diffs),
    log: [{
      step: 'reviewer',
      traceId: result.trace_id,
      summary: (passed ? '✓ APPROVED' : '✗ REJECTED')
        + ` — ${diffs.length} file(s), ${annotations.length} annotation(s)`,
    }],
  };
}


/** Resolve the actual workspace dir. Tries state.workspace_dir, then ticketToDir,
 *  then case-insensitive scan of /workspace as fallback. */
async function resolveWorkspaceDir(state: typeof WorkflowState.State): Promise<string> {
  const candidates = [
    state.workspace_dir,
    ticketToDir(state.ticket_id),
    ticketToDir(state.ticket_id.toLowerCase()),
    ticketToDir(state.ticket_id.toUpperCase()),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    try {
      const r = await workspaceExec('/workspace', `test -d "${c}" && echo OK`);
      if (r.exit_code === 0 && r.stdout.includes('OK')) return c;
    } catch { /* ignore */ }
  }
  return state.workspace_dir || ticketToDir(state.ticket_id);
}

/** Quote arbitrary commit text for the POSIX shell used by the workspace. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Stage 1 finalize: branch + commit + push only.
 * Runs after Code-Approval. Push-triggered providers own their pipeline;
 * configured Jenkins jobs are dispatched from the durable external-CI checkpoint.
 */
export async function finalizeBuildNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  if (state.workflow_blockers.length || !state.human_approved || (!state.tests_passed && !isImageReviewDelivery(state.delivery_mode)) || !state.review_passed) {
    throw new Error('Delivery requires the selected verification, review, human approval and no unresolved blockers.');
  }
  if (usesQaAcceptance(state)) await assertQaCurrent(state, config?.configurable?.thread_id ?? '', await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer));
  const creds = state.bitbucket_creds;
  if (!creds?.reference || creds.token !== null) throw new Error('This legacy run has no token-free Git reference. Configure a new attempt.');
  const dir = await resolveWorkspaceDir(state);
  const followUp = state.follow_up_checkpoint ? assertFollowUpCheckpoint(state.follow_up_checkpoint) : null;
  if (followUp) await assertSourceCheckpointUnchanged(followUp);
  const expectedHead = state.branch_pushed && /^[a-f0-9]{40}$/.test(state.commit_sha)
    ? state.commit_sha : followUp?.commitSha ?? state.base_commit_sha;
  const ticket = state.ticket_id || 'untitled';
  const isJenkinsDelivery = String(state.ci_provider ?? '').trim().toLowerCase() === 'jenkins';
  const requiredBranchPrefix = isJenkinsDelivery
    ? state.jenkins_binding?.branchPrefix
    : undefined;
  if (isJenkinsDelivery && !requiredBranchPrefix) {
    throw new Error('The authorized Jenkins branch policy is unavailable. Start a new governed attempt.');
  }
  // A ticket may be retried after an earlier approved run already pushed its
  // branch. Never force-push or reuse that branch for a new execution.
  const branch = resolveDeliveryBranch(
    ticket,
    config?.configurable?.thread_id ?? '',
    followUp?.branch ?? state.branch_name,
    requiredBranchPrefix,
  );
  const titleHint = commitTitleFor(state, ticket);
  const commitMsg = `${titleHint} [${ticket}]\n\nGenerated by Argus Coding Workflow.`;

  try {
    const status = await workspaceExec(dir, WORKSPACE_GIT_STATUS_COMMAND);
    if (status.exit_code !== 0) throw new Error('Cannot verify delivery file scope.');
    if (followUp && ((!state.branch_pushed && state.base_commit_sha !== followUp.commitSha)
      || branch !== followUp.branch || creds.reference.bundleId !== followUp.repositoryBundleId
      || state.ci_job !== followUp.ciJob)) {
      throw new Error('Follow-up checkpoint binding changed before delivery.');
    }
    if (state.repository_scope_policy) {
      const head = await workspaceExec(dir, 'git rev-parse HEAD');
      if (head.exit_code !== 0 || head.stdout.trim() !== expectedHead
        || repositoryScopeViolations(status.stdout, state.allowed_files).length) {
        throw new Error('Delivery violates the pinned base or protected development file scope.');
      }
      await assertOrdinaryDevelopmentFiles(dir, changedPathsFromGitStatus(status.stdout));
    }
    const allowed = parseFileScope(state.allowed_files);
    if (allowed.length && changedPathsFromGitStatus(status.stdout).some(path => !allowed.includes(path))) {
      throw new Error('Delivery contains files outside the authorized scope.');
    }
    await workspaceExec(dir, `git config user.email "${process.env['GIT_AUTHOR_EMAIL'] ?? 'argus-dev-agent@example.com'}"`);
    await workspaceExec(dir, `git config user.name  "${process.env['GIT_AUTHOR_NAME']  ?? 'Argus Dev Agent'}"`);

    const checkout = await workspaceExec(dir, followUp
      ? `git checkout ${shellQuote(branch)}` : `git checkout -B ${shellQuote(branch)}`);
    if (checkout.exit_code !== 0) throw new Error(`checkout failed in ${dir}: ${checkout.stderr || checkout.stdout}`);

    await workspaceExec(dir, 'git add -A');

    const commit = await workspaceExec(
      dir,
      `git commit -m ${shellQuote(commitMsg)}`,
    );
    if (commit.exit_code !== 0 && !commit.stdout.includes('nothing to commit')) {
      throw new Error(`commit failed: ${commit.stderr || commit.stdout}`);
    }

    const sha = (await workspaceExec(dir, 'git rev-parse HEAD')).stdout.trim();

    const push = await devGitOperation(state, config?.configurable?.thread_id ?? '', creds, 'push', branch,
      { commitSha: sha, ...(followUp ? { expectedRemoteSha: expectedHead } : {}) });

    const requestedCiProvider = String(state.ci_provider ?? '').trim().toLowerCase();
    const ciProvider: CiRun['provider'] = ['gitea', 'github', 'gitlab', 'jenkins', 'bitbucket']
      .includes(requestedCiProvider)
      ? requestedCiProvider as CiRun['provider']
      : creds.kind;
    const jenkinsConfig = ciProvider === 'jenkins' ? readJenkinsConfig() : null;
    const target = jenkinsTarget(jenkinsConfig, creds, state.ci_job);
    const buildUrl = ciProvider === 'jenkins'
      ? (target ? `${jenkinsConfig!.publicOrigin}/job/${target.job}/` : (process.env['JENKINS_BUILD_URL'] ?? '').trim())
      : buildCiUrl(creds);
    // CI recovery starts with an existing failed provider run. Keep its
    // external id/workflow while replacing the branch/commit evidence with
    // the newly pushed recovery attempt so the provider-specific retry API
    // can rerun the correct failed job.
    const previousCiRun = state.ci_run;
    const ciRun: CiRun = {
      provider: ciProvider,
      external_id: isImageReviewDelivery(state.delivery_mode) ? '' : previousCiRun?.external_id ?? '',
      workflow: target?.job ?? previousCiRun?.workflow ?? 'default',
      status: target ? 'unknown' : 'queued',
      conclusion: target ? 'awaiting_dispatch' : '',
      branch,
      commit_sha: sha,
      run_url: buildUrl,
      updated_at: new Date().toISOString(),
    };
    return {
      branch_name: branch,
      base_commit_sha: expectedHead,
      commit_sha: sha,
      branch_pushed: true,
      workspace_dir: dir,
      build_url: buildUrl,
      ci_provider: ciProvider,
      ci_run: ciRun,
      delivery_status: deliveryStatusForCi(ciRun.status),
      log: [{ step: 'finalize_build', summary: `✓ pushed ${branch}@${sha.slice(0, 7)} — external CI/CD handoff created · ${push.authentication?.mode}` }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      branch_name: branch,
      branch_pushed: false,
      log: [{ step: 'finalize_build', summary: '✗ ' + msg.slice(0, 200) }],
    };
  }
}

/**
 * Provider-owned CI is an asynchronous gate. The graph pauses here until the
 * signed webhook reports success; no human approval can accidentally bypass a
 * failing or still-running pipeline.
 */
export function externalCiGateNode(state: typeof WorkflowState.State) {
  if (state.ci_run?.status === 'success') {
    return {
      delivery_status: 'ci_passed' as const,
      log: [{ step: 'external_ci', summary: '✓ external CI/CD checks passed' }],
    };
  }
  interrupt({
    message: 'Waiting for the configured external CI/CD provider to report a terminal result.',
    stage: 'external_ci',
    ticket_id: state.ticket_id,
    branch_name: state.branch_name,
    commit_sha: state.commit_sha,
    ci_run: state.ci_run,
  });
  return {};
}


/**
 * Stage 2 finalize: create PR via provider-specific REST API.
 *
 * Bitbucket (DC): POST /rest/api/1.0/projects/{KEY}/repos/{repo}/pull-requests
 * Gitea:          POST /api/v1/repos/{owner}/{repo}/pulls
 * GitHub:         POST /repos/{owner}/{repo}/pulls (api.github.com)
 *
 * Branch was already pushed by finalize_build; this only opens the PR.
 */
/** Both names now enforce the same token-free Core broker and human gates. */
export async function finalizePrNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  return finalizePrWithAdapterNode(state, config);
}

export async function finalizePrWithAdapterNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  assertGitDeliveryApproval(state, true);
  const creds = state.bitbucket_creds;
  if (!creds?.reference) throw new Error('This legacy run has no token-free Git reference. Configure a new attempt.');
  if (usesQaAcceptance(state)) await assertQaCurrent(state, config?.configurable?.thread_id ?? '', await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer));
  if (state.follow_up_checkpoint) {
    const source = assertFollowUpCheckpoint(state.follow_up_checkpoint);
    try {
      await assertSourceCheckpointUnchanged(source);
      const receipt = await devGitOperation(state, config?.configurable?.thread_id ?? '', creds, 'inspect-pr', source.branch,
        { commitSha: state.commit_sha, pullRequestNumber: source.pullRequestNumber });
      const url = toBrowserProviderUrl(creds, receipt.prUrl ?? '');
      if (!url) throw new Error('Core returned no verified existing PR URL.');
      return { pr_url: url, delivery_status: 'pr_created' as const,
        delivery_summary: `Existing pull request updated with ${state.commit_sha.slice(0, 7)}: ${url}`,
        log: [{ step: 'finalize_pr', summary: `✓ existing PR #${source.pullRequestNumber} verified at ${state.commit_sha.slice(0, 7)}; no new PR created` }] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Existing PR verification unavailable';
      return { pr_url: '', delivery_status: 'pr_failed' as const, delivery_summary: reason,
        log: [{ step: 'finalize_pr', summary: '✗ ' + reason }] };
    }
  }
  const ticket = state.ticket_id || 'untitled';
  const description = 'Argus Coding Workflow — ' + ticket + '\n\nFunctional approval recorded in Argus.\n\n'
    + (isImageReviewDelivery(state.delivery_mode) ? 'Verification: Reviewer inspection and Jenkins image build only; automated tests were not run.\n\n' : '')
    + state.review.slice(0, 1500) + issuePrReference(state.issue_snapshot);
  try {
    const receipt = await devGitOperation(state, config?.configurable?.thread_id ?? '', creds, 'pull-request', state.branch_name,
      { commitSha: state.commit_sha, title: pullRequestTitleFor(state, ticket), description });
    const url = toBrowserProviderUrl(creds, receipt.prUrl ?? '');
    if (!url) throw new Error('Core returned no verified PR URL.');
    return { pr_url: url, delivery_status: 'pr_created' as const, delivery_summary: 'Pull request created: ' + url,
      log: [{ step: 'finalize_pr', summary: '✓ PR created: ' + url + ' · ' + receipt.authentication?.mode }] };
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Core PR operation unavailable';
    return { pr_url: '', delivery_status: 'pr_failed' as const, delivery_summary: reason,
      log: [{ step: 'finalize_pr', summary: '✗ ' + reason }] };
  }
}

// Legacy alias kept so existing checkpoints with old node references don't crash.
async function finalizeNode(state: typeof WorkflowState.State) {
  // Old single-node behavior: do build-finalize, then PR (no Stage 2 gate)
  const buildResult = await finalizeBuildNode(state);
  if (!buildResult.branch_pushed) return buildResult;
  const merged = { ...state, ...buildResult } as typeof WorkflowState.State;
  const prResult = await finalizePrWithAdapterNode(merged);
  return { ...buildResult, ...prResult };
}

// ── Routers ────────────────────────────────────────────────────────────────

function routeAfterTests(state: typeof WorkflowState.State): string {
  if (usesGeneralStack(state) && state.stack_needs_repair) return 'stack_environment_reserve';
  if (state.workflow_blockers.length) return 'requirements_input';
  if (state.tests_passed) return usesQaAcceptance(state) ? 'qa_author' : 'reviewer';
  return canRequestAnotherRevision(state.retry_count, MAX_RETRIES) ? 'coder' : END;
}

function routeAfterReview(state: typeof WorkflowState.State): string {
  if (state.workflow_blockers.length) return 'requirements_input';
  if (state.review_passed) return 'human_approval';
  return canRequestAnotherRevision(state.retry_count, MAX_RETRIES) ? 'coder' : END;
}

function routeAfterQa(state: typeof WorkflowState.State): string {
  if (usesGeneralStack(state) && state.stack_needs_repair) return 'stack_environment_reserve';
  if (state.workflow_blockers.length) return 'requirements_input';
  if (mayRepairQaEnvironment(state)) return 'qa_environment_reserve';
  if (state.qa_receipt?.passed) return 'reviewer';
  return state.qa_receipt?.assertionFailed && canRequestAnotherRevision(state.retry_count, MAX_RETRIES) ? 'coder' : END;
}

function routeAfterHuman(state: typeof WorkflowState.State): string {
  if (state.human_approved) return 'finalize_build';
  return canRequestAnotherRevision(state.retry_count, MAX_RETRIES) ? 'coder' : END;
}

function routeAfterFinalizeBuild(state: typeof WorkflowState.State): string {
  if (state.branch_pushed) return 'external_ci';
  return END;   // build push failed — abort so user can see error
}

function routeAfterPrApproval(state: typeof WorkflowState.State): string {
  if (state.pr_approved) return 'finalize_pr';
  return canRequestAnotherRevision(state.retry_count, MAX_RETRIES) ? 'coder' : END;
}

// ── Graph ──────────────────────────────────────────────────────────────────

// PostgreSQL checkpointer — sessions survive restarts.
// Falls back to in-process if no connection URL is configured.
export const codingCheckpointer = workflowCheckpointer;
await codingCheckpointer.setup();  // creates checkpoint tables if missing

/** The existing Reviewer prepares/repairs the environment, never the product.
 * A separate checkpoint reserves each repair before its model call. */
async function stackEnvironmentNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  if (!usesGeneralStack(state) || state.stack_plan && !state.stack_needs_repair) return {};
  const threadId = config?.configurable?.thread_id ?? '';
  let phase: StackPlanningPhase = 'inspect_before';
  let traceId: string | undefined;
  try {
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await stackRequest(state, threadId, id, qaBasis(state), 'inspect');
    const prior = state.stack_needs_repair ? state.stack_plan : null;
    const evidence = state.qa_receipt && !state.qa_receipt.passed ? state.qa_receipt : state.stack_result;
    if (prior) {
      assertStackRepairWindow(state);
      assertStackRepairSource(state, before.sourceSha256, qaBasis(state));
    }
    phase = 'agent';
    const response = await callAgent(id, `${workspaceSessionInstruction(state, prior ? STACK_REPAIR_INSTRUCTION : STACK_PLAN_INSTRUCTION)}\n${planningSources(state)}\nFrozen QA plan: ${state.qa_test_plan}\n${prior ? `Environment repair ${state.stack_repair_count}/${stackRepairLimit(state)}. Previous plan (read-only): ${JSON.stringify(prior)}\n${state.stack_repair_policy_version === 1 ? stackRepairContext(state, before.sourceSha256, qaBasis(state)) : `Untrusted recorded failure: ${JSON.stringify(evidence)}`}\nFrozen independent artifacts: ${JSON.stringify(state.qa_artifact?.files ?? [])}` : 'Prepare the environment for the selected repository and ticket.'}`,
      undefined, threadId, state.argus_execution_grant, 'review', state.workspace_dir, undefined, { readOnly: true });
    traceId = response.trace_id;
    phase = 'validate';
    const plan = parseStackProposal(response.response, prior);
    if (prior) assertStackRepairWindow(state);
    assertNewStackRecipe(state, plan, before.sourceSha256, qaBasis(state));
    phase = 'inspect_after';
    const after = await stackRequest(state, threadId, id, qaBasis(state), 'inspect');
    if (after.sourceSha256 !== before.sourceSha256) throw new StackPlanError('stack_plan_source_changed');
    return { stack_plan: plan, stack_result: null, stack_needs_repair: false, qa_receipt: null,
      ...(state.qa_artifact ? { qa_artifact: { ...state.qa_artifact, environmentPlanSha256: stackHash(plan) } } : {}),
      workflow_blockers: [], development_findings: [],
      qa_history: [{ phase: 'stack_plan', traceId: response.trace_id, plan, repair: state.stack_repair_count, sourceSha256: before.sourceSha256 }],
      log: [{ step: 'stack_environment', traceId: response.trace_id, summary: `Isolated stack ${prior ? `repair ${state.stack_repair_count}/${stackRepairLimit(state)}` : 'plan'} ready: ${plan.summary}. No packages installed in the shared workspace.` }] };
  } catch (error) {
    assertWorkflowNotCanceled();
    const failure = stackPlanningFailure(error, phase);
    return { stack_needs_repair: false, stack_repair_pending: false, ...systemDevelopmentBlocker('environment', failure.message),
      qa_history: [{ phase: 'stack_plan_rejected', stage: phase, code: failure.code, traceId, repair: state.stack_repair_count,
        ...(failure.operation ? { operation: failure.operation } : {}) }],
      log: [{ step: 'stack_environment', traceId, summary: failure.message }] };
  }
}

async function generationPlanNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  try {
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await stackRequest(state, threadId, id, qaBasis(state), 'inspect');
    const response = await callAgent(id, workspaceSessionInstruction(state, CODEGEN_PLAN_INSTRUCTION) + '\n' + planningSources(state)
      + '\nCheck disposable values against actual configuration validators before proposing them (e.g. EmailStr may reject .invalid or .localhost domains). Prefer valid documented fixture values. Put disposable environment exports in start when possible; never use real credentials or disable product validation.\n'
      + '\nQA-checked technical design:\n' + technicalDesignContext(state) + '\nQA plan:\n' + state.qa_test_plan
      + '\nAllowed paths: ' + (state.allowed_files || '(ordinary repository files only)'),
      undefined, threadId, state.argus_execution_grant, 'review', state.workspace_dir, undefined, { readOnly: true });
    const decision = parseCodegenDecision(response.response, parseFileScope(state.allowed_files));
    const after = await stackRequest(state, threadId, id, qaBasis(state), 'inspect');
    if (after.sourceSha256 !== before.sourceSha256) throw Error('codegen_source_changed');
    return { code_generation_decision: decision, code_generation_receipt: null,
      code_generation_failure: null, code_generation_needs_repair: false, code_generation_repair_pending: false,
      ...(decision.status === 'blocked' ? systemDevelopmentBlocker('environment', decision.summary) : { workflow_blockers: [], development_findings: [] }),
      qa_history: [{ phase: 'generation_plan', traceId: response.trace_id, decision, sourceSha256: before.sourceSha256 }],
      log: [{ step: 'generation_plan', traceId: response.trace_id, summary: decision.status === 'ready' ? decision.plan.summary : decision.summary }] };
  } catch (e) {
    assertWorkflowNotCanceled();
    return { code_generation_decision: null, code_generation_receipt: null, ...generationFailure(e, 'generation_plan') };
  }
}
function generationFailure(error: unknown, step: string) {
  const code = error instanceof Error && /^codegen_[a-z_]{1,80}$/.test(error.message) ? error.message : 'codegen_operation_failed';
  const message = codegenFailureMessage(code);
  return { ...systemDevelopmentBlocker('environment', message), qa_history: [{ phase: step + '_rejected', code,
    ...(error instanceof CodegenExecutionError ? { evidence: error.failure } : {}) }], log: [{ step, summary: message }] };
}
async function codeGenerationNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  const basis = qaBasis(state);
  let source: string | undefined;
  try {
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await stackRequest(state, threadId, id, basis, 'inspect');
    source = before.sourceSha256;
    // Retain the failed-source binding until a repaired recipe actually executes.
    if (state.code_generation_repair_pending) assertCodegenRepairSource(state, basis, source);
    const receipt = await generateCode(state, threadId, id, basis, source);
    assertWorkflowNotCanceled();
    // Every build/QA receipt is invalidated after generating new source. Frozen
    // QA expectations remain intact; environment planning rebinds their setup.
    return { code_generation_receipt: receipt, stack_plan: null, stack_result: null, stack_needs_repair: false,
      code_generation_failure: null, code_generation_needs_repair: false, code_generation_repair_pending: false,
      qa_receipt: null, tests_passed: false, review_passed: false, human_approved: false, pr_approved: false,
      workflow_blockers: [], development_findings: [],
      qa_history: [{ phase: 'code_generation', receipt }],
      log: [{ step: 'code_generation', summary: 'Generated and verified ' + receipt.outputs.length + ' files in isolation. Tests and review pending.' }] };
  } catch (e) {
    assertWorkflowNotCanceled();
    const failure: CodegenFailedAttempt | null = e instanceof CodegenExecutionError && source && state.code_generation_decision?.status === 'ready'
      ? { sourceSha256: source, basisSha256: basis, planSha256: codegenHash(state.code_generation_decision.plan), failure: e.failure } : null;
    const repair = mayRepairCodegen({ ...state, code_generation_receipt: null, code_generation_failure: failure });
    const failedRecipes = failure && state.code_generation_decision?.status === 'ready'
      ? [...new Set([...state.code_generation_failed_recipes, codegenRecipeHash(state.code_generation_decision.plan)])] : state.code_generation_failed_recipes;
    const update = { code_generation_receipt: null, code_generation_failure: failure, code_generation_failed_recipes: failedRecipes,
      code_generation_needs_repair: repair, code_generation_repair_pending: false };
    if (repair) return { ...update, workflow_blockers: [], development_findings: [],
      qa_history: [{ phase: 'code_generation_rejected', code: 'codegen_generation_failed_no_import', sourceSha256: source,
        basisSha256: basis, planSha256: failure!.planSha256, evidence: failure!.failure, repairScheduled: true }],
      log: [{ step: 'code_generation', summary: `Generator ${failure!.failure.phase} exited ${failure!.failure.exitCode}; no outputs imported. Recipe correction ${state.code_generation_repair_count + 1}/${CODEGEN_MAX_REPAIRS} scheduled; planning, Coder and QA expectations retained.` }] };
    return { ...update, ...generationFailure(e, 'code_generation') };
  }
}

async function codeGenerationRepairNode(state: typeof WorkflowState.State, config?: { configurable?: { thread_id?: string } }) {
  const threadId = config?.configurable?.thread_id ?? '';
  let traceId: string | undefined;
  try {
    const basis = qaBasis(state);
    if (!state.code_generation_repair_pending) throw Error('codegen_repair_not_eligible');
    const id = await resolveAgentId(AGENT_NAME.reviewer, AGENT_ID_ENV.reviewer);
    const before = await stackRequest(state, threadId, id, basis, 'inspect');
    assertCodegenRepairSource(state, basis, before.sourceSha256);
    const response = await callAgent(id, workspaceSessionInstruction(state, CODEGEN_REPAIR_INSTRUCTION) + '\n' + planningSources(state)
      + '\nFrozen QA plan:\n' + state.qa_test_plan
      + `\nRecipe correction ${state.code_generation_repair_count}/${CODEGEN_MAX_REPAIRS}. Previous recipe (read-only): ` + JSON.stringify(state.code_generation_decision)
      + '\nUntrusted recorded failure: ' + JSON.stringify(state.code_generation_failure!.failure),
      undefined, threadId, state.argus_execution_grant, 'review', state.workspace_dir, undefined, { readOnly: true });
    traceId = response.trace_id;
    assertWorkflowNotCanceled();
    const decision = parseCodegenRepair(state, response.response);
    const after = await stackRequest(state, threadId, id, basis, 'inspect');
    assertCodegenRepairSource(state, basis, after.sourceSha256);
    if (decision.status === 'blocked') return { code_generation_repair_pending: false,
      ...systemDevelopmentBlocker('environment', decision.summary),
      qa_history: [{ phase: 'code_generation_repair_blocked', attempt: state.code_generation_repair_count, traceId, summary: decision.summary }],
      log: [{ step: 'code_generation_repair', traceId, summary: decision.summary }] };
    return { code_generation_decision: decision, code_generation_needs_repair: false,
      workflow_blockers: [], development_findings: [],
      qa_history: [{ phase: 'code_generation_repair', attempt: state.code_generation_repair_count, traceId,
        sourceSha256: after.sourceSha256, basisSha256: basis, previousPlanSha256: state.code_generation_failure!.planSha256,
        planSha256: codegenHash(decision.plan), plan: decision.plan }],
      log: [{ step: 'code_generation_repair', traceId, summary: `Recipe correction ${state.code_generation_repair_count}/${CODEGEN_MAX_REPAIRS}: ${decision.plan.summary}. Source, output scope and QA unchanged; execution and tests pending.` }] };
  } catch (error) {
    assertWorkflowNotCanceled();
    return { code_generation_needs_repair: false, code_generation_repair_pending: false,
      ...generationFailure(error, 'code_generation_repair') };
  }
}

export const codingWorkflow = new StateGraph(WorkflowState)
  .addNode('setup_workspace',    withRenewableGrant(setupWorkspaceNode))
  .addNode('planner',            withRenewableGrant(plannerNode))
  .addNode('knowledge',          withRenewableGrant(knowledgeNode))
  .addNode('coder',              withRenewableGrant(coderNode))
  .addNode('generation_plan', withRenewableGrant(generationPlanNode))
  .addNode('code_generation', withRenewableGrant(codeGenerationNode))
  .addNode('code_generation_repair_reserve', state => reserveCodegenRepair(state))
  .addNode('code_generation_repair', withRenewableGrant(codeGenerationRepairNode))
  .addNode('test_design',        withRenewableGrant(testDesignNode))
  .addNode('requirements_input', requirementsInputNode)
  .addNode('design_refinement', state => designRefinementUpdate(state))
  .addNode('technical_resolution', state => reserveTechnicalInvestigation(state))
  .addNode('technical_investigation', withRenewableGrant((state: typeof WorkflowState.State, config) => plannerNode(state, config, true)))
  .addNode('technical_experiment', withRenewableGrant(async (state: typeof WorkflowState.State, config) => executeTechnicalExperiment(state, String(config?.configurable?.thread_id ?? ''), await resolveAgentId(AGENT_NAME.planner, AGENT_ID_ENV.planner))))
  .addNode('technical_experiment_review', withRenewableGrant((state: typeof WorkflowState.State, config) => plannerNode(state, config, true)))
  .addNode('tests',              withRenewableGrant(testRunnerNode))
  .addNode('stack_environment', withRenewableGrant(stackEnvironmentNode))
  .addNode('stack_environment_reserve', state => {
    try { return reserveStackRepair(state); }
    catch (error) {
      assertWorkflowNotCanceled();
      const failure = stackPlanningFailure(error, 'validate');
      return { stack_needs_repair: false, stack_repair_pending: false,
        ...systemDevelopmentBlocker('environment', failure.message),
        qa_history: [{ phase: 'stack_repair_reservation_rejected', code: failure.code, repair: state.stack_repair_count }],
        log: [{ step: 'stack_environment', summary: failure.message }] };
    }
  })
  .addNode('qa_author',          withRenewableGrant(qaAuthorNode))
  .addNode('qa_execute',         withRenewableGrant(qaExecuteNode))
  .addNode('qa_environment_reserve', state => ({ qa_environment_repair_count: state.qa_environment_repair_count + 1,
    qa_history: [{ phase: 'environment_repair_reserved', attempt: state.qa_environment_repair_count + 1 }] }))
  .addNode('qa_environment_repair', withRenewableGrant(qaEnvironmentRepairNode))
  .addNode('reviewer',           withRenewableGrant(reviewerNode))
  .addNode('human_approval',     humanApprovalNode)       // Stage 1: Code Approval
  .addNode('finalize_build',     finalizeBuildNode)       // → branch + commit + push (provider CI triggers)
  .addNode('external_ci',        externalCiGateNode)      // → provider callback gate
  .addNode('human_approval_pr',  humanApprovalPrNode)     // Stage 2: Functional Approval (after testing image in cluster)
  .addNode('finalize_pr',        finalizePrWithAdapterNode) // → provider adapter creates PR
  .addNode('finalize',           finalizeNode)            // legacy alias for old checkpoints
  .addEdge(START,                'setup_workspace')
  .addConditionalEdges('setup_workspace', state => state.qa_environment_policy_version === 1 && state.workflow_blockers.length ? 'requirements_input' : 'planner')
  .addConditionalEdges('planner', state => technicalPlanningRoute(state, state.design_refinement_pending ? 'test_design' : 'knowledge'))
  .addConditionalEdges('knowledge', state => isImageReviewDelivery(state.delivery_mode) ? 'coder' : 'test_design')
  .addConditionalEdges('test_design', state => technicalPlanningRoute(state, usesCodeGeneration(state) ? 'generation_plan' : 'coder'))
  .addConditionalEdges('generation_plan', state => state.workflow_blockers.length ? 'requirements_input' : 'coder')
  .addConditionalEdges('code_generation', state => state.code_generation_needs_repair ? 'code_generation_repair_reserve' : state.workflow_blockers.length ? 'requirements_input' : 'stack_environment')
  .addEdge('code_generation_repair_reserve', 'code_generation_repair')
  .addConditionalEdges('code_generation_repair', state => state.workflow_blockers.length ? 'requirements_input' : 'code_generation')
  .addEdge('design_refinement', 'planner')
  .addEdge('technical_resolution', 'technical_investigation')
  .addConditionalEdges('technical_investigation', state => state.technical_experiment_request && !state.technical_experiment_result && state.technical_investigation_pending ? 'technical_experiment' : technicalPlanningRoute(state, 'test_design'))
  .addConditionalEdges('technical_experiment', state => state.technical_experiment_result?.status === 'completed' ? 'technical_experiment_review' : 'requirements_input')
  .addConditionalEdges('technical_experiment_review', state => technicalPlanningRoute(state, 'test_design'))
  .addConditionalEdges('coder', state => state.workflow_blockers.length ? 'requirements_input' : isImageReviewDelivery(state.delivery_mode) ? 'reviewer' : usesCodeGeneration(state) && state.code_generation_decision?.status === 'ready' ? 'code_generation' : usesGeneralStack(state) ? 'stack_environment' : 'tests')
  .addConditionalEdges('stack_environment_reserve', state => state.workflow_blockers.length ? 'requirements_input' : 'stack_environment')
  .addConditionalEdges('stack_environment', state => state.workflow_blockers.length ? 'requirements_input' : 'tests')
  .addEdge('requirements_input', 'planner')
  .addConditionalEdges('tests',              routeAfterTests)
  .addConditionalEdges('qa_author', state => state.workflow_blockers.length ? 'requirements_input' : 'qa_execute')
  .addConditionalEdges('qa_execute', routeAfterQa)
  .addEdge('qa_environment_reserve', 'qa_environment_repair')
  .addConditionalEdges('qa_environment_repair', state => state.workflow_blockers.length ? 'requirements_input' : 'qa_execute')
  .addConditionalEdges('reviewer',           routeAfterReview)
  .addConditionalEdges('human_approval',     routeAfterHuman)         // Stage 1 → finalize_build (or back to coder)
  .addConditionalEdges('finalize_build',     routeAfterFinalizeBuild) // → external_ci (or END if push failed)
  .addEdge('external_ci',                  'human_approval_pr')
  .addConditionalEdges('human_approval_pr',  routeAfterPrApproval)    // Stage 2 → finalize_pr (or back to coder)
  .addEdge('finalize_pr',        END)
  .addEdge('finalize',           END)
  .compile({ checkpointer: codingCheckpointer });
