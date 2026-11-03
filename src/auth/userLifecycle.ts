import pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import { normalizeRole, type ArgusRole } from './roles.js';
import { hashPassword, type User } from './userAuth.js';
import {
  loadUserWorkspaceMemberships,
  replaceUserWorkspaceMemberships,
  type WorkspaceMembership,
} from './workspaceMemberships.js';

const DEFAULT_ACCESS_WORKSPACE_KEY = 'default';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export class UserLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
    readonly code = 'USER_LIFECYCLE_INVALID',
  ) {
    super(message);
    this.name = 'UserLifecycleError';
  }
}

export interface ManagedUserUpdate {
  display_name?: string;
  role?: ArgusRole;
  enabled?: boolean;
  allowed_bundles?: number[] | null;
  workspace_scopes?: WorkspaceMembership[];
}

export interface UserLifecycleAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
  workspaceKey?: string;
  tenantKey?: string;
}

export interface AuditedUserLifecycleResult<T> {
  value: T;
  before: User | null;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export function parseAllowedBundleIds(raw: unknown): number[] | null {
  if (raw === null) return null;
  if (!Array.isArray(raw)) {
    throw new UserLifecycleError('allowed_bundles must be an array of bundle IDs or null.');
  }
  if (raw.some(id => !Number.isInteger(id) || Number(id) <= 0)) {
    throw new UserLifecycleError('allowed_bundles contains an invalid bundle ID.');
  }
  return [...new Set(raw as number[])];
}

const WORKSPACE_SCOPE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const MAX_WORKSPACE_MEMBERSHIPS = 32;

export function parseWorkspaceMemberships(raw: unknown): WorkspaceMembership[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_WORKSPACE_MEMBERSHIPS) {
    throw new UserLifecycleError(`workspace_scopes must contain between 1 and ${MAX_WORKSPACE_MEMBERSHIPS} entries.`);
  }
  const memberships: WorkspaceMembership[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new UserLifecycleError('workspace_scopes contains an invalid entry.');
    }
    const source = item as Record<string, unknown>;
    const tenantKey = typeof source['tenant_key'] === 'string' ? source['tenant_key'].trim() : '';
    const workspaceKey = typeof source['workspace_key'] === 'string' ? source['workspace_key'].trim() : '';
    if (!WORKSPACE_SCOPE_KEY.test(tenantKey) || !WORKSPACE_SCOPE_KEY.test(workspaceKey)) {
      throw new UserLifecycleError('workspace_scopes contains an invalid tenant or workspace key.');
    }
    if (typeof source['is_default'] !== 'boolean') {
      throw new UserLifecycleError('workspace_scopes requires an explicit is_default value.');
    }
    const identity = `${tenantKey}\u0000${workspaceKey}`;
    if (seen.has(identity)) throw new UserLifecycleError('workspace_scopes contains a duplicate membership.');
    seen.add(identity);
    memberships.push({ tenant_key: tenantKey, workspace_key: workspaceKey, is_default: source['is_default'] });
  }
  if (memberships.filter(membership => membership.is_default).length !== 1) {
    throw new UserLifecycleError('workspace_scopes must contain exactly one default membership.');
  }
  return memberships.sort((left, right) => Number(right.is_default) - Number(left.is_default)
    || left.tenant_key.localeCompare(right.tenant_key)
    || left.workspace_key.localeCompare(right.workspace_key));
}

type LifecycleUser = Pick<User, 'id' | 'username' | 'role' | 'enabled'>;

function remainsActivePlatformAdmin(user: LifecycleUser, updates: ManagedUserUpdate): boolean {
  return (updates.enabled ?? user.enabled) && normalizeRole(updates.role ?? user.role) === 'platform_admin';
}

async function lockLifecycle(client: pg.PoolClient): Promise<void> {
  // Serialises only role/status/deletion checks, keeping the last-admin invariant race-safe.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('argus-user-lifecycle'))");
}

