import pg from 'pg';
import { createHash, createHmac } from 'node:crypto';
import { logger } from '../lib/logger.js';
import {
  assertEgressAllowed,
  assertSsrfSafe,
  assertSsrfSafeResolved,
} from '../backends/customBackends.js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import type { UserLifecycleAuditContext } from '../auth/userLifecycle.js';

// ── DB Row ────────────────────────────────────────────────────

export interface ToolFilterRow {
  id: number;
  name: string;
  description: string;
  webhook_url: string;
  hmac_secret: string | null;
  timeout_ms: number;
  tool_patterns: string[];       // leer = matcht alle Tools
  enabled: boolean;
  on_timeout: 'allow' | 'deny';
  created_at: string;
  updated_at: string;
}

type ToolFilterCreateInput = Omit<ToolFilterRow, 'id' | 'created_at' | 'updated_at'>;
type ToolFilterUpdateInput = Partial<Omit<ToolFilterRow, 'id' | 'created_at' | 'updated_at'>>;

export interface AuditedToolFilterMutation {
  value: ToolFilterRow;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export interface AuditedToolFilterDeletion {
  value: ToolFilterRow | null;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export class ToolFilterMutationError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: 'RUNTIME_POLICY_INVALID' | 'RUNTIME_POLICY_NOT_FOUND' | 'RUNTIME_POLICY_REPLAY_RESOURCE_MISSING',
  ) {
    super(message);
    this.name = 'ToolFilterMutationError';
  }
}

// ── Webhook Payload / Response ────────────────────────────────

export interface FilterWebhookPayload {
  tool_name: string;
  args: Record<string, unknown>;
  api_key_prefix: string | null;
  session_id: string | null;
  timestamp: string;
}

export type FilterWebhookResponse =
  | { allow: true; args?: Record<string, unknown> }
  | { allow: false; reason: string };

export type FilterResult =
  | { allowed: true; args: Record<string, unknown> }
  | { allowed: false; reason: string };

export interface ToolFilterTestResult {
  reachable: boolean;
  status: number | null;
  ok: boolean;
  decision: 'allow' | 'deny' | 'invalid' | 'unreachable';
  reason: string | null;
  latencyMs: number;
  signed: boolean;
  responsePreview: string | null;
}

// ── In-Memory Cache ───────────────────────────────────────────

let cachedFilters: ToolFilterRow[] = [];

export function setToolFilters(filters: ToolFilterRow[]): void {
  cachedFilters = filters;
}

export function getToolFilters(): ToolFilterRow[] {
  return cachedFilters;
}

// ── DB helpers ────────────────────────────────────────────────

async function tableExists(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'mcp_tool_filters') AS exists`,
  );
  return rows[0].exists as boolean;
}

export async function loadToolFilters(pool: pg.Pool): Promise<ToolFilterRow[]> {
  if (!(await tableExists(pool))) return [];
  const { rows } = await pool.query<ToolFilterRow>(
    `SELECT * FROM mcp_tool_filters WHERE enabled = true ORDER BY name`,
  );
  return rows;
}

export async function loadAllToolFilters(pool: pg.Pool): Promise<ToolFilterRow[]> {
  if (!(await tableExists(pool))) return [];
  const { rows } = await pool.query<ToolFilterRow>(
    `SELECT * FROM mcp_tool_filters ORDER BY name`,
  );
  return rows;
}

export async function getToolFilter(pool: pg.Pool, id: number): Promise<ToolFilterRow | null> {
  if (!(await tableExists(pool))) return null;
  const { rows } = await pool.query<ToolFilterRow>(
    `SELECT * FROM mcp_tool_filters WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function createToolFilter(
  pool: pg.Pool,
  data: ToolFilterCreateInput,
): Promise<ToolFilterRow> {
  return createToolFilterRecord(pool, data);
}

