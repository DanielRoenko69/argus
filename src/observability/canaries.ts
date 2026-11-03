/**
 * Native synthetic Agent canaries.
 *
 * Scheduled and manually triggered probes call the normal Agent Chat runtime,
 * persist privacy-minimized execution evidence in PostgreSQL and reuse the
 * shared alerts webhook for failure/recovery transitions. Runtime settings are
 * DB-backed; credentials remain environment/Vault-only.
 */

import type pg from 'pg';
import { logger } from '../lib/logger.js';

type Queryable = Pick<pg.Pool, 'query'>;
export type CanaryStatus = 'ok' | 'failed' | 'timeout' | 'error';
export type CanarySource = 'scheduled' | 'manual';

interface CanaryDef {
  agentId: number;
  agentName: string;
  message: string;
  expectsContent?: string;
}

export interface CanaryResult {
  agentId: number;
  agentName: string;
  timestamp: string;
  status: CanaryStatus;
  latencyMs: number;
  errorMessage?: string;
}

export interface CanarySummary {
  agentId: number;
  agentName: string;
  total: number;
  okCount: number;
  failCount: number;
  successRate: number;
  p95LatencyMs: number;
  lastStatus: CanaryStatus | null;
  lastAt: string | null;
}

export interface CanaryRuntimeConfig {
  enabled: boolean;
  intervalMinutes: number;
  timeoutSeconds: number;
  retentionDays: number;
  agentIds: number[];
}

export interface CanaryConfigRecord extends CanaryRuntimeConfig {
  source: 'database' | 'environment';
  updatedAt: string | null;
  credentialConfigured: boolean;
  targetMode: 'automatic' | 'selected';
}

export interface CanaryRunRecord extends CanaryResult {
  id: number;
  source: CanarySource;
  triggeredBy: string | null;
  completedAt: string;
}

export interface CanaryOperationsResponse {
  generatedAt: string;
  config: CanaryConfigRecord;
  state: {
    status: 'disabled' | 'not_configured' | 'no_data' | 'healthy' | 'degraded' | 'running';
    totalTargets: number;
    passingTargets: number;
    failingTargets: number;
    lastRunAt: string | null;
    nextRunAt: string | null;
    running: boolean;
  };
  availableAgents: Array<{ id: number; name: string; label: string }>;
  canaries: CanarySummary[];
  history: CanaryRunRecord[];
}

const RING_SIZE = 50;
const WORKER_POLL_MS = 15_000;
const ADVISORY_LOCK = 'argus:synthetic-canaries';

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function environmentAgentIds(): number[] {
  const ids = (process.env['CANARIES_AGENT_IDS'] ?? '').split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isSafeInteger(value) && value > 0);
  return [...new Set(ids)].slice(0, 50);
}

const ENVIRONMENT_CONFIG: CanaryRuntimeConfig = {
  enabled: process.env['CANARIES_ENABLED'] === '1',
  intervalMinutes: boundedInteger(Number(process.env['CANARIES_INTERVAL_MS']) / 60_000, 5, 5, 1440),
  timeoutSeconds: boundedInteger(Number(process.env['CANARIES_TIMEOUT_MS']) / 1000, 30, 5, 120),
  retentionDays: boundedInteger(process.env['CANARIES_RETENTION_DAYS'], 30, 1, 90),
  agentIds: environmentAgentIds(),
};

