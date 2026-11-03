/**
 * userPolicyStore — DB accessors for the four policy tables introduced by
 * migration 083, plus the per-call fetcher that assembles input for
 * userPolicyResolver. No business logic here.
 *
 * Pre-flight schema notes (verified 2026-05-22):
 *  - mcp_composites: tool_allow_patterns TEXT[], tool_deny_patterns TEXT[], enabled BOOLEAN
 *  - mcp_user_composites (user_id, composite_id, granted_by)  — mig 083
 *  - mcp_user_tool_rules (id, user_id, tool_pattern, effect, reason, expires_at, created_by) — mig 083
 *  - mcp_group_composites (group_name, composite_id) — mig 083
 *  - mcp_group_tool_rules (id, group_name, tool_pattern, effect, reason) — mig 083
 *  - mcp_users.allowed_bundles INTEGER[] — mig 009 (NULL = all bundles)
 *  - Legacy bundle→tool lookup: mcp_tools.name via mcp_tool_bundles (tool_id, bundle_id) — mig 005
 *    (NOT mcp_dynamic_tools — that table does not exist in this schema)
 */

import type pg from 'pg';
import type { Pool } from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import type { PolicyRule } from './userPolicyResolver.js';

const DEFAULT_ACCESS_WORKSPACE_KEY = 'default';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export class AccessPolicyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
    readonly code = 'ACCESS_POLICY_INVALID',
  ) {
    super(message);
    this.name = 'AccessPolicyError';
  }
}

export interface AccessPolicyAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
  workspaceKey?: string;
  tenantKey?: string;
}