async function createToolFilterRecord(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  data: ToolFilterCreateInput,
): Promise<ToolFilterRow> {
  assertSsrfSafe(data.webhook_url);
  const { rows } = await queryable.query<ToolFilterRow>(
    `INSERT INTO mcp_tool_filters
       (name, description, webhook_url, hmac_secret, timeout_ms, tool_patterns, enabled, on_timeout)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [data.name, data.description, data.webhook_url, encrypt(data.hmac_secret ?? null),
     data.timeout_ms, data.tool_patterns, data.enabled, data.on_timeout],
  );
  return rows[0];
}

export async function updateToolFilter(
  pool: pg.Pool,
  id: number,
  data: ToolFilterUpdateInput,
): Promise<ToolFilterRow | null> {
  return updateToolFilterRecord(pool, id, data);
}

async function updateToolFilterRecord(
  queryable: Pick<pg.Pool, 'query'> | pg.PoolClient,
  id: number,
  data: ToolFilterUpdateInput,
): Promise<ToolFilterRow | null> {
  if (data.webhook_url) assertSsrfSafe(data.webhook_url);
  const allowedColumns = new Set([
    'description', 'webhook_url', 'hmac_secret', 'timeout_ms',
    'tool_patterns', 'enabled', 'on_timeout',
  ]);
  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(data)) {
    if (!allowedColumns.has(k)) continue;
    sets.push(`${k} = $${i++}`);
    vals.push(k === 'hmac_secret' ? encrypt(v as string | null) : v);
  }
  if (sets.length === 0) return null;
  vals.push(id);
  const { rows } = await queryable.query<ToolFilterRow>(
    `UPDATE mcp_tool_filters SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    vals,
  );
  return rows[0] ?? null;
}

