import { randomBytes, scrypt, timingSafeEqual, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { logger } from '../lib/logger.js';
import type { WorkspaceMembership } from './workspaceMemberships.js';

const scryptAsync = promisify(scrypt);
const KEY_LENGTH = 64;

export interface User {
  id: number;
  username: string;
  display_name: string;
  role: string; // ArgusRole — see src/auth/roles.ts
  allowed_bundles: number[] | null;
  enabled: boolean;
  created_at: string;
  last_login: string | null;
  workspace_scopes?: WorkspaceMembership[];
  last_auth_method?: 'local' | 'oidc' | null;
  last_mfa_verified_at?: string | null;
  last_mfa_method?: string | null;
}

export interface SessionWorkspaceScope {
  tenantKey: string;
  workspaceKey: string;
  isDefault: boolean;
}

export interface SessionUser {
  id: number;
  username: string;
  display_name: string;
  role: string; // ArgusRole — see src/auth/roles.ts
  allowed_bundles: number[] | null;
  entra_groups: string[];
  /** Optional for backward-compatible callers; persisted sessions always set it. */
  auth_method?: 'local' | 'oidc';
  mfa_verified_at?: string | null;
  mfa_method?: string | null;
  /** Server-authorized scopes loaded with the session; never supplied by the browser. */
  workspace_scopes?: SessionWorkspaceScope[];
}

export interface SessionAuthAssurance {
  authMethod: 'local' | 'oidc';
  mfaVerifiedAt?: string | null;
  mfaMethod?: string | null;
}

// ── Password strength validation ──────────────────────────
// M2: Enforce meaningful password requirements for admin access.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyui',
  'admin123', 'admin1234', 'letmein1', 'welcome1', 'monkey123',
  'iloveyou', 'sunshine', 'princess', 'football', 'superman',
]);

/**
 * Validates password strength. Returns an error message string on failure, null on success.
 * Requirements: 10+ chars, uppercase, lowercase, digit, not a common password.
 */
export function validatePasswordStrength(password: string, username?: string): string | null {
  if (password.length < 10) return 'Passwort muss mindestens 10 Zeichen lang sein.';
  if (!/[A-Z]/.test(password)) return 'Passwort muss mindestens einen Großbuchstaben enthalten.';
  if (!/[a-z]/.test(password)) return 'Passwort muss mindestens einen Kleinbuchstaben enthalten.';
  if (!/[0-9]/.test(password)) return 'Passwort muss mindestens eine Zahl enthalten.';
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'Passwort ist zu häufig verwendet. Bitte wähle ein sichereres Passwort.';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Passwort darf den Benutzernamen nicht enthalten.';
  return null;
}

// ── Password hashing (scrypt) ──────────────────────────────

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
  return `${salt}:${derivedKey.toString('hex')}`;
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  const [salt, key] = hash.split(':');
  if (!salt || !key) return false;
  const derivedKey = (await scryptAsync(plain, salt, KEY_LENGTH)) as Buffer;
  const keyBuffer = Buffer.from(key, 'hex');
  if (derivedKey.length !== keyBuffer.length) return false;
  return timingSafeEqual(derivedKey, keyBuffer);
}

// ── Session management ─────────────────────────────────────

export async function createSession(
  pool: pg.Pool,
  userId: number,
  maxAgeHours: number,
  ip?: string,
  userAgent?: string,
  assurance: SessionAuthAssurance = { authMethod: 'local' },
): Promise<string> {
  const mfaVerifiedAt = assurance.mfaVerifiedAt ?? null;
  const mfaMethod = assurance.mfaMethod?.trim() || null;
  if ((mfaVerifiedAt == null) !== (mfaMethod == null)) {
    throw new Error('Session MFA assurance requires both mfaVerifiedAt and mfaMethod');
  }
  if (assurance.authMethod !== 'oidc' && mfaVerifiedAt != null) {
    throw new Error('Only OIDC sessions may carry MFA assurance');
  }
  if (mfaVerifiedAt != null && !Number.isFinite(new Date(mfaVerifiedAt).getTime())) {
    throw new Error('Session mfaVerifiedAt is invalid');
  }
  const sessionId = randomUUID();
  await pool.query(
    `INSERT INTO mcp_sessions
       (id, user_id, expires_at, ip_address, user_agent, auth_method, mfa_verified_at, mfa_method)
     VALUES ($1, $2, now() + interval '1 hour' * $3, $4, $5, $6, $7, $8)`,
    [
      sessionId, userId, maxAgeHours, ip ?? null, userAgent ?? null,
      assurance.authMethod, mfaVerifiedAt, mfaMethod,
    ],
  );
  return sessionId;
}

