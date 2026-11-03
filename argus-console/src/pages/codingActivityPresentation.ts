import type { DistributedTraceRun, SolutionPackCodingEvidence } from '../types';

export interface WorkflowActivityLog { step: string; summary: string; traceId?: string }
export type ReviewVerdict = 'approved' | 'changes-requested';

/** Display only: use persisted phase/attempt identities, never agent order as a verdict. */
export function bindCodingActivity<T extends DistributedTraceRun>(
  runs: T[], log: WorkflowActivityLog[], evidence: Partial<SolutionPackCodingEvidence>,
): Array<T & { reviewVerdict?: ReviewVerdict }> {
  const bindings = new Map<string, { workflowStepId: string; reviewVerdict?: ReviewVerdict }>();
  for (const entry of log) if (entry.traceId) bindings.set(entry.traceId, { workflowStepId: entry.step });
  for (const revision of evidence.revisionHistory ?? []) {
    if (revision.coder.traceId) bindings.set(revision.coder.traceId, { workflowStepId: 'coder' });
    if (revision.reviewer?.traceId) bindings.set(revision.reviewer.traceId, {
      workflowStepId: 'reviewer',
      reviewVerdict: revision.reviewer.verdict === 'APPROVE' ? 'approved' : 'changes-requested',
    });
  }
  // Legacy QA calls used taskType=review. Match a unique retained content prefix,
  // not chronology or the latest review verdict. Ambiguous/missing evidence stays unknown.
  const qa = log.filter(entry => entry.step === 'test_design' && !entry.traceId);
  for (const entry of qa) {
    const prefix = entry.summary.trim();
    if (prefix.length < 80) continue;
    const encoded = JSON.stringify(prefix).slice(1, -1);
    const matches = runs.filter(run => !bindings.has(run.id) && run.taskType === 'review'
      && (run.outputPreview?.startsWith(prefix) || run.outputPreview?.includes(`"summary":"${encoded}`)));
    if (matches.length === 1) bindings.set(matches[0]!.id, { workflowStepId: 'test_design' });
  }
  const activeQa = runs.filter(run => run.status === 'running' && run.taskType === 'review');
  if (['test_design', 'qa_author', 'qa_environment_repair', 'stack_environment', 'generation_plan', 'code_generation_repair'].includes(evidence.currentStage ?? '') && activeQa.length === 1 && !bindings.has(activeQa[0]!.id)) {
    bindings.set(activeQa[0]!.id, { workflowStepId: evidence.currentStage! });
  }
  return runs.map(run => ({ ...run, ...bindings.get(run.id) }));
}

