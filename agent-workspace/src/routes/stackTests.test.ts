import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseStackRequest, stackExecutionMetadata, parseStackBrokerResponse, stackPublicError, STACK_BROKER_TIMEOUT_MS, stackBrokerRequest, validateStackRecoveryProof } from './stackTests.js';
import { createHash } from 'node:crypto';
test('snapshot diagnostic codes survive only the trusted typed boundary', () => {
  for (const code of ['stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped', 'stack_snapshot_reconciliation_required']) {
    try { parseStackBrokerResponse(409, JSON.stringify({ error: code, secret: 'PRIVATE' })); assert.fail('must throw'); }
    catch (error) { assert.equal(stackPublicError(error), code); assert.doesNotMatch(String(error), /PRIVATE/); }
    assert.equal(stackPublicError(new Error(code)), 'stack_unavailable_no_replay');
  }
  for (const body of ['not JSON PRIVATE', JSON.stringify({ error: 'stack_SECRET' })]) {
    assert.throws(() => parseStackBrokerResponse(409, body), /stack_unavailable_no_replay/);
  }
  assert.deepEqual(parseStackBrokerResponse(200, '{"ok":true}'), { ok: true });
  assert.equal(STACK_BROKER_TIMEOUT_MS, (900 + 900 + 600 + 120) * 1000);
});
const input = { action: 'project', threadId: randomUUID(), workspaceRoot: '/workspace/FIXTURE', baseCommitSha: 'a'.repeat(40),
  basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), stackPlan: { version: 1, summary: 'fixture', setup: 'true', start: '', test: 'test-command', python: '/usr/bin/python3' } };
test('workspace mode crosses the broker boundary explicitly and excludes image authority', () => {
  const r = parseStackRequest({ ...input, executionMode: 'workspace-session-v1' });
  assert.equal(stackBrokerRequest(r, []).executionMode, 'workspace-session-v1');
  assert.equal(stackBrokerRequest(r, []).preparedSession, null);
  assert.equal(stackBrokerRequest(r, []).preparedImage, null);
  const qa = { ...r, action: 'run', files: [{ id: 'one', content: 'def test_one(): assert True' }], preparedSession: 'd'.repeat(64) };
  assert.deepEqual(parseStackRequest(qa), qa);
  for (const delta of [{ preparedSession: undefined }, { preparedImage: 'sha256:' + 'e'.repeat(64) }, { executionMode: undefined }, { executionMode: 'unknown' }])
    assert.throws(() => parseStackRequest({ ...qa, ...delta }));
});
test('recovery proof is exact, pre-test and cannot substitute source, recipe or image', () => {
  const r=parseStackRequest(input), broker=stackBrokerRequest(r,[]);
  const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const proof={version:1,requestSha256:hash(broker),sourceSha256:input.sourceSha256,planSha256:hash(input.stackPlan),
    preparedImage:'sha256:'+'d'.repeat(64),containerId:'e'.repeat(64),recoverySha256:'f'.repeat(64),testsStarted:false};
  assert.deepEqual(validateStackRecoveryProof(r,broker,proof),proof);
  for(const delta of [{testsStarted:true},{sourceSha256:'0'.repeat(64)},{planSha256:'0'.repeat(64)},
    {requestSha256:'0'.repeat(64)},{preparedImage:'ubuntu:latest'},{recoverySha256:''},{extra:'no'}])
    assert.throws(()=>validateStackRecoveryProof(r,broker,{...proof,...delta}));
});
test('controller stop reasons survive setup projection, including legacy controller receipts', () => {
  for (const testStarted of [true, false])
    assert.deepEqual(stackExecutionMetadata({ status: 'failed', testStarted }), { executionStatus: 'failed', testStarted });
  for (const testStarted of ['false', 0, null])
    assert.throws(() => stackExecutionMetadata({ status: 'failed', testStarted }));
  for (const status of ['completed', 'failed', 'output_limit', 'timeout', 'canceled', 'interrupted', 'disk_limit'])
    assert.deepEqual(stackExecutionMetadata({ status }), { executionStatus: status });
  const outputCapture = { version: 1, stdoutBytes: 4000000, stderrBytes: 27, stdoutTruncated: true, stderrTruncated: false };
  assert.deepEqual(stackExecutionMetadata({ status: 'completed', outputCapture }), { executionStatus: 'completed', outputCapture });
  for (const delta of [{ stdoutBytes: -1 }, { stderrBytes: Infinity }, { stdoutTruncated: 'yes' }, { token: 'no' }, { version: 2 }])
    assert.throws(() => stackExecutionMetadata({ status: 'failed', outputCapture: { ...outputCapture, ...delta } }));
  assert.throws(() => stackExecutionMetadata({ status: 'unknown' }));
});
test('general stack is strict at the workspace boundary too', () => {
  assert.deepEqual(parseStackRequest(input), input);
  for (const delta of [{ workspaceRoot: '/etc' }, { dockerSocket: '/var/run/docker.sock' }, { environmentPolicyVersion: 2 },
    { stackPlan: { ...input.stackPlan, image: 'arbitrary' } }, { stackPlan: { ...input.stackPlan, python: '/bin/../sh' } },
    { stackPlan: { ...input.stackPlan, setup: 'é'.repeat(13000) } }, { files: [] }])
    assert.throws(() => parseStackRequest({ ...input, ...delta }));
});
test('independent execution cannot run without a frozen test and pinned prepared image', () => {
  assert.throws(() => parseStackRequest({ ...input, action: 'run' }));
  const qa = { ...input, action: 'run', preparedImage: 'sha256:' + 'd'.repeat(64), files: [{ id: 'one', content: 'def test_one(): assert True' }] };
  assert.deepEqual(parseStackRequest(qa), qa);
  assert.throws(() => parseStackRequest({ ...qa, preparedImage: 'ubuntu:latest' }));
});
