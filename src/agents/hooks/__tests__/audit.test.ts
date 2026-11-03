jest.mock('../../../audit/immutableAudit.js', () => ({
  writeImmutableAudit: jest.fn(),
}));

import { logHookDecision } from '../audit.js';
import { writeImmutableAudit } from '../../../audit/immutableAudit.js';
import type { HookContext } from '../types.js';

describe('logHookDecision', () => {
  beforeEach(() => jest.mocked(writeImmutableAudit).mockClear());

  it('does not throw on a valid decision', () => {
    const fakePool = { query: jest.fn().mockResolvedValue({ rows: [] }) } as never;
    const ctx: HookContext = {
      agentId: 1,
      agentName: 'coder',
      sessionId: 's1',
      toolName: 'workspace_exec',
      toolArgs: { cmd: 'ls' },
      iteration: 1,
      agentDepth: 0,
    };
    expect(() =>
      logHookDecision(fakePool, ctx, {
        hookName: 'test-hook',
        toolName: 'workspace_exec',
        decision: 'allow',
      })
    ).not.toThrow();
    expect(writeImmutableAudit).toHaveBeenCalledTimes(1);
  });

  it('handles a block decision with a long reason (truncated to 80 chars)', () => {
    const fakePool = { query: jest.fn().mockResolvedValue({ rows: [] }) } as never;
    const ctx: HookContext = {
      agentId: 2,
      agentName: 'planner',
      sessionId: 's2',
      toolName: 'workspace_write',
      toolArgs: { path: '/x', content: 'foo' },
      iteration: 3,
      agentDepth: 1,
    };
    const longReason = 'x'.repeat(500);
    expect(() =>
      logHookDecision(fakePool, ctx, {
        hookName: 'pii-pre-write-guard',
        toolName: 'workspace_write',
        decision: 'block',
        reason: longReason,
      })
    ).not.toThrow();
    expect(jest.mocked(writeImmutableAudit).mock.calls[0]?.[1].errorType).toHaveLength(
      'pii-pre-write-guard:block:'.length + 80,
    );
  });
});