const API_KEY = (process.env['CANARIES_API_KEY'] || process.env['MCP_API_KEYS']?.split(',')[0] || '').trim();
const BASE_URL = (process.env['CANARIES_BASE_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
const history = new Map<number, CanaryResult[]>();
const recentBadStreak = new Map<number, number>();
let running = false;

export class CanaryRunConflictError extends Error {}
export class CanaryConfigurationError extends Error {}

function push(agentId: number, result: CanaryResult): void {
  let ring = history.get(agentId);
  if (!ring) { ring = []; history.set(agentId, ring); }
  ring.push(result);
  if (ring.length > RING_SIZE) ring.shift();
}

/** Legacy in-process projection kept for the existing read-only endpoint. */
export function getAllResults(): Record<string, CanaryResult[]> {
  const out: Record<string, CanaryResult[]> = {};
  for (const [agentId, entries] of history) out[String(agentId)] = [...entries];
  return out;
}

/** Legacy in-process projection kept for the existing read-only endpoint. */
export function getSummaries(): CanarySummary[] {
  const out: CanarySummary[] = [];
  for (const [agentId, ring] of history) {
    const okCount = ring.filter(result => result.status === 'ok').length;
    const sorted = ring.map(result => result.latencyMs).sort((left, right) => left - right);
    const last = ring.at(-1);
    out.push({
      agentId,
      agentName: last?.agentName ?? `agent-${agentId}`,
      total: ring.length,
      okCount,
      failCount: ring.length - okCount,
      successRate: ring.length ? okCount / ring.length : 0,
      p95LatencyMs: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0,
      lastStatus: last?.status ?? null,
      lastAt: last?.timestamp ?? null,
    });
  }
  return out.sort((left, right) => left.agentId - right.agentId);
}

function exactBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new CanaryConfigurationError(`${field} must be a boolean`);
  return value;
}

function exactInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new CanaryConfigurationError(`${field} must be a whole number from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

export function normalizeCanaryConfig(value: unknown): CanaryRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CanaryConfigurationError('Canary configuration must be an object');
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input['agentIds']) || input['agentIds'].length > 50) {
    throw new CanaryConfigurationError('agentIds must contain at most 50 Agent IDs');
  }
  const agentIds = [...new Set(input['agentIds'].map(id => exactInteger(id, 'Agent ID', 1, Number.MAX_SAFE_INTEGER)))];
  return {
    enabled: exactBoolean(input['enabled'], 'enabled'),
    intervalMinutes: exactInteger(input['intervalMinutes'], 'intervalMinutes', 5, 1440),
    timeoutSeconds: exactInteger(input['timeoutSeconds'], 'timeoutSeconds', 5, 120),
    retentionDays: exactInteger(input['retentionDays'], 'retentionDays', 1, 90),
    agentIds,
  };
}

export function normalizeCanaryRunAgentIds(value: unknown): number[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length > 50) {
    throw new CanaryConfigurationError('agentIds must contain at most 50 Agent IDs');
  }
  return [...new Set(value.map(id => exactInteger(id, 'Agent ID', 1, Number.MAX_SAFE_INTEGER)))];
}

function parseStoredConfig(value: unknown): CanaryRuntimeConfig | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    return normalizeCanaryConfig(parsed);
  } catch {
    return null;
  }
}

function iso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function loadCanaryConfig(pool: Queryable): Promise<CanaryConfigRecord> {
  const { rows } = await pool.query<{ value: unknown; updated_at: string | Date }>(
    `SELECT value, updated_at FROM mcp_platform_settings
      WHERE category='synthetic_canaries' AND key='config'`,
  );
  const stored = rows[0] ? parseStoredConfig(rows[0].value) : null;
  const config = stored ?? ENVIRONMENT_CONFIG;
  return {
    ...config,
    source: stored ? 'database' : 'environment',
    updatedAt: stored ? iso(rows[0]?.updated_at) : null,
    credentialConfigured: Boolean(API_KEY),
    targetMode: config.agentIds.length ? 'selected' : 'automatic',
  };
}

export async function saveCanaryConfig(
  pool: pg.Pool,
  input: unknown,
  userId: number,
): Promise<CanaryConfigRecord> {
  const config = normalizeCanaryConfig(input);
  if (config.agentIds.length) {
    const { rows } = await pool.query<{ id: number }>(
      `SELECT id FROM mcp_agents
        WHERE id = ANY($1::int[]) AND enabled=true AND agent_mode='chat'`,
      [config.agentIds],
    );
    const eligible = new Set(rows.map(row => row.id));
    const invalid = config.agentIds.filter(id => !eligible.has(id));
    if (invalid.length) {
      throw new CanaryConfigurationError(`Agents are not eligible for chat canaries: ${invalid.join(', ')}`);
    }
  }
  await pool.query(
    `INSERT INTO mcp_platform_settings (category, key, value, updated_by, updated_at)
     VALUES ('synthetic_canaries', 'config', $1::jsonb, $2, now())
     ON CONFLICT (category, key) DO UPDATE
       SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [JSON.stringify(config), userId],
  );
  return loadCanaryConfig(pool);
}