export function codingProgressPresentation(input: {
  state: string; canceling: boolean; evidence: Partial<SolutionPackCodingEvidence>; maxRevisions?: number; technicalBlocked?: boolean; responseFailure?: boolean;
}) {
  const history = input.evidence.revisionHistory ?? [];
  const latest = history.at(-1);
  const reviewOnly = input.evidence.verificationMode === 'review-only-image';
  const stage = input.evidence.currentStage;
  const active = ['TASK_STATE_WORKING', 'TASK_STATE_SUBMITTED'].includes(input.state);
  const reviewing = active && stage === 'reviewer';
  const revising = active && stage === 'coder' && history.length > 0;
  const tests = latest?.tests ? latest.tests.passed ? 'passed' : 'failed' : 'not recorded';
  const review = latest?.reviewer ? latest.reviewer.verdict === 'APPROVE' ? 'passed' : 'changes requested' : 'not recorded';
  let title = reviewing ? 'Code review in progress' : revising ? 'Coder is revising the implementation' : 'Development checks';
  let detail = reviewOnly
    ? 'Automated tests are intentionally skipped. A completed agent invocation is not an accepted review; human approvals remain separate.'
    : 'A completed agent invocation is not a passed test or an accepted review. Human approvals remain separate.';
  let tone = 'neutral';
  if (input.canceling) { title = 'Cancellation requested'; detail = 'Waiting for the current operation to stop. No later workflow step will start.'; }
  else if (input.state === 'TASK_STATE_CANCELED') { title = 'Run canceled'; detail = 'No correction is running. Earlier agent results and reviewer findings remain evidence, not approval.'; }
  else if (['TASK_STATE_FAILED', 'TASK_STATE_REJECTED'].includes(input.state)) { title = 'Workflow stopped'; detail = 'No automatic correction is running. Inspect the checks and findings before configuring another attempt.'; }
  else if (active && stage === 'design_refinement') {
    title = 'Planner and QA are resolving a design conflict';
    detail = 'At most two internal design corrections. Requirements, permissions and delivery approvals remain unchanged.';
  } else if (active && ['code_generation_repair_reserve', 'code_generation_repair'].includes(stage ?? '')) {
    title = 'Correcting the isolated generator recipe';
    detail = 'At most two recipe corrections after a confirmed failed attempt with no import. Planning, Coder, source, output scope and QA expectations are retained. This is not an approval.';
  } else if (active && stage === 'code_generation') {
    title = 'Running the isolated repository generator';
    detail = 'Only declared generated files may be imported. Tests, review and human approvals still follow.';
  } else if (active && ['stack_environment', 'stack_environment_reserve'].includes(stage ?? '')) {
    title = 'Preparing the test environment';
    detail = 'The existing agent plans runtimes, dependencies and local services within the configured repair budget. Frozen tests and human approvals remain unchanged. These calls are not code reviews.';
  } else if (active && ['qa_environment_reserve', 'qa_environment_repair'].includes(stage ?? '')) {
    title = 'QA is checking a missing dependency';
    detail = 'At most one dependency supplement. Test source, expectations and product code remain unchanged. This is not code review or approval.';
  } else if (active && ['qa_author', 'qa_execute'].includes(stage ?? '')) {
    title = stage === 'qa_author' ? 'QA is authoring independent tests' : 'Independent QA tests are running';
    detail = 'Supplemental tests use an isolated source snapshot. Coder retries retain the same QA expectations and correction budget. This is not approval.';
  } else if (active && ['technical_resolution', 'technical_investigation'].includes(stage ?? '')) {
    title = 'Technical evidence investigation';
    detail = 'One additional bounded investigation, followed by independent QA. No extra permissions or human approvals are granted.';
  } else if (active && ['technical_experiment', 'technical_experiment_review'].includes(stage ?? '')) {
    title = stage === 'technical_experiment' ? 'Controlled technical experiment' : 'Planner is interpreting measurement evidence';
    detail = 'One isolated experiment within the existing investigation. Independent QA follows; no code or delivery approval is granted.';
  } else if (input.state === 'TASK_STATE_INPUT_REQUIRED' && input.technicalBlocked && input.responseFailure) {
    title = 'Agent response error — no answer required';
    detail = 'Argus could not validate the returned response. This is a technical format/integrity stop, not a product question. The checkpoint is saved; inspect recovery below. No automatic retry or approval.';
  } else if (input.state === 'TASK_STATE_INPUT_REQUIRED' && input.technicalBlocked) {
    title = 'Technical work blocked';
    detail = 'The checkpoint is saved. No product-owner answer or generic approval can resolve this technical evidence gap.';
  } else if (input.state === 'TASK_STATE_INPUT_REQUIRED' && stage === 'requirements_input') {
    title = 'Clarification needed — not an approval';
    detail = 'Review the decision or repair request below. Completing an agent call does not approve code or pull-request creation.';
  }
  else if (revising) {
    title = latest?.reviewer?.verdict === 'REQUEST_CHANGES' ? 'Changes requested — Coder is revising' : latest?.tests?.passed === false ? 'Tests failed — Coder is revising' : title;
    detail = reviewOnly
      ? 'This is a correction in the same run. Code review must pass again before human approval; automated tests remain skipped.'
      : 'This is a correction in the same run, not a restart of planning. Tests and code review must pass again before human approval.';
    tone = 'warning';
  } else if (input.state === 'TASK_STATE_INPUT_REQUIRED' && stage === 'human_approval') {
    title = 'Code review passed — human approval required'; tone = 'success';
  }
  const max = input.maxRevisions;
  return {
    title, detail, tone, latest,
    checks: `Latest completed implementation: tests ${reviewOnly ? 'intentionally skipped' : tests}; code review ${review}.`,
    count: `${history.length} completed implementation result${history.length === 1 ? '' : 's'}`,
    policy: Number.isInteger(max) && max! >= 0 ? `Current policy: at most ${max} correction rounds after the initial implementation.` : 'Correction limit unavailable in the current catalog.',
  };
}
