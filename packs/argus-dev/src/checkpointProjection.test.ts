import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCheckpointData } from './checkpointProjection.js';

test('private authority stays out of nested node results, interrupts and checkpoint metadata', () => {
  const secret = 'private-canary-never-public';
  const input = { tasks: [{ result: { argus_execution_grant: secret, human_approved: true,
    bitbucket_creds: { token: secret, repo_slug: 'demo' } } }],
    metadata: { step: 3, approvalGrant: secret, nested: { gitApproval: { grant: secret }, qa_response_receipt: secret } } };
  const output = publicCheckpointData(input);
  assert.ok(!JSON.stringify(output).includes(secret));
  assert.deepEqual(output, { tasks: [{ result: { human_approved: true,
    bitbucket_creds: { token: '[REDACTED]', repo_slug: 'demo' } } }], metadata: { step: 3, nested: {} } });
  assert.equal(input.tasks[0]!.result.argus_execution_grant, secret);
  assert.deepEqual(publicCheckpointData({ bitbucket_creds: { token: null } }), { bitbucket_creds: { token: null } });
});
