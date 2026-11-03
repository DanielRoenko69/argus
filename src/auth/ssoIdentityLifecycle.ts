import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import type { SsoRoleMappingResult } from './ssoRoleMapping.js';
import type { User } from './userAuth.js';

const DEFAULT_ACCESS_WORKSPACE_KEY = 'default';

export interface SsoIdentityUser extends User {
  entra_groups: string[];
}

export interface VerifiedSsoIdentity {
  username: string;
  displayName: string;
  groups: readonly string[];
  provider: string;
  mapping: SsoRoleMappingResult;
}

export interface SsoIdentityAuditContext {
  producerEventId: string;
  environment: string;
  requestId?: string | null;
  workspaceKey?: string;
  tenantKey?: string;
}

export interface SsoIdentitySyncResult {
  value: SsoIdentityUser;
  before: SsoIdentityUser | null;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export class SsoIdentityLifecycleError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
    readonly code = 'SSO_IDENTITY_INVALID',
  ) {
    super(message);
    this.name = 'SsoIdentityLifecycleError';
  }
}

async function linkSsoIdentityRecord(
  client: pg.PoolClient,
  targetUserId: number,
  identity: VerifiedSsoIdentity,
): Promise<SsoMutationResult> {
  const groups = normalizedGroups(identity.groups);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`argus-sso-link-user:${targetUserId}`]);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`argus-sso-identity:${identity.username}`]);
  const target = await client.query<SsoIdentityUser>(
    `SELECT ${SSO_USER_PROJECTION} FROM mcp_users WHERE id=$1 FOR UPDATE`,
    [targetUserId],
  );
  const before = target.rows[0]
    ? { ...target.rows[0], entra_groups: target.rows[0].entra_groups ?? [] }
    : null;
  if (!before) throw new SsoIdentityLifecycleError('The local account no longer exists.');
  if (!before.enabled) {
    throw new SsoIdentityLifecycleError('The local account is disabled.', 403, 'SSO_ACCOUNT_DISABLED');
  }

  const conflict = await client.query<{ id: number | string }>(
    'SELECT id FROM mcp_users WHERE username=$1 AND id<>$2 FOR UPDATE',
    [identity.username, targetUserId],
  );
  if (conflict.rows.length > 0) {
    throw new SsoIdentityLifecycleError(
      'This SSO identity already belongs to another Argus account.',
      409,
      'SSO_IDENTITY_CONFLICT',
    );
  }

  const result = await client.query<SsoIdentityUser>(
    `UPDATE mcp_users
        SET username=$1,
            password_hash='oidc-sso:no-password',
            role=$2,
            entra_groups=$3,
            last_login=now(),
            failed_attempts=0,
            locked_until=NULL
      WHERE id=$4
      RETURNING ${SSO_USER_PROJECTION}`,
    [identity.username, identity.mapping.effectiveRole, groups, targetUserId],
  );
  if (!result.rows[0]) throw new SsoIdentityLifecycleError('The local account no longer exists.');
  return { before, value: { ...result.rows[0], entra_groups: result.rows[0].entra_groups ?? [] } };
}

/**
 * Converts an authenticated local account into the verified SSO identity while
 * retaining its stable user id, workspace memberships, Bundle scope and owned
 * resources. The local password is intentionally invalidated by the same
 * transaction so the linked account cannot bypass provider MFA afterwards.
 */
