import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import { apiKeyPrefix } from './apiKeyMiddleware.js';
import { rotateManagedApiKey } from './apiKeyManagement.js';
import { generateApiKey, hashApiKey } from './apiKeyRbac.js';
import type { UserLifecycleAuditContext } from './userLifecycle.js';

const DEFAULT_ACCESS_WORKSPACE_KEY = 'default';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface ManagedApiKey {
  id: number;
  key_prefix: string;
  label: string;
  allowed_bundles: number[] | null;
  allowed_tools: string[] | null;
  denied_tools: string[] | null;
  max_requests_per_minute: number | null;
  scope: 'mcp' | 'agents' | 'both';
  key_suffix: string | null;
  enabled: boolean;
  acting_as_user_id: number | null;
  composite_id: number | null;
  expires_at: string | Date | null;
  last_used_at: string | Date | null;
  rotation_schedule: string | null;
  next_rotation_at: string | Date | null;
  created_at: string | Date;
  tenant_key: string;
  workspace_key: string;
}

export interface ManagedApiKeyCreate {
  label: string;
  allowedBundles?: number[] | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  maxRequestsPerMinute?: number | null;
  scope: 'mcp' | 'agents' | 'both';
  enabled?: boolean;
  actingAsUserId?: number | null;
  expiresAt?: string | null;
}

export interface ManagedApiKeyUpdate {
  label: string;
  allowedBundles?: number[] | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  maxRequestsPerMinute?: number | null;
  scope: 'mcp' | 'agents' | 'both';
  enabled?: boolean;
  expiresAt?: string | null;
}

export interface AuditedApiKeyResult {
  value: ManagedApiKey | null;
  before: ManagedApiKey | null;
  apiKey: string | null;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export class ApiKeyLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code = 'API_KEY_LIFECYCLE_INVALID',
  ) {
    super(message);
    this.name = 'ApiKeyLifecycleError';
  }
}

const API_KEY_PROJECTION = `id, key_prefix, label, allowed_bundles, allowed_tools, denied_tools,
  max_requests_per_minute, scope, key_suffix, enabled, acting_as_user_id,
  composite_id, expires_at, last_used_at, rotation_schedule, next_rotation_at, created_at,
  tenant_key, workspace_key`;

function iso(value: string | Date | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}

function auditKey(key: ManagedApiKey): Record<string, unknown> {
  return {
    label: key.label,
    keyPrefix: key.key_prefix,
    keySuffix: key.key_suffix,
    scope: key.scope,
    enabled: key.enabled,
    actingAsUserId: key.acting_as_user_id,
    compositeId: key.composite_id,
    allowedBundles: key.allowed_bundles,
    allowedTools: key.allowed_tools,
    deniedTools: key.denied_tools,
    maxRequestsPerMinute: key.max_requests_per_minute,
    expiresAt: iso(key.expires_at),
    rotationSchedule: key.rotation_schedule,
    nextRotationAt: iso(key.next_rotation_at),
    tenantKey: key.tenant_key,
    workspaceKey: key.workspace_key,
  };
}

