import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MAX_CI_RECOVERY_RETRIES, routeAfterRecoveryReview, routeAfterRecoveryTests } from './ciRecoveryRouting.js';

const END = '__end__';
const state = (patch: Partial<Parameters<typeof routeAfterRecoveryTests>[0]> = {}) => ({
  fix_applied: true, tests_passed: true, review_passed: false, retry_count: 1, ...patch,
});

test('a verified recovery is reviewed before human approval is requested', () => {
  assert.equal(routeAfterRecoveryTests(state(), END), 'ci_recovery_review');
  assert.equal(routeAfterRecoveryReview(state({ review_passed: true }), END), 'ci_recovery_approval');
});

test('a rejected review or failed verification never reaches approval', () => {
  assert.equal(routeAfterRecoveryReview(state(), END), 'fix_ci_failure');
  assert.equal(routeAfterRecoveryReview(state({ review_passed: true, tests_passed: false }), END), 'fix_ci_failure');
  assert.equal(routeAfterRecoveryTests(state({ tests_passed: false }), END), 'fix_ci_failure');
  const exhausted = state({ retry_count: MAX_CI_RECOVERY_RETRIES });
  assert.equal(routeAfterRecoveryReview(exhausted, END), END);
  assert.equal(routeAfterRecoveryTests({ ...exhausted, tests_passed: false }, END), END);
});

test('the recovery graph wires the review between verification and approval', () => {
  // The graph module needs a workflow runtime at import time; assert its wiring.
  const source = readFileSync(new URL('./workflows/ciRecovery.ts', import.meta.url), 'utf8');
  assert.match(source, /addNode\('ci_recovery_review', reviewCiRecoveryNode\)/);
  assert.match(source, /addConditionalEdges\('ci_recovery_tests', routeAfterFix\)/);
  assert.match(source, /addConditionalEdges\('ci_recovery_review', routeAfterReview\)/);
  assert.match(source, /REVIEW_OUTPUT_INSTRUCTION/);
});
