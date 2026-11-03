import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlanningCheckout, verifiedPlanningHandoff } from './planningHandoff.js';
import type { GitCreds } from './state.js';

const creds: GitCreds = { kind: 'gitea', base_url: 'http://gitea:3000', project_key: 'team', user_slug: '', repo_slug: 'repo', target_branch: 'main', token: null };
const parent = { thread_id: 'parent', graph_id: 'backlog_grooming', status: 'completed', metadata: { execution_principal: 'user:7', execution_bundle_ids: [10, 20] } };
const values = { human_approved: true, review_passed: true, backlog_completed: true, repository: 'team/repo', base_commit_sha: 'a'.repeat(40), bitbucket_creds: creds, backlog_tasks: 'A complete, approved slice with tests.' };
test('verified handoff pins content and checkout; no new authority', () => {
  const result = verifiedPlanningHandoff(parent, values, 'user:7', [10, 20], 'src/new.py\ntests/test_new.py');
  assert.equal(result.planning_handoff, values.backlog_tasks);
  assert.equal(result.planning_provenance.sha256.length, 64);
  assert.doesNotThrow(() => assertPlanningCheckout(result.planning_provenance, creds, 'a'.repeat(40)));
  assert.throws(() => assertPlanningCheckout(result.planning_provenance, creds, 'b'.repeat(40)));
  assert.throws(() => assertPlanningCheckout(result.planning_provenance, { ...creds, base_url: 'http://other' }));
});
test('rejects cross-user, unauthorized, unapproved, stale and incomplete handoffs', () => {
  assert.throws(() => verifiedPlanningHandoff(parent, values, 'user:8', [10, 20], 'src/new.py'));
  assert.throws(() => verifiedPlanningHandoff(parent, values, 'user:7', [10], 'src/new.py'));
  assert.doesNotThrow(() => verifiedPlanningHandoff(parent, values, 'user:7', [10, 20], ''));
  assert.throws(() => verifiedPlanningHandoff(parent, values, 'user:7', [10, 20], '../outside'));
  for (const delta of [{ human_approved: false }, { review_passed: false }, { backlog_completed: false }, { backlog_tasks: 'partial [truncated]' }, { base_commit_sha: '' }, { repository: 'other/repo' }]) {
    assert.throws(() => verifiedPlanningHandoff(parent, { ...values, ...delta }, 'user:7', [10, 20], 'src/new.py'));
  }
});