export async function getSession(pool: pg.Pool, sessionId: string): Promise<SessionUser | null> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.allowed_bundles, u.entra_groups,
            s.auth_method, s.mfa_verified_at, s.mfa_method,
            COALESCE(scopes.workspace_scopes, '[]'::jsonb) AS workspace_scopes
     FROM mcp_sessions s
     JOIN mcp_users u ON u.id = s.user_id
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object(
         'tenantKey', membership.tenant_key,
         'workspaceKey', membership.workspace_key,
         'isDefault', membership.is_default
       ) ORDER BY membership.is_default DESC, membership.tenant_key, membership.workspace_key) AS workspace_scopes
       FROM mcp_workspace_memberships membership
       WHERE membership.user_id=u.id
     ) scopes ON TRUE
     WHERE s.id = $1 AND s.expires_at > now() AND u.enabled = true`,
    [sessionId],
  );
  if (!rows[0]) return null;
  return {
    ...rows[0],
    entra_groups: rows[0].entra_groups ?? [],
    auth_method: rows[0].auth_method === 'oidc' ? 'oidc' : 'local',
    mfa_verified_at: rows[0].mfa_verified_at
      ? new Date(rows[0].mfa_verified_at).toISOString()
      : null,
    mfa_method: typeof rows[0].mfa_method === 'string' ? rows[0].mfa_method : null,
    workspace_scopes: Array.isArray(rows[0].workspace_scopes) ? rows[0].workspace_scopes : [],
  };
}

/** Fail-closed freshness check for sensitive operations. */
export function hasFreshMfaSession(
  user: Pick<SessionUser, 'auth_method' | 'mfa_verified_at' | 'mfa_method'>,
  maxAgeSeconds: number,
  now = new Date(),
): boolean {
  if (user.auth_method !== 'oidc' || !user.mfa_verified_at || !user.mfa_method) return false;
  const verifiedAt = new Date(user.mfa_verified_at).getTime();
  const current = now.getTime();
  if (!Number.isFinite(verifiedAt) || !Number.isFinite(current)) return false;
  const ageMs = current - verifiedAt;
  return ageMs >= -60_000 && ageMs <= Math.max(0, maxAgeSeconds) * 1_000;
}

export async function deleteSession(pool: pg.Pool, sessionId: string): Promise<void> {
  await pool.query('DELETE FROM mcp_sessions WHERE id = $1', [sessionId]);
}

export async function cleanupExpiredSessions(pool: pg.Pool): Promise<void> {
  // Batch DELETE to avoid long table-locks when many sessions have expired.
  // Postgres-specific: subquery with LIMIT to delete at most N rows per round.
  const BATCH_SIZE = 1000;
  const MAX_BATCHES = 50;  // hard cap: 50_000 rows per cleanup run
  try {
    let totalDeleted = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const { rowCount } = await pool.query(
        `DELETE FROM mcp_sessions
         WHERE id IN (
           SELECT id FROM mcp_sessions WHERE expires_at < now() LIMIT $1
         )`,
        [BATCH_SIZE],
      );
      if (!rowCount) break;
      totalDeleted += rowCount;
      if (rowCount < BATCH_SIZE) break;
    }
    if (totalDeleted > 0) {
      logger.info({ deleted: totalDeleted }, 'Cleaned up expired sessions');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to cleanup expired sessions');
  }
}

// ── User management ────────────────────────────────────────

export async function isFirstUser(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM mcp_users');
  return rows[0].count === 0;
}

export async function createUser(
  pool: pg.Pool,
  username: string,
  password: string,
  displayName: string,
  role: string, // ArgusRole — platform_admin|operations_admin|developer|agent_operator|viewer
  allowedBundles?: number[] | null,
  enabled = true,
): Promise<User> {
  const passwordHash = await hashPassword(password);
  const { rows } = await pool.query(
    `INSERT INTO mcp_users (username, password_hash, display_name, role, allowed_bundles, enabled)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, username, display_name, role, allowed_bundles, enabled, created_at, last_login`,
    [username, passwordHash, displayName, role, allowedBundles ?? null, enabled],
  );
  return rows[0];
}

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_MINUTES = 15;

export async function authenticateUser(
  pool: pg.Pool,
  username: string,
  password: string,
): Promise<User | null> {
  const { rows } = await pool.query(
    'SELECT * FROM mcp_users WHERE username = $1 AND enabled = true',
    [username],
  );
  if (rows.length === 0) return null;

  const user = rows[0];

  // M2: check account lockout
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    logger.warn({ username }, 'Login blocked — account locked due to too many failed attempts');
    return null;
  }

  const valid = await verifyPassword(password, user.password_hash);

  if (!valid) {
    // Increment failed attempts; lock account after threshold
    const newAttempts = (user.failed_attempts ?? 0) + 1;
    if (newAttempts >= MAX_FAILED_ATTEMPTS) {
      // Use parameterized interval instead of template-literal interpolation.
      // Pattern: `interval '1 minute' * $N` keeps the SQL static and the duration safely bound.
      await pool.query(
        `UPDATE mcp_users SET failed_attempts = $1, locked_until = now() + interval '1 minute' * $3 WHERE id = $2`,
        [newAttempts, user.id, LOCKOUT_MINUTES],
      );
      logger.warn({ userId: user.id, attempts: newAttempts }, `Account locked for ${LOCKOUT_MINUTES} minutes after repeated failed logins`);
    } else {
      await pool.query('UPDATE mcp_users SET failed_attempts = $1 WHERE id = $2', [newAttempts, user.id]);
    }
    return null;
  }

  // Successful login: reset failed attempts + lockout
  await pool.query(
    'UPDATE mcp_users SET last_login = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1',
    [user.id],
  );

  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    allowed_bundles: user.allowed_bundles ?? null,
    enabled: user.enabled,
    created_at: user.created_at,
    last_login: new Date().toISOString(),
  };
}

export async function listUsers(pool: pg.Pool): Promise<User[]> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.display_name, u.role, u.allowed_bundles, u.enabled, u.created_at, u.last_login,
            COALESCE(scopes.workspace_scopes, '[]'::jsonb) AS workspace_scopes,
            recent_session.auth_method AS last_auth_method,
            recent_session.mfa_verified_at AS last_mfa_verified_at,
            recent_session.mfa_method AS last_mfa_method
       FROM mcp_users u
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(jsonb_build_object(
           'tenant_key', membership.tenant_key,
           'workspace_key', membership.workspace_key,
           'is_default', membership.is_default
         ) ORDER BY membership.is_default DESC, membership.tenant_key, membership.workspace_key) AS workspace_scopes
         FROM mcp_workspace_memberships membership
         WHERE membership.user_id=u.id
       ) scopes ON TRUE
       LEFT JOIN LATERAL (
         SELECT session.auth_method, session.mfa_verified_at, session.mfa_method
           FROM mcp_sessions session
          WHERE session.user_id=u.id
          ORDER BY session.created_at DESC
          LIMIT 1
       ) recent_session ON TRUE
      ORDER BY u.created_at`,
  );
  return rows;
}

