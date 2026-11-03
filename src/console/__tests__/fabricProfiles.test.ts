import { describe, expect, it, jest } from '@jest/globals';
import {
  FABRIC_PROFILE_API_VERSION,
  FABRIC_PROFILE_KIND,
  detectFabricProfileDrift,
  fabricProfileDigest,
  persistFabricProfileDriftSnapshot,
  planFabricProfileImport,
  validateFabricProfileManifest,
} from '../fabricProfiles.js';

function manifest() {
  return {
    apiVersion: FABRIC_PROFILE_API_VERSION,
    kind: FABRIC_PROFILE_KIND,
    metadata: { name: 'platform-ops', label: 'Platform Ops', description: 'Shared tools', version: '1.0.0' },
    spec: {
      connectors: [{ slot: 'github', backendName: 'github_argus_core', backendType: 'mcp' }],
      bundles: [{
        name: 'platform_ops_read', label: 'Platform read', description: '', icon: '', systemPrompt: null, agentRole: null,
        connectors: [{ slot: 'github', toolPolicy: { mode: 'selected', allowedToolNames: ['github_search_code'] } }],
        skills: [], directTools: [],
      }],
      access: {
        compositeName: 'platform-ops-access', description: '', toolAllowPatterns: [], toolDenyPatterns: ['*_delete'],
        groupBindings: [{ logicalName: 'platform-engineers', required: true }],
      },
    },
  };
}

