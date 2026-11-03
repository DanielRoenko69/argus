import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshDevGrant, withRenewableGrant } from './grantRenewal.js';
const now = Math.floor(Date.now() / 1000);
const claims = { v: 1, iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator', jti: 'grant',
  principalKind: 'user', principalId: '3', bundleIds: [50,3,4], coreAgentIds: [2], messageId: 'message', rootTraceId: 'thread',
  workspaceRoot: '/workspace/TEST', iat: now - 7200, exp: now - 3600 };
const token = (c = claims) => 'eg_v1.' + Buffer.from(JSON.stringify(c)).toString('base64url') + '.fixture';
test('fresh grants need no renewal call; expired grants get exactly one bounded private renewal', async () => {
  let calls = 0;
  const fresh = token({ ...claims, iat: now, exp: now + 3600 });
  const fetchFn = (async (_url: unknown, init: RequestInit) => {
    calls++; assert.equal(init.redirect, 'error'); assert.ok(init.signal); assert.equal(JSON.parse(String(init.body)).runId, 'run');
    return Response.json({ grant: fresh });
  }) as typeof fetch;
  assert.equal(await freshDevGrant(fresh, 'thread', 'run', fetchFn), fresh); assert.equal(calls, 0);
  assert.equal(await freshDevGrant(token(), 'thread', 'run', fetchFn), fresh); assert.equal(calls, 1);
});
test('authority drift, expired replacement and errors stop without provider fallback or retries', async () => {
  for (const change of [{ bundleIds: [50,3,4,5] }, { jti: 'other' }, { workspaceRoot: '/workspace/OTHER' }, { principalId: '4' }, { exp: now - 1 }]) {
    await assert.rejects(freshDevGrant(token(), 'thread', 'run', (async () => Response.json({ grant: token({ ...claims, iat: now, exp: now + 3600, ...change }) })) as typeof fetch));
  }
  let calls = 0;
  await assert.rejects(freshDevGrant(token(), 'thread', 'run', (async () => { calls++; return new Response('', { status: 403 }); }) as typeof fetch));
  assert.equal(calls, 1);
});
test('node wrapper does not dispatch after a renewal failure', async () => {
  const previous = process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED; process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED = 'true';
  let called = false;
  try {
    await assert.rejects(withRenewableGrant(async () => { called = true; return { result: true }; })({ argus_execution_grant: token() }, { configurable: { thread_id: 'thread' } }));
    assert.equal(called, false);
  } finally { if (previous === undefined) delete process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED; else process.env.ARGUS_DEV_GRANT_RENEWAL_ENABLED = previous; }
});
