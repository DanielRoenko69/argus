import assert from 'node:assert/strict';
import test from 'node:test';
import { bundleResolutionCandidates } from './bundleResolution.js';

test('keeps every authorized bundle candidate independent of capability order', () => {
  assert.deepEqual(bundleResolutionCandidates([161, 212], 161), [161, 212]);
  assert.deepEqual(bundleResolutionCandidates([212, 161], 212), [212, 161]);
});

test('deduplicates candidates and preserves the legacy single-bundle fallback', () => {
  assert.deepEqual(bundleResolutionCandidates([161, 161, 0, -1], 212), [161]);
  assert.deepEqual(bundleResolutionCandidates([], 212), [212]);
});
