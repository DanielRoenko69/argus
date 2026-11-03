import { describe, it, expect } from '@jest/globals';
import { clampParams, resolveModelParams } from '../modelParams.js';

describe('clampParams', () => {
  it('passes in-range values through', () => {
    expect(clampParams({ temperature: 0.7, top_p: 0.9, max_tokens: 1000 }))
      .toEqual({ temperature: 0.7, top_p: 0.9, max_tokens: 1000 });
  });
  it('clamps out-of-range to bounds', () => {
    expect(clampParams({ temperature: 5, top_p: 2, max_tokens: 999999 }))
      .toEqual({ temperature: 2, top_p: 1, max_tokens: 32000 });
    expect(clampParams({ temperature: -1, top_p: -0.5, max_tokens: 0 }))
      .toEqual({ temperature: 0, top_p: 0, max_tokens: 1 });
  });
  it('rounds max_tokens and drops non-numbers / unknown keys', () => {
    expect(clampParams({ max_tokens: 12.9, temperature: 'hot', foo: 1 } as unknown))
      .toEqual({ max_tokens: 13 });
  });
  it('returns {} for undefined / empty / junk', () => {
    expect(clampParams(undefined)).toEqual({});
    expect(clampParams({})).toEqual({});
    expect(clampParams(42 as unknown)).toEqual({});
  });
});

describe('resolveModelParams', () => {
  const agent = { temperature: '0.3', max_tokens: 4096 };
  it('falls back to agent defaults when no overrides', () => {
    expect(resolveModelParams(agent, {})).toEqual({ temperature: 0.3, max_tokens: 4096 });
    expect(resolveModelParams(agent, undefined)).toEqual({ temperature: 0.3, max_tokens: 4096 });
  });
  it('override wins over agent default', () => {
    expect(resolveModelParams(agent, { temperature: 1.2, max_tokens: 50 }))
      .toEqual({ temperature: 1.2, max_tokens: 50 });
  });
  it('includes top_p only when set', () => {
    expect(resolveModelParams(agent, { top_p: 0.8 }))
      .toEqual({ temperature: 0.3, max_tokens: 4096, top_p: 0.8 });
    expect('top_p' in resolveModelParams(agent, {})).toBe(false);
  });
});