async function discoverCanaries(pool: Queryable, agentIds: number[]): Promise<CanaryDef[]> {
  const selected = agentIds.length > 0;
  const { rows } = await pool.query<{ id: number; name: string; label: string }>(
    selected
      ? `SELECT id, name, label FROM mcp_agents
          WHERE id = ANY($1::int[]) AND enabled=true AND agent_mode='chat'
          ORDER BY label, id`
      : `SELECT id, name, label FROM mcp_agents
          WHERE enabled=true AND agent_mode='chat'
          ORDER BY label, id`,
    selected ? [agentIds] : [],
  );
  return rows.map(agent => ({
    agentId: agent.id,
    agentName: agent.label || agent.name,
    message: '[canary] Antworte mit einem Satz: bist du erreichbar?',
  }));
}

function safeFailureMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/(?:api[-_ ]?key|authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 300) || 'unknown error';
}

async function runCanary(definition: CanaryDef, timeoutSeconds: number): Promise<CanaryResult> {
  const started = Date.now();
  const timestamp = new Date(started).toISOString();
  try {
    const response = await fetch(`${BASE_URL}/api/agents/${definition.agentId}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'X-Langfuse-Session-Id': `canary-${definition.agentId}-${started}`,
      },
      body: JSON.stringify({ message: definition.message }),
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return {
        agentId: definition.agentId, agentName: definition.agentName, timestamp,
        status: 'failed', latencyMs,
        errorMessage: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
      };
    }
    const body = await response.json() as { response?: string };
    const content = (body.response ?? '').trim();
    if (!content) {
      return { agentId: definition.agentId, agentName: definition.agentName, timestamp, status: 'failed', latencyMs, errorMessage: 'empty response' };
    }
    if (definition.expectsContent && !content.toLowerCase().includes(definition.expectsContent.toLowerCase())) {
      return { agentId: definition.agentId, agentName: definition.agentName, timestamp, status: 'failed', latencyMs, errorMessage: 'expected content missing' };
    }
    return { agentId: definition.agentId, agentName: definition.agentName, timestamp, status: 'ok', latencyMs };
  } catch (error) {
    const message = safeFailureMessage(error);
    return {
      agentId: definition.agentId,
      agentName: definition.agentName,
      timestamp,
      status: /aborted|timeout/i.test(message) ? 'timeout' : 'error',
      latencyMs: Date.now() - started,
      errorMessage: message,
    };
  }
}

async function postCanaryAlert(kind: 'failure' | 'recovery', current: CanaryResult, previous?: CanaryResult): Promise<void> {
  const webhookUrl = process.env['ALERTS_WEBHOOK_URL'];
  if (!webhookUrl) return;
  const format = (process.env['ALERTS_WEBHOOK_FORMAT'] ?? 'slack').toLowerCase();
  const title = `${kind === 'failure' ? '🔴' : '🟢'} Canary ${kind === 'failure' ? 'failed' : 'recovered'}: ${current.agentName} (id=${current.agentId})`;
  const description = [
    `Status: ${current.status}`,
    `Latency: ${current.latencyMs}ms`,
    current.errorMessage ? `Error: ${current.errorMessage}` : null,
    previous ? `Previous: ${previous.status}` : null,
  ].filter(Boolean).join('\n');
  const payload = format === 'teams' ? {
    '@type': 'MessageCard', '@context': 'http://schema.org/extensions',
    themeColor: kind === 'failure' ? 'dc2626' : '16a34a', summary: title, title, text: description,
  } : format === 'generic' ? {
    title, severity: kind, description, timestamp: current.timestamp,
  } : { text: `*${title}*\n${description}` };
  try {
    await fetch(webhookUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(8_000),
    }).catch(() => undefined);
  } catch { /* Notification delivery must never fail the probe. */ }
}

async function maybeAlert(previous: CanaryResult | undefined, current: CanaryResult): Promise<void> {
  if (current.status === 'ok') {
    if (previous && previous.status !== 'ok') await postCanaryAlert('recovery', current, previous);
    recentBadStreak.set(current.agentId, 0);
    return;
  }
  const streak = (recentBadStreak.get(current.agentId) ?? 0) + 1;
  recentBadStreak.set(current.agentId, streak);
  if (streak === 1 || streak % 3 === 0) await postCanaryAlert('failure', current, previous);
}

async function latestResults(pool: Queryable, agentIds: number[]): Promise<Map<number, CanaryResult>> {
  if (!agentIds.length) return new Map();
  const { rows } = await pool.query<{
    agent_id: number; agent_name: string; status: CanaryStatus; latency_ms: number; started_at: string | Date; error_message: string | null;
  }>(
    `SELECT DISTINCT ON (agent_id)
            agent_id, agent_name, status, latency_ms, started_at, error_message
       FROM mcp_observability_canary_runs
      WHERE agent_id = ANY($1::int[])
      ORDER BY agent_id, completed_at DESC`,
    [agentIds],
  );
  return new Map(rows.map(row => [row.agent_id, {
    agentId: row.agent_id, agentName: row.agent_name, status: row.status,
    latencyMs: row.latency_ms, timestamp: iso(row.started_at)!,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
  }]));
}

async function persistResult(
  pool: Queryable,
  result: CanaryResult,
  source: CanarySource,
  triggeredBy: string | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO mcp_observability_canary_runs
      (agent_id, agent_name, status, latency_ms, error_message, source, triggered_by, started_at, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())`,
    [result.agentId, result.agentName, result.status, result.latencyMs, result.errorMessage ?? null, source, triggeredBy, result.timestamp],
  );
}

export async function runCanariesNow(
  pool: pg.Pool,
  options: { source: CanarySource; triggeredBy?: string | null; agentIds?: number[] },
): Promise<CanaryResult[]> {
  if (!API_KEY) throw new CanaryConfigurationError('No Canary API credential is configured');
  if (running) throw new CanaryRunConflictError('A Canary run is already active');
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [ADVISORY_LOCK]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) throw new CanaryRunConflictError('A Canary run is already active on another replica');
    running = true;
    const config = await loadCanaryConfig(client);
    const requested = options.agentIds ?? config.agentIds;
    const definitions = await discoverCanaries(client, requested);
    if (requested.length && definitions.length !== requested.length) {
      throw new CanaryConfigurationError('One or more selected Agents are disabled, missing, or not chat-capable');
    }
    const previous = await latestResults(client, definitions.map(definition => definition.agentId));
    const results = await Promise.all(definitions.map(definition => runCanary(definition, config.timeoutSeconds)));
    for (const result of results) {
      push(result.agentId, result);
      await persistResult(client, result, options.source, options.triggeredBy ?? null);
      await maybeAlert(previous.get(result.agentId), result);
    }
    await client.query(
      `DELETE FROM mcp_observability_canary_runs
        WHERE completed_at < now() - make_interval(days => $1)`,
      [config.retentionDays],
    );
    return results;
  } finally {
    running = false;
    if (locked) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK]).catch(() => undefined);
    client.release();
  }
}

