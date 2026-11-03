import { explainUserPolicy, resolveUserPolicy, type PolicyInput } from '../userPolicyResolver.js';

describe('resolveUserPolicy', () => {
  const baseInput: PolicyInput = {
    toolName: 'jira_create_issue',
    userCompositeAllowPatterns: [],
    userCompositeDenyPatterns: [],
    userAllowRules: [],
    userDenyRules: [],
    groupCompositeAllowPatterns: [],
    groupCompositeDenyPatterns: [],
    groupAllowRules: [],
    groupDenyRules: [],
    hasUserComposites: false,
    hasGroupComposites: false,
    legacyAllowedBundleTools: null,
  };

  it('returns "no_rule" when user has no policies at all and no legacy', () => {
    expect(resolveUserPolicy(baseInput).decision).toBe('no_rule');
  });

  it('returns "allow" when tool matches user composite allow-pattern', () => {
    const r = resolveUserPolicy({ ...baseInput, hasUserComposites: true, userCompositeAllowPatterns: ['jira_*'] });
    expect(r.decision).toBe('allow');
    expect(r.reason).toContain('user-composite');
  });

  it('returns "allow" via group composite pattern', () => {
    const r = resolveUserPolicy({ ...baseInput, hasGroupComposites: true, groupCompositeAllowPatterns: ['jira_create_issue'] });
    expect(r.decision).toBe('allow');
    expect(r.reason).toContain('group-composite');
  });

  it('composite with empty allow-patterns means "all tools" (wildcard semantics)', () => {
    const r = resolveUserPolicy({ ...baseInput, hasUserComposites: true, userCompositeAllowPatterns: [] });
    // hasUserComposites=true + empty patterns = wildcard "*"
    expect(r.decision).toBe('allow');
  });

  it('composite deny pattern blocks the tool even if composite allow matches', () => {
    const r = resolveUserPolicy({
      ...baseInput, hasUserComposites: true,
      userCompositeAllowPatterns: ['jira_*'],
      userCompositeDenyPatterns: ['jira_create_*'],
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('composite-deny');
  });

  it('returns "allow" via user explicit allow_rule', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      userAllowRules: [{ id: 1, pattern: 'jira_create_issue', source: 'user' }],
    });
    expect(r.decision).toBe('allow');
    expect(r.reason).toContain('user-rule');
  });

  it('returns "deny" when user deny_rule matches, even if composite allows', () => {
    const r = resolveUserPolicy({
      ...baseInput, hasUserComposites: true,
      userCompositeAllowPatterns: ['jira_*'],
      userDenyRules: [{ id: 9, pattern: 'jira_create_issue', source: 'user' }],
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('user-deny');
  });

  it('group deny wins over user composite allow', () => {
    const r = resolveUserPolicy({
      ...baseInput, hasUserComposites: true,
      userCompositeAllowPatterns: ['k8s_*'],
      toolName: 'k8s_delete_ns',
      groupDenyRules: [{ id: 4, pattern: 'k8s_delete_*', source: 'group:admins' }],
    });
    expect(r.decision).toBe('deny');
    expect(r.reason).toContain('group-deny');
  });

  it('returns "allow" via legacy allowed_bundles when not in policy-mode', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      legacyAllowedBundleTools: ['jira_create_issue'],
    });
    expect(r.decision).toBe('allow');
    expect(r.reason).toContain('legacy');
  });

  it('returns "no_rule" when legacy data exists but tool not in it', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      legacyAllowedBundleTools: ['other_tool'],
    });
    expect(r.decision).toBe('no_rule');
  });

  it('user composites disable legacy fallback', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      hasUserComposites: true,
      userCompositeAllowPatterns: ['other_*'],
      legacyAllowedBundleTools: ['jira_create_issue'], // ignored when in policy-mode
    });
    expect(r.decision).toBe('no_rule');
  });

  it('group composites also disable legacy fallback', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      hasGroupComposites: true,
      groupCompositeAllowPatterns: ['other_*'],
      legacyAllowedBundleTools: ['jira_create_issue'],
    });
    expect(r.decision).toBe('no_rule');
  });

  it('any user rule disables legacy fallback', () => {
    const r = resolveUserPolicy({
      ...baseInput,
      userDenyRules: [{ id: 1, pattern: 'never_called_*', source: 'user' }],
      legacyAllowedBundleTools: ['jira_create_issue'],
    });
    expect(r.decision).toBe('no_rule');
  });

  it('handles glob patterns in deny rules', () => {
    const r = resolveUserPolicy({
      ...baseInput, hasUserComposites: true,
      userCompositeAllowPatterns: ['*'],
      userDenyRules: [{ id: 5, pattern: 'k8s_*', source: 'user' }],
      toolName: 'k8s_apply',
    });
    expect(r.decision).toBe('deny');
  });

  it('explains the same deny-first decision returned by the runtime resolver', () => {
    const input: PolicyInput = {
      ...baseInput,
      hasUserComposites: true,
      userCompositeAllowPatterns: ['k8s_*'],
      groupDenyRules: [{ id: 12, pattern: '*_delete', source: 'group:platform' }],
      toolName: 'k8s_delete',
    };
    const explained = explainUserPolicy(input);
    expect(explained.result).toEqual(resolveUserPolicy(input));
    expect(explained.policyMode).toBe(true);
    expect(explained.steps.at(-1)).toMatchObject({
      key: 'group-rule-deny',
      outcome: 'matched',
      evidence: ['*_delete'],
    });
    expect(explained.steps.some(step => step.key === 'user-composite-allow')).toBe(false);
  });
});