export async function deleteToolFilter(pool: pg.Pool, id: number): Promise<boolean> {
  const r = await pool.query(`DELETE FROM mcp_tool_filters WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

function toolFilterAuditScope(context: UserLifecycleAuditContext) {
  const workspaceKey = context.workspaceKey ?? 'default';
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: context.tenantKey ?? workspaceKey,
  };
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function isoTimestamp(value: string | Date): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Runtime policy has an invalid revision timestamp');
  return parsed.toISOString();
}

function auditSnapshot(row: ToolFilterRow) {
  return {
    name: row.name,
    descriptionDigest: digest(row.description),
    webhookUrlDigest: digest(row.webhook_url),
    hasHmacSecret: Boolean(row.hmac_secret),
    timeoutMs: row.timeout_ms,
    toolPatterns: [...row.tool_patterns].sort(),
    enabled: row.enabled,
    onFailure: row.on_timeout,
  };
}

async function loadToolFilterForReplay(pool: pg.Pool, event: CanonicalAuditEventSummary): Promise<ToolFilterRow> {
  const id = Number(event.resource.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Canonical runtime policy event has invalid resource id');
  const result = await pool.query<ToolFilterRow>('SELECT * FROM mcp_tool_filters WHERE id=$1', [id]);
  if (!result.rows[0]) {
    throw new ToolFilterMutationError(
      'Runtime policy from the idempotent request no longer exists.',
      409,
      'RUNTIME_POLICY_REPLAY_RESOURCE_MISSING',
    );
  }
  return result.rows[0];
}

function assertPolicyReplayAction(event: CanonicalAuditEventSummary, action: 'created' | 'updated' | 'deleted'): void {
  if (event.action !== `risk_policy.external_filter.${action}`) {
    throw new ToolFilterMutationError(
      'Idempotency key was already used for a different runtime policy mutation.',
      409,
      'RUNTIME_POLICY_INVALID',
    );
  }
}

function canonicalPolicyEvent(
  context: UserLifecycleAuditContext,
  action: 'created' | 'updated' | 'deleted',
  value: ToolFilterRow,
  before: ToolFilterRow | null,
) {
  const scope = toolFilterAuditScope(context);
  const revision = isoTimestamp(value.updated_at);
  return {
    ...scope,
    solution: 'argus.core',
    actor: context.actor,
    action: `risk_policy.external_filter.${action}`,
    outcome: 'success' as const,
    risk: 'high' as const,
    resource: { type: 'runtime_policy', id: String(value.id), revision },
    policy: {
      id: `argus.external-tool-filter:${value.id}`,
      version: revision,
      decision: action === 'deleted' ? 'deleted' : value.enabled ? value.on_timeout : 'disabled',
    },
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload: {
      before: before == null ? null : auditSnapshot(before),
      after: action === 'deleted' ? null : auditSnapshot(value),
      context: { secretMaterial: 'excluded' },
    },
  };
}

/** Create an external runtime policy and canonical evidence in one transaction. */
export async function createToolFilterAudited(
  pool: pg.Pool,
  data: ToolFilterCreateInput,
  context: UserLifecycleAuditContext,
): Promise<AuditedToolFilterMutation> {
  assertSsrfSafe(data.webhook_url);
  const scope = toolFilterAuditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'risk_policy.external_filter.mutation', eventId: context.producerEventId },
    scope,
    client => createToolFilterRecord(client, data),
    value => canonicalPolicyEvent(context, 'created', value, null),
  );
  assertPolicyReplayAction(outcome.event, 'created');
  return {
    value: outcome.result ?? await loadToolFilterForReplay(pool, outcome.event),
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

/** Update an external runtime policy and canonical evidence in one transaction. */
export async function updateToolFilterAudited(
  pool: pg.Pool,
  id: number,
  data: ToolFilterUpdateInput,
  context: UserLifecycleAuditContext,
): Promise<AuditedToolFilterMutation> {
  if (data.webhook_url) assertSsrfSafe(data.webhook_url);
  const scope = toolFilterAuditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'risk_policy.external_filter.mutation', eventId: context.producerEventId },
    scope,
    async client => {
      const beforeResult = await client.query<ToolFilterRow>(
        'SELECT * FROM mcp_tool_filters WHERE id=$1 FOR UPDATE', [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw new ToolFilterMutationError('Runtime policy not found.', 404, 'RUNTIME_POLICY_NOT_FOUND');
      const value = await updateToolFilterRecord(client, id, data);
      if (!value) throw new ToolFilterMutationError('Runtime policy update is empty.', 400, 'RUNTIME_POLICY_INVALID');
      return { before, value };
    },
    result => canonicalPolicyEvent(context, 'updated', result.value, result.before),
  );
  assertPolicyReplayAction(outcome.event, 'updated');
  return {
    value: outcome.result?.value ?? await loadToolFilterForReplay(pool, outcome.event),
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

/** Delete an external runtime policy and canonical evidence in one transaction. */
export async function deleteToolFilterAudited(
  pool: pg.Pool,
  id: number,
  context: UserLifecycleAuditContext,
): Promise<AuditedToolFilterDeletion> {
  const scope = toolFilterAuditScope(context);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'risk_policy.external_filter.mutation', eventId: context.producerEventId },
    scope,
    async client => {
      const beforeResult = await client.query<ToolFilterRow>(
        'SELECT * FROM mcp_tool_filters WHERE id=$1 FOR UPDATE', [id],
      );
      const before = beforeResult.rows[0];
      if (!before) throw new ToolFilterMutationError('Runtime policy not found.', 404, 'RUNTIME_POLICY_NOT_FOUND');
      const deleted = await client.query('DELETE FROM mcp_tool_filters WHERE id=$1', [id]);
      if ((deleted.rowCount ?? 0) !== 1) {
        throw new ToolFilterMutationError('Runtime policy not found.', 404, 'RUNTIME_POLICY_NOT_FOUND');
      }
      return before;
    },
    value => canonicalPolicyEvent(context, 'deleted', value, value),
  );
  assertPolicyReplayAction(outcome.event, 'deleted');
  return { value: outcome.result, auditEvent: outcome.event, replayed: outcome.replayed };
}

// ── Pattern Matching ──────────────────────────────────────────

function matchPattern(toolName: string, pattern: string): boolean {
  // M1: Guard against ReDoS — limit pattern length and wildcard count
  if (pattern.length > 256) return false;
  const wildcardCount = (pattern.match(/[*%]/g) ?? []).length;
  if (wildcardCount > 8) return false;
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*%]/g, '[^]*');  // [^]* instead of .* avoids catastrophic backtracking
  return new RegExp(`^${re}$`, 'i').test(toolName);
}

function filterAppliesToTool(filter: ToolFilterRow, toolName: string): boolean {
  if (filter.tool_patterns.length === 0) return true;
  return filter.tool_patterns.some(p => matchPattern(toolName, p));
}

// ── HMAC Signatur ─────────────────────────────────────────────

function signPayload(payload: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
}

const MAX_FILTER_RESPONSE_BYTES = 64 * 1024;

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = '';
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_FILTER_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`Filter response exceeds ${MAX_FILTER_RESPONSE_BYTES} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return body;
}

function parseFilterResponse(raw: string): FilterWebhookResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Filter response must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Filter response must be a JSON object');
  }
  const body = parsed as Record<string, unknown>;
  if (body['allow'] === false) {
    return {
      allow: false,
      reason: typeof body['reason'] === 'string' && body['reason'].trim()
        ? body['reason'].trim().slice(0, 1000)
        : 'Denied by external policy',
    };
  }
  if (body['allow'] !== true) {
    throw new Error('Filter response must contain allow=true or allow=false');
  }
  if (body['args'] !== undefined && (
    !body['args'] || typeof body['args'] !== 'object' || Array.isArray(body['args'])
  )) {
    throw new Error('Filter response args must be a JSON object');
  }
  return {
    allow: true,
    ...(body['args'] !== undefined ? { args: body['args'] as Record<string, unknown> } : {}),
  };
}

