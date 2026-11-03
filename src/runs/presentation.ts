import type {
  RunActionPolicy,
  RunAllowedAction,
  RunChildCounts,
  RunDisplayStatus,
  RunSourceRecord,
  RunStatusV2,
} from './types.js';

export const EMPTY_CHILD_COUNTS: Readonly<RunChildCounts> = Object.freeze({
  running: 0,
  waiting: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
});

export function statusBucket(status: RunStatusV2): keyof RunChildCounts {
  if (status === 'running') return 'running';
  if (status === 'waiting_for_approval' || status === 'waiting_for_external' || status === 'stopped') return 'waiting';
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'stale') return 'running';
  return 'failed';
}

export function directDisplayStatus(status: RunStatusV2): RunDisplayStatus {
  if (status === 'running') return 'active';
  if (status === 'waiting_for_approval') return 'action_required';
  if (status === 'waiting_for_external' || status === 'stopped') return 'waiting';
  if (status === 'completed') return 'succeeded';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'stale') return 'stale';
  return 'failed';
}

export function aggregateDisplayStatus(
  status: RunStatusV2,
  childCounts: RunChildCounts,
  hasActionRequiredChild = false,
  staleCandidate = false,
): RunDisplayStatus {
  const direct = directDisplayStatus(status);
  if (direct === 'action_required' || hasActionRequiredChild) return 'action_required';
  if (staleCandidate && childCounts.running === 0) return 'stale';
  if (direct === 'active' || childCounts.running > 0) return 'active';
  if (direct === 'waiting' || childCounts.waiting > 0) return 'waiting';
  if (direct === 'failed' || childCounts.failed > 0) return 'failed';
  return direct;
}

export function allowedRunActions(
  run: Pick<RunSourceRecord, 'kind' | 'status'>,
  _displayStatus: RunDisplayStatus,
  policy: RunActionPolicy,
): RunAllowedAction[] {
  const actions: RunAllowedAction[] = ['open'];
  const canCancel = run.kind === 'workflow' ? policy.canRunWorkflows : policy.canRunAgents;
  if (canCancel && ['running', 'waiting_for_approval', 'waiting_for_external', 'stale'].includes(run.status)) actions.push('cancel');
  if (run.status === 'waiting_for_approval' && policy.canReviewApprovals) actions.push('review_approval');
  return actions;
}
