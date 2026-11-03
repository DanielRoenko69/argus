import { isGitBrokerCodingGraph } from './gitBrokerWorkflows.js';

export type ApprovalRecoveryStage = 'human_approval' | 'human_approval_pr';
type RecordValue = Record<string, unknown>;

export interface ApprovalRecoveryState {
  graphId: string;
  status: string;
  checkpointId: string | null;
  next: readonly string[];
  interrupted: boolean;
  failedTask?: { name: string; interrupted: boolean; error: boolean } | null;
  values: RecordValue;
  previousRun?: {
    kind: string;
    status: string;
    baseCheckpointId: string | null;
    payload: RecordValue;
  } | null;
}

/** A failed approval may be resumed only if the graph is still at the same
 * interrupt. The graph runs one superstep at a time, so no delivery node can
 * have executed while this exact approval interrupt remains current. */
export function approvalRecoveryStage(state: ApprovalRecoveryState): ApprovalRecoveryStage | null {
  if (!isGitBrokerCodingGraph(state.graphId) || !['interrupted', 'failed'].includes(state.status)
    || !state.checkpointId || !state.interrupted || state.next.length > 1
    || !state.values['bitbucket_creds'] || typeof state.values['bitbucket_creds'] !== 'object'
    || !(state.values['bitbucket_creds'] as RecordValue)['reference']) return null;
  // A LangGraph node exception retains the original checkpoint and interrupt,
  // but its failed task moves out of `next`. A missing/ambiguous task is never
  // interpreted as an approval.
  const stage = state.next.length === 1 ? state.next[0]
    : state.status === 'failed' && state.failedTask?.interrupted && state.failedTask.error
      ? state.failedTask.name : null;
  if (stage !== 'human_approval' && stage !== 'human_approval_pr') return null;
  if (stage === 'human_approval') {
    if (state.values['human_approved'] === true || state.values['branch_pushed'] === true) return null;
  } else if (state.values['human_approved'] !== true || state.values['branch_pushed'] !== true
    || state.values['pr_approved'] === true || Boolean(state.values['pr_url'])) return null;
  if (state.status === 'failed') {
    const run = state.previousRun;
    const approval = run?.payload['gitApproval'];
    if (!run || run.kind !== 'resume' || run.status !== 'failed' || run.baseCheckpointId !== state.checkpointId
      || !approval || typeof approval !== 'object' || Array.isArray(approval)
      || (approval as RecordValue)['checkpointId'] !== state.checkpointId
      || (approval as RecordValue)['stage'] !== stage) return null;
  }
  return stage;
}
