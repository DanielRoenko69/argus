import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryStatusForCi, externalCiIsPending, mergeCiRun } from './ciLifecycle.js';
import type { CiRun } from './state.js';

const run = (status: CiRun['status']): CiRun => ({
  provider: 'gitea', external_id: '42', workflow: 'checks', status,
  conclusion: '', branch: 'feature/ARGUS-1', commit_sha: 'abc', run_url: '',
  updated_at: new Date().toISOString(),
});

test('maps external CI states to the Argus delivery lifecycle', () => {
  assert.equal(deliveryStatusForCi('queued'), 'awaiting_ci');
  assert.equal(deliveryStatusForCi('running'), 'ci_running');
  assert.equal(deliveryStatusForCi('success'), 'ci_passed');
  assert.equal(deliveryStatusForCi('failure'), 'ci_failed');
});

test('does not regress a terminal CI result on a stale webhook retry', () => {
  assert.equal(mergeCiRun(run('success'), run('running')).status, 'success');
  assert.equal(mergeCiRun(run('running'), run('success')).status, 'success');
  assert.equal(mergeCiRun(run('success'), { ...run('running'), external_id: '43', commit_sha: 'other' }).status, 'running');
});

test('recognizes only a pushed branch with a non-terminal CI result as pending', () => {
  assert.equal(externalCiIsPending({ branch_pushed: true, ci_run: run('queued') }), true);
  assert.equal(externalCiIsPending({ branch_pushed: true, ci_run: run('success') }), false);
  assert.equal(externalCiIsPending({ branch_pushed: false, ci_run: run('queued') }), false);
});
