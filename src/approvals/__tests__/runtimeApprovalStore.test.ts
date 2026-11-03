import type { HookContext } from '../../agents/hooks/types.js';
import { runtimeApprovalKeys, stableToolArgs } from '../runtimeApprovalStore.js';

function context(overrides: Partial<HookContext> = {}): HookContext {
  return {
    agentId: 4,
    agentName: 'operator',
    sessionId: 'session-a',
    toolName: 'k8s_apply',
    toolArgs: { namespace: 'prod', manifest: { kind: 'Deployment', replicas: 2 } },
    iteration: 1,
    agentDepth: 0,
    ...overrides,
  };
}

describe('runtime approval identity', () => {
  it('canonicalizes object key order before hashing arguments', () => {
    const left = stableToolArgs({ z: 2, nested: { b: true, a: false }, a: 1 });
    const right = stableToolArgs({ a: 1, nested: { a: false, b: true }, z: 2 });
    expect(left).toBe(right);
  });

  it('uses one workflow grant across runs but distinct request identities', () => {
    const first = runtimeApprovalKeys(context({ agentId: 0, workflowId: 9, sessionId: 'builder:101' }));
    const retry = runtimeApprovalKeys(context({ agentId: 0, workflowId: 9, sessionId: 'builder:102' }));
    expect(first.grantKey).toBe(retry.grantKey);
    expect(first.requestKey).not.toBe(retry.requestKey);
    expect(first.subjectType).toBe('workflow');
  });

  it('keeps an agent grant scoped to its conversation session', () => {
    const first = runtimeApprovalKeys(context({ sessionId: 'chat-a' }));
    const otherSession = runtimeApprovalKeys(context({ sessionId: 'chat-b' }));
    expect(first.grantKey).not.toBe(otherSession.grantKey);
  });

  it('invalidates a grant when any tool argument changes', () => {
    const first = runtimeApprovalKeys(context());
    const changed = runtimeApprovalKeys(context({
      toolArgs: { namespace: 'prod', manifest: { kind: 'Deployment', replicas: 3 } },
    }));
    expect(first.grantKey).not.toBe(changed.grantKey);
  });

  it('never reuses an approval grant across tenant or workspace boundaries', () => {
    const first = runtimeApprovalKeys(
      context({ workflowId: 9 }),
      { tenantKey: 'tenant-a', workspaceKey: 'engineering' },
    );
    const otherTenant = runtimeApprovalKeys(
      context({ workflowId: 9 }),
      { tenantKey: 'tenant-b', workspaceKey: 'engineering' },
    );
    expect(first.grantKey).not.toBe(otherTenant.grantKey);
    expect(first.requestKey).not.toBe(otherTenant.requestKey);
  });
});
