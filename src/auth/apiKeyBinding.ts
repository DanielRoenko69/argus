import type pg from 'pg';
import { parseArgusRole, ROLE_WEIGHTS } from './roles.js';
import type { SessionUser } from './userAuth.js';

type Creator = Pick<SessionUser, 'id' | 'role'>;
type Target = { id: number; role: string; enabled: boolean };

/** A service identity is explicit null (or omitted for older API clients). */
export function parseApiKeyBinding(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('acting_as_user_id must be a positive integer or null');
  }
  return value;
}

export function canBindApiKeyToUser(creator: Creator | undefined, target: Target): boolean {
  if (!creator || !target.enabled || !Number.isSafeInteger(creator.id) || creator.id <= 0) return false;
  const creatorRole = parseArgusRole(creator.role);
  const targetRole = parseArgusRole(target.role);
  if (!creatorRole || !targetRole) return false;
  const ownWeight = ROLE_WEIGHTS[creatorRole];
  const targetWeight = ROLE_WEIGHTS[targetRole];
  // Self-binding carries the caller's existing identity, not another peer's authority.
  // A stale lower-role session must not mint a newly elevated identity either.
  return targetWeight < ownWeight || (target.id === creator.id && targetWeight === ownWeight);
}

export async function assertCanBindKeyToUser(
  pool: Pick<pg.Pool, 'query'>,
  creator: Creator | undefined,
  targetUserId: number | null,
): Promise<void> {
  parseApiKeyBinding(targetUserId);
  if (targetUserId == null) return;
  if (!creator) throw new Error('binding requires authenticated creator');
  const { rows } = await pool.query<Target>(
    'SELECT id, role, enabled FROM mcp_users WHERE id = $1', [targetUserId],
  );
  if (!rows[0] || !canBindApiKeyToUser(creator, rows[0])) {
    throw new Error('User binding is not permitted. Choose your own active identity or an active user with a strictly lower role.');
  }
}

export async function listApiKeyBindingTargets(pool: Pick<pg.Pool, 'query'>, creator: Creator | undefined) {
  if (!creator) return [];
  const { rows } = await pool.query<Target & { username: string; display_name: string }>(
    'SELECT id, username, display_name, role, enabled FROM mcp_users WHERE enabled = TRUE ORDER BY username, id',
  );
  return rows.filter(row => canBindApiKeyToUser(creator, row)).map(({ id, username, display_name, role }) => ({
    id, username, display_name, role, is_self: id === creator.id,
  }));
}
