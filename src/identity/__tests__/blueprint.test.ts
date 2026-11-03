import { resolveBlueprintId } from '../blueprint.js';

describe('resolveBlueprintId', () => {
  const map = { worker: 'argus-test-worker', reviewer: 'argus-test-reviewer' };

  it('returns the mapped blueprint id for a known agent_role', () => {
    expect(resolveBlueprintId({ agent_role: 'worker' }, map)).toBe('argus-test-worker');
  });

  it('falls back to the "default" key when agent_role is unmapped', () => {
    const withDefault = { ...map, default: 'argus-test-default' };
    expect(resolveBlueprintId({ agent_role: 'unknown' }, withDefault)).toBe('argus-test-default');
  });

  it('returns null when nothing matches and no default is set', () => {
    expect(resolveBlueprintId({ agent_role: 'unknown' }, map)).toBeNull();
  });

  it('returns null when agent_role is null', () => {
    expect(resolveBlueprintId({ agent_role: null }, map)).toBeNull();
  });
});
