jest.mock('../audit.js', () => ({
  logHookDecision: jest.fn(),
}));

import { runPreToolHooks, runPostToolHooks, registerHook, clearHooks } from '../registry.js';
import type { ToolHook, HookContext } from '../types.js';

const ctx: HookContext = {
  agentId: 1, agentName: 'coder', sessionId: 's',
  toolName: 'workspace_exec', toolArgs: { cmd: 'ls' },
  iteration: 1, agentDepth: 0,
};

beforeEach(() => clearHooks());

describe('runPreToolHooks', () => {
  it('returns allow when no hooks registered', async () => {
    const r = await runPreToolHooks({} as never, ctx);
    expect(r.decision).toBe('allow');
  });

  it('blocks when one hook returns block', async () => {
    const h: ToolHook = {
      name: 'blocker', priority: 100, description: 'x',
      preToolUse: async () => ({ block: 'nope' }),
    };
    registerHook(h);
    const r = await runPreToolHooks({} as never, ctx);
    expect(r.decision).toBe('block');
    expect(r.reason).toBe('nope');
    expect(r.hookName).toBe('blocker');
  });

  it('runs lower priority first and short-circuits on block', async () => {
    const calls: string[] = [];
    registerHook({
      name: 'second', priority: 200, description: '',
      preToolUse: async () => { calls.push('second'); return null; },
    });
    registerHook({
      name: 'first', priority: 100, description: '',
      preToolUse: async () => { calls.push('first'); return { block: 'stop' }; },
    });
    const r = await runPreToolHooks({} as never, ctx);
    expect(calls).toEqual(['first']);
    expect(r.decision).toBe('block');
  });

  it('modify replaces toolArgs', async () => {
    registerHook({
      name: 'mask', priority: 100, description: '',
      preToolUse: async () => ({ modify: { cmd: 'echo masked' } }),
    });
    const r = await runPreToolHooks({} as never, ctx);
    expect(r.decision).toBe('modify');
    expect(r.modifiedArgs).toEqual({ cmd: 'echo masked' });
  });
});

describe('runPostToolHooks', () => {
  it('returns void when no hooks registered', async () => {
    await expect(runPostToolHooks({} as never, ctx)).resolves.toBeUndefined();
  });

  it('runs all postToolUse hooks regardless of order outcome', async () => {
    const calls: string[] = [];
    registerHook({
      name: 'a', priority: 200, description: '',
      postToolUse: async () => { calls.push('a'); },
    });
    registerHook({
      name: 'b', priority: 100, description: '',
      postToolUse: async () => { calls.push('b'); },
    });
    await runPostToolHooks({} as never, { ...ctx, toolResult: 'ok' });
    expect(calls).toEqual(['b', 'a']);
  });
});
