/**
 * WorkflowState — shared state schema for the coding workflow.
 *
 * Uses @langchain/langgraph 0.2.x Annotation API (not StateSchema/ReducedValue,
 * which do not exist in this version).
 *
 * Channel semantics:
 *   - Plain Annotation<T>({ reducer: (_, y) => y, default })  → last-value-wins
 *   - log uses an append reducer so each node's entries accumulate
 */

import { Annotation } from '@langchain/langgraph';
import type { PlanningProvenance } from './planningHandoff.js';
import type { DeliveryStatus } from './ciLifecycle.js';

type LogEntry = { step: string; summary: string; traceId?: string };

export type FileDiff = {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  diff: string;       // unified diff (truncated if huge)
};

export type ReviewAnnotation = {
  path: string;
  line?: number;
  severity: 'info' | 'suggestion' | 'concern';
  comment: string;    // 1-2 sentence note from reviewer
};

/** Provider-neutral status evidence returned by an external CI/CD system. */
export type CiRun = {
  provider: 'gitea' | 'github' | 'gitlab' | 'jenkins' | 'bitbucket' | 'unknown';
  external_id: string;
  workflow: string;
  status: 'queued' | 'running' | 'success' | 'failure' | 'canceled' | 'unknown';
  conclusion: string;
  branch: string;
  commit_sha: string;
  run_url: string;
  updated_at: string;
};

// Resolved at workflow start via Core's metadata-only Git reference endpoint.
// Persists in workflow state so downstream nodes (finalize_build, finalize_pr)
// reuse the same repository binding; Core resolves authentication per operation.
// Renamed from "BitbucketCreds" to support Gitea + GitHub too — kind field
// dispatches URL construction + PR API path in finalize_pr.
export type GitKind = 'bitbucket' | 'gitea' | 'github';

export type GitCreds = {
  kind: GitKind;            // provider for URL / PR API dispatch
  base_url: string;
  token: string | null;
  project_key: string;      // bitbucket only — empty for gitea/github
  user_slug: string;
  repo_slug: string;
  target_branch: string;
  // New governed checkouts persist metadata only. token remains null; the Core
  // broker resolves the original user's current credential for each operation.
  reference?: { version: 1; bundleId: number; backendId: number; binding: string };
};

// Backwards-compat alias — was named BitbucketCreds before Gitea/GitHub support.
export type BitbucketCreds = GitCreds;

// TDAD: structured representation of a parsed test failure so the Coder
// agent can do root-cause-aware fixes instead of dumping the whole stdout.
export type TestFailure = {
  test_file: string;        // e.g. backend/tests/api/routes/test_utils.py
  test_name?: string;        // e.g. test_healthcheck_returns_ok
  line?: number;             // line in the test file where the assertion lives
  error_class: 'assertion' | 'syntax' | 'import' | 'runtime' | 'timeout' | 'fixture' | 'unknown';
  error_message: string;     // first line of the failure
  trace_snippet?: string;     // 3-5 lines of relevant traceback
};

/** Deterministic project component tested during the latest workflow attempt. */
export type TestProfileEvidence = {
  id: string;
  runner: 'node' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | 'docs';
  root: string;
  passed: boolean;
};

export type RevisionTrigger = 'initial' | 'tests' | 'qa' | 'reviewer' | 'human' | 'functional';

export type RevisionAgentEvidence = {
  output: string;
  traceId?: string;
  sessionId?: string;
  runtimeRunId?: string;
  recordedAt: string;
};

export type RevisionTestEvidence = {
  passed: boolean;
  output: string;
  profiles: TestProfileEvidence[];
  recordedAt: string;
};

export type RevisionReviewEvidence = {
  verdict: 'APPROVE' | 'REQUEST_CHANGES';
  summary: string;
  findings: Array<{
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    message: string;
    file?: string;
    line?: number;
  }>;
  requiredChanges: string[];
  output: string;
  traceId?: string;
  sessionId?: string;
  runtimeRunId?: string;
  recordedAt: string;
};

export type RevisionHumanDecision = {
  stage: 'code' | 'functional';
  approved: boolean;
  feedback: string;
  recordedAt: string;
};

export type RevisionEvidence = {
  attempt: number;
  retryCount: number;
  trigger: RevisionTrigger;
  triggerFeedback: string;
  startedAt: string;
  coder: RevisionAgentEvidence;
  tests?: RevisionTestEvidence;
  reviewer?: RevisionReviewEvidence;
  humanDecisions: RevisionHumanDecision[];
  fileDiffs: FileDiff[];
};

