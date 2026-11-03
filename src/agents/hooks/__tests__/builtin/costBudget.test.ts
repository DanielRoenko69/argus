import { costBudgetGuard, resetBudgetForTest } from '../../builtin/costBudget.js';
import type { HookContext } from '../../types.js';

const ctxFor = (sessionId: string, toolName = 'workspace_exec'): HookContext => ({
  agentId: 1, agentName: 'coder', sessionId,
  toolName, toolArgs: { cmd: 'ls' }, iteration: 1, agentDepth: 0,
});

beforeEach(() => resetBudgetForTest());

describe('costBudgetGuard', () => {
  it('allows the first N tool calls', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await costBudgetGuard.preToolUse!(ctxFor('s1'));
      expect(r ?? null).toBeNull();
      await costBudgetGuard.postToolUse!({ ...ctxFor('s1'), toolResult: 'ok' });
    }
  });

  it('blocks after 60 tool calls in one session', async () => {
    let blocked = false;
    for (let i = 0; i < 80; i++) {
      const r = await costBudgetGuard.preToolUse!(ctxFor('s2'));
      if (r && 'block' in r) { blocked = true; break; }
      await costBudgetGuard.postToolUse!({ ...ctxFor('s2'), toolResult: 'ok' });
    }
    expect(blocked).toBe(true);
  });

  it('does not bleed budget between sessions', async () => {
    for (let i = 0; i < 60; i++) {
      await costBudgetGuard.postToolUse!({ ...ctxFor('s3'), toolResult: 'ok' });
    }
    const fresh = await costBudgetGuard.preToolUse!(ctxFor('s4'));
    expect(fresh ?? null).toBeNull();
  });
});
