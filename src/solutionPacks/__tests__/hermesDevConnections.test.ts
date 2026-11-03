import { describe, expect, it, jest } from '@jest/globals';
import {
  HERMES_DEV_TOOL_PATTERN,
  HermesDevConnectionManager,
  personalHermesConfig,
} from '../hermesDevConnections.js';

describe('personalHermesConfig', () => {
  it('keeps credentials in environment placeholders and includes bounded workspace evidence', () => {
    const result = personalHermesConfig('ak_once', 'https://argus.example/mcp/hermes-dev');

    expect(result.environment).toEqual({
      ARGUS_HERMES_DEV_MCP_URL: 'https://argus.example/mcp/hermes-dev',
      ARGUS_HERMES_DEV_MCP_KEY: 'ak_once',
    });
    expect(result.configYaml).toContain('url: "${ARGUS_HERMES_DEV_MCP_URL}"');
    expect(result.configYaml).toContain('Authorization: "Bearer ${ARGUS_HERMES_DEV_MCP_KEY}"');
    expect(result.configYaml).toContain('argus_dev_get_workspace_evidence');
    expect(result.configYaml).not.toContain('ak_once');
  });
});

describe('HermesDevConnectionManager', () => {
  it('builds the personal Bundle catalog from direct and remote Fabric tool assignments', async () => {
    const queries: string[] = [];
    const pool = {
      query: jest.fn(async (text: string) => {
        queries.push(text);
        if (text.includes('FROM mcp_users WHERE')) return { rows: [{
          id: 7, username: 'entra:subject-7', display_name: 'Hermes Developer', role: 'developer',
          allowed_bundles: [3], entra_groups: ['engineering'], enabled: true,
        }] };
        if (text.includes('FROM (')) return { rows: [{ id: 3, name: 'github', label: 'GitHub', tool_count: 44 }] };
        if (text.includes('FROM mcp_hermes_dev_connections connection')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const manager = new HermesDevConnectionManager(pool as never);

    await expect(manager.catalog(7)).resolves.toEqual({
      identity: {
        id: 7, username: 'entra:subject-7', displayName: 'Hermes Developer', role: 'developer', authentication: 'sso',
      },
      connections: [],
      bundles: [{ id: 3, name: 'github', label: 'GitHub', toolCount: 44 }],
    });
    const catalogSql = queries.find(text => text.includes('FROM ('))!;
    expect(catalogSql).toContain('FROM mcp_tool_bundles assignment');
    expect(catalogSql).toContain('FROM mcp_remote_tools remote_tool');
    expect(catalogSql).not.toContain('tools.backend_id');
    expect(catalogSql).not.toContain('bundle.enabled');
  });

  it('lists a personal Hermes connector only inside the selected workspace membership', async () => {
    const queries: Array<{ text: string; values?: unknown[] }> = [];
    const pool = {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        queries.push({ text, values });
        if (text.includes('FROM mcp_users WHERE')) return { rows: [{
          id: 7, username: 'entra:subject-7', display_name: 'Hermes Developer', role: 'developer',
          allowed_bundles: [3], entra_groups: [], enabled: true,
        }] };
        if (text.includes('FROM mcp_workspace_memberships')) return { rows: [{ '?column?': 1 }] };
        if (text.includes('FROM (')) return { rows: [] };
        if (text.includes('FROM mcp_hermes_dev_connections connection')) return { rows: [] };
        return { rows: [] };
      }),
    };
    const manager = new HermesDevConnectionManager(pool as never);
    await manager.catalog(7, { tenantKey: 'acme', workspaceKey: 'payments' });
    const list = queries.find(entry => entry.text.includes('FROM mcp_hermes_dev_connections connection'))!;
    expect(list.values).toEqual([7, 'acme', 'payments']);
    expect(list.text).toContain('connection.tenant_key=$2');
    expect(list.text).toContain('connection.workspace_key=$3');
  });

  it('atomically creates an SSO-owner-bound, Bundle-scoped key without accepting a caller-selected user', async () => {
    const transactionQueries: Array<{ text: string; values?: unknown[] }> = [];
    const client = {
      query: jest.fn(async (text: string, values?: unknown[]) => {
        transactionQueries.push({ text, values });
        if (text.includes('INSERT INTO mcp_api_keys')) return { rows: [{ id: 91 }] };
        if (text.includes('INSERT INTO mcp_user_tool_rules')) return { rows: [{ id: 92 }] };
        if (text.includes('INSERT INTO mcp_hermes_dev_connections')) return { rows: [{ id: 93 }] };
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    const pool = {
      connect: jest.fn(async () => client),
      query: jest.fn(async (text: string, values?: unknown[]) => {
        if (text.includes('FROM mcp_users WHERE')) return { rows: [{
          id: 7, username: 'entra:subject-7', display_name: 'Hermes Developer', role: 'developer',
          allowed_bundles: [3, 4], entra_groups: ['engineering'], enabled: true,
        }] };
        if (text.includes('FROM mcp_service_bundles')) return { rows: (values?.[0] as number[]).map(id => ({ id })) };
        if (text.includes('FROM mcp_hermes_dev_connections connection')) return { rows: [{
          id: 93, label: 'Laptop Hermes', user_id: 7, username: 'hermes-dev', display_name: 'Hermes Developer',
          api_key_id: 91, key_prefix: 'ak_generated', key_suffix: 'cafe', bundle_ids: [3, 4], enabled: true,
          last_used_at: null, last_tested_at: null, last_test_state: null, last_test_detail: null, revoked_at: null,
          created_at: new Date('2026-08-31T10:00:00.000Z'), updated_at: new Date('2026-08-31T10:00:00.000Z'),
        }] };
        return { rows: [] };
      }),
    };
    const manager = new HermesDevConnectionManager(pool as never);

    const created = await manager.create({ label: 'Laptop Hermes', bundleIds: [3, 4, 3] }, 7);

    const keyInsert = transactionQueries.find(entry => entry.text.includes('INSERT INTO mcp_api_keys'))!;
    expect(keyInsert.values?.[2]).toEqual([3, 4]);
    expect(keyInsert.values?.[3]).toEqual([HERMES_DEV_TOOL_PATTERN]);
    expect(keyInsert.values?.[7]).toBe(7);
    const ruleInsert = transactionQueries.find(entry => entry.text.includes('INSERT INTO mcp_user_tool_rules'))!;
    expect(ruleInsert.values).toEqual([7, HERMES_DEV_TOOL_PATTERN, 'Managed Hermes Dev connector: Laptop Hermes', 7]);
    expect(transactionQueries.map(entry => entry.text)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(client.release).toHaveBeenCalled();
    expect(created.apiKey).toMatch(/^ak_[0-9a-f]{64}$/);
    expect(created.connection).toMatchObject({ id: 93, userId: 7, bundleIds: [3, 4] });
  });

  it('rejects Bundles outside the current delegated identity scope', async () => {
    const pool = {
      query: jest.fn(async (text: string) => {
        if (text.includes('FROM mcp_users WHERE')) return { rows: [{
          id: 7, username: 'entra:subject-7', display_name: 'Hermes Developer', role: 'developer',
          allowed_bundles: [3], entra_groups: [], enabled: true,
        }] };
        return { rows: [] };
      }),
    };
    const manager = new HermesDevConnectionManager(pool as never);

    await expect(manager.create({ label: 'Laptop Hermes', bundleIds: [4] }, 7)).rejects.toMatchObject({
      status: 403,
      code: 'hermes_connection_bundle_denied',
    });
  });

  it('re-evaluates active owner and Bundle rights for every MCP credential resolution', async () => {
    const pool = {
      query: jest.fn(async (text: string) => {
        if (text.includes('FROM mcp_hermes_dev_connections connection')) return { rows: [{
          user_id: 7, bundle_ids: [3, 4], username: 'entra:subject-7', display_name: 'Hermes Developer',
          role: 'developer', allowed_bundles: [4], entra_groups: ['engineering'],
        }] };
        if (text.includes('FROM mcp_service_bundles')) return { rows: [{ id: 3 }, { id: 4 }] };
        return { rows: [] };
      }),
    };
    const manager = new HermesDevConnectionManager(pool as never);

    await expect(manager.resolveCredential('ak_owner')).resolves.toEqual({
      caller: {
        userId: 7,
        apiKeyPrefix: 'ak_owner',
        allowedBundleIds: [4],
        tenantKey: 'default',
        workspaceKey: 'default',
      },
      owner: {
        id: 7, username: 'entra:subject-7', displayName: 'Hermes Developer', role: 'developer',
        allowedBundleIds: [4], entraGroups: ['engineering'],
      },
    });
  });
});
