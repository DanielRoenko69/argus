import {
  canOpenBundle,
  normalizeFabricAccessMutation,
  normalizeFabricBundleMutation,
  normalizeFabricCompositeMutation,
  normalizeFabricConnectionMutation,
  normalizeFabricGroupPolicyMutation,
  normalizeFabricTechnicalPolicyMutation,
  normalizeFabricToolAssignment,
  normalizeFabricToolTransfer,
  normalizeFabricUserPolicyMutation,
  normalizePolicySimulationInput,
  mutateBundleToolPolicy,
} from '../consoleApi.js';

describe('MCP Fabric bundle visibility', () => {
  it('allows users without a legacy bundle restriction to open any bundle', () => {
    expect(canOpenBundle(41, null)).toBe(true);
  });

  it('allows an explicitly granted bundle', () => {
    expect(canOpenBundle(7, [3, 7, 11])).toBe(true);
  });

  it('does not expose a bundle outside the user scope', () => {
    expect(canOpenBundle(8, [3, 7, 11])).toBe(false);
  });
});

describe('MCP Fabric access mutation validation', () => {
  it('normalizes a supported direct principal assignment', () => {
    expect(normalizeFabricAccessMutation({
      kind: 'workflow',
      id: '17',
      granted: true,
    })).toEqual({ kind: 'workflow', id: 17, granted: true });
  });

  it('rejects inherited kinds and malformed states', () => {
    expect(() => normalizeFabricAccessMutation({
      kind: 'group',
      id: 3,
      granted: true,
    })).toThrow('Principal-Typ');
    expect(() => normalizeFabricAccessMutation({
      kind: 'user',
      id: 0,
      granted: false,
    })).toThrow('Principal-ID');
    expect(() => normalizeFabricAccessMutation({
      kind: 'agent',
      id: 2,
      granted: 'yes' as unknown as boolean,
    })).toThrow('Access-Status');
  });
});

describe('MCP Fabric bulk tool assignment validation', () => {
  it('normalizes and de-duplicates backend tool identities', () => {
    expect(normalizeFabricToolAssignment({
      bundleId: '7',
      tools: [
        { backendId: 3, name: ' jira_get_issue ' },
        { backendId: '3', name: 'jira_get_issue' },
        { backendId: 4, name: 'bitbucket_get_pr' },
        { backendId: null, name: 'workspace_read' },
      ],
    })).toEqual({
      bundleId: 7,
      tools: [
        { backendId: 3, name: 'jira_get_issue' },
        { backendId: 4, name: 'bitbucket_get_pr' },
        { backendId: null, name: 'workspace_read' },
      ],
    });
  });

  it('rejects empty or malformed tool assignments', () => {
    expect(() => normalizeFabricToolAssignment({ bundleId: 1, tools: [] })).toThrow('Mindestens ein Tool');
    expect(() => normalizeFabricToolAssignment({
      bundleId: 1,
      tools: [{ backendId: 0, name: 'jira_get_issue' }],
    })).toThrow('Backend-ID');
  });
});

describe('MCP Fabric bundle tool changes', () => {
  it('normalizes remove and move requests without duplicate tool identities', () => {
    expect(normalizeFabricToolTransfer({
      action: 'move',
      targetBundleId: '9',
      tools: [
        { backendId: 3, name: 'jira_get_issue' },
        { backendId: '3', name: ' jira_get_issue ' },
        { backendId: null, name: 'workspace_read' },
      ],
    }, 7)).toEqual({
      action: 'move',
      targetBundleId: 9,
      tools: [
        { backendId: 3, name: 'jira_get_issue' },
        { backendId: null, name: 'workspace_read' },
      ],
    });
    expect(normalizeFabricToolTransfer({
      action: 'remove',
      targetBundleId: 9,
      tools: [{ backendId: null, name: 'workspace_read' }],
    }, 7).targetBundleId).toBeNull();
  });

  it('rejects invalid or identical move targets', () => {
    expect(() => normalizeFabricToolTransfer({
      action: 'move',
      targetBundleId: 7,
      tools: [{ backendId: 3, name: 'jira_get_issue' }],
    }, 7)).toThrow('verschieden');
    expect(() => normalizeFabricToolTransfer({
      action: 'archive' as 'move',
      tools: [{ backendId: 3, name: 'jira_get_issue' }],
    }, 7)).toThrow('Tool-Aktion');
  });

  it('converts all-mode removals to a selected allowlist and collapses complete additions', () => {
    expect(mutateBundleToolPolicy(
      ['jira_get_issue', 'jira_update_issue', 'jira_search_issues'],
      'all',
      [],
      ['jira_update_issue'],
      'remove',
    )).toEqual({
      mode: 'selected',
      allowedToolNames: ['jira_get_issue', 'jira_search_issues'],
    });
    expect(mutateBundleToolPolicy(
      ['jira_get_issue', 'jira_update_issue'],
      'selected',
      ['jira_get_issue'],
      ['jira_update_issue'],
      'add',
    )).toEqual({ mode: 'all', allowedToolNames: [] });
  });
});