export async function updateUser(
  pool: pg.Pool,
  id: number,
  updates: { display_name?: string; role?: string; enabled?: boolean; allowed_bundles?: number[] | null },
): Promise<User | null> {
  // Build SET clauses dynamically — allowed_bundles needs special handling
  // because NULL means "unrestricted" (not "unchanged").
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (updates.display_name !== undefined) {
    setClauses.push(`display_name = $${idx++}`);
    values.push(updates.display_name);
  }
  if (updates.role !== undefined) {
    setClauses.push(`role = $${idx++}`);
    values.push(updates.role);
  }
  if (updates.enabled !== undefined) {
    setClauses.push(`enabled = $${idx++}`);
    values.push(updates.enabled);
  }
  if ('allowed_bundles' in updates) {
    setClauses.push(`allowed_bundles = $${idx++}`);
    values.push(updates.allowed_bundles ?? null);
  }

  if (setClauses.length === 0) return null;

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE mcp_users SET ${setClauses.join(', ')}
     WHERE id = $${idx}
     RETURNING id, username, display_name, role, allowed_bundles, enabled, created_at, last_login`,
    values,
  );
  return rows[0] ?? null;
}

export async function changePassword(pool: pg.Pool, id: number, newPassword: string): Promise<boolean> {
  const passwordHash = await hashPassword(newPassword);
  const { rowCount } = await pool.query(
    'UPDATE mcp_users SET password_hash = $1, password_changed_at = now() WHERE id = $2',
    [passwordHash, id],
  );
  return (rowCount ?? 0) > 0;
}

export interface PasswordAgeInfo {
  changed_at: string | null;
  age_days: number | null;
  expires_in_days: number | null;
  expired: boolean;
}

/** Get password age info for a user. Returns null if user not found. */
export async function getPasswordAge(
  pool: pg.Pool,
  userId: number,
  maxAgeDays: number,
): Promise<PasswordAgeInfo | null> {
  const { rows } = await pool.query<{ password_changed_at: string | null }>(
    'SELECT password_changed_at FROM mcp_users WHERE id = $1',
    [userId],
  );
  if (rows.length === 0) return null;
  const changed = rows[0].password_changed_at;
  if (!changed) return { changed_at: null, age_days: null, expires_in_days: null, expired: false };
  const ageMs = Date.now() - new Date(changed).getTime();
  const ageDays = Math.floor(ageMs / 86_400_000);
  const expiresInDays = maxAgeDays - ageDays;
  return {
    changed_at: changed,
    age_days: ageDays,
    expires_in_days: expiresInDays,
    expired: expiresInDays < 0,
  };
}

export async function deleteUser(pool: pg.Pool, id: number): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM mcp_users WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}