export interface AuditedAccessPolicyResult<T> {
  value: T;
  before: unknown | null;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export interface UserPolicyData {
  hasUserComposites: boolean;
  hasGroupComposites: boolean;
  userCompositeAllowPatterns: string[];
  userCompositeDenyPatterns: string[];
  groupCompositeAllowPatterns: string[];
  groupCompositeDenyPatterns: string[];
  userAllowRules: PolicyRule[];
  userDenyRules: PolicyRule[];
  groupAllowRules: PolicyRule[];
  groupDenyRules: PolicyRule[];
  legacyAllowedBundleTools: string[] | null;
}

/**
 * Per-tool-call data fetch. Runs five indexed queries in parallel.
 * All queries are bounded by (user_id) or (group_name) indexes added in mig 083.
 */
export async function fetchUserPolicyData(
  pool: Pool,
  userId: number,
  groups: string[],
): Promise<UserPolicyData> {
  // ANY() requires non-empty array; use sentinel for empty groups list
  const groupsArr = groups.length > 0 ? groups : ['__no_group_match__'];

  const [
    userCompositesQ,
    userRulesQ,
    groupCompositesQ,
    groupRulesQ,
    userRowQ,
  ] = await Promise.all([
    // User's composites — aggregate allow/deny patterns
    pool.query<{ tool_allow_patterns: string[]; tool_deny_patterns: string[] }>(
      `SELECT c.tool_allow_patterns, c.tool_deny_patterns
       FROM mcp_user_composites uc
       JOIN mcp_composites c ON c.id = uc.composite_id
       WHERE uc.user_id = $1 AND c.enabled = true`,
      [userId],
    ),
    // User's tool rules — filter out expired
    pool.query<{ id: number; tool_pattern: string; effect: 'allow' | 'deny' }>(
      `SELECT id, tool_pattern, effect
       FROM mcp_user_tool_rules
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    ),
    // Group's composites
    pool.query<{ tool_allow_patterns: string[]; tool_deny_patterns: string[]; group_name: string }>(
      `SELECT c.tool_allow_patterns, c.tool_deny_patterns, gc.group_name
       FROM mcp_group_composites gc
       JOIN mcp_composites c ON c.id = gc.composite_id
       WHERE gc.group_name = ANY($1) AND c.enabled = true`,
      [groupsArr],
    ),
    // Group's tool rules
    pool.query<{ id: number; tool_pattern: string; effect: 'allow' | 'deny'; group_name: string }>(
      `SELECT id, tool_pattern, effect, group_name
       FROM mcp_group_tool_rules
       WHERE group_name = ANY($1)`,
      [groupsArr],
    ),
    // Legacy: allowed_bundles INTEGER[] (NULL = all bundles = no legacy restriction)
    pool.query<{ allowed_bundles: number[] | null }>(
      `SELECT allowed_bundles FROM mcp_users WHERE id = $1`,
      [userId],
    ),
  ]);

  const userCompositeRows = userCompositesQ.rows;
  const groupCompositeRows = groupCompositesQ.rows;

  // Resolve legacy bundle → tool names via mcp_tool_bundles junction table.
  // mig 005 moved from mcp_tools.bundle_id to many-to-many mcp_tool_bundles(tool_id, bundle_id).
  // Wrapped in try/catch for fail-soft: returns null if schema diverges so the resolver
  // falls through to default-deny rather than crashing.
  let legacyTools: string[] | null = null;
  const allowedBundles = userRowQ.rows[0]?.allowed_bundles ?? null;
  if (allowedBundles !== null && allowedBundles.length > 0) {
    try {
      const r = await pool.query<{ name: string }>(
        `SELECT DISTINCT t.name
         FROM mcp_tools t
         JOIN mcp_tool_bundles tb ON tb.tool_id = t.id
         WHERE tb.bundle_id = ANY($1)`,
        [allowedBundles],
      );
      legacyTools = r.rows.map(row => row.name);
    } catch {
      legacyTools = null;  // schema differs — disable legacy fallback gracefully
    }
  }

  return {
    hasUserComposites: userCompositeRows.length > 0,
    hasGroupComposites: groupCompositeRows.length > 0,
    userCompositeAllowPatterns: userCompositeRows.flatMap(r => r.tool_allow_patterns ?? []),
    userCompositeDenyPatterns:  userCompositeRows.flatMap(r => r.tool_deny_patterns ?? []),
    groupCompositeAllowPatterns: groupCompositeRows.flatMap(r => r.tool_allow_patterns ?? []),
    groupCompositeDenyPatterns:  groupCompositeRows.flatMap(r => r.tool_deny_patterns ?? []),
    userAllowRules: userRulesQ.rows
      .filter(r => r.effect === 'allow')
      .map(r => ({ id: r.id, pattern: r.tool_pattern, source: 'user' })),
    userDenyRules: userRulesQ.rows
      .filter(r => r.effect === 'deny')
      .map(r => ({ id: r.id, pattern: r.tool_pattern, source: 'user' })),
    groupAllowRules: groupRulesQ.rows
      .filter(r => r.effect === 'allow')
      .map(r => ({ id: r.id, pattern: r.tool_pattern, source: `group:${r.group_name}` })),
    groupDenyRules: groupRulesQ.rows
      .filter(r => r.effect === 'deny')
      .map(r => ({ id: r.id, pattern: r.tool_pattern, source: `group:${r.group_name}` })),
    legacyAllowedBundleTools: legacyTools,
  };
}

// ── CRUD ────────────────────────────────────────────────────────────────────

function normalizePositiveIds(values: number[], field: string): number[] {
  if (!Array.isArray(values) || values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    throw new AccessPolicyError(`${field} must contain positive integer IDs.`);
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

function normalizeGroupName(value: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > 128) {
    throw new AccessPolicyError('group name must contain between 1 and 128 characters.');
  }
  return normalized;
}

function normalizeToolRule(rule: ToolRuleInput, includeExpiry: boolean): ToolRuleInput {
  const pattern = typeof rule?.tool_pattern === 'string' ? rule.tool_pattern.trim() : '';
  if (!pattern || pattern.length > 512) {
    throw new AccessPolicyError('tool_pattern must contain between 1 and 512 characters.');
  }
  if (!['allow', 'deny'].includes(rule.effect)) {
    throw new AccessPolicyError('effect must be allow or deny.');
  }
  const reason = rule.reason?.trim();
  if (reason && reason.length > 2_000) throw new AccessPolicyError('reason exceeds 2000 characters.');
  let expiresAt: string | null | undefined;
  if (includeExpiry && rule.expires_at != null && rule.expires_at !== '') {
    const date = new Date(rule.expires_at);
    if (!Number.isFinite(date.getTime())) throw new AccessPolicyError('expires_at must be a valid timestamp.');
    expiresAt = date.toISOString();
  } else if (includeExpiry && rule.expires_at === null) {
    expiresAt = null;
  }
  return {
    tool_pattern: pattern,
    effect: rule.effect,
    ...(reason ? { reason } : {}),
    ...(includeExpiry && expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  };
}

function auditScope(context: AccessPolicyAuditContext) {
  const workspaceKey = context.workspaceKey ?? DEFAULT_ACCESS_WORKSPACE_KEY;
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

function policyAuditBase(
  context: AccessPolicyAuditContext,
  action: string,
  resource: { type: string; id: string },
  payload: { before?: unknown; after?: unknown; context?: unknown },
) {
  return {
    ...auditScope(context),
    solution: 'argus.core',
    actor: context.actor,
    action,
    outcome: 'success' as const,
    risk: 'critical' as const,
    resource,
    policy: { id: 'argus.access.policy-management', version: '1', decision: 'allow' },
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload,
  };
}

async function assertUserExists(client: Queryable, userId: number): Promise<void> {
  const result = await client.query('SELECT id FROM mcp_users WHERE id=$1 FOR UPDATE', [userId]);
  if (!result.rows[0]) throw new AccessPolicyError('User not found', 404, 'USER_NOT_FOUND');
}

async function setUserCompositesRecord(
  client: pg.PoolClient,
  userId: number,
  compositeIds: number[],
  grantedBy?: number,
): Promise<{ before: number[]; value: number[] }> {
  await assertUserExists(client, userId);
  const normalizedIds = normalizePositiveIds(compositeIds, 'composite_ids');
  const beforeRows = await client.query<{ composite_id: number }>(
    'SELECT composite_id FROM mcp_user_composites WHERE user_id=$1 ORDER BY composite_id FOR UPDATE',
    [userId],
  );
  await client.query('DELETE FROM mcp_user_composites WHERE user_id = $1', [userId]);
  for (const cid of normalizedIds) {
    await client.query(
      'INSERT INTO mcp_user_composites (user_id, composite_id, granted_by) VALUES ($1, $2, $3)',
      [userId, cid, grantedBy ?? null],
    );
  }
  return { before: beforeRows.rows.map(row => row.composite_id), value: normalizedIds };
}

/**
 * Replace a user's composite assignments atomically.
 * Wraps in a transaction: DELETE all existing → INSERT new set.
 */
export async function setUserComposites(
  pool: Pool,
  userId: number,
  compositeIds: number[],
  grantedBy?: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setUserCompositesRecord(client, userId, compositeIds, grantedBy);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export interface ToolRuleInput {
  tool_pattern: string;
  effect: 'allow' | 'deny';
  reason?: string;
  expires_at?: string | null;
}

interface UserToolRuleRecord {
  id: number;
  user_id: number;
  tool_pattern: string;
  effect: 'allow' | 'deny';
  reason: string | null;
  expires_at: string | null;
}

interface GroupToolRuleRecord {
  id: number;
  group_name: string;
  tool_pattern: string;
  effect: 'allow' | 'deny';
  reason: string | null;
}

async function addUserToolRuleRecord(
  client: Queryable,
  userId: number,
  rule: ToolRuleInput,
  createdBy?: number,
): Promise<UserToolRuleRecord> {
  await assertUserExists(client, userId);
  const normalized = normalizeToolRule(rule, true);
  const { rows } = await client.query<UserToolRuleRecord>(
    `INSERT INTO mcp_user_tool_rules (user_id, tool_pattern, effect, reason, expires_at, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, user_id, tool_pattern, effect, reason, expires_at`,
    [
      userId, normalized.tool_pattern, normalized.effect, normalized.reason ?? null,
      normalized.expires_at ?? null, createdBy ?? null,
    ],
  );
  if (!rows[0]) throw new Error('user tool rule insert returned no row');
  return rows[0];
}

export async function addUserToolRule(
  pool: Pool,
  userId: number,
  rule: ToolRuleInput,
  createdBy?: number,
): Promise<number> {
  return (await addUserToolRuleRecord(pool, userId, rule, createdBy)).id;
}

export async function deleteUserToolRule(pool: Pool, ruleId: number): Promise<void> {
  await deleteUserToolRuleRecord(pool, ruleId);
}

async function deleteUserToolRuleRecord(client: Queryable, ruleId: number): Promise<UserToolRuleRecord> {
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) throw new AccessPolicyError('rule ID is invalid.');
  const found = await client.query<UserToolRuleRecord>(
    `SELECT id, user_id, tool_pattern, effect, reason, expires_at
       FROM mcp_user_tool_rules WHERE id=$1 FOR UPDATE`,
    [ruleId],
  );
  if (!found.rows[0]) throw new AccessPolicyError('User tool rule not found', 404, 'USER_TOOL_RULE_NOT_FOUND');
  await client.query('DELETE FROM mcp_user_tool_rules WHERE id = $1', [ruleId]);
  return found.rows[0];
}

async function setGroupCompositesRecord(
  client: pg.PoolClient,
  groupName: string,
  compositeIds: number[],
): Promise<{ before: number[]; value: number[]; groupName: string }> {
  const normalizedGroup = normalizeGroupName(groupName);
  const normalizedIds = normalizePositiveIds(compositeIds, 'composite_ids');
  const beforeRows = await client.query<{ composite_id: number }>(
    'SELECT composite_id FROM mcp_group_composites WHERE group_name=$1 ORDER BY composite_id FOR UPDATE',
    [normalizedGroup],
  );
  await client.query('DELETE FROM mcp_group_composites WHERE group_name = $1', [normalizedGroup]);
  for (const cid of normalizedIds) {
    await client.query(
      'INSERT INTO mcp_group_composites (group_name, composite_id) VALUES ($1, $2)',
      [normalizedGroup, cid],
    );
  }
  return { before: beforeRows.rows.map(row => row.composite_id), value: normalizedIds, groupName: normalizedGroup };
}

/**
 * Replace a group's composite assignments atomically.
 */
export async function setGroupComposites(
  pool: Pool,
  groupName: string,
  compositeIds: number[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setGroupCompositesRecord(client, groupName, compositeIds);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function addGroupToolRule(
  pool: Pool,
  groupName: string,
  rule: ToolRuleInput,
): Promise<number> {
  return (await addGroupToolRuleRecord(pool, groupName, rule)).id;
}

async function addGroupToolRuleRecord(
  client: Queryable,
  groupName: string,
  rule: ToolRuleInput,
): Promise<GroupToolRuleRecord> {
  const normalizedGroup = normalizeGroupName(groupName);
  const normalized = normalizeToolRule(rule, false);
  const { rows } = await client.query<GroupToolRuleRecord>(
    `INSERT INTO mcp_group_tool_rules (group_name, tool_pattern, effect, reason)
     VALUES ($1, $2, $3, $4)
     RETURNING id, group_name, tool_pattern, effect, reason`,
    [normalizedGroup, normalized.tool_pattern, normalized.effect, normalized.reason ?? null],
  );
  if (!rows[0]) throw new Error('group tool rule insert returned no row');
  return rows[0];
}

export async function deleteGroupToolRule(pool: Pool, ruleId: number): Promise<void> {
  await deleteGroupToolRuleRecord(pool, ruleId);
}

async function deleteGroupToolRuleRecord(client: Queryable, ruleId: number): Promise<GroupToolRuleRecord> {
  if (!Number.isSafeInteger(ruleId) || ruleId <= 0) throw new AccessPolicyError('rule ID is invalid.');
  const found = await client.query<GroupToolRuleRecord>(
    `SELECT id, group_name, tool_pattern, effect, reason
       FROM mcp_group_tool_rules WHERE id=$1 FOR UPDATE`,
    [ruleId],
  );
  if (!found.rows[0]) throw new AccessPolicyError('Group tool rule not found', 404, 'GROUP_TOOL_RULE_NOT_FOUND');
  await client.query('DELETE FROM mcp_group_tool_rules WHERE id = $1', [ruleId]);
  return found.rows[0];
}

// ── Agent-rule CRUD (mirrors tool-rule helpers above) ────────────────────────

export interface UserAgentPolicyData {
  agentAllowIds: Set<number>;
  agentDenyIds: Set<number>;
}

/**
 * Load a user's effective agent rules.
 * Parallel fetch: user rules (honours expires_at) + group rules.
 * Groups are obtained exactly the same way fetchUserPolicyData does: passed in
 * by the caller who already has them from the session.
 */
export async function fetchUserAgentPolicyData(
  pool: Pool,
  userId: number,
  groups: string[],
): Promise<UserAgentPolicyData> {
  const groupsArr = groups.length > 0 ? groups : ['__no_group_match__'];

  const [userRulesQ, groupRulesQ] = await Promise.all([
    pool.query<{ agent_id: number; effect: 'allow' | 'deny' }>(
      `SELECT agent_id, effect
       FROM mcp_user_agent_rules
       WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
      [userId],
    ),
    pool.query<{ agent_id: number; effect: 'allow' | 'deny' }>(
      `SELECT agent_id, effect
       FROM mcp_group_agent_rules
       WHERE group_name = ANY($1)`,
      [groupsArr],
    ),
  ]);

  const agentAllowIds = new Set<number>();
  const agentDenyIds = new Set<number>();

  for (const row of userRulesQ.rows) {
    if (row.effect === 'allow') agentAllowIds.add(row.agent_id);
    else agentDenyIds.add(row.agent_id);
  }
  for (const row of groupRulesQ.rows) {
    if (row.effect === 'allow') agentAllowIds.add(row.agent_id);
    else agentDenyIds.add(row.agent_id);
  }

  return { agentAllowIds, agentDenyIds };
}

/** Get raw agent rules for a user (all effects, including denied). */
export async function getUserAgentRules(
  pool: Queryable,
  userId: number,
): Promise<{ agent_id: number; effect: 'allow' | 'deny' }[]> {
  const { rows } = await pool.query<{ agent_id: number; effect: 'allow' | 'deny' }>(
    `SELECT agent_id, effect
     FROM mcp_user_agent_rules
     WHERE user_id = $1
     ORDER BY agent_id`,
    [userId],
  );
  return rows;
}

/**
 * Replace a user's agent allow-list atomically.
 * Deletes only the user's existing `effect='allow'` rows, then inserts the
 * new allow set. Any `effect='deny'` rows are left untouched.
 */
export async function setUserAgentAllow(
  pool: Pool,
  userId: number,
  agentIds: number[],
  createdBy?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setUserAgentAllowRecord(client, userId, agentIds, createdBy);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setUserAgentAllowRecord(
  client: pg.PoolClient,
  userId: number,
  agentIds: number[],
  createdBy?: string,
): Promise<{ before: number[]; value: number[] }> {
  await assertUserExists(client, userId);
  const normalizedIds = normalizePositiveIds(agentIds, 'agentIds');
  const beforeRows = await client.query<{ agent_id: number }>(
    `SELECT agent_id FROM mcp_user_agent_rules
      WHERE user_id=$1 AND effect='allow' ORDER BY agent_id FOR UPDATE`,
    [userId],
  );
  await client.query(
    `DELETE FROM mcp_user_agent_rules WHERE user_id = $1 AND effect = 'allow'`,
    [userId],
  );
  for (const agentId of normalizedIds) {
    await client.query(
      `INSERT INTO mcp_user_agent_rules (user_id, agent_id, effect, created_by)
       VALUES ($1, $2, 'allow', $3)
       ON CONFLICT (user_id, agent_id) DO UPDATE SET effect = 'allow', created_by = EXCLUDED.created_by`,
      [userId, agentId, createdBy ?? null],
    );
  }
  return { before: beforeRows.rows.map(row => row.agent_id), value: normalizedIds };
}

/** Get raw agent rules for a group (all effects). */
export async function getGroupAgentRules(
  pool: Queryable,
  groupName: string,
): Promise<{ agent_id: number; effect: 'allow' | 'deny' }[]> {
  const { rows } = await pool.query<{ agent_id: number; effect: 'allow' | 'deny' }>(
    `SELECT agent_id, effect
     FROM mcp_group_agent_rules
     WHERE group_name = $1
     ORDER BY agent_id`,
    [groupName],
  );
  return rows;
}

/**
 * Replace a group's agent allow-list atomically.
 * Deletes only the group's existing `effect='allow'` rows, inserts the new set.
 * Existing `effect='deny'` rows are left untouched.
 */
export async function setGroupAgentAllow(
  pool: Pool,
  groupName: string,
  agentIds: number[],
  createdBy?: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await setGroupAgentAllowRecord(client, groupName, agentIds);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function setGroupAgentAllowRecord(
  client: pg.PoolClient,
  groupName: string,
  agentIds: number[],
): Promise<{ before: number[]; value: number[]; groupName: string }> {
  const normalizedGroup = normalizeGroupName(groupName);
  const normalizedIds = normalizePositiveIds(agentIds, 'agentIds');
  const beforeRows = await client.query<{ agent_id: number }>(
    `SELECT agent_id FROM mcp_group_agent_rules
      WHERE group_name=$1 AND effect='allow' ORDER BY agent_id FOR UPDATE`,
    [normalizedGroup],
  );
  await client.query(
    `DELETE FROM mcp_group_agent_rules WHERE group_name = $1 AND effect = 'allow'`,
    [normalizedGroup],
  );
  for (const agentId of normalizedIds) {
    await client.query(
      `INSERT INTO mcp_group_agent_rules (group_name, agent_id, effect)
       VALUES ($1, $2, 'allow')
       ON CONFLICT (group_name, agent_id) DO UPDATE SET effect = 'allow'`,
      [normalizedGroup, agentId],
    );
  }
  return { before: beforeRows.rows.map(row => row.agent_id), value: normalizedIds, groupName: normalizedGroup };
}

// ── Read helpers ─────────────────────────────────────────────────────────────

export async function listUserPolicies(
  pool: Queryable,
  userId: number,
): Promise<{
  composites: number[];
  rules: Array<{
    id: number;
    tool_pattern: string;
    effect: string;
    reason: string | null;
    expires_at: string | null;
  }>;
}> {
  const [c, r] = await Promise.all([
    pool.query<{ composite_id: number }>(
      'SELECT composite_id FROM mcp_user_composites WHERE user_id = $1 ORDER BY composite_id',
      [userId],
    ),
    pool.query<{
      id: number;
      tool_pattern: string;
      effect: string;
      reason: string | null;
      expires_at: string | null;
    }>(
      'SELECT id, tool_pattern, effect, reason, expires_at FROM mcp_user_tool_rules WHERE user_id = $1 ORDER BY id',
      [userId],
    ),
  ]);
  return { composites: c.rows.map(x => x.composite_id), rules: r.rows };
}

export async function listGroupPolicies(
  pool: Queryable,
  groupName: string,
): Promise<{
  composites: number[];
  rules: Array<{
    id: number;
    tool_pattern: string;
    effect: string;
    reason: string | null;
  }>;
}> {
  const [c, r] = await Promise.all([
    pool.query<{ composite_id: number }>(
      'SELECT composite_id FROM mcp_group_composites WHERE group_name = $1 ORDER BY composite_id',
      [groupName],
    ),
    pool.query<{
      id: number;
      tool_pattern: string;
      effect: string;
      reason: string | null;
    }>(
      'SELECT id, tool_pattern, effect, reason FROM mcp_group_tool_rules WHERE group_name = $1 ORDER BY id',
      [groupName],
    ),
  ]);
  return { composites: c.rows.map(x => x.composite_id), rules: r.rows };
}

// ── Canonical audited policy mutations ─────────────────────────────────────

export async function setUserCompositesAudited(
  pool: Pool,
  userId: number,
  compositeIds: number[],
  grantedBy: number | undefined,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number[]>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.user-composites.replace', eventId: context.producerEventId },
    scope,
    client => setUserCompositesRecord(client, userId, compositeIds, grantedBy),
    result => policyAuditBase(context, 'access.user_composites.replaced', {
      type: 'user_access_policy', id: String(userId),
    }, {
      before: { compositeIds: result.before },
      after: { compositeIds: result.value },
    }),
  );
  const current = outcome.result?.value
    ?? (await listUserPolicies(pool, userId)).composites;
  return {
    value: current,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function addUserToolRuleAudited(
  pool: Pool,
  userId: number,
  rule: ToolRuleInput,
  createdBy: number | undefined,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.user-tool-rule.create', eventId: context.producerEventId },
    scope,
    client => addUserToolRuleRecord(client, userId, rule, createdBy),
    value => policyAuditBase(context, 'access.user_tool_rule.created', {
      type: 'user_tool_rule', id: String(value.id),
    }, {
      before: null,
      after: {
        userId: value.user_id,
        toolPattern: value.tool_pattern,
        effect: value.effect,
        reason: value.reason,
        expiresAt: value.expires_at,
      },
    }),
  );
  const id = outcome.result?.id ?? Number(outcome.event.resource.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('canonical user tool rule resource ID is invalid');
  return { value: id, before: null, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function deleteUserToolRuleAudited(
  pool: Pool,
  ruleId: number,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<boolean>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.user-tool-rule.delete', eventId: context.producerEventId },
    scope,
    client => deleteUserToolRuleRecord(client, ruleId),
    before => policyAuditBase(context, 'access.user_tool_rule.deleted', {
      type: 'user_tool_rule', id: String(before.id),
    }, {
      before: {
        userId: before.user_id,
        toolPattern: before.tool_pattern,
        effect: before.effect,
        reason: before.reason,
        expiresAt: before.expires_at,
      },
      after: null,
    }),
  );
  return {
    value: true,
    before: outcome.result ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function setGroupCompositesAudited(
  pool: Pool,
  groupName: string,
  compositeIds: number[],
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number[]>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.group-composites.replace', eventId: context.producerEventId },
    scope,
    client => setGroupCompositesRecord(client, groupName, compositeIds),
    result => policyAuditBase(context, 'access.group_composites.replaced', {
      type: 'group_access_policy', id: result.groupName,
    }, {
      before: { compositeIds: result.before },
      after: { compositeIds: result.value },
    }),
  );
  const resourceGroup = outcome.result?.groupName ?? outcome.event.resource.id;
  const current = outcome.result?.value
    ?? (await listGroupPolicies(pool, resourceGroup)).composites;
  return {
    value: current,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function addGroupToolRuleAudited(
  pool: Pool,
  groupName: string,
  rule: ToolRuleInput,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.group-tool-rule.create', eventId: context.producerEventId },
    scope,
    client => addGroupToolRuleRecord(client, groupName, rule),
    value => policyAuditBase(context, 'access.group_tool_rule.created', {
      type: 'group_tool_rule', id: String(value.id),
    }, {
      before: null,
      after: {
        groupName: value.group_name,
        toolPattern: value.tool_pattern,
        effect: value.effect,
        reason: value.reason,
      },
    }),
  );
  const id = outcome.result?.id ?? Number(outcome.event.resource.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('canonical group tool rule resource ID is invalid');
  return { value: id, before: null, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function deleteGroupToolRuleAudited(
  pool: Pool,
  ruleId: number,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<boolean>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.group-tool-rule.delete', eventId: context.producerEventId },
    scope,
    client => deleteGroupToolRuleRecord(client, ruleId),
    before => policyAuditBase(context, 'access.group_tool_rule.deleted', {
      type: 'group_tool_rule', id: String(before.id),
    }, {
      before: {
        groupName: before.group_name,
        toolPattern: before.tool_pattern,
        effect: before.effect,
        reason: before.reason,
      },
      after: null,
    }),
  );
  return {
    value: true,
    before: outcome.result ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function setUserAgentAllowAudited(
  pool: Pool,
  userId: number,
  agentIds: number[],
  createdBy: string | undefined,
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number[]>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.user-agent-allow.replace', eventId: context.producerEventId },
    scope,
    client => setUserAgentAllowRecord(client, userId, agentIds, createdBy),
    result => policyAuditBase(context, 'access.user_agent_allow.replaced', {
      type: 'user_access_policy', id: String(userId),
    }, {
      before: { agentIds: result.before },
      after: { agentIds: result.value },
      context: { denyRulesPreserved: true },
    }),
  );
  const current = outcome.result?.value ?? (await getUserAgentRules(pool, userId))
    .filter(rule => rule.effect === 'allow')
    .map(rule => rule.agent_id);
  return {
    value: current,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function setGroupAgentAllowAudited(
  pool: Pool,
  groupName: string,
  agentIds: number[],
  context: AccessPolicyAuditContext,
): Promise<AuditedAccessPolicyResult<number[]>> {
  const scope = auditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'access.policies.group-agent-allow.replace', eventId: context.producerEventId },
    scope,
    client => setGroupAgentAllowRecord(client, groupName, agentIds),
    result => policyAuditBase(context, 'access.group_agent_allow.replaced', {
      type: 'group_access_policy', id: result.groupName,
    }, {
      before: { agentIds: result.before },
      after: { agentIds: result.value },
      context: { denyRulesPreserved: true },
    }),
  );
  const resourceGroup = outcome.result?.groupName ?? outcome.event.resource.id;
  const current = outcome.result?.value ?? (await getGroupAgentRules(pool, resourceGroup))
    .filter(rule => rule.effect === 'allow')
    .map(rule => rule.agent_id);
  return {
    value: current,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}