async function loadTarget(client: pg.PoolClient, id: number): Promise<User> {
  const { rows } = await client.query<User>(
    `SELECT id, username, display_name, role, allowed_bundles, enabled, created_at, last_login
       FROM mcp_users WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw new UserLifecycleError('User not found', 404, 'USER_NOT_FOUND');
  return rows[0];
}

export async function getManagedUser(pool: Queryable, id: number | string): Promise<User> {
  const { rows } = await pool.query<User>(
    `SELECT id, username, display_name, role, allowed_bundles, enabled, created_at, last_login
       FROM mcp_users WHERE id = $1`,
    [id],
  );
  if (!rows[0]) throw new UserLifecycleError('User not found', 404, 'USER_NOT_FOUND');
  return rows[0];
}

async function assertAnotherPlatformAdmin(client: pg.PoolClient, targetId: number): Promise<void> {
  const { rows } = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM mcp_users
      WHERE id <> $1
        AND enabled = true
        AND role IN ('platform_admin', 'admin')`,
    [targetId],
  );
  if ((rows[0]?.count ?? 0) === 0) {
    throw new UserLifecycleError(
      'The last active platform administrator cannot be removed or disabled.',
      409,
      'LAST_PLATFORM_ADMIN',
    );
  }
}

export async function updateManagedUser(
  pool: pg.Pool,
  actorId: number,
  targetId: number,
  updates: ManagedUserUpdate,
): Promise<User> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { value } = await updateManagedUserRecord(client, actorId, targetId, updates);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function updateManagedUserRecord(
  client: pg.PoolClient,
  actorId: number,
  targetId: number,
  updates: ManagedUserUpdate,
): Promise<{
  before: User;
  value: User;
  beforeWorkspaceScopes?: WorkspaceMembership[];
  afterWorkspaceScopes?: WorkspaceMembership[];
}> {
  await lockLifecycle(client);
  const target = await loadTarget(client, targetId);

  if (targetId === actorId && updates.enabled === false) {
    throw new UserLifecycleError('You cannot disable your own account.', 400, 'SELF_DISABLE');
  }
  if (targetId === actorId && updates.role && updates.role !== 'platform_admin') {
    throw new UserLifecycleError('You cannot remove your own platform administrator role.', 400, 'SELF_DEMOTE');
  }
  if (target.enabled && normalizeRole(target.role) === 'platform_admin' && !remainsActivePlatformAdmin(target, updates)) {
    await assertAnotherPlatformAdmin(client, targetId);
  }

  const setClauses: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    setClauses.push(`${column} = $${values.length}`);
  };
  if (updates.display_name !== undefined) add('display_name', updates.display_name);
  if (updates.role !== undefined) add('role', updates.role);
  if (updates.enabled !== undefined) add('enabled', updates.enabled);
  if ('allowed_bundles' in updates) add('allowed_bundles', updates.allowed_bundles ?? null);
  if (setClauses.length === 0 && updates.workspace_scopes === undefined) {
    throw new UserLifecycleError('No user changes supplied.', 400, 'NO_USER_CHANGES');
  }

  let value = target;
  if (setClauses.length > 0) {
    values.push(targetId);
    const { rows } = await client.query<User>(
      `UPDATE mcp_users SET ${setClauses.join(', ')}
        WHERE id = $${values.length}
        RETURNING id, username, display_name, role, allowed_bundles, enabled, created_at, last_login`,
      values,
    );
    if (!rows[0]) throw new UserLifecycleError('User not found', 404, 'USER_NOT_FOUND');
    value = rows[0];
  }
  if (updates.workspace_scopes === undefined) return { before: target, value };
  const beforeWorkspaceScopes = await loadUserWorkspaceMemberships(client, targetId);
  await replaceUserWorkspaceMemberships(client, targetId, updates.workspace_scopes);
  return {
    before: target,
    value,
    beforeWorkspaceScopes,
    afterWorkspaceScopes: updates.workspace_scopes,
  };
}