interface FilterDispatchResult {
  status: number;
  latencyMs: number;
  signed: boolean;
  rawBody: string;
  response: FilterWebhookResponse;
}

async function dispatchFilter(
  filter: ToolFilterRow,
  payload: FilterWebhookPayload,
  test = false,
): Promise<FilterDispatchResult> {
  // Re-check at dispatch time. A value may have been imported or its DNS may
  // have changed after configuration, so create-time validation is not enough.
  await assertSsrfSafeResolved(filter.webhook_url, undefined, { failClosedOnDnsError: true });
  assertEgressAllowed(filter.webhook_url);

  const bodyStr = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Argus-MCP-Gateway/1.0',
    'X-Argus-Filter-Name': filter.name,
    ...(test ? { 'X-Argus-Test': 'true' } : {}),
  };
  const hmacSecret = decrypt(filter.hmac_secret) ?? filter.hmac_secret;
  if (hmacSecret) headers['X-Argus-Signature'] = signPayload(bodyStr, hmacSecret);

  const startedAt = Date.now();
  const res = await fetch(filter.webhook_url, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(filter.timeout_ms),
  });
  const rawBody = await readBoundedResponse(res);
  if (!res.ok) throw new Error(`Filter webhook returned HTTP ${res.status}`);
  return {
    status: res.status,
    latencyMs: Date.now() - startedAt,
    signed: Boolean(hmacSecret),
    rawBody,
    response: parseFilterResponse(rawBody),
  };
}

export async function testToolFilter(
  filter: ToolFilterRow,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolFilterTestResult> {
  const startedAt = Date.now();
  try {
    const result = await dispatchFilter(filter, {
      tool_name: toolName,
      args,
      api_key_prefix: null,
      session_id: 'console-policy-test',
      timestamp: new Date().toISOString(),
    }, true);
    const denied = result.response.allow === false;
    const reason = result.response.allow ? null : result.response.reason;
    return {
      reachable: true,
      status: result.status,
      ok: true,
      decision: denied ? 'deny' : 'allow',
      reason,
      latencyMs: result.latencyMs,
      signed: result.signed,
      responsePreview: result.rawBody.slice(0, 1000),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unreachable = /fetch failed|timed out|timeout|aborted|could not be resolved/i.test(message);
    return {
      reachable: !unreachable,
      status: null,
      ok: false,
      decision: unreachable ? 'unreachable' : 'invalid',
      reason: message.slice(0, 1000),
      latencyMs: Date.now() - startedAt,
      signed: Boolean(filter.hmac_secret),
      responsePreview: null,
    };
  }
}

// ── runFilters() ──────────────────────────────────────────────

/**
 * Läuft alle aktiven Filter sequenziell durch.
 * Gibt die (ggf. modifizierten) args zurück, oder einen Ablehnungsgrund.
 * Liest ausschließlich aus dem In-Memory-Cache — kein DB-Hit pro Tool-Call.
 */
export async function runFilters(
  toolName: string,
  args: Record<string, unknown>,
  context: { apiKeyPrefix: string | null; sessionId: string | null },
): Promise<FilterResult> {
  const activeFilters = cachedFilters.filter(
    f => f.enabled && filterAppliesToTool(f, toolName),
  );

  if (activeFilters.length === 0) {
    return { allowed: true, args };
  }

  let currentArgs = args;

  for (const filter of activeFilters) {
    const payload: FilterWebhookPayload = {
      tool_name: toolName,
      args: currentArgs,
      api_key_prefix: context.apiKeyPrefix,
      session_id: context.sessionId,
      timestamp: new Date().toISOString(),
    };

    try {
      const { response: body } = await dispatchFilter(filter, payload);

      if (!body.allow) {
        logger.info({ filter: filter.name, toolName, reason: (body as { allow: false; reason: string }).reason }, 'Tool call blocked by filter');
        return {
          allowed: false,
          reason: (body as { allow: false; reason: string }).reason ?? `Blocked by filter '${filter.name}'`,
        };
      }

      // Optional: modifizierte Args vom Webhook übernehmen
      const modifiedArgs = body.args;
      if (modifiedArgs) {
        currentArgs = modifiedArgs;
      }

    } catch (err) {
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      if (filter.on_timeout === 'deny') {
        const reason = `Filter '${filter.name}' ${isTimeout ? 'timed out' : 'failed'}: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn({ filter: filter.name, isTimeout }, reason);
        return { allowed: false, reason };
      }
      logger.warn({ filter: filter.name, err, isTimeout }, 'Filter webhook failed — allowing (on_timeout=allow)');
    }
  }

  return { allowed: true, args: currentArgs };
}