export async function linkSsoIdentityAudited(
  pool: pg.Pool,
  targetUserId: number,
  identity: VerifiedSsoIdentity,
  context: SsoIdentityAuditContext,
): Promise<SsoIdentitySyncResult> {
  if (!Number.isSafeInteger(targetUserId) || targetUserId < 1) {
    throw new SsoIdentityLifecycleError('A valid local user is required for SSO linking.');
  }
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.sso-identity.link', eventId: context.producerEventId },
    scope,
    client => linkSsoIdentityRecord(client, targetUserId, identity),
    result => ({
      ...scope,
      solution: 'argus.core',
      actor: {
        type: 'human' as const,
        id: String(result.value.id),
        ssoSubject: identity.username,
        authMethod: 'oidc',
        effectiveRoles: [identity.mapping.effectiveRole],
      },
      action: 'access.sso_identity.linked',
      outcome: 'success' as const,
      risk: 'critical' as const,
      resource: { type: 'user', id: String(result.value.id) },
      policy: {
        id: 'argus.access.sso-account-link',
        version: '1',
        decision: 'verified_mfa_link',
      },
      correlation: { requestId: context.requestId ?? context.producerEventId },
      payload: {
        before: auditIdentity(result.before!),
        after: auditIdentity(result.value),
        context: {
          provider: identity.provider,
          identitySource: 'verified_oidc_claims',
          localPassword: 'invalidated',
          mapping: mappingEvidence(identity.mapping),
          rawClaims: 'excluded',
        },
      },
    }),
  );
  const value = outcome.result?.value ?? await loadSsoUser(pool, outcome.event.resource.id);
  return {
    value,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

type SsoMutationResult = {
  before: SsoIdentityUser | null;
  value: SsoIdentityUser;
};

const SSO_USER_PROJECTION = `id, username, display_name, role, allowed_bundles, enabled,
  created_at, last_login, entra_groups`;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedGroups(groups: readonly string[]): string[] {
  return [...new Set(groups.filter(group => typeof group === 'string' && group.length > 0))].sort();
}

export function ssoGroupSnapshot(groups: readonly string[]): { count: number; digest: string } {
  const normalized = normalizedGroups(groups);
  return { count: normalized.length, digest: sha256(JSON.stringify(normalized)) };
}

/**
 * Derives a stable producer key from the signed OIDC state without retaining
 * the state, nonce or authorization code in evidence.
 */
export function buildSsoIdentityAuditContext(
  signedState: string,
  options: Omit<SsoIdentityAuditContext, 'producerEventId'>,
): SsoIdentityAuditContext {
  if (!signedState) throw new SsoIdentityLifecycleError('OIDC state is required');
  const producerEventId = `oidc-callback:${sha256(signedState)}`;
  return {
    ...options,
    producerEventId,
    requestId: options.requestId ?? producerEventId,
  };
}

function auditScope(context: SsoIdentityAuditContext) {
  const workspaceKey = context.workspaceKey ?? DEFAULT_ACCESS_WORKSPACE_KEY;
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

function auditIdentity(user: SsoIdentityUser): Record<string, unknown> {
  return {
    role: user.role,
    enabled: user.enabled,
    groupSnapshot: ssoGroupSnapshot(user.entra_groups ?? []),
  };
}

function mappingEvidence(mapping: SsoRoleMappingResult): Record<string, unknown> {
  return {
    decision: mapping.usedDefault ? 'default' : 'mapped',
    effectiveRole: mapping.effectiveRole,
    matchedMappings: mapping.matched
      .map(match => ({ groupDigest: sha256(match.group), role: match.role }))
      .sort((left, right) => left.groupDigest.localeCompare(right.groupDigest)),
  };
}

async function loadSsoUser(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  id: number | string,
): Promise<SsoIdentityUser> {
  const result = await queryable.query<SsoIdentityUser>(
    `SELECT ${SSO_USER_PROJECTION} FROM mcp_users WHERE id=$1`,
    [id],
  );
  if (!result.rows[0]) throw new SsoIdentityLifecycleError('SSO user not found');
  return { ...result.rows[0], entra_groups: result.rows[0].entra_groups ?? [] };
}

async function syncSsoIdentityRecord(
  client: pg.PoolClient,
  identity: VerifiedSsoIdentity,
): Promise<SsoMutationResult> {
  const groups = normalizedGroups(identity.groups);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`argus-sso-identity:${identity.username}`]);
  const existing = await client.query<SsoIdentityUser>(
    `SELECT ${SSO_USER_PROJECTION} FROM mcp_users WHERE username=$1 FOR UPDATE`,
    [identity.username],
  );
  const before = existing.rows[0]
    ? { ...existing.rows[0], entra_groups: existing.rows[0].entra_groups ?? [] }
    : null;
  if (before && !before.enabled) {
    throw new SsoIdentityLifecycleError(
      'The SSO account is disabled.',
      403,
      'SSO_ACCOUNT_DISABLED',
    );
  }

  const result = before
    ? await client.query<SsoIdentityUser>(
      `UPDATE mcp_users
          SET display_name=$1, role=$2, entra_groups=$3, last_login=now()
        WHERE id=$4
        RETURNING ${SSO_USER_PROJECTION}`,
      [identity.displayName, identity.mapping.effectiveRole, groups, before.id],
    )
    : await client.query<SsoIdentityUser>(
      `INSERT INTO mcp_users
         (username, password_hash, display_name, role, entra_groups, enabled, last_login)
       VALUES ($1, $2, $3, $4, $5, true, now())
       RETURNING ${SSO_USER_PROJECTION}`,
      [identity.username, 'oidc-sso:no-password', identity.displayName, identity.mapping.effectiveRole, groups],
    );
  if (!result.rows[0]) throw new Error('SSO identity synchronization returned no user');
  return { before, value: { ...result.rows[0], entra_groups: result.rows[0].entra_groups ?? [] } };
}

/**
 * Atomically persists the verified OIDC identity projection and its canonical
 * evidence. Group-to-role rules remain deployment configuration; this event
 * freezes the effective decision that was actually applied at login time.
 */
export async function syncSsoIdentityAudited(
  pool: pg.Pool,
  identity: VerifiedSsoIdentity,
  context: SsoIdentityAuditContext,
): Promise<SsoIdentitySyncResult> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.sso-identity.sync', eventId: context.producerEventId },
    scope,
    client => syncSsoIdentityRecord(client, identity),
    result => ({
      ...scope,
      solution: 'argus.core',
      actor: {
        type: 'human' as const,
        id: String(result.value.id),
        ssoSubject: result.value.username,
        authMethod: 'oidc',
        effectiveRoles: [identity.mapping.effectiveRole],
      },
      action: result.before ? 'access.sso_identity.synchronized' : 'access.sso_identity.provisioned',
      outcome: 'success' as const,
      risk: 'critical' as const,
      resource: { type: 'user', id: String(result.value.id) },
      policy: {
        id: 'argus.access.sso-role-mapping',
        version: '1',
        decision: identity.mapping.usedDefault ? 'default' : 'mapped',
      },
      correlation: { requestId: context.requestId ?? context.producerEventId },
      payload: {
        before: result.before ? auditIdentity(result.before) : null,
        after: auditIdentity(result.value),
        context: {
          provider: identity.provider,
          identitySource: 'verified_oidc_claims',
          mapping: mappingEvidence(identity.mapping),
          rawClaims: 'excluded',
        },
      },
    }),
  );
  const value = outcome.result?.value ?? await loadSsoUser(pool, outcome.event.resource.id);
  return {
    value,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}