export async function deleteManagedUser(pool: pg.Pool, actorId: number, targetId: number): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await deleteManagedUserRecord(client, actorId, targetId);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function deleteManagedUserRecord(
  client: pg.PoolClient,
  actorId: number,
  targetId: number,
): Promise<User> {
  await lockLifecycle(client);
  const target = await loadTarget(client, targetId);
  if (actorId === targetId) {
    throw new UserLifecycleError('You cannot delete your own account.', 400, 'SELF_DELETE');
  }
  if (target.enabled && normalizeRole(target.role) === 'platform_admin') {
    await assertAnotherPlatformAdmin(client, targetId);
  }
  const deleted = await client.query('DELETE FROM mcp_users WHERE id = $1', [targetId]);
  if ((deleted.rowCount ?? 0) !== 1) throw new UserLifecycleError('User not found', 404, 'USER_NOT_FOUND');
  return target;
}

export interface ManagedUserCreate {
  username: string;
  password: string;
  displayName: string;
  role: ArgusRole;
  allowedBundles?: number[] | null;
  enabled?: boolean;
  workspaceScopes?: WorkspaceMembership[];
}

export type FirstUserBootstrapCreate = Pick<ManagedUserCreate, 'username' | 'password' | 'displayName'>;

function auditUser(user: User, workspaceScopes?: WorkspaceMembership[]): Record<string, unknown> {
  return {
    label: user.display_name,
    username: user.username,
    role: normalizeRole(user.role),
    enabled: user.enabled,
    allowedBundles: user.allowed_bundles,
    ...(workspaceScopes ? { workspaceScopes } : {}),
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

function userAuditBase(
  context: UserLifecycleAuditContext,
  action: string,
  resourceId: string,
  payload: { before?: unknown; after?: unknown; context?: unknown },
  risk: 'high' | 'critical' = 'high',
) {
  const scope = auditScope(context);
  return {
    ...scope,
    solution: 'argus.core',
    actor: context.actor,
    action,
    outcome: 'success' as const,
    risk,
    resource: { type: 'user', id: resourceId },
    policy: { id: 'argus.access.user-lifecycle', version: '1', decision: 'allow' },
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload,
  };
}

async function insertManagedUserRecord(
  client: pg.PoolClient,
  input: Omit<ManagedUserCreate, 'password'>,
  passwordHash: string,
): Promise<User> {
  const { rows } = await client.query<User>(
    `INSERT INTO mcp_users (username, password_hash, display_name, role, allowed_bundles, enabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, username, display_name, role, allowed_bundles, enabled, created_at, last_login`,
    [
      input.username,
      passwordHash,
      input.displayName,
      input.role,
      input.allowedBundles ?? null,
      input.enabled ?? true,
    ],
  );
  if (!rows[0]) throw new Error('managed user insert returned no row');
  if (input.workspaceScopes) {
    await replaceUserWorkspaceMemberships(client, rows[0].id, input.workspaceScopes);
  }
  return rows[0];
}

export async function createManagedUserAudited(
  pool: pg.Pool,
  input: ManagedUserCreate,
  context: UserLifecycleAuditContext,
): Promise<AuditedUserLifecycleResult<User>> {
  const passwordHash = await hashPassword(input.password);
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.users.create', eventId: context.producerEventId },
    scope,
    client => insertManagedUserRecord(client, {
      username: input.username,
      displayName: input.displayName,
      role: input.role,
      allowedBundles: input.allowedBundles,
      enabled: input.enabled,
      workspaceScopes: input.workspaceScopes,
    }, passwordHash),
    user => userAuditBase(context, 'access.user.created', String(user.id), {
      before: null,
      after: auditUser(user, input.workspaceScopes),
    }),
  );
  const value = outcome.result ?? await getManagedUser(pool, outcome.event.resource.id);
  return { value, before: null, auditEvent: outcome.event, replayed: outcome.replayed };
}

/**
 * Creates the only allowed unauthenticated local account. The table lock closes
 * the check-then-insert race against every other user insert, including SSO
 * auto-provisioning paths that do not know about this helper.
 */
export async function createFirstUserAudited(
  pool: pg.Pool,
  input: FirstUserBootstrapCreate,
  context: UserLifecycleAuditContext,
): Promise<AuditedUserLifecycleResult<User>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.first-user.bootstrap', eventId: context.producerEventId },
    scope,
    async client => {
      // Hash only after the idempotency lookup. A replay must not repeat even
      // the expensive credential derivation step.
      const passwordHash = await hashPassword(input.password);
      await client.query('LOCK TABLE mcp_users IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query<{ exists: boolean }>('SELECT EXISTS (SELECT 1 FROM mcp_users) AS exists');
      if (existing.rows[0]?.exists) {
        throw new UserLifecycleError(
          'Registration is no longer available. Contact a platform administrator.',
          409,
          'FIRST_USER_EXISTS',
        );
      }
      return insertManagedUserRecord(client, {
        username: input.username,
        displayName: input.displayName,
        role: 'platform_admin',
        allowedBundles: null,
        enabled: true,
      }, passwordHash);
    },
    user => ({
      ...userAuditBase(context, 'access.first_user.bootstrapped', String(user.id), {
        before: null,
        after: auditUser(user),
        context: {
          bootstrapMode: 'first_local_platform_admin',
          initiatorTrust: 'unauthenticated_registration',
        },
      }, 'critical'),
      policy: { id: 'argus.access.first-user-bootstrap', version: '1', decision: 'allow' },
    }),
  );
  const value = outcome.result ?? await getManagedUser(pool, outcome.event.resource.id);
  return { value, before: null, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function updateManagedUserAudited(
  pool: pg.Pool,
  actorId: number,
  targetId: number,
  updates: ManagedUserUpdate,
  context: UserLifecycleAuditContext,
): Promise<AuditedUserLifecycleResult<User>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.users.update', eventId: context.producerEventId },
    scope,
    client => updateManagedUserRecord(client, actorId, targetId, updates),
    result => userAuditBase(context, 'access.user.updated', String(result.value.id), {
      before: auditUser(result.before, result.beforeWorkspaceScopes),
      after: auditUser(result.value, result.afterWorkspaceScopes),
      context: { changedFields: Object.keys(updates).sort() },
    }, updates.role !== undefined || updates.enabled !== undefined || updates.workspace_scopes !== undefined ? 'critical' : 'high'),
  );
  const value = outcome.result?.value ?? await getManagedUser(pool, outcome.event.resource.id);
  return {
    value,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function changeManagedUserPasswordAudited(
  pool: pg.Pool,
  targetId: number,
  newPassword: string,
  context: UserLifecycleAuditContext,
): Promise<AuditedUserLifecycleResult<boolean>> {
  const passwordHash = await hashPassword(newPassword);
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.users.password', eventId: context.producerEventId },
    scope,
    async client => {
      const before = await loadTarget(client, targetId);
      const changed = await client.query(
        'UPDATE mcp_users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
        [passwordHash, targetId],
      );
      if ((changed.rowCount ?? 0) !== 1) throw new UserLifecycleError('User not found', 404, 'USER_NOT_FOUND');
      return { before, value: true };
    },
    result => userAuditBase(context, 'access.user.password_changed', String(result.before.id), {
      after: { label: result.before.display_name, passwordChanged: true },
      context: { credentialType: 'password', secretMaterial: 'excluded' },
    }, 'critical'),
  );
  return {
    value: outcome.result?.value ?? true,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function deleteManagedUserAudited(
  pool: pg.Pool,
  actorId: number,
  targetId: number,
  context: UserLifecycleAuditContext,
): Promise<AuditedUserLifecycleResult<boolean>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.users.delete', eventId: context.producerEventId },
    scope,
    async client => ({ before: await deleteManagedUserRecord(client, actorId, targetId), value: true }),
    result => userAuditBase(context, 'access.user.deleted', String(result.before.id), {
      before: auditUser(result.before),
      after: null,
    }, 'critical'),
  );
  return {
    value: outcome.result?.value ?? true,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}
