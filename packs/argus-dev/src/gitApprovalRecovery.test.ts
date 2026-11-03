import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalRecoveryStage, type ApprovalRecoveryState } from './gitApprovalRecovery.js';

const checkpointId = '11111111-1111-4111-8111-111111111111';
const base: ApprovalRecoveryState = {
  graphId: 'coding_follow_up_image_workflow', status: 'interrupted', checkpointId,
  next: ['human_approval'], interrupted: true,
  values: { bitbucket_creds: { reference: {} }, human_approved: false, branch_pushed: false },
};
const failed = (stage: 'human_approval' | 'human_approval_pr'): ApprovalRecoveryState => ({
  ...base, status: 'failed', next: [stage],
  values: { ...base.values, human_approved: stage === 'human_approval_pr', branch_pushed: stage === 'human_approval_pr' },
  previousRun: { kind: 'resume', status: 'failed', baseCheckpointId: checkpointId,
    payload: { gitApproval: { checkpointId, stage } } },
});

test('a recorded approval can be redispatched only at the same pending interrupt', () => {
  assert.equal(approvalRecoveryStage(base), 'human_approval');
  assert.equal(approvalRecoveryStage(failed('human_approval')), 'human_approval');
  assert.equal(approvalRecoveryStage(failed('human_approval_pr')), 'human_approval_pr');
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), next: [],
    failedTask: { name: 'human_approval', interrupted: true, error: true } }), 'human_approval');
});

test('failed recovery refuses changed checkpoint, missing prior dispatch and advanced delivery', () => {
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), checkpointId: 'other' }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), previousRun: null }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), previousRun: { kind: 'continue', status: 'failed',
    baseCheckpointId: checkpointId, payload: {} } }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), values: { ...base.values, branch_pushed: true } }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval_pr'), values: { ...failed('human_approval_pr').values,
    pr_url: 'http://gitea/pulls/1' } }), null);
  assert.equal(approvalRecoveryStage({ ...base, status: 'running' }), null);
  assert.equal(approvalRecoveryStage({ ...base, interrupted: false }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), next: [],
    failedTask: { name: 'human_approval', interrupted: true, error: false } }), null);
  assert.equal(approvalRecoveryStage({ ...failed('human_approval'), next: [],
    failedTask: { name: 'finalize_build', interrupted: true, error: true } }), null);
});
