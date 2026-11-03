import { makeUserPolicyGate } from '../../builtin/userPolicyGate.js';
import type { HookContext } from '../../types.js';

// Mock the store module
const fetchUserPolicyDataMock = jest.fn();
jest.mock('../../../../auth/userPolicyStore.js', () => ({
  fetchUserPolicyData: (...args: unknown[]) => fetchUserPolicyDataMock(...args),
}));

const emptyData = {
  hasUserComposites: false, hasGroupComposites: false,
  userCompositeAllowPatterns: [], userCompositeDenyPatterns: [],
  groupCompositeAllowPatterns: [], groupCompositeDenyPatterns: [],
  userAllowRules: [], userDenyRules: [],
  groupAllowRules: [], groupDenyRules: [],
  legacyAllowedBundleTools: null,
};

const baseCtx: HookContext = {
  agentId: 1, agentName: 'a', sessionId: 's', iteration: 1, agentDepth: 0,
  toolName: 'jira_create_issue', toolArgs: {},
};

const pool = {} as never;

beforeEach(() => fetchUserPolicyDataMock.mockReset());

describe('userPolicyGate hook', () => {
  it('allows when no userId on context (API-key request, skip)', async () => {
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx }))!;
    expect(result.block).toBe('no');
    expect(fetchUserPolicyDataMock).not.toHaveBeenCalled();
  });

  it('allows when resolver returns allow (via user-composite wildcard)', async () => {
    fetchUserPolicyDataMock.mockResolvedValueOnce({
      ...emptyData, hasUserComposites: true,
    });
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx, userId: 42, userGroups: [] }))!;
    expect(result.block).toBe('no');
  });

  it('blocks with reason when user deny rule matches', async () => {
    fetchUserPolicyDataMock.mockResolvedValueOnce({
      ...emptyData,
      userDenyRules: [{ id: 9, pattern: 'jira_create_issue', source: 'user' }],
    });
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx, userId: 42 }))!;
    expect(result.block).toBe('yes');
    expect(result.reason).toMatch(/user-deny/);
  });

  it('blocks with default-deny when no policy data and no legacy', async () => {
    fetchUserPolicyDataMock.mockResolvedValueOnce(emptyData);
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx, userId: 42 }))!;
    expect(result.block).toBe('yes');
    expect(result.reason).toMatch(/default-deny/);
  });

  it('legacy allowed_bundles passes through when not in policy-mode', async () => {
    fetchUserPolicyDataMock.mockResolvedValueOnce({
      ...emptyData,
      legacyAllowedBundleTools: ['jira_create_issue'],
    });
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx, userId: 42 }))!;
    expect(result.block).toBe('no');
  });

  it('fail-closed on store DB error', async () => {
    fetchUserPolicyDataMock.mockRejectedValueOnce(new Error('connection lost'));
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx, userId: 42 }))!;
    expect(result.block).toBe('yes');
    expect(result.reason).toMatch(/policy-load-error/);
  });

  it('priority is 50', () => {
    const hook = makeUserPolicyGate(pool);
    expect(hook.priority).toBe(50);
  });

  it('allow-all when enforce=false even for authenticated user with deny policy', async () => {
    // Even if policy data would deny, enforce=false short-circuits before fetch.
    const hook = makeUserPolicyGate(pool, { enforce: () => false });
    const result = (await hook.preToolUse!({
      ...baseCtx,
      userId: 42,
      userGroups: ['argus-developers'],
      toolName: 'k8s_apply',
    }))!;
    expect(result.block).toBe('no');
    expect(fetchUserPolicyDataMock).not.toHaveBeenCalled();
  });

  it('defaults to enforce=true when opts omitted (back-compat)', async () => {
    // No opts → behaves as before; API-key request (no userId) still returns block:'no'
    const hook = makeUserPolicyGate(pool);
    const result = (await hook.preToolUse!({ ...baseCtx }))!;
    expect(result.block).toBe('no');
  });
});
