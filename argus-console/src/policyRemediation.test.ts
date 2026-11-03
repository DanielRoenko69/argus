import { describe, expect, it } from 'vitest';
import { buildRemediationCandidates, previewCompositeImpact, suggestToolPatterns } from './policyRemediation';
import type { AccessPolicyComposite } from './types';

const baseComposite: AccessPolicyComposite = {
  id: 1,
  name: 'read-only',
  description: '',
  bundleMode: 'selected',
  includedBundleIds: [7],
  toolAllowPatterns: ['github_get_*'],
  toolDenyPatterns: ['*_secret'],
  systemPrompt: null,
  agentRole: null,
  enabled: true,
  userCount: 0,
  groupCount: 0,
  agentCount: 0,
  apiKeyCount: 0,
  groupNames: [],
  createdAt: '2030-01-01T00:00:00.000Z',
  updatedAt: '2030-01-01T00:00:00.000Z',
};

const catalog = {
  tools: ['github_get_issue', 'github_get_secret', 'github_delete_repo', 'jira_search'],
  bundles: [{
    id: 7,
    name: 'github',
    label: 'GitHub',
    icon: '',
    toolCount: 3,
    toolNames: ['github_get_issue', 'github_get_secret', 'github_delete_repo'],
  }],
  composites: [baseComposite],
};

describe('policy remediation impact preview', () => {
  it('applies bundle scope, allow patterns and deny patterns in runtime order', () => {
    const preview = previewCompositeImpact(catalog, baseComposite);

    expect(preview.allowedTools).toEqual(['github_get_issue']);
    expect(preview.deniedTools).toEqual(['github_get_secret']);
    expect(preview.removedTools).toEqual([
      'github_get_secret',
      'github_delete_repo',
      'jira_search',
    ]);
    expect(preview.lockoutRisk).toBe(false);
    expect(preview.unmatchedAllowPatterns).toEqual([]);
  });

  it('ranks a usable selected-bundle composite before broad and lockout candidates', () => {
    const candidates = buildRemediationCandidates({
      ...catalog,
      composites: [
        {
          ...baseComposite,
          id: 2,
          name: 'broad',
          bundleMode: 'all',
          includedBundleIds: [],
          toolAllowPatterns: [],
        },
        {
          ...baseComposite,
          id: 3,
          name: 'empty',
          includedBundleIds: [999],
        },
        baseComposite,
      ],
    });

    expect(candidates.map(candidate => candidate.composite.name)).toEqual([
      'read-only',
      'broad',
      'empty',
    ]);
    expect(candidates[2]?.lockoutRisk).toBe(true);
  });

  it('suggests specific read patterns before write-capable patterns', () => {
    expect(suggestToolPatterns([
      'jira_update_issue',
      'jira_get_issue',
      'jira_get_transitions',
      'bitbucket_create_pr',
      'bitbucket_list_prs',
    ])).toEqual([
      { pattern: 'jira_get_*', kind: 'read', matchCount: 2 },
      { pattern: 'bitbucket_list_*', kind: 'read', matchCount: 1 },
      { pattern: 'bitbucket_create_*', kind: 'write', matchCount: 1 },
      { pattern: 'jira_update_*', kind: 'write', matchCount: 1 },
    ]);
  });
});
