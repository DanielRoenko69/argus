import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { logger } from '../lib/logger.js';

// ── Types ────────────────────────────────────────────────────

export interface ApiKeyRbacEntry {
  key_prefix: string;
  label: string;
  allowed_bundles: number[] | null;
  allowed_tools: string[] | null;   // whitelist patterns (SQL LIKE), null = all allowed
  denied_tools: string[] | null;    // blacklist patterns, evaluated after whitelist
  scope: 'mcp' | 'agents' | 'both';  // which endpoints this key can access
  enabled: boolean;
  key_hash: string | null;
  tenant_key?: string;
  workspace_key?: string;
  /** When set: requests with this key get treated as if user_id was authenticated.
   *  Enables Cursor/VS Code workflows where there's no SSO session but Argus
   *  still needs the user-identity for user-policies + upstream token resolution.
   */
  acting_as_user_id?: number | null;
  /** Username of the bound user (loaded JOIN-style for ALS propagation, no extra DB round-trip per request). */
  acting_as_username?: string | null;
  /** Role of the bound user (e.g., 'developer'). */
  acting_as_role?: string | null;
  /** IdP group claims of the bound user for the shared user/group policy hook. */
  acting_as_entra_groups?: string[];
}

export interface ToolPatternPolicy {
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  apiKeyPrefix?: string;
}

/** Check if a tool name is permitted for this key.
 *  1. If allowed_tools is set, name must match at least one pattern.
 *  2. If denied_tools is set, name must NOT match any pattern.
 *  Patterns use shell-style wildcards: * = any substring (converted from SQL LIKE %).
 */
export function isToolAllowed(entry: ApiKeyRbacEntry, toolName: string): boolean {
  return isToolAllowedByPatterns({
    allowedTools: entry.allowed_tools,
    deniedTools: entry.denied_tools,
  }, toolName);
}

export function isToolAllowedByPatterns(policy: ToolPatternPolicy, toolName: string): boolean {
  if (policy.allowedTools && policy.allowedTools.length > 0) {
    const allowed = policy.allowedTools.some(p => matchPattern(toolName, p));
    if (!allowed) return false;
  }
  if (policy.deniedTools && policy.deniedTools.length > 0) {
    const denied = policy.deniedTools.some(p => matchPattern(toolName, p));
    if (denied) return false;
  }
  return true;
}

function matchPattern(name: string, pattern: string): boolean {
  // M1: Guard against ReDoS — limit pattern length and wildcard count
  if (pattern.length > 256) return false;
  const wildcardCount = (pattern.match(/[*%]/g) ?? []).length;
  if (wildcardCount > 8) return false;
  // Support both * (shell-style) and % (SQL LIKE-style) as wildcards
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // escape regex special chars
    .replace(/[*%]/g, '[^]*');               // * and % → [^]* (no backtracking across newlines)
  return new RegExp(`^${re}$`, 'i').test(name);
}

// ── In-Memory Cache ──────────────────────────────────────────

let rbacCache: Map<string, ApiKeyRbacEntry> = new Map();
let hashLookup: Map<string, ApiKeyRbacEntry> = new Map();

// ── Hashing helpers ──────────────────────────────────────────

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): string {
  // 32 random bytes → 64 hex chars, prefixed with "ak_"
  return 'ak_' + randomBytes(32).toString('hex');
}

/** Validate a full API key against DB-managed keys (hash lookup). */
export function validateDbApiKey(fullKey: string): ApiKeyRbacEntry | undefined {
  const hash = hashApiKey(fullKey);
  return hashLookup.get(hash);
}

