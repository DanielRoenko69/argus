/**
 * Tests for makeHookedToolRunner — the wrapper that routes non-agent tool
 * paths (workflow steps, cron/webhook, /mcp) through the tool-execution hooks.
 * Audit finding #1: a workflow `workspace_exec rm -rf /` MUST be blocked.
 */

import type pg from 'pg';
// Mock the real tool runner so importing hookedToolRunner doesn't pull the whole
// dynamic-import tool chain (ragTools → …) which jest can't load. Every test here
// supplies its own `inner` runner, so the mocked executeTool is never invoked.
jest.mock('../../tools/toolRunner.js', () => ({ executeTool: jest.fn() }));
jest.mock('../../agents/hooks/audit.js', () => ({ logHookDecision: jest.fn() }));
import { makeHookedToolRunner } from '../hookedToolRunner.js';
import { registerHook, clearHooks } from '../../agents/hooks/registry.js';
import { destructiveCmdGuard } from '../../agents/hooks/builtin/destructiveCmd.js';
import type { ToolHook } from '../../agents/hooks/types.js';
import type { ToolRunner } from '../types.js';
import type { Config } from '../../config/env.js';
import { getCurrentCallingUser, withRequestContext } from '../../lib/requestContext.js';

// Stub pool — only used by logHookDecision (fire-and-forget audit write).
const fakePool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool;
const fakeConfig = {} as Config;
const identity = { source: 'workflow', sessionId: 'test-session' };

const okRunner = (text = 'ok'): ReturnType<ToolRunner> =>
  Promise.resolve({ content: [{ type: 'text' as const, text }] });

describe('makeHookedToolRunner', () => {
  beforeEach(() => {
    clearHooks();
    registerHook(destructiveCmdGuard);
  });
  afterEach(() => clearHooks());

  it('binds transport identity to the verified execution, not an ambient approving admin', async () => {
    const inner: ToolRunner = async () => okRunner(String(getCurrentCallingUser()?.id));
    const run = makeHookedToolRunner(fakePool, fakeConfig, { ...identity, userId: 3 }, inner);
    const result = await withRequestContext({ callingUser: { id: 1, role: 'admin' } }, () => run('gitea_get_issue', {}));
    expect(result.content[0]!.text).toBe('3');
  });

  it('does not let scheduled service work borrow an ambient human OAuth identity', async () => {
    const inner: ToolRunner = async () => okRunner(String(getCurrentCallingUser()?.id));
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner);
    const result = await withRequestContext({ callingUser: { id: 3 } }, () => run('gitea_get_issue', {}));
    expect(result.content[0]!.text).toBe('undefined');
  });

  it('blocks a destructive workspace_exec and never calls the inner runner', async () => {
    const inner = jest.fn<ReturnType<ToolRunner>, Parameters<ToolRunner>>(() => okRunner());
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner as ToolRunner);

    const res = await run('workspace_exec', { cmd: 'rm -rf /' });

    expect(inner).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('[hook:destructive-cmd-guard]');
  });

  it('passes a benign tool call through to the inner runner unchanged', async () => {
    const inner = jest.fn<ReturnType<ToolRunner>, Parameters<ToolRunner>>(() => okRunner('listed'));
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner as ToolRunner);

    const res = await run('k8s_list_pods', { namespace: 'default' });

    expect(inner).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledWith('k8s_list_pods', { namespace: 'default' }, undefined);
    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toBe('listed');
  });

  it('forwards a cred override to the inner runner', async () => {
    const inner = jest.fn<ReturnType<ToolRunner>, Parameters<ToolRunner>>(() => okRunner());
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner as ToolRunner);

    await run('jira_get_issue', { key: 'OPS-1' }, { token: 'scoped-token' });

    expect(inner).toHaveBeenCalledWith('jira_get_issue', { key: 'OPS-1' }, { token: 'scoped-token' });
  });

  it('applies hook arg-modifications before calling the inner runner', async () => {
    const maskingHook: ToolHook = {
      name: 'test-masker',
      priority: 500,
      description: 'test',
      preToolUse: async () => ({ modify: { content: '[redacted]' } }),
    };
    registerHook(maskingHook);
    const inner = jest.fn<ReturnType<ToolRunner>, Parameters<ToolRunner>>(() => okRunner());
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner as ToolRunner);

    await run('confluence_create_page', { content: 'secret@example.com' });

    expect(inner).toHaveBeenCalledWith('confluence_create_page', { content: '[redacted]' }, undefined);
  });

  it('converts an inner-runner throw into an error result (does not reject)', async () => {
    const inner: ToolRunner = () => { throw new Error('boom'); };
    const run = makeHookedToolRunner(fakePool, fakeConfig, identity, inner);

    const res = await run('k8s_list_pods', {});

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toContain('boom');
  });

  it('returns the persisted approval id and workflow checkpoint metadata on an approval block', async () => {
    let capturedContext: Parameters<NonNullable<ToolHook['preToolUse']>>[0] | undefined;
    registerHook({
      name: 'human-approval-gate',
      priority: 50,
      description: 'test approval',
      preToolUse: async (ctx) => {
        capturedContext = ctx;
        return { block: 'Runtime human approval #42 is pending' };
      },
    });
    const inner = jest.fn<ReturnType<ToolRunner>, Parameters<ToolRunner>>(() => okRunner());
    const run = makeHookedToolRunner(
      fakePool,
      fakeConfig,
      {
        ...identity,
        workflowId: 17,
        workflowExecutionId: 99,
      },
      inner as ToolRunner,
    );

    const res = await run('k8s_apply', { namespace: 'production' }, undefined, { stepId: 'deploy' });

    expect(inner).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.approvalRequestId).toBe(42);
    expect(capturedContext).toMatchObject({
      workflowId: 17,
      workflowExecutionId: 99,
      workflowStepId: 'deploy',
    });
  });
});
