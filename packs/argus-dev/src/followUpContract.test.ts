import test from 'node:test';
import assert from 'node:assert/strict';
import { followUpCheckpointFromSource, assertFollowUpCheckpoint } from './followUpContract.js';

const source = {
  thread_id: '11111111-1111-4111-8111-111111111111', graph_id: 'coding_image_workflow', status: 'completed',
  metadata: { workflow_id: 'ticket-to-image-pull-request', execution_principal: 'user:1', repository: 'alex/demo' },
};
const snapshot = {
  checkpointId: 'checkpoint-1', next: [] as string[],
  values: { delivery_mode: 'ticket-to-image-pull-request', branch_name: 'feature/DEMO-1',
    commit_sha: 'a'.repeat(40), pr_url: 'http://localhost:3005/alex/demo/pulls/2', ci_job: 'image-only',
    branch_pushed: true, review_passed: true, human_approved: true, pr_approved: true,
    bitbucket_creds: { reference: { bundleId: 8 } },
    ci_run: { provider: 'jenkins', status: 'success', branch: 'feature/DEMO-1', commit_sha: 'a'.repeat(40) } },
};

test('pins a completed approved image delivery without carrying credentials or full prior state', () => {
  const checkpoint = followUpCheckpointFromSource(source, snapshot, 'user:1', [8]);
  assert.equal(checkpoint.commitSha, 'a'.repeat(40));
  assert.equal(checkpoint.pullRequestNumber, 2);
  assert.equal(checkpoint.ciJob, 'image-only');
  assert.equal(checkpoint.repositoryBundleId, 8);
  assert.equal('bitbucket_creds' in checkpoint, false);
  assert.throws(() => assertFollowUpCheckpoint({ ...checkpoint, commitSha: 'b'.repeat(40) }), /pinned branch/);
});

test('refuses cross-principal, unapproved, in-progress or different-bundle continuation', () => {
  assert.throws(() => followUpCheckpointFromSource(source, snapshot, 'user:2', [8]), /same user/);
  assert.throws(() => followUpCheckpointFromSource(source, snapshot, 'user:1', [9]), /same user/);
  assert.throws(() => followUpCheckpointFromSource({ ...source, status: 'interrupted' }, snapshot, 'user:1', [8]), /completed/);
  assert.throws(() => followUpCheckpointFromSource(source,
    { ...snapshot, values: { ...snapshot.values, pr_approved: false } }, 'user:1', [8]), /approved/);
  assert.throws(() => followUpCheckpointFromSource(source,
    { ...snapshot, next: ['finalize_pr'] }, 'user:1', [8]), /completed/);
});
