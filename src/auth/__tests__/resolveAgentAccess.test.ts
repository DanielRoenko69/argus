/**
 * Unit tests for resolveAgentAccess — pure function, no DB.
 * Truth table:
 *   no rules        → all candidates
 *   allow{5}        → [5]
 *   allow{5,7}+deny{7} → [5]
 *   deny{5} no allow → all except 5
 *   (expired rule semantics tested at store layer; resolver only sees the
 *    already-aggregated allow/deny sets from fetchUserAgentPolicyData)
 */

import { resolveAgentAccess } from '../userPolicyResolver.js';

describe('resolveAgentAccess', () => {
  const candidates = [1, 2, 3, 5, 7];

  it('no rules → all candidates returned unchanged', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set(), agentDenyIds: new Set() },
      candidates,
    );
    expect(result).toEqual(candidates);
  });

  it('allow{5} → only [5]', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([5]), agentDenyIds: new Set() },
      candidates,
    );
    expect(result).toEqual([5]);
  });

  it('allow{5,7} → [5, 7]', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([5, 7]), agentDenyIds: new Set() },
      candidates,
    );
    expect(result.sort()).toEqual([5, 7]);
  });

  it('allow{5,7} + deny{7} → [5] (deny wins over allow)', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([5, 7]), agentDenyIds: new Set([7]) },
      candidates,
    );
    expect(result).toEqual([5]);
  });

  it('deny{5} no allow → all candidates except 5 (deny-only, unrestricted default)', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set(), agentDenyIds: new Set([5]) },
      candidates,
    );
    expect(result.sort()).toEqual([1, 2, 3, 7]);
  });

  it('deny{1,2,3} no allow → candidates minus {1,2,3}', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([]), agentDenyIds: new Set([1, 2, 3]) },
      candidates,
    );
    expect(result.sort()).toEqual([5, 7]);
  });

  it('allow{99} → empty (candidate not in allow set)', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([99]), agentDenyIds: new Set() },
      candidates,
    );
    expect(result).toEqual([]);
  });

  it('empty candidates → always empty regardless of rules', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([1, 2]), agentDenyIds: new Set() },
      [],
    );
    expect(result).toEqual([]);
  });

  it('deny{5} + allow{5} → deny wins, [5] removed', () => {
    // deny-first semantics: deny is applied before allow filter
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([5]), agentDenyIds: new Set([5]) },
      candidates,
    );
    // deny removes 5 first; then allow set has 5 but after deny there's nothing left
    // in candidates that matches allow{5}, so result is []
    expect(result).toEqual([]);
  });

  it('allow set containing all candidates → all candidates (no effective restriction)', () => {
    const result = resolveAgentAccess(
      { agentAllowIds: new Set([1, 2, 3, 5, 7]), agentDenyIds: new Set() },
      candidates,
    );
    expect(result.sort()).toEqual([...candidates].sort());
  });
});
