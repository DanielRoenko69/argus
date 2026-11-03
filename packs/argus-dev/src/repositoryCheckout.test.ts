import assert from 'node:assert/strict';
import test from 'node:test';
import { selectCheckoutTarget } from './repositoryCheckout.js';
import type { GitCreds } from './state.js';
const target: GitCreds = { kind: 'gitea', base_url: 'http://gitea:3000', project_key: 'demo-demo', repo_slug: 'gem-demo-work', user_slug: '', token: null, target_branch: 'main' };
test('workspace checkout requires an unambiguous matching target', () => {
  assert.equal(selectCheckoutTarget([target, target], 'demo-demo/gem-demo-work'), target);
  assert.throws(() => selectCheckoutTarget([target], 'argus/sample'), /does not match/);
  assert.throws(() => selectCheckoutTarget([target, { ...target, base_url: 'http://other:3000' }], ''), /exactly one/);
  assert.throws(() => selectCheckoutTarget([], ''), /exactly one/);
});
