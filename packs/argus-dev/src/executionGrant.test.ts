import assert from 'node:assert/strict';
import test from 'node:test';
import { decodePackExecutionGrant, runtimeOverrideFromExecutionGrant } from './executionGrant.js';

const nowMs = Date.parse('2026-08-02T10:00:00.000Z');
const now = Math.floor(nowMs / 1000);
const payload = {
  v: 1,
  jti: '6dbc13b5-bd57-4c2b-b503-24e381b6c8d6',
  iss: 'argus.core',
  aud: 'argus.dev',
  agent: 'coding-orchestrator',
  principalKind: 'user',
  principalId: '7',
  bundleIds: [11],
  coreAgentIds: [2, 3, 4],
  runtimeProfileOverrides: [{
    agentId: 3,
    runtimeProfileId: 37,
    runtimeType: 'hermes',
    runtimeProfileName: 'hermes-managed-dev',
  }],
  messageId: 'message-42',
  rootTraceId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
  iat: now,
  exp: now + 900,
};
const token = `eg_v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.core-signature`;

test('Argus Dev binds the opaque Core grant to the exact task without needing the signing secret', () => {
  const decoded = decodePackExecutionGrant(token, {
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    messageId: 'message-42',
    rootTraceId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
  }, nowMs);
  assert.equal(decoded.token, token);
  assert.deepEqual(decoded.claims.bundleIds, [11]);
  assert.equal(decoded.claims.principalId, '7');
  assert.deepEqual(runtimeOverrideFromExecutionGrant(token, 3), payload.runtimeProfileOverrides[0]);
  assert.equal(runtimeOverrideFromExecutionGrant(token, 2), null);
});

test('Argus Dev rejects a grant replayed into another A2A message or trace', () => {
  assert.throws(() => decodePackExecutionGrant(token, {
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    messageId: 'message-43',
    rootTraceId: 'c295ea44-7543-4f78-b524-7a38915ad6e4',
  }, nowMs), /not bound/);
  assert.throws(() => decodePackExecutionGrant(token, {
    packId: 'argus.dev',
    agentId: 'coding-orchestrator',
    messageId: 'message-42',
    rootTraceId: '43667960-d455-4453-b0cf-1bae4955270d',
  }, nowMs), /not bound/);
});
