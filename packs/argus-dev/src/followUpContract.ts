/** Immutable, non-secret handoff between completed Dev deliveries. A new
 * workflow thread gets a fresh grant and checkpoint history; the predecessor
 * is never resumed, copied wholesale or rewritten. */
import { createHash } from 'node:crypto';

export interface FollowUpCheckpoint {
  version: 1;
  sourceThreadId: string;
  sourceCheckpointId: string;
  repository: string;
  branch: string;
  commitSha: string;
  pullRequestUrl: string;
  pullRequestNumber: number;
  ciJob: string;
  repositoryBundleId: number;
  digest: string;
}

const sha = /^[a-f0-9]{40}$/;
const thread = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const digestMaterial = (value: Omit<FollowUpCheckpoint, 'digest'>): string => createHash('sha256')
  .update(JSON.stringify([value.version, value.sourceThreadId, value.sourceCheckpointId, value.repository,
    value.branch, value.commitSha, value.pullRequestUrl, value.pullRequestNumber, value.ciJob, value.repositoryBundleId]))
  .digest('hex');

export function assertFollowUpCheckpoint(value: FollowUpCheckpoint): FollowUpCheckpoint {
  const { digest, ...material } = value;
  const actualDigest = digestMaterial(material);
  if (value.version !== 1 || !thread.test(value.sourceThreadId) || !value.sourceCheckpointId || !sha.test(value.commitSha)
    || !/^feature\/[A-Za-z0-9][A-Za-z0-9._/-]{0,190}$/.test(value.branch)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    || !value.pullRequestUrl || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1
    || !value.ciJob || !Number.isSafeInteger(value.repositoryBundleId) || value.repositoryBundleId < 1
    || digest !== actualDigest) {
    throw new Error('A completed Dev delivery with a pinned branch, PR and Jenkins job is required.');
  }
  return value;
}

export function followUpCheckpointFromSource(source: {
  thread_id: string; graph_id: string; status: string; metadata: Record<string, unknown>;
}, snapshot: { checkpointId: string | null; next: readonly string[]; values: unknown } | null,
principal: string, bundleIds: readonly number[]): FollowUpCheckpoint {
  const values = record(snapshot?.values);
  const ci = record(values['ci_run']);
  const credentials = record(values['bitbucket_creds']);
  const reference = record(credentials['reference']);
  const repository = String(source.metadata['repository'] ?? '');
  const url = String(values['pr_url'] ?? '');
  const match = /\/pulls\/([1-9]\d*)\/?$/.exec(url);
  const bundleId = Number(reference['bundleId']);
  const supported = source.metadata['workflow_id'] === 'ticket-to-image-pull-request'
    || source.metadata['workflow_id'] === 'ticket-follow-up-image-pull-request';
  if (!supported || !['coding_image_workflow', 'coding_follow_up_image_workflow'].includes(source.graph_id)
    || source.status !== 'completed' || !snapshot?.checkpointId || snapshot.next.length !== 0
    || source.metadata['execution_principal'] !== principal || !bundleIds.includes(bundleId)
    || values['delivery_mode'] !== 'ticket-to-image-pull-request'
    || values['branch_pushed'] !== true || values['review_passed'] !== true
    || values['human_approved'] !== true || values['pr_approved'] !== true
    || ci['provider'] !== 'jenkins' || ci['status'] !== 'success'
    || ci['branch'] !== values['branch_name'] || ci['commit_sha'] !== values['commit_sha']
    || !match || !Number.isSafeInteger(bundleId)) {
    throw new Error('Only a completed, approved Jenkins image delivery owned by the same user can be continued.');
  }
  const material = {
    version: 1 as const,
    sourceThreadId: source.thread_id,
    sourceCheckpointId: snapshot.checkpointId,
    repository,
    branch: String(values['branch_name'] ?? ''),
    commitSha: String(values['commit_sha'] ?? ''),
    pullRequestUrl: url,
    pullRequestNumber: Number(match[1]),
    ciJob: String(values['ci_job'] ?? ''),
    repositoryBundleId: bundleId,
  };
  return assertFollowUpCheckpoint({ ...material, digest: digestMaterial(material) });
}
