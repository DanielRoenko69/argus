import { describe, it, expect, afterEach } from '@jest/globals';
import {
  effectiveMaxToolCalls,
  compileExtraPatterns,
  getAgentHookConfig,
  setAgentHookConfigProvider,
  resetAgentHookConfigProvider,
} from '../config.js';

afterEach(() => resetAgentHookConfigProvider());

describe('effectiveMaxToolCalls — tighten-only', () => {
  it('uses the built-in cap when nothing configured', () => {
    expect(effectiveMaxToolCalls(60, null)).toBe(60);
  });
  it('lowers the cap when configured below built-in', () => {
    expect(effectiveMaxToolCalls(60, 20)).toBe(20);
  });
  it('NEVER raises above the built-in cap (additive/tighten-only)', () => {
    expect(effectiveMaxToolCalls(60, 200)).toBe(60);
  });
  it('ignores invalid/non-positive configured values', () => {
    expect(effectiveMaxToolCalls(60, 0)).toBe(60);
    expect(effectiveMaxToolCalls(60, -5)).toBe(60);
    expect(effectiveMaxToolCalls(60, NaN)).toBe(60);
  });
});

describe('compileExtraPatterns', () => {
  it('compiles valid regex sources (case-insensitive)', () => {
    const res = compileExtraPatterns(['curl\\s+evil', 'wget']);
    expect(res).toHaveLength(2);
    expect(res[0].test('CURL  evil.sh')).toBe(true);
  });
  it('skips invalid regex sources without throwing', () => {
    const res = compileExtraPatterns(['valid', '(unclosed', '[bad']);
    expect(res).toHaveLength(1);
  });
});

describe('getAgentHookConfig — fail-safe', () => {
  it('returns empty config by default (built-in behaviour unchanged)', async () => {
    expect(await getAgentHookConfig(1)).toEqual({ extraDestructivePatterns: [], maxToolCalls: null });
  });
  it('returns the provider value when set', async () => {
    setAgentHookConfigProvider(async () => ({ extraDestructivePatterns: ['rmrf'], maxToolCalls: 10 }));
    expect(await getAgentHookConfig(1)).toEqual({ extraDestructivePatterns: ['rmrf'], maxToolCalls: 10 });
  });
  it('falls back to EMPTY when the provider throws (never weakens a guard)', async () => {
    setAgentHookConfigProvider(async () => { throw new Error('db down'); });
    expect(await getAgentHookConfig(1)).toEqual({ extraDestructivePatterns: [], maxToolCalls: null });
  });
});
