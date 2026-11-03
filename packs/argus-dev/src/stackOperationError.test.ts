import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { stackRequest, stackPlanningFailure } from './stackClient.js';
import { readStackResponse, StackOperationError } from './stackOperationError.js';
import { STACK_HTTP_TIMEOUT_MS, stackHttpOptions } from './stackHttp.js';
import { RUNTIME_HTTP_MAX_MS } from './runtimeHttp.js';
const thread = randomUUID();
const state = { qa_environment_policy_version: 2, argus_execution_grant: 'fixture-not-a-real-token', base_commit_sha: 'a'.repeat(40) };
test('snapshot cause is actionable without replay, secrets or changing model deadlines', async () => {
  assert.equal(STACK_HTTP_TIMEOUT_MS, 2_580_000);
  assert.equal(RUNTIME_HTTP_MAX_MS, 1_830_000);
  assert.ok(stackHttpOptions('project').dispatcher);
  const durations: number[] = [];
  const timeout = mock.method(AbortSignal, 'timeout', (ms: number) => { durations.push(ms); return new AbortController().signal; });
  try { stackHttpOptions('inspect'); stackHttpOptions('project'); stackHttpOptions('run'); }
  finally { timeout.mock.restore(); }
  assert.deepEqual(durations, [60_000, 2_580_000, 2_580_000]);
  for (const code of ['stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped', 'stack_snapshot_reconciliation_required']) {
    await assert.rejects(readStackResponse(Response.json({ code, upstreamStatus: 409, error: 'SECRET' }, { status: 409 }), 'project', thread), error => {
      assert.ok(error instanceof StackOperationError);
      assert.equal(error.details.reason, code);
      assert.equal(error.details.upstreamStatus, 409);
      assert.match(error.message, /No automatic replay/);
      assert.doesNotMatch(error.message, /SECRET/);
      if (code !== 'stack_snapshot_worker_not_stopped') assert.match(error.message, /operator reconciliation/);
      return true;
    });
  }
});
test('Core status and exact allowlisted reason survive planning without response secrets or replay', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; return Response.json({ code: 'stack_workspace_http_error', upstreamStatus: 409, error: 'SECRET', token: 'PRIVATE' }, { status: 409 }); };
  await assert.rejects(stackRequest(state, thread, 2, 'b'.repeat(64), 'inspect', undefined, undefined, fetcher as typeof fetch), error => {
    assert.ok(error instanceof StackOperationError);
    const failure = stackPlanningFailure(error, 'inspect_before');
    assert.equal(failure.operation?.httpStatus, 409);
    assert.equal(failure.operation?.upstreamStatus, 409);
    assert.equal(failure.operation?.rootTraceId, thread);
    assert.match(failure.message, /inspect_before.*HTTP 409/);
    assert.doesNotMatch(JSON.stringify(failure), /SECRET|PRIVATE|fixture-not/);
    return true;
  });
  assert.equal(calls, 1);
});
test('untrusted error codes/prose and malformed replies never leak or pass', async () => {
  for (const body of ['<html>SECRET</html>', JSON.stringify({ code: 'stack_SECRET', error: 'PRIVATE', upstreamStatus: 403 })]) {
    await assert.rejects(readStackResponse(new Response(body, { status: 503 }), 'inspect', thread), error => {
      assert.ok(error instanceof StackOperationError);
      assert.equal(error.details.reason, 'stack_http_error');
      assert.equal(error.details.upstreamStatus, undefined);
      assert.doesNotMatch(JSON.stringify(error), /SECRET|PRIVATE/); return true;
    });
  }
  await assert.rejects(readStackResponse(new Response('x'.repeat(128001)), 'inspect', thread), { details: { action: 'inspect', reason: 'stack_response_limit', httpStatus: 200, upstreamStatus: undefined, rootTraceId: thread } });
});
test('transport timeout and bad successful evidence are distinct, never retried', async () => {
  for (const [fetcher, reason] of [
    [async () => { throw Object.assign(new Error('SECRET'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }); }, 'stack_transport_timeout'],
    [async () => { throw new Error('SECRET'); }, 'stack_transport_error'],
    [async () => Response.json({ fake: 'SECRET' }), 'stack_invalid_evidence'],
  ] as const) {
    let calls = 0;
    await assert.rejects(stackRequest(state, thread, 2, 'b'.repeat(64), 'inspect', undefined, undefined,
      (async () => { calls++; return fetcher(); }) as typeof fetch), error => {
      assert.ok(error instanceof StackOperationError); assert.equal(error.details.reason, reason);
      assert.doesNotMatch(error.message, /SECRET/); return true;
    });
    assert.equal(calls, 1);
  }
  const snapshot = { sourceSha256: 'c'.repeat(64), files: 1, excludedFiles: 0, python: true };
  assert.deepEqual(await stackRequest(state, thread, 2, 'b'.repeat(64), 'inspect', undefined, undefined,
    (async () => Response.json(snapshot)) as typeof fetch), snapshot);
});
