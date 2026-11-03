import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRetryParent, retryExecutionInput } from './workflowRetry.js';
const retry = { sourceThreadId: 'parent', sourceTaskId: 'task', feedback: 'Add numeric tolerances.' };
const parent = { status: 'failed', metadata: { execution_principal: 'user:7', a2a_task_id: 'task' } };
test('configured restart accepts only failed or fully canceled parents owned by the same principal', () => {
  assert.doesNotThrow(() => assertRetryParent(parent, retry, 'user:7'));
  assert.doesNotThrow(() => assertRetryParent({ ...parent, status: 'canceled' }, retry, 'user:7'));
  for (const state of [null, ...['completed', 'running', 'canceling', 'queued', 'interrupted', 'waiting_external_ci'].map(status => ({ ...parent, status })), { ...parent, metadata: {} }]) {
    assert.throws(() => assertRetryParent(state, retry, 'user:7'), /same execution principal/);
  }
  assert.throws(() => assertRetryParent(parent, retry, 'user:8'));
  assert.throws(() => assertRetryParent(parent, { ...retry, sourceTaskId: 'other' }, 'user:7'));
  assert.throws(() => assertRetryParent({ ...parent, status: 'canceled' }, retry, 'user:8'));
  assert.throws(() => assertRetryParent({ ...parent, status: 'canceled' }, { ...retry, sourceTaskId: 'other' }, 'user:7'));
});
test('only explicit new feedback enters execution; frozen original input stays unchanged', () => {
  const input = Object.freeze({ issue_body: 'Plan GEM', backlog_constraints: 'Read only' });
  assert.deepEqual(retryExecutionInput(input, 'issue_body', ''), input);
  const result = retryExecutionInput(input, 'issue_body', retry.feedback);
  assert.match(String(result.issue_body), /Additional operator feedback/);
  assert.match(String(result.issue_body), /numeric tolerances/);
  assert.equal(input.issue_body, 'Plan GEM');
  assert.equal(result.backlog_constraints, 'Read only');
  assert.ok(String(retryExecutionInput(input, 'issue_body', 'a'.repeat(20_000)).issue_body).length < 12_100);
});
