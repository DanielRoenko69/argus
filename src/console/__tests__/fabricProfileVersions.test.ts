import { describe, expect, it, jest } from '@jest/globals';
import {
  FABRIC_PROFILE_API_VERSION,
  FABRIC_PROFILE_KIND,
  applyApprovedFabricProfileRestore,
  decideFabricProfileRestore,
  diffFabricProfileManifests,
  diffFabricProfileVersions,
  type FabricProfileManifest,
} from '../fabricProfiles.js';

function manifest(version: string): FabricProfileManifest {
  return {
    apiVersion: FABRIC_PROFILE_API_VERSION,
    kind: FABRIC_PROFILE_KIND,
    metadata: { name: 'platform-ops', label: 'Platform Ops', description: 'Shared baseline', version },
    spec: {
      connectors: [{ slot: 'github', backendName: 'github-main', backendType: 'mcp' }],
      bundles: [{
        name: 'platform_read', label: 'Platform read', description: '', icon: '', systemPrompt: null, agentRole: null,
        connectors: [{ slot: 'github', toolPolicy: { mode: 'selected', allowedToolNames: ['github_get_issue'] } }],
        skills: [], directTools: [],
      }],
      access: null,
    },
  };
}

function versionRow(revision: number, value: FabricProfileManifest) {
  return {
    id: 90 + revision,
    profile_id: 12,
    revision,
    manifest_version: value.metadata.version,
    manifest: value,
    manifest_digest: String(revision).repeat(64),
    source: 'local',
    installed_bundle_ids: [3],
    applied_mappings: {},
    change_kind: revision === 1 ? 'created' : 'exported',
    applied: false,
    created_by: 'admin',
    created_at: new Date(`2026-09-13T1${revision}:00:00.000Z`),
  };
}

function restoreRow(status: 'pending' | 'approved' | 'stale' = 'pending') {
  return {
    id: '4ed7e706-87f2-4b2d-8bb9-3784884bb9f2', profile_id: 12, profile_label: 'Platform Ops',
    target_revision: 1, target_manifest_digest: '1'.repeat(64), requested_from_revision: 2,
    requested_from_manifest_digest: '2'.repeat(64), mappings: {}, plan_token: 'b'.repeat(64),
    plan_snapshot: { actions: [], blockers: [] }, status, requested_by: 7, requested_by_username: 'admin',
    request_comment: 'Restore known baseline', requested_at: new Date('2026-09-13T12:00:00.000Z'),
    decided_by: status === 'pending' ? null : 8, decided_by_username: status === 'pending' ? null : 'reviewer',
    decision_comment: status === 'pending' ? null : 'Reviewed and approved',
    decided_at: status === 'pending' ? null : new Date('2026-09-13T12:05:00.000Z'),
    applied_at: null, updated_at: new Date('2026-09-13T12:05:00.000Z'),
  };
}

describe('MCP Fabric profile versions', () => {
  it('summarizes connector, bundle, access and metadata changes without index-based noise', () => {
    const before = manifest('1.0.0');
    const after = manifest('1.1.0');
    after.spec.connectors[0]!.backendName = 'github-production';
    after.spec.bundles[0]!.connectors[0]!.toolPolicy.allowedToolNames.push('github_search_code');
    after.spec.access = {
      compositeName: 'platform-access', description: '', toolAllowPatterns: [], toolDenyPatterns: ['*_delete'], groupBindings: [],
    };

    const changes = diffFabricProfileManifests(before, after);
    expect(changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'metadata', field: 'version', before: '1.0.0', after: '1.1.0' }),
      expect.objectContaining({ scope: 'connector', resource: 'github' }),
      expect.objectContaining({ scope: 'bundle', resource: 'platform_read' }),
      expect.objectContaining({ scope: 'access', kind: 'added' }),
    ]));
  });

  it('loads exact revisions and returns digest-bound diff metadata', async () => {
    const before = manifest('1.0.0');
    const after = manifest('1.1.0');
    after.metadata.description = 'Updated baseline';
    const query = jest.fn(async (_sql: string, params?: unknown[]) => ({
      rows: [Number(params?.[1]) === 1 ? versionRow(1, before) : versionRow(2, after)],
    }));

    const result = await diffFabricProfileVersions({ query } as never, 12, 1, 2);
    expect(result).toMatchObject({
      profileId: 12,
      from: { revision: 1, manifestDigest: '1'.repeat(64) },
      to: { revision: 2, manifestDigest: '2'.repeat(64) },
      counts: { total: 2, added: 0, removed: 0, changed: 2 },
      truncated: false,
    });
  });

  it('enforces separation of duties before a restore can be approved', async () => {
    const previous = process.env['ALLOW_SELF_APPROVE_FABRIC_RESTORE'];
    delete process.env['ALLOW_SELF_APPROVE_FABRIC_RESTORE'];
    const client = {
      query: jest.fn(async (sql: string) => sql.includes('SELECT request.*') ? { rows: [restoreRow()] } : { rows: [] }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    await expect(decideFabricProfileRestore(pool as never, {
      requestId: restoreRow().id, decision: 'approved', actorId: 7, actorUsername: 'admin', comment: 'Approve restore',
    })).rejects.toThrow(/different policy admin/i);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    if (previous === undefined) delete process.env['ALLOW_SELF_APPROVE_FABRIC_RESTORE'];
    else process.env['ALLOW_SELF_APPROVE_FABRIC_RESTORE'] = previous;
  });

  it('marks an approved restore stale when the immutable head changed', async () => {
    const client = {
      query: jest.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('SELECT request.*')) return { rows: [restoreRow('approved')] };
        if (sql.includes('SELECT revision, manifest_digest')) return { rows: [{ revision: 3, manifest_digest: '3'.repeat(64) }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = { connect: jest.fn(async () => client) };
    await expect(applyApprovedFabricProfileRestore(pool as never, {
      requestId: restoreRow().id, actor: 'reviewer',
    })).rejects.toThrow(/stale because the Bundle Set changed/i);
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status='stale'"),
      [restoreRow().id],
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
  });
});
