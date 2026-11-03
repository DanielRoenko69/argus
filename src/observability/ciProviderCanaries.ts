/**
 * Argus-owned persistence and console projection for the opt-in LangGraph CI
 * provider canaries. The LangGraph runtime owns provider credentials and the
 * outbound read-only request; Core stores only bounded status evidence.
 */

import type pg from 'pg';
import { LANGGRAPH_URL, WORKSPACE_SECRET } from '../config/env.js';
import { logger } from '../lib/logger.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type CiProviderCanaryStatus = 'ok' | 'failed' | 'timeout' | 'error';
export type CiProviderCanarySource = 'manual' | 'scheduled' | 'internal';

export interface CiProviderCanaryResult {
  provider: 'gitea' | 'github' | 'gitlab' | 'jenkins';
  external_id: string;
  status: CiProviderCanaryStatus;
  http_status: number | null;
  latency_ms: number;
  provider_status?: string;
  error_message?: string;
}

export interface CiProviderCanaryRunRecord {
  id: number;
  provider: CiProviderCanaryResult['provider'];
  externalId: string;
  status: CiProviderCanaryStatus;
  httpStatus: number | null;
  latencyMs: number;
  providerStatus: string | null;
  errorMessage: string | null;
  source: CiProviderCanarySource;
  triggeredBy: string | null;
  startedAt: string;
  completedAt: string;
}

export interface CiProviderCanaryOperationsResponse {
  generatedAt: string;
  state: {
    status: 'no_data' | 'healthy' | 'degraded';
    totalRuns: number;
    passingRuns: number;
    failingRuns: number;
    lastRunAt: string | null;
  };
  history: CiProviderCanaryRunRecord[];
}

export class CiProviderCanaryError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const ALLOWED_PROVIDERS = new Set<CiProviderCanaryResult['provider']>(['gitea', 'github', 'gitlab', 'jenkins']);
const MAX_HISTORY = 100;
const REQUEST_TIMEOUT_MS = 45_000;
const SCHEDULER_LOCK = 'argus:ci-provider-canary-scheduler';

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\r\n\t]+/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function safeError(value: unknown): string {
  return (value instanceof Error ? value.message : String(value))
    .replace(/(?:authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 320) || 'unknown error';
}

function asStatus(value: unknown): CiProviderCanaryStatus {
  if (value === 'ok' || value === 'failed' || value === 'timeout' || value === 'error') return value;
  throw new CiProviderCanaryError('LangGraph returned an invalid CI canary status');
}

function normalizeResult(value: unknown): CiProviderCanaryResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CiProviderCanaryError('LangGraph returned an invalid CI canary result');
  }
  const input = value as Record<string, unknown>;
  const provider = input['provider'];
  const externalId = boundedText(input['external_id'], 200);
  const latency = Number(input['latency_ms']);
  const httpStatus = input['http_status'] == null ? null : Number(input['http_status']);
  if (typeof provider !== 'string' || !ALLOWED_PROVIDERS.has(provider as CiProviderCanaryResult['provider'])) {
    throw new CiProviderCanaryError('LangGraph returned an invalid CI canary provider');
  }
  if (!externalId || !Number.isSafeInteger(latency) || latency < 0 || latency > 120_000) {
    throw new CiProviderCanaryError('LangGraph returned invalid CI canary timing data');
  }
  if (httpStatus !== null && (!Number.isSafeInteger(httpStatus) || httpStatus < 100 || httpStatus > 599)) {
    throw new CiProviderCanaryError('LangGraph returned an invalid CI canary HTTP status');
  }
  const status = asStatus(input['status']);
  return {
    provider: provider as CiProviderCanaryResult['provider'],
    external_id: externalId,
    status,
    http_status: httpStatus,
    latency_ms: latency,
    ...(boundedText(input['provider_status'], 120) ? { provider_status: boundedText(input['provider_status'], 120)! } : {}),
    ...(boundedText(input['error_message'], 320) ? { error_message: safeError(input['error_message']) } : {}),
  };
}

async function fetchCanaries(): Promise<CiProviderCanaryResult[]> {
  if (!WORKSPACE_SECRET) throw new CiProviderCanaryError('WORKSPACE_SECRET is required for CI canary execution');
  const response = await fetch(`${LANGGRAPH_URL.replace(/\/+$/, '')}/ci/canaries`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const message = boundedText(body['error'], 320) ?? `LangGraph returned HTTP ${response.status}`;
    throw new CiProviderCanaryError(message, response.status);
  }
  const results = body['results'];
  if (!Array.isArray(results) || results.length > 8) throw new CiProviderCanaryError('LangGraph returned an invalid CI canary result set');
  return results.map(normalizeResult);
}

