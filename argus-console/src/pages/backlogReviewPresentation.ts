/** Display-only interpretation. Never changes workflow state or approval. */
export function reviewOutcome(text: string | null | undefined): 'approved' | 'changes-requested' | null {
  // Direct runtimes return structured review JSON. Truncated JSON and ambiguous
  // prose must stay unknown; persisted per-attempt evidence is preferred by callers.
  try {
    const value = JSON.parse(text ?? '');
    if (value?.verdict === 'REQUEST_CHANGES' && Array.isArray(value.required_changes) && value.required_changes.length > 0) return 'changes-requested';
    if (value?.verdict === 'APPROVE' && Array.isArray(value.required_changes) && value.required_changes.length === 0
      && !value.findings?.some((finding: { severity?: string }) => ['critical', 'high'].includes(finding.severity ?? ''))) return 'approved';
  } catch { /* Legacy text is handled below. */ }
  const verdicts = [...(text ?? '').matchAll(/^\s*VERDICT:\s*(APPROVED|REJECTED)\s*$/gim)];
  if (verdicts.length !== 1) return null;
  return verdicts[0]![1]!.toUpperCase() === 'APPROVED' ? 'approved' : 'changes-requested';
}

export function backlogReviewPresentation(input: {
  state: string;
  canceling: boolean;
  stage?: string;
  review?: string;
  passed?: boolean;
  humanApproved?: boolean;
  humanChangeRequest?: string;
  retries?: number;
  completedReviews: number;
  maxAttempts?: number;
}) {
  if (!input.review?.trim()) return null;
  const max = Number.isInteger(input.maxAttempts) && input.maxAttempts! > 0 && input.maxAttempts! <= 100
    ? input.maxAttempts! : null;
  const reviewed = Math.max(1, input.completedReviews);
  const rejected = input.passed === false;
  const active = input.state === 'TASK_STATE_WORKING' || input.state === 'TASK_STATE_SUBMITTED';
  const humanRevision = Boolean(input.humanChangeRequest?.trim()) && input.humanApproved !== true;
  const revising = active && !input.canceling && (rejected || humanRevision) && input.stage === 'decompose_backlog';
  const rechecking = active && !input.canceling && (rejected || humanRevision) && input.stage === 'review_backlog';
  const round = reviewed + (revising || rechecking ? 1 : 0);
  // Human-requested revisions can add accepted reviews without consuming the
  // automatic rejection budget. Never show a misleading total such as 3/2.
  const roundLabel = `Round ${round}${max == null || humanRevision || round > max ? '' : `/${max}`}`;
  const policy = max == null ? 'Automatic review limit unavailable.' : `Current automatic review limit: ${max} rounds. Human-requested revisions may add review rounds.`;
  const decision = input.passed === true ? 'Review passed' : rejected ? 'Changes requested' : 'Review outcome unavailable';
  let title = decision;
  let detail = 'Agent execution finishing does not mean the plan is approved. Human approval remains separate.';
  let tone = input.passed === true ? 'success' : 'warning';
  if (input.canceling) {
    title = 'Cancellation requested';
    detail = 'Waiting for the current operation to stop. No further plan or review step will start.';
    tone = 'neutral';
  } else if (input.state === 'TASK_STATE_CANCELED') {
    title = 'Run canceled';
    detail = 'No plan revision is running. The last reviewer findings remain available as evidence.';
    tone = 'neutral';
  } else if (input.state === 'TASK_STATE_FAILED' || input.state === 'TASK_STATE_REJECTED') {
    title = rejected && max != null && (input.retries ?? 0) >= max
      ? 'Review limit reached — changes still required' : 'Workflow stopped';
    detail = 'No automatic plan revision is running. Review the findings before configuring a new attempt.';
  } else if (humanRevision && (revising || rechecking)) {
    title = `${revising ? 'Human changes requested — revising plan' : 'Reviewing human-requested revision'} · ${roundLabel.toLowerCase()}`;
    detail = 'The previous agent verdict remains evidence. A human requested changes; the updated plan must be reviewed and approved separately.';
    tone = 'warning';
  } else if (input.passed === true) {
    title = input.humanApproved ? 'Plan review passed — human approval recorded' : 'Plan review passed — human approval required';
    detail = 'The reviewer accepted the plan. This does not approve implementation, CI execution or a pull request.';
  } else if (revising) {
    title = `Changes requested — revising plan · ${roundLabel.toLowerCase()}`;
    detail = 'The reviewer rejected the previous plan. The planner is addressing the findings below; this is a revision in the same run, not a full restart.';
  } else if (rechecking) {
    title = `Reviewing revised plan · ${roundLabel.toLowerCase()}`;
    detail = 'The previous review requested changes. The revised plan is now being checked; the next verdict is still pending.';
  }
  return { title, detail, tone, decision, roundLabel, policy };
}
