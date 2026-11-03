import type pg from 'pg';
import { z } from 'zod';
import { rotateManagedApiKey } from '../auth/apiKeyManagement.js';
import { apiKeyPrefix } from '../auth/apiKeyMiddleware.js';
import { generateApiKey, hashApiKey } from '../auth/apiKeyRbac.js';
import type { HermesDevBridge, HermesDevBridgeCaller } from './hermesDevBridge.js';

export const HERMES_DEV_TOOL_PATTERN = 'argus_dev_*';
export const HERMES_DEV_TOOLS = [
  'argus_dev_capabilities',
  'argus_dev_preflight',
  'argus_dev_start_workflow',
  'argus_dev_get_run',
  'argus_dev_get_workspace_evidence',
  'argus_dev_get_result',
  'argus_dev_cancel_run',
] as const;

const createSchema = z.object({
  label: z.string().trim().min(1).max(128),
  bundleIds: z.array(z.number().int().positive()).min(1).max(64),
}).strict();

export interface HermesDevConnectionOwner {
  id: number;
  username: string;
  displayName: string;
  role: string;
  allowedBundleIds: number[] | null;
  entraGroups: string[];
}

export interface HermesDevWorkspaceScope {
  tenantKey: string;
  workspaceKey: string;
}

const DEFAULT_SCOPE: HermesDevWorkspaceScope = { tenantKey: 'default', workspaceKey: 'default' };

export interface HermesDevConnectionBundle {
  id: number;
  name: string;
  label: string;
  toolCount: number;
}

export interface HermesDevResolvedCredential {
  caller: HermesDevBridgeCaller;
  owner: HermesDevConnectionOwner;
}

export class HermesDevConnectionError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HermesDevConnectionError';
  }
}