describe('native access policy validation', () => {
  it('normalizes a selected-bundle composite and de-duplicates patterns', () => {
    expect(normalizeFabricCompositeMutation({
      name: 'incident-operators',
      description: ' Production incident policy ',
      bundleMode: 'selected',
      includedBundleIds: [7, 3, 7],
      toolAllowPatterns: ['k8s_*', 'grafana_*', 'k8s_*'],
      toolDenyPatterns: ['*_delete'],
      enabled: true,
    })).toMatchObject({
      name: 'incident-operators',
      description: 'Production incident policy',
      includedBundleIds: [7, 3],
      toolAllowPatterns: ['k8s_*', 'grafana_*'],
      toolDenyPatterns: ['*_delete'],
      enabled: true,
    });
  });

  it('requires an explicit bundle in selected mode and rejects unsafe patterns', () => {
    expect(() => normalizeFabricCompositeMutation({
      name: 'empty_scope',
      bundleMode: 'selected',
      includedBundleIds: [],
    })).toThrow('mindestens ein Bundle');
    expect(() => normalizeFabricCompositeMutation({
      name: 'unsafe_pattern',
      toolAllowPatterns: ['tool name with spaces'],
    })).toThrow('ungültiges Tool-Pattern');
  });

  it('normalizes group composite bindings and tool rules', () => {
    expect(normalizeFabricGroupPolicyMutation({
      groupName: 'platform-engineering',
      compositeIds: [4, 4, 8],
      agentIds: [3, 3, 9],
      rules: [
        { toolPattern: 'github_*', effect: 'allow', reason: 'Repository operations' },
        { toolPattern: '*_delete', effect: 'deny' },
      ],
    })).toEqual({
      groupName: 'platform-engineering',
      compositeIds: [4, 8],
      agentIds: [3, 9],
      rules: [
        { toolPattern: 'github_*', effect: 'allow', reason: 'Repository operations' },
        { toolPattern: '*_delete', effect: 'deny', reason: null },
      ],
    });
  });

  it('normalizes policy simulator requests and rejects malformed principals', () => {
    expect(normalizePolicySimulationInput({
      principalKind: 'user',
      principalId: 17,
      toolName: 'github_create_pr',
    })).toEqual({
      principalKind: 'user',
      principalId: '17',
      toolName: 'github_create_pr',
    });
    expect(normalizePolicySimulationInput({
      principalKind: 'group',
      principalId: 'platform-engineering',
      toolName: 'k8s_*',
    })).toMatchObject({ principalId: 'platform-engineering' });
    expect(() => normalizePolicySimulationInput({
      principalKind: 'agent',
      principalId: 'not-an-id',
      toolName: 'github_search',
    })).toThrow('Principal-ID');
  });

  it('normalizes an atomic user policy with expiring rules', () => {
    expect(normalizeFabricUserPolicyMutation({
      userId: '9',
      compositeIds: [3, 3, 7],
      agentIds: [12, 4, 12],
      rules: [{
        toolPattern: ' jira_* ',
        effect: 'allow',
        reason: ' Incident response ',
        expiresAt: '2030-01-02T10:30:00.000Z',
      }],
    })).toEqual({
      userId: 9,
      compositeIds: [3, 7],
      agentIds: [12, 4],
      rules: [{
        toolPattern: 'jira_*',
        effect: 'allow',
        reason: 'Incident response',
        expiresAt: '2030-01-02T10:30:00.000Z',
      }],
    });
    expect(() => normalizeFabricUserPolicyMutation({
      userId: 9,
      rules: [{ toolPattern: 'jira_*', effect: 'allow', expiresAt: 'not-a-date' }],
    })).toThrow('Ablaufzeit');
  });

  it('normalizes technical identity policies and legacy percent globs', () => {
    expect(normalizeFabricTechnicalPolicyMutation({
      kind: 'api_key',
      id: '5',
      compositeId: 3,
      bundleMode: 'selected',
      allowedBundleIds: [7, 7, 2],
      toolMode: 'selected',
      allowedTools: ['jira_%', 'bitbucket_get_*'],
      deniedTools: ['%_delete'],
    })).toEqual({
      kind: 'api_key',
      id: 5,
      compositeId: 3,
      allowedBundleIds: [7, 2],
      allowedTools: ['jira_*', 'bitbucket_get_*'],
      deniedTools: ['*_delete'],
    });
    expect(normalizeFabricTechnicalPolicyMutation({
      kind: 'agent',
      id: 8,
      compositeId: null,
      bundleMode: 'selected',
      allowedBundleIds: [],
    })).toEqual({
      kind: 'agent',
      id: 8,
      compositeId: null,
      allowedBundleIds: null,
      allowedTools: null,
      deniedTools: null,
    });
    expect(() => normalizeFabricTechnicalPolicyMutation({
      kind: 'api_key',
      id: 5,
      bundleMode: 'selected',
      allowedBundleIds: [],
    })).toThrow('mindestens ein Bundle');
  });
});