interface SummaryRow {
  agent_id: number; agent_name: string; total: number; ok_count: number; fail_count: number;
  success_rate: number | string; p95_latency_ms: number | string; last_status: CanaryStatus; last_at: string | Date;
}

interface RunRow {
  id: number; agent_id: number; agent_name: string; status: CanaryStatus; latency_ms: number;
  error_message: string | null; source: CanarySource; triggered_by: string | null;
  started_at: string | Date; completed_at: string | Date;
}

export async function getCanaryOperations(pool: pg.Pool): Promise<CanaryOperationsResponse> {
  const [config, agents, summaryRows, runRows, scheduleRow] = await Promise.all([
    loadCanaryConfig(pool),
    pool.query<{ id: number; name: string; label: string }>(
      `SELECT id, name, label FROM mcp_agents WHERE enabled=true AND agent_mode='chat' ORDER BY label, id`,
    ),
    pool.query<SummaryRow>(
      `SELECT agent_id,
              (array_agg(agent_name ORDER BY completed_at DESC))[1] AS agent_name,
              count(*)::int AS total,
              count(*) FILTER (WHERE status='ok')::int AS ok_count,
              count(*) FILTER (WHERE status<>'ok')::int AS fail_count,
              round(100.0 * count(*) FILTER (WHERE status='ok') / count(*), 1)::float8 AS success_rate,
              coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms), 0)::int AS p95_latency_ms,
              (array_agg(status ORDER BY completed_at DESC))[1] AS last_status,
              max(completed_at) AS last_at
         FROM mcp_observability_canary_runs
        WHERE completed_at > now() - interval '24 hours'
        GROUP BY agent_id
        ORDER BY agent_id`,
    ),
    pool.query<RunRow>(
      `SELECT id, agent_id, agent_name, status, latency_ms, error_message,
              source, triggered_by, started_at, completed_at
         FROM mcp_observability_canary_runs
        ORDER BY completed_at DESC, id DESC
        LIMIT 100`,
    ),
    pool.query<{ last_scheduled_at: string | Date | null }>(
      `SELECT max(completed_at) AS last_scheduled_at
         FROM mcp_observability_canary_runs WHERE source='scheduled'`,
    ),
  ]);
  const availableAgents = agents.rows.map(agent => ({ id: agent.id, name: agent.name, label: agent.label || agent.name }));
  const canaries: CanarySummary[] = summaryRows.rows.map(row => ({
    agentId: row.agent_id, agentName: row.agent_name, total: Number(row.total),
    okCount: Number(row.ok_count), failCount: Number(row.fail_count), successRate: Number(row.success_rate),
    p95LatencyMs: Number(row.p95_latency_ms), lastStatus: row.last_status, lastAt: iso(row.last_at),
  }));
  const currentTargetIds = new Set(config.agentIds.length ? config.agentIds : availableAgents.map(agent => agent.id));
  const currentCanaries = canaries.filter(canary => currentTargetIds.has(canary.agentId));
  const historyRecords: CanaryRunRecord[] = runRows.rows.map(row => ({
    id: Number(row.id), agentId: row.agent_id, agentName: row.agent_name,
    status: row.status, latencyMs: row.latency_ms, timestamp: iso(row.started_at)!,
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    source: row.source, triggeredBy: row.triggered_by, completedAt: iso(row.completed_at)!,
  }));
  const lastRunAt = historyRecords[0]?.completedAt ?? null;
  const lastScheduledAt = iso(scheduleRow.rows[0]?.last_scheduled_at);
  const nextRunAt = config.enabled && config.credentialConfigured
    ? new Date(Math.max(Date.now(), (lastScheduledAt ? Date.parse(lastScheduledAt) : Date.now()) + config.intervalMinutes * 60_000)).toISOString()
    : null;
  const failingTargets = currentCanaries.filter(canary => canary.lastStatus !== 'ok').length;
  const passingTargets = currentCanaries.filter(canary => canary.lastStatus === 'ok').length;
  const status = running ? 'running'
    : !config.enabled ? 'disabled'
      : !config.credentialConfigured ? 'not_configured'
        : currentCanaries.length === 0 ? 'no_data'
          : failingTargets > 0 ? 'degraded' : 'healthy';
  return {
    generatedAt: new Date().toISOString(),
    config,
    state: {
      status, totalTargets: currentTargetIds.size, passingTargets, failingTargets,
      lastRunAt, nextRunAt, running,
    },
    availableAgents,
    canaries,
    history: historyRecords,
  };
}