export interface HermesDevConnection {
  id: number;
  label: string;
  userId: number;
  username: string;
  displayName: string;
  apiKeyId: number;
  keyPrefix: string;
  keySuffix: string | null;
  bundleIds: number[];
  tenantKey: string;
  workspaceKey: string;
  enabled: boolean;
  clientSeen: boolean;
  lastUsedAt: string | null;
  lastTestedAt: string | null;
  lastTestState: 'ready' | 'blocked' | 'failed' | null;
  lastTestDetail: string | null;
  revokedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HermesDevConnectionSecret {
  connection: HermesDevConnection;
  apiKey: string;
  endpointPath: '/mcp/hermes-dev';
  environment: {
    ARGUS_HERMES_DEV_MCP_URL: string;
    ARGUS_HERMES_DEV_MCP_KEY: string;
  };
  configYaml: string;
}

export interface HermesDevConnectionCatalog {
  identity: Pick<HermesDevConnectionOwner, 'id' | 'username' | 'displayName' | 'role'> & {
    authentication: 'sso' | 'argus-session';
  };
  connections: HermesDevConnection[];
  bundles: HermesDevConnectionBundle[];
}

interface ConnectionRow {
  id: number;
  label: string;
  user_id: number;
  username: string;
  display_name: string;
  api_key_id: number;
  key_prefix: string;
  key_suffix: string | null;
  bundle_ids: number[];
  tenant_key: string;
  workspace_key: string;
  enabled: boolean;
  last_used_at: Date | string | null;
  last_tested_at: Date | string | null;
  last_test_state: 'ready' | 'blocked' | 'failed' | null;
  last_test_detail: string | null;
  revoked_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ConnectionRow): HermesDevConnection {
  const lastUsedAt = iso(row.last_used_at);
  return {
    id: row.id,
    label: row.label,
    userId: row.user_id,
    username: row.username,
    displayName: row.display_name,
    apiKeyId: row.api_key_id,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    bundleIds: row.bundle_ids,
    tenantKey: row.tenant_key ?? 'default',
    workspaceKey: row.workspace_key ?? 'default',
    enabled: row.enabled && row.revoked_at == null,
    clientSeen: lastUsedAt != null,
    lastUsedAt,
    lastTestedAt: iso(row.last_tested_at),
    lastTestState: row.last_test_state,
    lastTestDetail: row.last_test_detail,
    revokedAt: iso(row.revoked_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

const SELECT_CONNECTION = `
  SELECT connection.id, connection.label, connection.user_id,
         users.username, users.display_name, connection.api_key_id,
         keys.key_prefix, keys.key_suffix, connection.bundle_ids,
         connection.tenant_key, connection.workspace_key,
         keys.enabled, keys.last_used_at, connection.last_tested_at,
         connection.last_test_state, connection.last_test_detail,
         connection.revoked_at, connection.created_at, connection.updated_at
    FROM mcp_hermes_dev_connections connection
    JOIN mcp_api_keys keys ON keys.id = connection.api_key_id
    JOIN mcp_users users ON users.id = connection.user_id`;

export function personalHermesConfig(apiKey: string, endpointUrl = 'http://127.0.0.1:3000/mcp/hermes-dev'): Omit<HermesDevConnectionSecret, 'connection'> {
  return {
    apiKey,
    endpointPath: '/mcp/hermes-dev',
    environment: {
      ARGUS_HERMES_DEV_MCP_URL: endpointUrl,
      ARGUS_HERMES_DEV_MCP_KEY: apiKey,
    },
    configYaml: `mcp_servers:\n  argus_dev:\n    url: "\${ARGUS_HERMES_DEV_MCP_URL}"\n    headers:\n      Authorization: "Bearer \${ARGUS_HERMES_DEV_MCP_KEY}"\n    enabled: true\n    timeout: 900\n    connect_timeout: 30\n    supports_parallel_tool_calls: false\n    tools:\n      include:\n${HERMES_DEV_TOOLS.map(tool => `        - ${tool}`).join('\n')}\n      prompts: false\n      resources: false\n    sampling:\n      enabled: false`,
  };
}

export class HermesDevConnectionManager {
  constructor(
    private readonly pool: pg.Pool,
    private readonly bridge?: Pick<HermesDevBridge, 'capabilities' | 'preflight'>,
  ) {}

  private async owner(userId: number, scope: HermesDevWorkspaceScope): Promise<HermesDevConnectionOwner> {
    const result = await this.pool.query<{
      id: number;
      username: string;
      display_name: string;
      role: string;
      allowed_bundles: number[] | null;
      entra_groups: string[];
      enabled: boolean;
    }>(
      `SELECT id, username, display_name, role, allowed_bundles,
              coalesce(entra_groups, ARRAY[]::text[]) AS entra_groups, enabled
         FROM mcp_users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new HermesDevConnectionError(404, 'hermes_connection_owner_missing', 'Your Argus identity was not found');
    if (!row.enabled) throw new HermesDevConnectionError(403, 'hermes_connection_owner_disabled', 'Your Argus identity is disabled');
    if (scope.tenantKey !== 'default' || scope.workspaceKey !== 'default') {
      const membership = await this.pool.query(
        `SELECT 1 FROM mcp_workspace_memberships
          WHERE user_id=$1 AND tenant_key=$2 AND workspace_key=$3`,
        [userId, scope.tenantKey, scope.workspaceKey],
      );
      if (!membership.rows[0]) {
        throw new HermesDevConnectionError(404, 'hermes_connection_workspace_not_found', 'Workspace scope was not found');
      }
    }
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      allowedBundleIds: row.allowed_bundles,
      entraGroups: row.entra_groups ?? [],
    };
  }

  async list(ownerUserId: number, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<HermesDevConnection[]> {
    const result = await this.pool.query<ConnectionRow>(
      `${SELECT_CONNECTION} WHERE connection.user_id = $1
         AND connection.tenant_key=$2 AND connection.workspace_key=$3
       ORDER BY connection.created_at DESC`,
      [ownerUserId, scope.tenantKey, scope.workspaceKey],
    );
    return result.rows.map(mapRow);
  }

  async get(id: number, ownerUserId?: number, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<HermesDevConnection | null> {
    const result = ownerUserId == null
      ? await this.pool.query<ConnectionRow>(`${SELECT_CONNECTION} WHERE connection.id = $1`, [id])
      : await this.pool.query<ConnectionRow>(
        `${SELECT_CONNECTION} WHERE connection.id = $1 AND connection.user_id = $2
           AND connection.tenant_key=$3 AND connection.workspace_key=$4`,
        [id, ownerUserId, scope.tenantKey, scope.workspaceKey],
      );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async catalog(ownerUserId: number, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<HermesDevConnectionCatalog> {
    const owner = await this.owner(ownerUserId, scope);
    const bundleResult = await this.pool.query<{
      id: number;
      name: string;
      label: string;
      tool_count: string | number;
    }>(
      `SELECT available.id, available.name, available.label, available.tool_count
         FROM (
           SELECT bundle.id, bundle.name, bundle.label,
             (
               (SELECT count(*)
                  FROM mcp_tool_bundles assignment
                  JOIN mcp_tools tool ON tool.id = assignment.tool_id
                 WHERE assignment.bundle_id = bundle.id AND tool.enabled = true)
               + (SELECT count(*)
                    FROM mcp_remote_tools remote_tool
                    JOIN mcp_backend_bundles backend_assignment
                      ON backend_assignment.backend_id = remote_tool.backend_id
                    JOIN mcp_backends backend ON backend.id = backend_assignment.backend_id
                    LEFT JOIN mcp_bundle_backend_tool_policies policy
                      ON policy.backend_id = backend_assignment.backend_id
                     AND policy.bundle_id = backend_assignment.bundle_id
                   WHERE backend_assignment.bundle_id = bundle.id
                     AND backend.enabled = true
                     AND (
                       policy.mode IS NULL
                       OR policy.mode = 'all'
                       OR remote_tool.prefixed_name = ANY(policy.allowed_tool_names)
                     ))
             )::int AS tool_count
             FROM mcp_service_bundles bundle
            WHERE $1::int[] IS NULL OR bundle.id = ANY($1::int[])
         ) available
        WHERE available.tool_count > 0
        ORDER BY available.label`,
      [owner.allowedBundleIds],
    );
    return {
      identity: {
        id: owner.id,
        username: owner.username,
        displayName: owner.displayName,
        role: owner.role,
        authentication: /^(entra|oidc):/.test(owner.username) ? 'sso' : 'argus-session',
      },
      connections: await this.list(ownerUserId, scope),
      bundles: bundleResult.rows.map(row => ({
        id: row.id,
        name: row.name,
        label: row.label,
        toolCount: Number(row.tool_count),
      })),
    };
  }

  async create(
    raw: unknown,
    ownerUserId: number,
    endpointUrl?: string,
    scope: HermesDevWorkspaceScope = DEFAULT_SCOPE,
  ): Promise<HermesDevConnectionSecret> {
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw new HermesDevConnectionError(400, 'invalid_hermes_connection', 'Label and at least one Bundle are required');
    const bundleIds = [...new Set(parsed.data.bundleIds)];
    const owner = await this.owner(ownerUserId, scope);
    if (owner.allowedBundleIds != null && bundleIds.some(id => !owner.allowedBundleIds!.includes(id))) {
      throw new HermesDevConnectionError(403, 'hermes_connection_bundle_denied', 'A selected Bundle is not available to your current Argus identity');
    }
    const bundleResult = await this.pool.query<{ id: number }>(
      'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[])',
      [bundleIds],
    );
    if (bundleResult.rows.length !== bundleIds.length) {
      throw new HermesDevConnectionError(400, 'hermes_connection_bundle_invalid', 'Every selected Bundle must exist');
    }

    const fullKey = generateApiKey();
    const prefix = apiKeyPrefix(fullKey);
    const client = await this.pool.connect();
    let connectionId = 0;
    try {
      await client.query('BEGIN');
      const keyResult = await client.query<{ id: number }>(
        `INSERT INTO mcp_api_keys (
           key_prefix, label, allowed_bundles, allowed_tools, denied_tools,
           max_requests_per_minute, scope, enabled, key_hash, key_suffix,
           user_id, acting_as_user_id, metadata, tenant_key, workspace_key
         ) VALUES ($1, $2, $3, $4, $5, 60, 'mcp', true, $6, $7, $8, $8, $9::jsonb, $10, $11)
         RETURNING id`,
        [
          prefix,
          `Hermes Dev · ${parsed.data.label}`,
          bundleIds,
          [HERMES_DEV_TOOL_PATTERN],
          [],
          hashApiKey(fullKey),
          fullKey.slice(-4),
          ownerUserId,
          JSON.stringify({ integration: 'hermes-dev', connectorVersion: 2, delegatedBy: 'authenticated-session' }),
          scope.tenantKey,
          scope.workspaceKey,
        ],
      );
      const ruleResult = await client.query<{ id: number }>(
        `INSERT INTO mcp_user_tool_rules (user_id, tool_pattern, effect, reason, created_by)
         VALUES ($1, $2, 'allow', $3, $4)
         RETURNING id`,
        [ownerUserId, HERMES_DEV_TOOL_PATTERN, `Managed Hermes Dev connector: ${parsed.data.label}`, ownerUserId],
      );
      const connectionResult = await client.query<{ id: number }>(
        `INSERT INTO mcp_hermes_dev_connections (
           label, api_key_id, user_id, user_tool_rule_id, bundle_ids, tenant_key, workspace_key
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [parsed.data.label, keyResult.rows[0]!.id, ownerUserId, ruleResult.rows[0]!.id,
          bundleIds, scope.tenantKey, scope.workspaceKey],
      );
      connectionId = connectionResult.rows[0]!.id;
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    const connection = await this.get(connectionId);
    if (!connection) throw new HermesDevConnectionError(500, 'hermes_connection_reload_failed', 'Hermes connection was created but could not be reloaded');
    return { connection, ...personalHermesConfig(fullKey, endpointUrl) };
  }

  async rotate(id: number, ownerUserId: number, endpointUrl?: string, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<HermesDevConnectionSecret> {
    const connection = await this.get(id, ownerUserId, scope);
    if (!connection) throw new HermesDevConnectionError(404, 'hermes_connection_not_found', 'Hermes connection was not found');
    if (connection.revokedAt) throw new HermesDevConnectionError(409, 'hermes_connection_revoked', 'A revoked Hermes connection cannot be rotated');
    const rotated = await rotateManagedApiKey(this.pool, connection.apiKeyId, undefined, scope);
    if (!rotated) throw new HermesDevConnectionError(404, 'hermes_connection_key_missing', 'Hermes connection credential was not found');
    await this.pool.query('UPDATE mcp_hermes_dev_connections SET updated_at = now() WHERE id = $1', [id]);
    return { connection: (await this.get(id, ownerUserId, scope))!, ...personalHermesConfig(rotated.api_key, endpointUrl) };
  }

  async revoke(id: number, ownerUserId: number, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<HermesDevConnection> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query<{ api_key_id: number; user_tool_rule_id: number | null }>(
        `SELECT api_key_id, user_tool_rule_id FROM mcp_hermes_dev_connections
          WHERE id = $1 AND user_id = $2 AND tenant_key=$3 AND workspace_key=$4
            AND revoked_at IS NULL FOR UPDATE`,
        [id, ownerUserId, scope.tenantKey, scope.workspaceKey],
      );
      if (!owned.rows[0]) throw new HermesDevConnectionError(404, 'hermes_connection_not_found', 'Active Hermes connection was not found');
      await client.query('UPDATE mcp_api_keys SET enabled = false, deleted_at = now() WHERE id = $1', [owned.rows[0].api_key_id]);
      if (owned.rows[0].user_tool_rule_id != null) {
        await client.query('DELETE FROM mcp_user_tool_rules WHERE id = $1', [owned.rows[0].user_tool_rule_id]);
      }
      await client.query(
        `UPDATE mcp_hermes_dev_connections
            SET revoked_at = now(), updated_at = now(), user_tool_rule_id = NULL
          WHERE id = $1`,
        [id],
      );
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw cause;
    } finally {
      client.release();
    }
    return (await this.get(id, ownerUserId, scope))!;
  }

  async test(id: number, ownerUserId: number, scope: HermesDevWorkspaceScope = DEFAULT_SCOPE): Promise<{ connection: HermesDevConnection; coreReady: boolean; clientSeen: boolean; detail: string }> {
    const connection = await this.get(id, ownerUserId, scope);
    if (!connection) throw new HermesDevConnectionError(404, 'hermes_connection_not_found', 'Hermes connection was not found');
    if (connection.revokedAt) throw new HermesDevConnectionError(409, 'hermes_connection_revoked', 'Hermes connection is revoked');
    const caller: HermesDevBridgeCaller = {
      userId: connection.userId,
      apiKeyPrefix: connection.keyPrefix,
      allowedBundleIds: connection.bundleIds,
      tenantKey: connection.tenantKey,
      workspaceKey: connection.workspaceKey,
    };
    let state: 'ready' | 'blocked' | 'failed' = 'ready';
    let detail = 'Argus Dev capabilities and read-only preflight are ready';
    try {
      if (!this.bridge) throw new Error('Hermes Dev bridge is not available');
      await this.bridge.capabilities(caller);
      await this.bridge.preflight(caller);
    } catch (cause) {
      state = 'blocked';
      detail = cause instanceof Error ? cause.message.slice(0, 1_000) : 'Hermes Dev preflight failed';
    }
    await this.pool.query(
      `UPDATE mcp_hermes_dev_connections
          SET last_tested_at = now(), last_test_state = $2, last_test_detail = $3, updated_at = now()
        WHERE id = $1`,
      [id, state, detail],
    );
    const updated = (await this.get(id, ownerUserId, scope))!;
    return { connection: updated, coreReady: state === 'ready', clientSeen: updated.clientSeen, detail };
  }

  /**
   * Re-authorize a long-lived Hermes credential against the current Argus
   * identity and Bundle state. The browser SSO token never leaves Argus; only
   * this server-side delegation is evaluated for each MCP request.
   */
  async resolveCredential(apiKeyPrefix: string): Promise<HermesDevResolvedCredential> {
    const result = await this.pool.query<{
      user_id: number;
      bundle_ids: number[];
      username: string;
      display_name: string;
      role: string;
      allowed_bundles: number[] | null;
      entra_groups: string[];
      tenant_key: string;
      workspace_key: string;
    }>(
      `SELECT connection.user_id, connection.bundle_ids, users.username,
              users.display_name, users.role, users.allowed_bundles,
              coalesce(users.entra_groups, ARRAY[]::text[]) AS entra_groups,
              connection.tenant_key, connection.workspace_key
         FROM mcp_hermes_dev_connections connection
         JOIN mcp_api_keys keys ON keys.id = connection.api_key_id
         JOIN mcp_users users ON users.id = connection.user_id
        WHERE keys.key_prefix = $1 AND keys.enabled = true
          AND keys.deleted_at IS NULL AND connection.revoked_at IS NULL
          AND users.enabled = true
          AND keys.tenant_key=connection.tenant_key
          AND keys.workspace_key=connection.workspace_key
          AND EXISTS (
            SELECT 1 FROM mcp_workspace_memberships membership
             WHERE membership.user_id=connection.user_id
               AND membership.tenant_key=connection.tenant_key
               AND membership.workspace_key=connection.workspace_key
          )`,
      [apiKeyPrefix],
    );
    const row = result.rows[0];
    if (!row) throw new HermesDevConnectionError(403, 'hermes_connection_delegation_inactive', 'Hermes connection or delegated Argus identity is no longer active');
    const available = await this.pool.query<{ id: number }>(
      `SELECT id FROM mcp_service_bundles
        WHERE id = ANY($1::int[])`,
      [row.bundle_ids],
    );
    const currentlyAllowed = row.allowed_bundles == null
      ? new Set(available.rows.map(bundle => bundle.id))
      : new Set(available.rows.map(bundle => bundle.id).filter(id => row.allowed_bundles!.includes(id)));
    const allowedBundleIds = row.bundle_ids.filter(id => currentlyAllowed.has(id));
    if (allowedBundleIds.length === 0) {
      throw new HermesDevConnectionError(403, 'hermes_connection_bundle_scope_revoked', 'No selected Bundle remains available to the delegated Argus identity');
    }
    return {
      caller: {
        userId: row.user_id,
        apiKeyPrefix,
        allowedBundleIds,
        tenantKey: row.tenant_key ?? 'default',
        workspaceKey: row.workspace_key ?? 'default',
      },
      owner: {
        id: row.user_id,
        username: row.username,
        displayName: row.display_name,
        role: row.role,
        allowedBundleIds: row.allowed_bundles,
        entraGroups: row.entra_groups ?? [],
      },
    };
  }
}
