import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent, getGlobalDispatcher } from 'undici';
import { runtimeHttpFailure, runtimeHttpOptions, runtimeHttpTimeoutMs } from './runtimeHttp.js';

test('runtime HTTP deadline follows the worker limit plus a bounded response grace', () => {
  assert.equal(runtimeHttpTimeoutMs(30), 60_000);
  assert.equal(runtimeHttpTimeoutMs(900), 930_000);
  assert.equal(runtimeHttpTimeoutMs(1800), 1_830_000);
  for (const value of [0, 29, 1801, NaN, Infinity, 30.5]) {
    assert.throws(() => runtimeHttpTimeoutMs(value), RangeError);
  }
});

test('runtime requests use a dedicated dispatcher and an explicit total deadline', t => {
  const globalDispatcher = getGlobalDispatcher();
  const deadlines: number[] = [];
  t.mock.method(AbortSignal, 'timeout', (ms: number) => {
    deadlines.push(ms);
    return new AbortController().signal;
  });
  const options = runtimeHttpOptions(900);
  assert.ok(options.dispatcher instanceof Agent);
  assert.notEqual(options.dispatcher, globalDispatcher);
  assert.equal(getGlobalDispatcher(), globalDispatcher);
  assert.equal(options.signal?.aborted, false);
  assert.equal(runtimeHttpOptions(1800).dispatcher, options.dispatcher);
  assert.deepEqual(deadlines, [930_000, 1_830_000]);
});

test('transport errors retain safe cause codes and distinguish timeout boundaries', () => {
  const failure = (code: string) => new TypeError('fetch failed', {
    cause: { cause: { code, message: 'secret nested payload', headers: { authorization: 'secret' } } },
  });
  assert.match(runtimeHttpFailure(failure('UND_ERR_HEADERS_TIMEOUT'), 900), /response-header timeout.*UND_ERR_HEADERS_TIMEOUT.*900s/);
  assert.match(runtimeHttpFailure(failure('UND_ERR_BODY_TIMEOUT'), 900), /response-body timeout.*UND_ERR_BODY_TIMEOUT/);
  assert.equal(runtimeHttpFailure(failure('ECONNRESET'), 900), 'fetch failed (ECONNRESET)');
  assert.equal(runtimeHttpFailure(failure('secret-code'), 900), 'fetch failed');
  assert.doesNotMatch(runtimeHttpFailure(failure('UND_ERR_SOCKET'), 900), /secret/);
  assert.match(runtimeHttpFailure(new DOMException('expired', 'TimeoutError'), 900), /930s.*worker limit 900s plus 30s response grace/);
});
