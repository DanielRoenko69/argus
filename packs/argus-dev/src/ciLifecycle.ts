import type { CiRun } from './state.js';

/** Durable lifecycle exposed by the Argus control plane for external CI/CD. */
export type DeliveryStatus =
  | 'not_started'
  | 'awaiting_ci'
  | 'ci_running'
  | 'ci_passed'
  | 'ci_failed'
  | 'ci_canceled'
  | 'unknown'
  | 'pr_failed'
  | 'pr_created';

const TERMINAL_CI_STATUSES = new Set<CiRun['status']>(['success', 'failure', 'canceled']);

export function ciStatusIsTerminal(status: CiRun['status']): boolean {
  return TERMINAL_CI_STATUSES.has(status);
}

/**
 * Provider webhooks can be retried or arrive out of order. Preserve a terminal
 * result when a stale queued/running notification is delivered afterwards.
 */
export function mergeCiRun(current: CiRun | null | undefined, incoming: CiRun): CiRun {
  if (!current) return incoming;
  const sameExecution = Boolean(current.external_id && incoming.external_id
    && current.external_id === incoming.external_id)
    || Boolean(current.commit_sha && incoming.commit_sha && current.commit_sha === incoming.commit_sha);
  if (!sameExecution) return incoming;
  if (ciStatusIsTerminal(current.status) && current.status !== incoming.status) {
    return current;
  }
  return incoming;
}

export function deliveryStatusForCi(status: CiRun['status']): DeliveryStatus {
  switch (status) {
    case 'queued': return 'awaiting_ci';
    case 'running': return 'ci_running';
    case 'success': return 'ci_passed';
    case 'failure': return 'ci_failed';
    case 'canceled': return 'ci_canceled';
    default: return 'unknown';
  }
}

export function externalCiIsPending(values: Record<string, unknown>): boolean {
  if (values['branch_pushed'] !== true) return false;
  const ci = values['ci_run'];
  if (!ci || typeof ci !== 'object' || Array.isArray(ci)) return false;
  const status = (ci as Record<string, unknown>)['status'];
  return status !== 'success' && status !== 'failure' && status !== 'canceled';
}