describe('Fabric profile manifest', () => {
  it('normalizes a portable bundle set and produces a stable digest', () => {
    const first = validateFabricProfileManifest(manifest());
    const second = validateFabricProfileManifest(JSON.parse(JSON.stringify(manifest())));
    expect(first.spec.bundles[0]?.connectors[0]?.toolPolicy.allowedToolNames).toEqual(['github_search_code']);
    expect(first.spec.access?.groupBindings).toEqual([{ logicalName: 'platform-engineers', required: true }]);
    expect(fabricProfileDigest(first)).toMatch(/^[a-f0-9]{64}$/);
    expect(fabricProfileDigest(first)).toBe(fabricProfileDigest(second));
  });

  it('keeps older manifests compatible and rejects duplicate group aliases', () => {
    const legacy = manifest();
    delete (legacy.spec.access as Partial<typeof legacy.spec.access>).groupBindings;
    expect(validateFabricProfileManifest(legacy).spec.access?.groupBindings).toEqual([]);

    const duplicate = manifest();
    duplicate.spec.access!.groupBindings.push({ logicalName: 'platform-engineers', required: false });
    expect(() => validateFabricProfileManifest(duplicate)).toThrow(/logical names must be unique/i);

    const tenantBound = manifest();
    tenantBound.spec.access!.groupBindings = [{
      logicalName: 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6', required: true,
    }];
    expect(() => validateFabricProfileManifest(tenantBound)).toThrow(/portable alias/i);
  });

  it('requires explicit portable-to-local SSO mapping and plans additive group access', async () => {
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM mcp_service_bundles')) return { rows: [] };
      if (sql.includes('FROM mcp_backends')) return { rows: [{ id: 4, name: 'github_argus_core' }] };
      if (sql.includes('WITH known_groups')) return { rows: [{ name: 'entra-platform-team', member_count: 3 }] };
      if (sql.includes('SELECT EXISTS')) return { rows: [{ exists: false }] };
      throw new Error(`Unexpected query: ${sql} ${JSON.stringify(params)}`);
    });
    const db = { query } as unknown as Parameters<typeof planFabricProfileImport>[0];

    const blocked = await planFabricProfileImport(db, manifest(), {});
    expect(blocked.blockers).toEqual([expect.objectContaining({
      code: 'missing_group', resource: 'platform-engineers',
    })]);

    const planned = await planFabricProfileImport(db, manifest(), {
      groups: { 'platform-engineers': 'entra-platform-team' },
    });
    expect(planned.blockers).toEqual([]);
    expect(planned.resolved.groups).toEqual({
      'platform-engineers': { name: 'entra-platform-team', memberCount: 3 },
    });
    expect(planned.actions).toContainEqual(expect.objectContaining({
      kind: 'group', operation: 'bind', target: 'entra-platform-team',
    }));
  });

  it('rejects secret-bearing payloads before persistence', () => {
    const unsafe = { ...manifest(), credentials: { token: 'must-not-leave-this-host' } };
    expect(() => validateFabricProfileManifest(unsafe)).toThrow(/cannot contain credentials/i);
  });

  it('rejects unknown connector references and invalid profile versions', () => {
    const unknown = manifest();
    unknown.spec.bundles[0]!.connectors[0]!.slot = 'missing';
    expect(() => validateFabricProfileManifest(unknown)).toThrow(/unknown connector slot/i);

    const invalidVersion = manifest();
    invalidVersion.metadata.version = 'latest';
    expect(() => validateFabricProfileManifest(invalidVersion)).toThrow(/semantic versioning/i);
  });

  it('detects live tool-policy drift against an applied profile', async () => {
    const currentManifest = validateFabricProfileManifest(manifest());
    const profile = {
      id: 12,
      name: currentManifest.metadata.name,
      label: currentManifest.metadata.label,
      description: currentManifest.metadata.description,
      manifestVersion: currentManifest.metadata.version,
      revision: 3,
      manifest: currentManifest,
      manifestDigest: fabricProfileDigest(currentManifest),
      source: 'imported' as const,
      installedBundleIds: [3],
      appliedMappings: { groups: { 'platform-engineers': 'entra-platform-team' } },
      createdBy: 'admin', updatedBy: 'admin', lastAppliedAt: '2026-09-13T10:00:00.000Z',
      createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('FROM mcp_service_bundles')) return { rows: [{
        id: 3, name: 'platform_ops_read', label: 'Platform read', description: '', icon: '',
        system_prompt: null, agent_role: null,
      }] };
      if (sql.includes('FROM mcp_backend_bundles')) return { rows: [{
        bundle_id: 3, id: 4, name: 'github_argus_core', backend_type: 'mcp',
        mode: 'all', allowed_tool_names: [],
      }] };
      if (sql.includes('FROM mcp_bundle_skills')) return { rows: [] };
      if (sql.includes('FROM mcp_tool_bundles')) return { rows: [] };
      if (sql.includes('FROM mcp_composites')) return { rows: [{
        id: 9, description: '', included_bundle_ids: [3], tool_allow_patterns: [],
        tool_deny_patterns: ['*_delete'], enabled: true,
      }] };
      if (sql.includes('FROM mcp_fabric_profile_group_bindings')) return { rows: [{
        logical_name: 'platform-engineers', group_name: 'entra-platform-team', composite_id: 9, assigned: true,
      }] };
      throw new Error(`Unexpected query: ${sql}`);
    });
    const drift = await detectFabricProfileDrift({ query } as unknown as Parameters<typeof detectFabricProfileDrift>[0], profile);
    expect(drift.status).toBe('drifted');
    expect(drift.findings).toContainEqual(expect.objectContaining({
      code: 'tool_policy_changed', severity: 'critical', resource: 'platform_ops_read:github_argus_core',
    }));
  });

  it('does not query live topology for a saved but unapplied baseline', async () => {
    const currentManifest = validateFabricProfileManifest(manifest());
    const query = jest.fn();
    const drift = await detectFabricProfileDrift({ query } as never, {
      id: 8, name: currentManifest.metadata.name, label: currentManifest.metadata.label,
      description: '', manifestVersion: '1.0.0', revision: 1, manifest: currentManifest,
      manifestDigest: fabricProfileDigest(currentManifest), source: 'local', installedBundleIds: [3],
      appliedMappings: {}, createdBy: 'admin', updatedBy: 'admin', lastAppliedAt: null,
      createdAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    });
    expect(drift.status).toBe('not_applied');
    expect(query).not.toHaveBeenCalled();
  });

  it('persists a bounded finding summary and increments only real transitions', async () => {
    const checkedAt = '2026-09-13T11:00:00.000Z';
    const query = jest.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('FOR UPDATE')) return { rows: [{
        profile_id: 12, profile_revision: 2, manifest_digest: 'a'.repeat(64), status: 'in_sync',
        finding_count: 0, critical_count: 0, warning_count: 0, findings: [], finding_digest: 'b'.repeat(64),
        check_source: 'scheduled', transition_sequence: 4, consecutive_failures: 0,
        last_error_code: null, last_error_at: null, checked_at: checkedAt, changed_at: checkedAt, notified_at: null,
      }] };
      if (sql.includes('INSERT INTO mcp_fabric_profile_drift_state')) {
        const storedFindings = JSON.parse(String(params?.[7] ?? '[]')) as Array<Record<string, unknown>>;
        expect(storedFindings[0]).toEqual({
          code: 'tool_policy_changed', severity: 'critical', resourceType: 'connector',
          resource: 'platform-team:github', message: 'Tool policy for github changed',
        });
        expect(storedFindings[0]).not.toHaveProperty('expected');
        expect(storedFindings[0]).not.toHaveProperty('actual');
        return { rows: [{
          profile_id: params?.[0], profile_revision: params?.[1], manifest_digest: params?.[2], status: params?.[3],
          finding_count: params?.[4], critical_count: params?.[5], warning_count: params?.[6], findings: storedFindings,
          finding_digest: params?.[8], check_source: params?.[9], transition_sequence: params?.[10],
          consecutive_failures: 0, last_error_code: null, last_error_at: null,
          checked_at: params?.[11], changed_at: params?.[11], notified_at: null,
        }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const result = await persistFabricProfileDriftSnapshot({ query } as never, {
      status: 'drifted', checkedAt, profileId: 12, profileRevision: 2, manifestDigest: 'a'.repeat(64),
      counts: { total: 1, critical: 1, warning: 0 },
      findings: [{
        code: 'tool_policy_changed', severity: 'critical', resourceType: 'connector',
        resource: 'platform-team:github', message: 'Tool policy for github changed',
        expected: { mode: 'selected', authorization: 'must-not-be-copied' }, actual: { mode: 'all' },
      }],
    }, 'scheduled');

    expect(result.transitioned).toBe(true);
    expect(result.previousStatus).toBe('in_sync');
    expect(result.snapshot.transitionSequence).toBe(5);
    expect(result.snapshot.status).toBe('drifted');
  });
});