async function scheduledPoll(pool: pg.Pool): Promise<void> {
  if (running) return;
  try {
    const config = await loadCanaryConfig(pool);
    if (!config.enabled || !config.credentialConfigured) return;
    const { rows } = await pool.query<{ last_at: string | Date | null }>(
      `SELECT max(completed_at) AS last_at FROM mcp_observability_canary_runs WHERE source='scheduled'`,
    );
    const lastAt = iso(rows[0]?.last_at);
    if (lastAt && Date.parse(lastAt) + config.intervalMinutes * 60_000 > Date.now()) return;
    await runCanariesNow(pool, { source: 'scheduled' });
  } catch (error) {
    if (!(error instanceof CanaryRunConflictError)) logger.warn({ err: error }, 'canaries: scheduled run failed');
  }
}

export function startCanaries(pool: pg.Pool): NodeJS.Timeout {
  setTimeout(() => void scheduledPoll(pool), 5_000).unref();
  const timer = setInterval(() => void scheduledPoll(pool), WORKER_POLL_MS);
  timer.unref();
  logger.info({
    enabled: ENVIRONMENT_CONFIG.enabled,
    interval_min: ENVIRONMENT_CONFIG.intervalMinutes,
    timeout_sec: ENVIRONMENT_CONFIG.timeoutSeconds,
    explicit_ids: ENVIRONMENT_CONFIG.agentIds.length ? ENVIRONMENT_CONFIG.agentIds : '(auto-discover chat agents)',
    credential_configured: Boolean(API_KEY),
  }, 'synthetic canary worker started; database settings override environment defaults');
  return timer;
}
