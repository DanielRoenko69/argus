import type { HookContext, HookResult, ToolHook, HookDecision } from '../types.js';

describe('hook types', () => {
  it('compiles a ToolHook with all fields', () => {
    const h: ToolHook = {
      name: 'test-hook',
      priority: 100,
      description: 'A test hook',
      preToolUse: async (_ctx: HookContext): Promise<HookResult> => ({ block: 'no' }),
      postToolUse: async (_ctx: HookContext): Promise<void> => {},
    };
    expect(h.name).toBe('test-hook');
  });

  it('compiles a HookDecision', () => {
    const d: HookDecision = { hookName: 'x', toolName: 'y', decision: 'allow' };
    expect(d.decision).toBe('allow');
  });
});
