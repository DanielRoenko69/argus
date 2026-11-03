import { buildPolicyPosture, type PolicyPostureInput } from '../policyPosture.js';

function fixture(): PolicyPostureInput {
  return {
    bundles: [{ id: 1 }, { id: 2 }],
    composites: [{
      id: 10,
      name: 'platform-read',
      bundleMode: 'selected' as const,
      includedBundleIds: [1],
      toolAllowPatterns: ['github_get_*'],
      toolDenyPatterns: ['*_delete'],
      enabled: true,
      userCount: 1,
      groupCount: 0,
      agentCount: 0,
      apiKeyCount: 0,
    }],
    groups: [],
    users: [{
      id: 7,
      label: 'Dana',
      role: 'viewer',
      enabled: true,
      allowedBundleIds: null,
      entraGroups: [],
      compositeIds: [10],
      rules: [],
    }],
    technicalIdentities: [{
      id: 4,
      kind: 'agent' as const,
      label: 'Triage Agent',
      enabled: true,
      compositeId: 10,
      allowedBundleIds: null,
      allowedTools: null,
    }],
  };
}

describe('policy posture analysis', () => {
  it('reports a clean, fully covered least-privilege baseline', () => {
    const posture = buildPolicyPosture(fixture(), new Date('2030-01-01T00:00:00.000Z'));

    expect(posture).toMatchObject({
      score: 100,
      status: 'strong',
      coveragePercent: 100,
      coveredPrincipals: 2,
      totalPrincipals: 2,
      unrestrictedPrincipals: 0,
      summary: { total: 0 },
    });
  });

  it('prioritizes unrestricted machine access and broad composites', () => {
    const input = fixture();
    input.composites[0] = {
      ...input.composites[0],
      bundleMode: 'all',
      includedBundleIds: [],
      toolAllowPatterns: [],
      toolDenyPatterns: [],
    };
    input.technicalIdentities = [{
      id: 8,
      kind: 'api_key',
      label: 'CI key',
      enabled: true,
      compositeId: null,
      allowedBundleIds: null,
      allowedTools: null,
    }];

    const posture = buildPolicyPosture(input);

    expect(posture.status).toBe('critical');
    expect(posture.unrestrictedPrincipals).toBe(1);
    expect(posture.findings.map(finding => finding.id)).toEqual(expect.arrayContaining([
      'unrestricted-composite:10',
      'unrestricted-api-key:8',
      'no-deny-guardrail:10',
    ]));
    expect(posture.findings[0]?.severity).toBe('critical');
  });

  it('detects legacy users, stale groups and expired overrides', () => {
    const input = fixture();
    input.users[0] = {
      ...input.users[0],
      allowedBundleIds: [1],
      compositeIds: [],
      entraGroups: [],
      rules: [{ expiresAt: '2029-01-01T00:00:00.000Z' }],
    };
    input.groups = [{
      name: 'old-team',
      memberCount: 0,
      compositeIds: [10],
      agentIds: [],
      rules: [],
    }];

    const posture = buildPolicyPosture(input, new Date('2030-01-01T00:00:00.000Z'));

    expect(posture.findings.map(finding => finding.id)).toEqual(expect.arrayContaining([
      'legacy-user:7',
      'expired-user-rules:7',
      'stale-group:old-team',
    ]));
  });
});