export async function loadApiKeyRbac(pool: pg.Pool): Promise<void> {
  try {
    const tableCheck = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'mcp_api_keys') AS exists`,
    );
    if (!tableCheck.rows[0].exists) return;

    // Check which optional columns exist (migrations may not have run yet)
    const colCheck = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'mcp_api_keys' AND column_name IN (
         'allowed_bundles', 'key_hash', 'allowed_tools', 'denied_tools', 'scope',
         'rotation_schedule', 'previous_key_hash', 'expires_at', 'deleted_at',
         'tenant_key', 'workspace_key'
       )`,
    );
    const existingCols = new Set(colCheck.rows.map((r: { column_name: string }) => r.column_name));
    const hasBundlesCol = existingCols.has('allowed_bundles');
    const hasHashCol = existingCols.has('key_hash');
    const hasAllowedToolsCol = existingCols.has('allowed_tools');
    const hasDeniedToolsCol = existingCols.has('denied_tools');
    const hasScopeCol = existingCols.has('scope');
    const hasRotationScheduleCol = existingCols.has('rotation_schedule');
    const hasPreviousKeyHashCol = existingCols.has('previous_key_hash');
    const hasExpiresAtCol = existingCols.has('expires_at');
    const hasDeletedAtCol = existingCols.has('deleted_at');
    const hasTenantKeyCol = existingCols.has('tenant_key');
    const hasWorkspaceKeyCol = existingCols.has('workspace_key');

    // acting_as_user_id added by migration 086
    const actingCheck = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.columns
        WHERE table_name = 'mcp_api_keys' AND column_name = 'acting_as_user_id') AS exists`,
    );
    const hasActingAsCol = actingCheck.rows[0].exists;

    const cols = ['key_prefix', 'label', 'enabled'];
    if (hasBundlesCol) cols.push('allowed_bundles');
    if (hasHashCol) cols.push('key_hash');
    if (hasAllowedToolsCol) cols.push('allowed_tools');
    if (hasDeniedToolsCol) cols.push('denied_tools');
    if (hasScopeCol) cols.push('scope');
    if (hasRotationScheduleCol) cols.push('rotation_schedule');
    if (hasPreviousKeyHashCol) cols.push('previous_key_hash');
    if (hasActingAsCol) cols.push('acting_as_user_id');
    if (hasTenantKeyCol) cols.push('tenant_key');
    if (hasWorkspaceKeyCol) cols.push('workspace_key');

    // When acting_as_user_id is present, LEFT JOIN mcp_users to grab username + role
    // so the API-key middleware can populate ALS context without another DB round-trip.
    // Wichtig: nur ENABLED Users werden gejoined → disabled Ex-Mitarbeiter verlieren
    // automatisch ihre Acting-Bindings (acting_as_user_id wird beim Build zu null).
    const projection = cols.map(c => `k.${c}`).join(', ');
    const joinClause = hasActingAsCol
      ? `LEFT JOIN mcp_users u ON u.id = k.acting_as_user_id AND u.enabled = true`
      : '';
    const extraCols = hasActingAsCol
      ? `, u.id AS acting_user_resolved_id, u.username AS acting_as_username,
           u.role AS acting_as_role, u.entra_groups AS acting_as_entra_groups`
      : '';
    const lifecyclePredicates = [
      'k.enabled = true',
      ...(hasExpiresAtCol ? ['(k.expires_at IS NULL OR k.expires_at > now())'] : []),
      ...(hasDeletedAtCol ? ['k.deleted_at IS NULL'] : []),
    ];
    const query = `SELECT ${projection}${extraCols} FROM mcp_api_keys k ${joinClause} WHERE ${lifecyclePredicates.join(' AND ')}`;
    const { rows } = await pool.query(query);

    const newCache = new Map<string, ApiKeyRbacEntry>();
    const newHashLookup = new Map<string, ApiKeyRbacEntry>();

    for (const row of rows) {
      const entry: ApiKeyRbacEntry = {
        key_prefix: row.key_prefix,
        label: row.label,
        allowed_bundles: hasBundlesCol ? row.allowed_bundles : null,
        allowed_tools: hasAllowedToolsCol ? row.allowed_tools : null,
        denied_tools: hasDeniedToolsCol ? row.denied_tools : null,
        scope: hasScopeCol ? (row.scope || 'both') : 'both',
        enabled: row.enabled,
        key_hash: hasHashCol ? row.key_hash : null,
        tenant_key: hasTenantKeyCol ? row.tenant_key : 'default',
        workspace_key: hasWorkspaceKeyCol ? row.workspace_key : 'default',
        // H4: nur honor acting_as wenn JOIN ein enabled-User gefunden hat (sonst null)
        acting_as_user_id: hasActingAsCol && row.acting_user_resolved_id != null
          ? row.acting_as_user_id : null,
        acting_as_username: hasActingAsCol && row.acting_user_resolved_id != null
          ? row.acting_as_username : null,
        acting_as_role: hasActingAsCol && row.acting_user_resolved_id != null
          ? row.acting_as_role : null,
        acting_as_entra_groups: hasActingAsCol && row.acting_user_resolved_id != null
          ? (row.acting_as_entra_groups ?? []) : [],
      };
      newCache.set(entry.key_prefix, entry);
      if (entry.key_hash) {
        newHashLookup.set(entry.key_hash, entry);
      }
      if (hasPreviousKeyHashCol && row.previous_key_hash) {
        newHashLookup.set(row.previous_key_hash as string, entry);
      }
    }

    rbacCache = newCache;
    hashLookup = newHashLookup;
    logger.info({ count: rows.length, dbManaged: newHashLookup.size }, 'API key RBAC cache loaded');
  } catch (err) {
    logger.warn({ err }, 'Failed to load API key RBAC cache (non-fatal)');
  }
}

export function getApiKeyRbac(keyPrefix: string): ApiKeyRbacEntry | undefined {
  return rbacCache.get(keyPrefix);
}

// ── Key Rotation ────────────────────────────────────────────

function calculateNextRotation(schedule: string | null): Date | null {
  if (!schedule) return null;
  const now = new Date();
  switch (schedule) {
    case 'daily': return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    case 'weekly': return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'monthly': return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
    case 'quarterly': return new Date(now.getFullYear(), now.getMonth() + 3, now.getDate());
    default: return null;
  }
}

export async function rotateKey(pool: pg.Pool, keyPrefix: string): Promise<{ newKey: string; nextRotation: Date | null }> {
  const newKey = generateApiKey();
  const newHash = hashApiKey(newKey);

  const { rows } = await pool.query(
    'SELECT key_hash, rotation_schedule FROM mcp_api_keys WHERE key_prefix = $1',
    [keyPrefix],
  );
  if (rows.length === 0) {
    throw new Error('Key not found');
  }

  const oldHash = rows[0].key_hash as string | null;
  const schedule = rows[0].rotation_schedule as string | null;
  const nextRotation = calculateNextRotation(schedule);

  await pool.query(
    `UPDATE mcp_api_keys
     SET key_hash = $1,
         previous_key_hash = $2,
         next_rotation_at = $3
     WHERE key_prefix = $4`,
    [newHash, oldHash, nextRotation, keyPrefix],
  );

  await loadApiKeyRbac(pool);
  return { newKey, nextRotation };
}

export async function checkAutoRotation(pool: pg.Pool): Promise<void> {
  try {
    const { rows } = await pool.query(
      `SELECT key_prefix, rotation_schedule FROM mcp_api_keys
       WHERE rotation_schedule IS NOT NULL
         AND (next_rotation_at IS NULL OR next_rotation_at <= now())`,
    );
    for (const row of rows) {
      try {
        await rotateKey(pool, row.key_prefix as string);
        logger.info({ keyPrefix: row.key_prefix }, 'Auto-rotated API key');
      } catch (err) {
        logger.error({ err, keyPrefix: row.key_prefix }, 'Auto-rotation failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'Auto-rotation check failed');
  }
}
