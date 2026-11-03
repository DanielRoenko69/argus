import test from 'node:test';
import assert from 'node:assert/strict';
import { REVIEW_ONLY_TEST_POLICY } from './reviewOnlyDelivery.js';

test('review-only permits ticket-scoped regression-test authoring but never test execution claims', () => {
  assert.match(REVIEW_ONLY_TEST_POLICY, /ticket explicitly requests regression tests within authorized paths/);
  assert.match(REVIEW_ONLY_TEST_POLICY, /plan and author them/);
  assert.match(REVIEW_ONLY_TEST_POLICY, /not executed/);
  assert.match(REVIEW_ONLY_TEST_POLICY, /nobody may claim the tests passed/);
  assert.doesNotMatch(REVIEW_ONLY_TEST_POLICY, /skips automated test authoring|No automated tests were authored/);
});
