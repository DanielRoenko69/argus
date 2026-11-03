import { describe, expect, it } from '@jest/globals';
import type { SessionContext } from '../mcpServer.js';
import { McpSessionRegistry, mcpSessionDenial } from '../mcpSessionGuard.js';

function ctx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    apiKeyPrefix: 'abcd1234',
    allowedBundles: [1],
    allowedTools: null,
    deniedTools: null,
    tenantKey: 'default',
    workspaceKey: 'default',
    callingUser: null,
    ...overrides,
  };
}

const keyA = { apiKeyPrefix: 'abcd1234', apiKeyScope: 'both' };
const keyB = { apiKeyPrefix: 'zzzz9999', apiKeyScope: 'both' };

describe('MCP session guard', () => {
  it('lets the creating credential resume its own session', () => {
    const registry = new McpSessionRegistry();
    expect(registry.bind('s1', keyA, ctx())).toBe(true);
    expect(registry.check('s1', keyA, ctx())).toBe('ok');
  });

  it('rejects another credential on every method path (GET/DELETE use the same check)', () => {
    const registry = new McpSessionRegistry();
    registry.bind('s1', keyA, ctx());
    expect(registry.check('s1', keyB, ctx({ apiKeyPrefix: 'zzzz9999' }))).toBe('not_owner');
    expect(registry.check('s1', {}, ctx({ apiKeyPrefix: null }))).toBe('not_owner');
  });

  it('fails closed for unbound sessions and identity-less creators', () => {
    const registry = new McpSessionRegistry();
    expect(registry.bind('s1', {}, ctx({ apiKeyPrefix: null }))).toBe(false);
    expect(registry.check('s1', keyA, ctx())).toBe('unknown_session');
    expect(mcpSessionDenial('unknown_session').status).toBe(403);
  });

  it('invalidates a session after the credential Bundle scope is narrowed', () => {
    const registry = new McpSessionRegistry();
    registry.bind('s1', keyA, ctx({ allowedBundles: [1] }));
    expect(registry.check('s1', keyA, ctx({ allowedBundles: [2] }))).toBe('policy_changed');
    expect(mcpSessionDenial('policy_changed').status).toBe(409);
  });

  it('invalidates on tool-policy, scope or role changes but not on ordering noise', () => {
    const registry = new McpSessionRegistry();
    registry.bind('s1', keyA, ctx({ allowedBundles: [1, 2], deniedTools: ['a', 'b'] }));
    expect(registry.check('s1', keyA, ctx({ allowedBundles: [2, 1], deniedTools: ['b', 'a'] }))).toBe('ok');
    expect(registry.check('s1', keyA, ctx({ allowedBundles: [1, 2], deniedTools: ['a'] }))).toBe('policy_changed');
    expect(registry.check('s1', { ...keyA, apiKeyScope: 'mcp' }, ctx({ allowedBundles: [1, 2], deniedTools: ['a', 'b'] })))
      .toBe('policy_changed');

    const sso = new McpSessionRegistry();
    const user = { user: { id: 5, role: 'developer' } };
    const userCtx = ctx({ apiKeyPrefix: null, allowedBundles: null, callingUser: { id: 5, entra_groups: [] } });
    sso.bind('s2', user, userCtx);
    expect(sso.check('s2', user, userCtx)).toBe('ok');
    expect(sso.check('s2', { user: { id: 5, role: 'viewer' } }, userCtx)).toBe('policy_changed');
  });
});
