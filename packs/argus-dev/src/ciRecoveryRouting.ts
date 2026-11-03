/**
 * Routing for the CI failure recovery graph, kept free of runtime imports so
 * the delivery preconditions can be verified without a workflow runtime.
 *
 * Core only accepts a Git write after verification, a passed review and a
 * human approval, so a recovery must pass its review before approval.
 */
export const MAX_CI_RECOVERY_RETRIES = 3;

export interface CiRecoveryRouteState {
  fix_applied: boolean;
  tests_passed: boolean;
  review_passed: boolean;
  retry_count: number;
}

export function routeAfterRecoveryTests(state: CiRecoveryRouteState, end: string): string {
  if (state.fix_applied && state.tests_passed) return 'ci_recovery_review';
  if (state.retry_count < MAX_CI_RECOVERY_RETRIES) return 'fix_ci_failure';
  return end;
}

export function routeAfterRecoveryReview(state: CiRecoveryRouteState, end: string): string {
  if (state.fix_applied && state.tests_passed && state.review_passed) return 'ci_recovery_approval';
  if (state.retry_count < MAX_CI_RECOVERY_RETRIES) return 'fix_ci_failure';
  return end;
}
