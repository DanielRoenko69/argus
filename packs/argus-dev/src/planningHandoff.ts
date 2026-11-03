import { createHash } from 'node:crypto';
import type { GitCreds } from './state.js';
import { parseFileScope } from './developmentContract.js';

export interface PlanningProvenance { threadId: string; repository: string; gitOrigin: string; baseCommit: string; sha256: string }
type Data = Record<string, any>;

/** Read only persisted, approved evidence owned by this run's principal. */
export function verifiedPlanningHandoff(parent: Data | null, values: Data, principal: string, bundles: number[], allowedFiles: string) {
  parseFileScope(allowedFiles);
  if (!parent || parent.graph_id !== 'backlog_grooming' || parent.status !== 'completed'
    || parent.metadata?.execution_principal !== principal
    || !Array.isArray(parent.metadata?.execution_bundle_ids)
    || !parent.metadata.execution_bundle_ids.length
    || !parent.metadata.execution_bundle_ids.every((id: number) => bundles.includes(id))) {
    throw new Error('Planning handoff requires a completed plan owned by this principal and its authorized bundles.');
  }
  if (values.human_approved !== true || values.review_passed !== true || values.backlog_completed !== true
    || !/^[a-f0-9]{40}$/.test(values.base_commit_sha || '')) {
    throw new Error('An approved, reviewed plan with a pinned base is required.');
  }
  const creds = values.bitbucket_creds as GitCreds | undefined;
  const repository = String(values.repository || '');
  if (!creds || repository !== `${creds.project_key || creds.user_slug}/${creds.repo_slug}`) {
    throw new Error('Planning repository provenance is missing or inconsistent.');
  }
  const handoff = values.backlog_tasks;
  if (typeof handoff !== 'string' || !handoff.trim() || handoff.length > 60_000 || /\[truncated\]/i.test(handoff)) {
    throw new Error('Planning handoff is missing, truncated or exceeds 60000 characters. Create a bounded complete handoff.');
  }
  const provenance: PlanningProvenance = { threadId: parent.thread_id, repository,
    gitOrigin: creds.base_url.replace(/\/+$/, ''), baseCommit: values.base_commit_sha,
    sha256: createHash('sha256').update(handoff).digest('hex') };
  return { repository, planning_handoff: handoff, planning_provenance: provenance };
}

export function assertPlanningCheckout(provenance: PlanningProvenance | null, creds: GitCreds, commit?: string): void {
  if (!provenance) return;
  if (provenance.repository !== `${creds.project_key || creds.user_slug}/${creds.repo_slug}`
    || provenance.gitOrigin !== creds.base_url.replace(/\/+$/, '')
    || (commit !== undefined && commit !== provenance.baseCommit)) {
    throw new Error('Checkout differs from the approved planning repository/base. Re-plan against the current base; no implementation was started.');
  }
}
