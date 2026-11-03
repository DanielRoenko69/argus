import { piiPreWriteGuard } from '../../builtin/piiPreWrite.js';
import type { HookContext } from '../../types.js';

const ctxFor = (toolName: string, args: Record<string, unknown>): HookContext => ({
  agentId: 1, agentName: 'coder', sessionId: 's',
  toolName, toolArgs: args, iteration: 1, agentDepth: 0,
});

describe('piiPreWriteGuard', () => {
  it('skips non-write tools', async () => {
    const r = await piiPreWriteGuard.preToolUse!(ctxFor('workspace_read', { path: '/x' }));
    expect(r ?? null).toBeNull();
  });

  it('allows clean content', async () => {
    const r = await piiPreWriteGuard.preToolUse!(ctxFor('workspace_write', { path: '/x.md', content: 'hello world' }));
    expect(r ?? null).toBeNull();
  });

  it('blocks content containing an obvious email address', async () => {
    const r = await piiPreWriteGuard.preToolUse!(ctxFor('workspace_write', {
      path: '/x.md', content: 'Contact: john.smith@example.com',
    }));
    expect(r).toHaveProperty('block');
    expect((r as {block:string}).block).toMatch(/PII|email/i);
  });

  it('checks replacement content for managed workspace edits', async () => {
    const r = await piiPreWriteGuard.preToolUse!(ctxFor('workspace_edit', {
      path: '/x.md', old_text: 'Contact: pending', new_text: 'Contact: john.smith@example.com',
    }));
    expect(r).toHaveProperty('block');
  });

  it('blocks content containing a credit-card-shaped number', async () => {
    const r = await piiPreWriteGuard.preToolUse!(ctxFor('workspace_write', {
      path: '/x.md', content: 'CC: 4111 1111 1111 1111',
    }));
    expect(r).toHaveProperty('block');
  });
});
