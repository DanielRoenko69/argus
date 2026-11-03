import { describe, expect, it } from '@jest/globals';
import {
  agentVisibleToBundleScope,
  intersectAgentBundleScope,
  NO_BUNDLE_ACCESS_SENTINEL,
} from '../../auth/bundleScope.js';

describe('agent bundle scope', () => {
  it('keeps unrestricted Agents visible but narrows their execution scope', () => {
    expect(agentVisibleToBundleScope(null, [3])).toBe(true);
    expect(intersectAgentBundleScope(null, [3])).toEqual([3]);
    expect(intersectAgentBundleScope([], [3])).toEqual([3]);
  });

  it('requires overlap for explicit assignments', () => {
    expect(agentVisibleToBundleScope([3, 7], [7])).toBe(true);
    expect(agentVisibleToBundleScope([3], [7])).toBe(false);
    expect(intersectAgentBundleScope([3], [7])).toEqual([NO_BUNDLE_ACCESS_SENTINEL]);
  });

  it('fails closed for an empty user scope', () => {
    expect(intersectAgentBundleScope(null, [])).toEqual([NO_BUNDLE_ACCESS_SENTINEL]);
  });
});