export const WorkflowState = Annotation.Root({
  follow_up_checkpoint: Annotation<import('./followUpContract.js').FollowUpCheckpoint | null>({
    reducer: (_prev, next) => next, default: () => null,
  }),
  issue_snapshot: Annotation<import('./repositoryIssue.js').RepositoryIssueSnapshot | null>({ reducer: (_prev, next) => next, default: () => null }),
  repository_scope_policy: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  allowed_files: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  planning_thread_id: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  planning_handoff: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  planning_provenance: Annotation<PlanningProvenance | null>({ reducer: (_prev, next) => next, default: () => null }),
  ci_job: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  jenkins_binding: Annotation<import('./devCi.js').DevCiReference | null>({ reducer: (_, next) => next, default: () => null }),
  qa_test_plan: Annotation<string>({ reducer: (_prev, next) => next ?? '', default: () => '' }),
  qa_acceptance_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  qa_environment_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stack_plan: Annotation<import('./stackEnvironment.js').StackPlan | null>({ reducer: (_, next) => next, default: () => null }),
  stack_snapshot_recovery_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stack_snapshot_recovery_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  code_generation_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  code_generation_decision: Annotation<import('./codeGenerationContract.js').CodegenDecision | null>({ reducer: (_, next) => next, default: () => null }),
  code_generation_receipt: Annotation<import('./codeGenerationContract.js').CodegenReceipt | null>({ reducer: (_, next) => next, default: () => null }),
  code_generation_recovery_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  code_generation_repair_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  code_generation_repair_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  code_generation_needs_repair: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  code_generation_repair_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  code_generation_failure: Annotation<import('./codeGenerationRepair.js').CodegenFailedAttempt | null>({ reducer: (_, next) => next, default: () => null }),
  code_generation_failed_recipes: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  stack_result: Annotation<import('./stackEnvironment.js').StackResult | null>({ reducer: (_, next) => next, default: () => null }),
  stack_repair_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stack_repair_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stack_repair_started_at: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  stack_repair_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  stack_repair_source_sha256: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  stack_repair_basis_sha256: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  stack_needs_repair: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  qa_environment_requirements: Annotation<Array<{ requirement: string; reason: string }>>({ reducer: (_, next) => next, default: () => [] }),
  qa_environment_repair_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  qa_artifact: Annotation<import('./qaAcceptance.js').QaArtifact | null>({ reducer: (_, next) => next, default: () => null }),
  qa_receipt: Annotation<import('./qaAcceptance.js').QaReceipt | null>({ reducer: (_, next) => next, default: () => null }),
  qa_history: Annotation<Array<Record<string, unknown>>>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  workflow_blockers: Annotation<string[]>({ reducer: (_prev, next) => next ?? [], default: () => [] }),
  development_contract_version: Annotation<number>({ reducer: (_, next) => next, default: () => 1 }),
  delivery_mode: Annotation<string>({ reducer: (_, next) => next ?? '', default: () => '' }),
  technical_design_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  technical_decisions: Annotation<import('./technicalDesign.js').TechnicalDecision[]>({ reducer: (_, next) => next, default: () => [] }),
  technical_open_findings: Annotation<import('./technicalDesign.js').TechnicalFinding[]>({ reducer: (_, next) => next, default: () => [] }),
  technical_resolution_evidence: Annotation<NonNullable<import('./technicalDesign.js').TechnicalDesignState['technical_resolution_evidence']>>({ reducer: (_, next) => next, default: () => [] }),
  technical_investigation_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  technical_investigation_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  technical_experiment_policy_version: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  technical_experiment_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  technical_experiment_request: Annotation<import('./technicalExperiment.js').TechnicalExperiment | null>({ reducer: (_, next) => next, default: () => null }),
  technical_experiment_result: Annotation<import('./technicalExperiment.js').TechnicalExperimentReceipt | null>({ reducer: (_, next) => next, default: () => null }),
  technical_response_failure: Annotation<import('./technicalDesign.js').TechnicalResponseFailure | null>({ reducer: (_, next) => next, default: () => null }),
  qa_response_receipt: Annotation<import('./qaResponseRecovery.js').QaResponseReceipt | null>({ reducer: (_, next) => next, default: () => null }),
  qa_review_repair_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  qa_review_repair_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  technical_design_history: Annotation<Array<Record<string, unknown>>>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  development_findings: Annotation<import('./developmentDecisions.js').DevelopmentFinding[]>({ reducer: (_, next) => next, default: () => [] }),
  plan_revision: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  plan_history: Annotation<Array<{ revision: number; proposal: string; traceId?: string }>>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  operator_clarifications: Annotation<Array<{ decisionId: string; text: string }>>({ reducer: (prev, next) => [...prev, ...next], default: () => [] }),
  design_refinement_count: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  design_refinement_started_at: Annotation<number>({ reducer: (_, next) => next, default: () => 0 }),
  design_refinement_signatures: Annotation<string[]>({ reducer: (_, next) => next, default: () => [] }),
  design_refinement_pending: Annotation<boolean>({ reducer: (_, next) => next, default: () => false }),
  design_feedback: Annotation<string>({ reducer: (_, next) => next, default: () => '' }),
  // ── Input ──────────────────────────────────────────────────────────────────
  ticket_id: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  description: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  repository: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  pull_request_number: Annotation<number>({
    reducer: (_prev, next) => next ?? 0,
    default: () => 0,
  }),
  review_goal: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  ci_provider: Annotation<string>({
    reducer: (_prev, next) => next ?? 'unknown',
    default: () => 'unknown',
  }),
  ci_workflow: Annotation<string>({
    reducer: (_prev, next) => next ?? 'external CI/CD',
    default: () => 'external CI/CD',
  }),
  ci_run_url: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  ci_failure_context: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  source_branch: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_finding_id: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_tool: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_severity: Annotation<string>({
    reducer: (_prev, next) => next ?? 'unknown',
    default: () => 'unknown',
  }),
  security_package: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_current_version: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_fixed_version: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_finding_context: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  security_passed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  release_id: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  release_version: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  release_scope: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  release_goal: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  release_notes: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  release_completed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  backlog_id: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  issue_title: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  issue_body: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  backlog_constraints: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  backlog_audience: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  backlog_tasks: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  backlog_completed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  next_action: Annotation<string>({
    reducer: (_prev, next) => next ?? 'release_handoff',
    default: () => 'release_handoff',
  }),

  // Argus workflow ID — legacy resolution path (workflow → bundle → backend).
  // Prefer argus_bundle_id when starting from the workflow studio UI.
  argus_workflow_id: Annotation<number>({
    reducer: (_prev, next) => next ?? 0,
    default: () => 0,
  }),

  // Argus bundle ID — preferred resolution path. UI's coding-page passes this
  // directly. Argus resolves git provider backend within the bundle.
  argus_bundle_id: Annotation<number>({
    reducer: (_prev, next) => next ?? 0,
    default: () => 0,
  }),

  // Every Core-authorized execution bundle, in grant order. Coding workflows
  // may combine read-only context with a repository/CI bundle; repository
  // credential discovery must therefore not depend on which checkbox the
  // operator selected first. `argus_bundle_id` remains for legacy callers.
  argus_bundle_ids: Annotation<number[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),

  // Short-lived, Core-issued technical identity for A2A-started runs. The
  // compact token is forwarded unchanged; only Core can verify or authorize it.
  // It is intentionally omitted from every A2A artifact and telemetry summary.
  argus_execution_grant: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),

  // ── Artifacts (last value wins) ────────────────────────────────────────────
  argus_workspace_root: Annotation<string>({ reducer: (_, y) => y, default: () => '' }),
  workspace_dir: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),

  // New runs contain metadata + Core-bound reference, never an upstream token.
  // Historical token-bearing checkpoints are not rewritten or silently adopted.
  bitbucket_creds: Annotation<GitCreds | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
  plan: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  context: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  code: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  // Official Codex thread reused across retries for the same ticket. This is
  // an opaque local runtime identifier, never an authentication credential.
  codex_thread_id: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  review: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  // Evidence emitted by a PR-review fix attempt. Kept separate from the
  // original implementation artifact so the UI can show the retry clearly.
  fix_output: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  fix_applied: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),

  // ── Test results ───────────────────────────────────────────────────────────
  test_output: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  tests_passed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  test_profiles: Annotation<TestProfileEvidence[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  // TDAD: structured failures extracted from test_output so the retry-prompt
  // gives the Coder a focused, root-cause-classified failure list instead
  // of the raw stdout dump.
  failed_tests: Annotation<TestFailure[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),

  // ── Control ────────────────────────────────────────────────────────────────
  retry_count: Annotation<number>({
    reducer: (_prev, next) => next ?? 0,
    default: () => 0,
  }),
  review_passed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  human_approved: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  human_feedback: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  // Actionable scope requested by a human after rejecting the current code.
  // Approval rationale intentionally does not populate this field.
  human_change_request: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),

  // ── Append-only audit log (reducer concatenates arrays) ───────────────────
  log: Annotation<LogEntry[]>({
    reducer: (existing, incoming) => [...existing, ...incoming],
    default: () => [],
  }),

  // ── Diff + reviewer annotations (for UI display) ──────────────────────────
  file_diffs: Annotation<FileDiff[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  review_annotations: Annotation<ReviewAnnotation[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),
  // Append-only, attempt-scoped delivery evidence. Nodes update only the
  // latest attempt while older revisions remain immutable and inspectable.
  revision_history: Annotation<RevisionEvidence[]>({
    reducer: (_prev, next) => next ?? [],
    default: () => [],
  }),

  // ── Stage 1: branch + commit + push (Code Approval done) ─────────────────
  branch_name: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  commit_sha: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  base_commit_sha: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  branch_pushed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  build_url: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  // External CI/CD evidence. Argus pushes the branch but never owns the
  // provider's build or deployment execution.
  ci_run: Annotation<CiRun | null>({
    reducer: (_prev, next) => next ?? null,
    default: () => null,
  }),
  // Argus-owned lifecycle for provider-neutral external CI/CD evidence.
  delivery_status: Annotation<DeliveryStatus>({
    reducer: (_prev, next) => next ?? 'not_started',
    default: () => 'not_started',
  }),

  // ── Stage 2: PR creation (Functional Approval done) ──────────────────────
  pr_approved: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
  pr_feedback: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  pr_url: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  delivery_summary: Annotation<string>({
    reducer: (_prev, next) => next ?? '',
    default: () => '',
  }),
  ci_recovery_completed: Annotation<boolean>({
    reducer: (_prev, next) => next ?? false,
    default: () => false,
  }),
});