describe('MCP Fabric bundle mutation validation', () => {
  it('normalizes optional values and de-duplicates backend assignments', () => {
    expect(normalizeFabricBundleMutation({
      name: 'incident_ops',
      label: ' Incident Operations ',
      description: '  Production response tools ',
      icon: ' 🚨 ',
      agentRole: '',
      systemPrompt: '  Inspect current signals first. ',
      backendIds: [7, 3, 7],
      skillIds: [12, 12, 5],
    }, true)).toEqual({
      name: 'incident_ops',
      label: 'Incident Operations',
      description: 'Production response tools',
      icon: '🚨',
      agentRole: null,
      systemPrompt: 'Inspect current signals first.',
      backendIds: [7, 3],
      skillIds: [12, 5],
      toolPolicies: [
        { backendId: 7, mode: 'all', allowedToolNames: [] },
        { backendId: 3, mode: 'all', allowedToolNames: [] },
      ],
    });
  });

  it('normalizes explicit tool allowlists and removes duplicate names', () => {
    expect(normalizeFabricBundleMutation({
      label: 'Restricted Operations',
      backendIds: [7],
      toolPolicies: [{
        backendId: 7,
        mode: 'selected',
        allowedToolNames: ['pods_list', 'pods_delete', 'pods_list'],
      }],
    }, false).toolPolicies).toEqual([{
      backendId: 7,
      mode: 'selected',
      allowedToolNames: ['pods_list', 'pods_delete'],
    }]);
  });

  it('rejects a tool policy for a connection outside the bundle', () => {
    expect(() => normalizeFabricBundleMutation({
      label: 'Invalid Policy',
      backendIds: [7],
      toolPolicies: [{ backendId: 9, mode: 'all' }],
    }, false)).toThrow('nicht ausgewähltes Backend');
  });

  it('rejects an invalid internal name on create', () => {
    expect(() => normalizeFabricBundleMutation({
      name: 'Incident Ops',
      label: 'Incident Operations',
    }, true)).toThrow('Interner Name');
  });

  it('rejects invalid backend identifiers', () => {
    expect(() => normalizeFabricBundleMutation({
      label: 'Incident Operations',
      backendIds: [4, -1],
    }, false)).toThrow('ungültige ID');
  });

  it('rejects invalid skill identifiers', () => {
    expect(() => normalizeFabricBundleMutation({
      label: 'Incident Operations',
      skillIds: [4, 0],
    }, false)).toThrow('Skill-Zuordnungen');
  });

  it('allows edit payloads without changing the immutable internal name', () => {
    expect(normalizeFabricBundleMutation({
      label: 'Renamed Bundle',
      backendIds: [],
    }, false).name).toBeUndefined();
  });
});