function auditScope(context: UserLifecycleAuditContext) {
  const workspaceKey = context.workspaceKey ?? DEFAULT_ACCESS_WORKSPACE_KEY;
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

function keyScope(context: UserLifecycleAuditContext): { tenantKey: string; workspaceKey: string } {
  const workspaceKey = context.workspaceKey ?? DEFAULT_ACCESS_WORKSPACE_KEY;
  return { tenantKey: context.tenantKey ?? workspaceKey, workspaceKey };
}

function apiKeyAuditBase(
  context: UserLifecycleAuditContext,
  action: string,
  resourceId: string,
  payload: { before?: unknown; after?: unknown; context?: unknown },
) {
  return {
    ...auditScope(context),
    solution: 'argus.core',
    actor: context.actor,
    action,
    outcome: 'success' as const,
    risk: 'critical' as const,
    resource: { type: 'api_key', id: resourceId },
    policy: { id: 'argus.access.api-key-lifecycle', version: '1', decision: 'allow' },
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload,
  };
}

async function loadApiKey(
  client: Queryable,
  id: number | string,
  scope: { tenantKey: string; workspaceKey: string },
  lock = false,
): Promise<ManagedApiKey> {
  const result = await client.query<ManagedApiKey>(
    `SELECT ${API_KEY_PROJECTION} FROM mcp_api_keys
      WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3
        AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
    [id, scope.tenantKey, scope.workspaceKey],
  );
  if (!result.rows[0]) throw new ApiKeyLifecycleError('API key not found', 404, 'API_KEY_NOT_FOUND');
  return result.rows[0];
}

export async function getManagedApiKey(
  pool: Queryable,
  id: number | string,
  scope: { tenantKey: string; workspaceKey: string },
): Promise<ManagedApiKey> {
  return loadApiKey(pool, id, scope);
}

async function createApiKeyRecord(
  client: pg.PoolClient,
  input: ManagedApiKeyCreate,
  createKey: () => string,
  scope: { tenantKey: string; workspaceKey: string },
): Promise<{ value: ManagedApiKey; apiKey: string }> {
  const fullKey = createKey();
  const prefix = apiKeyPrefix(fullKey);
  const result = await client.query<ManagedApiKey>(
    `INSERT INTO mcp_api_keys
       (key_prefix, label, allowed_bundles, allowed_tools, denied_tools,
        max_requests_per_minute, scope, enabled, key_hash, key_suffix,
        acting_as_user_id, expires_at, tenant_key, workspace_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING ${API_KEY_PROJECTION}`,
    [
      prefix,
      input.label,
      input.allowedBundles ?? null,
      input.allowedTools ?? null,
      input.deniedTools ?? null,
      input.maxRequestsPerMinute ?? null,
      input.scope,
      input.enabled ?? true,
      hashApiKey(fullKey),
      fullKey.slice(-4),
      input.actingAsUserId ?? null,
      input.expiresAt ?? null,
      scope.tenantKey,
      scope.workspaceKey,
    ],
  );
  if (!result.rows[0]) throw new Error('managed API key insert returned no row');
  return { value: result.rows[0], apiKey: fullKey };
}

async function updateApiKeyRecord(
  client: pg.PoolClient,
  id: number | string,
  input: ManagedApiKeyUpdate,
  scope: { tenantKey: string; workspaceKey: string },
): Promise<{ before: ManagedApiKey; value: ManagedApiKey }> {
  const before = await loadApiKey(client, id, scope, true);
  const result = await client.query<ManagedApiKey>(
    `UPDATE mcp_api_keys
        SET label=$1, allowed_bundles=$2, allowed_tools=$3, denied_tools=$4,
            max_requests_per_minute=$5, scope=$6, enabled=$7, expires_at=$8
      WHERE id=$9 AND tenant_key=$10 AND workspace_key=$11 AND deleted_at IS NULL
      RETURNING ${API_KEY_PROJECTION}`,
    [
      input.label,
      input.allowedBundles ?? null,
      input.allowedTools ?? null,
      input.deniedTools ?? null,
      input.maxRequestsPerMinute ?? null,
      input.scope,
      input.enabled ?? true,
      input.expiresAt ?? null,
      id,
      scope.tenantKey,
      scope.workspaceKey,
    ],
  );
  if (!result.rows[0]) throw new ApiKeyLifecycleError('API key not found', 404, 'API_KEY_NOT_FOUND');
  return { before, value: result.rows[0] };
}

async function deleteApiKeyRecord(
  client: pg.PoolClient,
  id: number | string,
  scope: { tenantKey: string; workspaceKey: string },
): Promise<ManagedApiKey> {
  const before = await loadApiKey(client, id, scope, true);
  const result = await client.query(
    'DELETE FROM mcp_api_keys WHERE id=$1 AND tenant_key=$2 AND workspace_key=$3',
    [id, scope.tenantKey, scope.workspaceKey],
  );
  if ((result.rowCount ?? 0) !== 1) throw new ApiKeyLifecycleError('API key not found', 404, 'API_KEY_NOT_FOUND');
  return before;
}

export async function createManagedApiKeyAudited(
  pool: pg.Pool,
  input: ManagedApiKeyCreate,
  context: UserLifecycleAuditContext,
  createKey: () => string = generateApiKey,
): Promise<AuditedApiKeyResult> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.api-keys.create', eventId: context.producerEventId },
    auditScope(context),
    client => createApiKeyRecord(client, input, createKey, keyScope(context)),
    result => apiKeyAuditBase(context, 'access.api_key.created', String(result.value.id), {
      before: null,
      after: auditKey(result.value),
      context: { plaintextHandling: 'returned_once_and_excluded' },
    }),
  );
  return {
    value: outcome.result?.value ?? null,
    before: null,
    apiKey: outcome.result?.apiKey ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function updateManagedApiKeyAudited(
  pool: pg.Pool,
  id: number | string,
  input: ManagedApiKeyUpdate,
  context: UserLifecycleAuditContext,
): Promise<AuditedApiKeyResult> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.api-keys.update', eventId: context.producerEventId },
    auditScope(context),
    client => updateApiKeyRecord(client, id, input, keyScope(context)),
    result => apiKeyAuditBase(context, 'access.api_key.updated', String(result.value.id), {
      before: auditKey(result.before),
      after: auditKey(result.value),
    }),
  );
  const value = outcome.result?.value ?? await getManagedApiKey(pool, outcome.event.resource.id, keyScope(context));
  return {
    value,
    before: outcome.result?.before ?? null,
    apiKey: null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function rotateManagedApiKeyAudited(
  pool: pg.Pool,
  id: number | string,
  context: UserLifecycleAuditContext,
  createKey: () => string = generateApiKey,
): Promise<AuditedApiKeyResult> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.api-keys.rotate', eventId: context.producerEventId },
    auditScope(context),
    async client => {
      const scope = keyScope(context);
      const before = await loadApiKey(client, id, scope, true);
      const rotated = await rotateManagedApiKey(client, id, createKey, scope);
      if (!rotated) throw new ApiKeyLifecycleError('API key not found', 404, 'API_KEY_NOT_FOUND');
      const value = await loadApiKey(client, id, scope);
      return { before, value, apiKey: rotated.api_key };
    },
    result => apiKeyAuditBase(context, 'access.api_key.rotated', String(result.value.id), {
      before: auditKey(result.before),
      after: auditKey(result.value),
      context: { plaintextHandling: 'returned_once_and_excluded' },
    }),
  );
  return {
    value: outcome.result?.value ?? null,
    before: outcome.result?.before ?? null,
    apiKey: outcome.result?.apiKey ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function deleteManagedApiKeyAudited(
  pool: pg.Pool,
  id: number | string,
  context: UserLifecycleAuditContext,
): Promise<AuditedApiKeyResult> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.api-keys.delete', eventId: context.producerEventId },
    auditScope(context),
    client => deleteApiKeyRecord(client, id, keyScope(context)),
    before => apiKeyAuditBase(context, 'access.api_key.deleted', String(before.id), {
      before: auditKey(before),
      after: null,
    }),
  );
  return {
    value: null,
    before: outcome.result ?? null,
    apiKey: null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}