export async function runCiProviderCanaries(
  pool: Queryable,
  options: { source: CiProviderCanarySource; triggeredBy?: string | null },
): Promise<CiProviderCanaryRunRecord[]> {
  const completedAt = new Date();
  const results = await fetchCanaries();
  const records: CiProviderCanaryRunRecord[] = [];
  for (const result of results) {
    const startedAt = new Date(completedAt.getTime() - result.latency_ms);
    const { rows } = await pool.query<{
      id: number; provider: CiProviderCanaryResult['provider']; external_id: string; status: CiProviderCanaryStatus;
      http_status: number | null; latency_ms: number; provider_status: string | null; error_message: string | null;
      source: CiProviderCanarySource; triggered_by: string | null; started_at: string | Date; completed_at: string | Date;
    }>(
      `INSERT INTO mcp_observability_ci_canary_runs
         (provider, external_id, status, http_status, latency_ms, provider_status, error_message, source, triggered_by, started_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, provider, external_id, status, http_status, latency_ms, provider_status, error_message,
                 source, triggered_by, started_at, completed_at`,
      [result.provider, result.external_id, result.status, result.http_status, result.latency_ms,
        result.provider_status ?? null, result.error_message ?? null, options.source,
        boundedText(options.triggeredBy, 160), startedAt, completedAt],
    );
    const row = rows[0]!;
    records.push(mapRecord(row));
  }
  return records;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapRecord(row: {
  id: number; provider: CiProviderCanaryResult['provider']; external_id: string; status: CiProviderCanaryStatus;
  http_status: number | null; latency_ms: number; provider_status: string | null; error_message: string | null;
  source: CiProviderCanarySource; triggered_by: string | null; started_at: string | Date; completed_at: string | Date;
}): CiProviderCanaryRunRecord {
  return {
    id: Number(row.id), provider: row.provider, externalId: row.external_id, status: row.status,
    httpStatus: row.http_status, latencyMs: Number(row.latency_ms), providerStatus: row.provider_status,
    errorMessage: row.error_message, source: row.source, triggeredBy: row.triggered_by,
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
  };
}

export async function getCiProviderCanaryOperations(pool: Queryable): Promise<CiProviderCanaryOperationsResponse> {
  const { rows } = await pool.query<{
    id: number; provider: CiProviderCanaryResult['provider']; external_id: string; status: CiProviderCanaryStatus;
    http_status: number | null; latency_ms: number; provider_status: string | null; error_message: string | null;
    source: CiProviderCanarySource; triggered_by: string | null; started_at: string | Date; completed_at: string | Date;
  }>(
    `SELECT id, provider, external_id, status, http_status, latency_ms, provider_status, error_message,
            source, triggered_by, started_at, completed_at
       FROM mcp_observability_ci_canary_runs
      ORDER BY completed_at DESC, id DESC
      LIMIT $1`,
    [MAX_HISTORY],
  );
  const history = rows.map(mapRecord);
  const passingRuns = history.filter(row => row.status === 'ok').length;
  const failingRuns = history.length - passingRuns;
  return {
    generatedAt: new Date().toISOString(),
    state: {
      status: history.length === 0 ? 'no_data' : failingRuns > 0 ? 'degraded' : 'healthy',
      totalRuns: history.length,
      passingRuns,
      failingRuns,
      lastRunAt: history[0]?.completedAt ?? null,
    },
    history,
  };
}

/**
 * Optional once-per-day rollout. It is deliberately separate from the
 * LangGraph opt-in flag: setting a target does not silently create scheduled
 * external traffic. A database advisory lock keeps multi-replica Core
 * deployments from probing the same targets concurrently.
 */
export function startCiProviderCanaryScheduler(pool: pg.Pool): NodeJS.Timeout | null {
  if (process.env['ARGUS_CI_CANARIES_SCHEDULED'] !== '1') return null;
  const intervalMs = Math.min(
    7 * 86_400_000,
    Math.max(60 * 60_000, Number(process.env['ARGUS_CI_CANARIES_SCHEDULE_INTERVAL_MS'] ?? 86_400_000) || 86_400_000),
  );
  let running = false;
  const poll = async (): Promise<void> => {
    if (running) return;
    running = true;
    let client: pg.PoolClient | null = null;
    let locked = false;
    try {
      client = await pool.connect();
      const lock = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [SCHEDULER_LOCK]);
      locked = Boolean(lock.rows[0]?.locked);
      if (!locked) return;
      const last = await client.query<{ last_at: string | Date | null }>(
        `SELECT max(completed_at) AS last_at FROM mcp_observability_ci_canary_runs WHERE source='scheduled'`,
      );
      const lastAt = last.rows[0]?.last_at;
      if (lastAt && Date.parse(new Date(lastAt).toISOString()) + intervalMs > Date.now()) return;
      await runCiProviderCanaries(pool, { source: 'scheduled', triggeredBy: 'scheduler' });
    } catch (error) {
      logger.warn({ err: error }, 'ci provider canary scheduler run failed');
    } finally {
      if (locked && client) await client.query('SELECT pg_advisory_unlock(hashtext($1))', [SCHEDULER_LOCK]).catch(() => undefined);
      client?.release();
      running = false;
    }
  };
  setTimeout(() => void poll(), 5_000).unref();
  const timer = setInterval(() => void poll(), intervalMs);
  timer.unref();
  logger.info({ interval_ms: intervalMs }, 'CI provider canary scheduler started');
  return timer;
}