describe('MCP Fabric connection mutation validation', () => {
  it('normalizes a complete MCP connection without materializing omitted secrets', () => {
    const result = normalizeFabricConnectionMutation({
      name: 'github_mcp',
      type: 'mcp',
      description: '  GitHub tools ',
      baseUrl: 'https://mcp.example.com/',
      mcpEndpoint: '/mcp',
      authType: 'bearer',
      authMode: 'strict',
      oauthAuthorizeUrl: 'https://auth.example.com/authorize',
      oauthTokenUrl: 'https://auth.example.com/token',
      oauthScopes: 'repo:read repo:write repo:read',
      bundleIds: [7, 3, 7],
    }, true);

    expect(result).toMatchObject({
      name: 'github_mcp',
      type: 'mcp',
      description: 'GitHub tools',
      baseUrl: 'https://mcp.example.com',
      mcpEndpoint: '/mcp',
      healthPath: null,
      authType: 'bearer',
      authMode: 'strict',
      oauthScopes: ['repo:read', 'repo:write'],
      bundleIds: [7, 3],
    });
    expect(Object.hasOwn(result, 'authValue')).toBe(false);
    expect(Object.hasOwn(result, 'oauthClientSecret')).toBe(false);
  });

  it('supports explicit credential clearing on edit', () => {
    const result = normalizeFabricConnectionMutation({
      type: 'http',
      baseUrl: 'https://api.example.com',
      authValue: null,
      oauthClientSecret: null,
    }, false);
    expect(Object.hasOwn(result, 'authValue')).toBe(true);
    expect(Object.hasOwn(result, 'oauthClientSecret')).toBe(true);
    expect(result.authValue).toBeNull();
    expect(result.oauthClientSecret).toBeNull();
  });

  it('normalizes a bundle-scoped Kubernetes execution target', () => {
    const result = normalizeFabricConnectionMutation({
      name: 'kubernetes_mcp',
      type: 'mcp',
      baseUrl: 'https://mcp.example.com',
      bundleIds: [8],
      executionTarget: {
        kind: 'kubernetes',
        platform: 'eks',
        targetId: 'production-kubernetes',
        label: 'Production Kubernetes',
        cluster: 'eu-central-platform-01',
        environment: 'production',
        namespaces: ['payments', 'observability'],
      },
    }, true);
    expect(result.executionTarget).toEqual({
      scope_kind: 'kubernetes',
      platform: 'eks',
      target_id: 'production-kubernetes',
      target_label: 'Production Kubernetes',
      cluster: 'eu-central-platform-01',
      environment: 'production',
      execution_namespaces: ['payments', 'observability'],
    });
  });

  it('rejects execution targets without a bundle or valid Kubernetes namespaces', () => {
    const target = {
      kind: 'kubernetes' as const,
      targetId: 'production-kubernetes',
      label: 'Production Kubernetes',
      cluster: 'eu-central-platform-01',
      environment: 'production',
      namespaces: ['payments'],
    };
    expect(() => normalizeFabricConnectionMutation({
      name: 'kubernetes_mcp', type: 'mcp', baseUrl: 'https://mcp.example.com', executionTarget: target,
    }, true)).toThrow(/access bundle/);
    expect(() => normalizeFabricConnectionMutation({
      name: 'kubernetes_mcp', type: 'mcp', baseUrl: 'https://mcp.example.com', bundleIds: [8],
      executionTarget: { ...target, namespaces: ['Not/A/Namespace'] },
    }, true)).toThrow(/valid Kubernetes namespaces/);
  });

  it('rejects unsafe internal names and unsupported URL schemes', () => {
    expect(() => normalizeFabricConnectionMutation({
      name: 'GitHub MCP',
      type: 'mcp',
      baseUrl: 'https://mcp.example.com',
    }, true)).toThrow('Interner Name');
    expect(() => normalizeFabricConnectionMutation({
      name: 'github_mcp',
      type: 'mcp',
      baseUrl: 'file:///etc/passwd',
    }, true)).toThrow('HTTP oder HTTPS');
  });

  it('rejects invalid endpoints, headers and bundle identifiers', () => {
    expect(() => normalizeFabricConnectionMutation({
      type: 'http',
      baseUrl: 'https://api.example.com',
      healthPath: 'health',
    }, false)).toThrow('mit / beginnen');
    expect(() => normalizeFabricConnectionMutation({
      type: 'http',
      baseUrl: 'https://api.example.com',
      defaultHeaders: { 'X-Test': 42 as unknown as string },
    }, false)).toThrow('ungültigen Eintrag');
    expect(() => normalizeFabricConnectionMutation({
      type: 'http',
      baseUrl: 'https://api.example.com',
      bundleIds: [1, 0],
    }, false)).toThrow('ungültige ID');
  });
});
