import pg from 'pg';
import { logger } from './logger.js';
import { auditLogCounter } from './metrics.js';

const { Pool } = pg;

export interface AuditEntry {
  apiKeyPrefix: string;
  tool: string;
  parameters: Record<string, unknown>;
  durationMs: number;
  resultSize: number;
  isError: boolean;
  errorMessage?: string;
}

let pool: pg.Pool | null = null;
let tableExists = false;

export async function initAuditLog(connectionUrl: string): Promise<void> {
  pool = new Pool({ connectionString: connectionUrl });

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mcp_audit_log (
        id            BIGSERIAL PRIMARY KEY,
        timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
        api_key_prefix VARCHAR(8),
        tool          VARCHAR(128) NOT NULL,
        parameters    JSONB,
        duration_ms   INTEGER,
        result_size   INTEGER,
        is_error      BOOLEAN DEFAULT false,
        error_message TEXT
      )
    `);

    // Index for time-based queries
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_timestamp ON mcp_audit_log (timestamp DESC)
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_mcp_audit_log_tool ON mcp_audit_log (tool)
    `);

    tableExists = true;
    logger.info('Audit log table initialized');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize audit log table - audit logging disabled');
  }
}

const SENSITIVE_KEYS = /password|secret|token|api_key|apikey|auth|credential|private/i;

/** Redact sensitive field values before storing in audit log. */
function redactParameters(params: Record<string, unknown>): Record<string, unknown> {
  if (!params || typeof params !== 'object') return {};
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    result[k] = SENSITIVE_KEYS.test(k) ? '••••••••' : v;
  }
  return result;
}

/** Extract only parameter names (no values) for DSGVO-compliant display. */
function sanitizeParameters(params: Record<string, unknown>): string {
  if (!params || typeof params !== 'object') return '';
  return Object.keys(params).join(', ').slice(0, 256);
}

export async function writeAuditEntry(entry: AuditEntry): Promise<void> {
  if (!pool || !tableExists) return;

  try {
    const paramSummary = sanitizeParameters(entry.parameters);
    const safeParameters = redactParameters(entry.parameters);
    await pool.query(
      `INSERT INTO mcp_audit_log (api_key_prefix, tool, parameters, param_summary, duration_ms, result_size, is_error, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.apiKeyPrefix,
        entry.tool,
        JSON.stringify(safeParameters),
        paramSummary,
        entry.durationMs,
        entry.resultSize,
        entry.isError,
        entry.errorMessage ?? null,
      ]
    );
    auditLogCounter.inc();
  } catch (err) {
    logger.error({ err, tool: entry.tool }, 'Failed to write audit log entry');
  }
}

// ── Audit log query functions (for Activity page) ────────────

export interface AuditLogFilters {
  from?: string;
  to?: string;
  apiKeyPrefix?: string;
  tool?: string;
  backend?: string;
  isError?: boolean;
  limit?: number;
  offset?: number;
}

export interface AuditLogRow {
  id: number;
  timestamp: string;
  api_key_prefix: string;
  tool: string;
  param_summary: string | null;
  duration_ms: number;
  result_size: number;
  is_error: boolean;
  error_message: string | null;
}

export async function queryAuditLog(filters: AuditLogFilters): Promise<{ entries: AuditLogRow[]; total: number }> {
  if (!pool) return { entries: [], total: 0 };

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (filters.from) {
    conditions.push(`timestamp >= $${idx}`);
    params.push(filters.from);
    idx++;
  }
  if (filters.to) {
    conditions.push(`timestamp <= $${idx}`);
    params.push(filters.to);
    idx++;
  }
  if (filters.apiKeyPrefix) {
    conditions.push(`api_key_prefix = $${idx}`);
    params.push(filters.apiKeyPrefix);
    idx++;
  }
  if (filters.tool) {
    conditions.push(`tool = $${idx}`);
    params.push(filters.tool);
    idx++;
  }
  if (filters.backend) {
    conditions.push(`tool ILIKE $${idx} || '_%'`);
    params.push(filters.backend);
    idx++;
  }
  if (filters.isError !== undefined) {
    conditions.push(`is_error = $${idx}`);
    params.push(filters.isError);
    idx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = filters.limit || 50;
  const offset = filters.offset || 0;

  const [dataRes, countRes] = await Promise.all([
    pool.query(
      `SELECT id, timestamp, api_key_prefix, tool, param_summary, duration_ms, result_size, is_error, error_message
       FROM mcp_audit_log ${where}
       ORDER BY timestamp DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total FROM mcp_audit_log ${where}`,
      params,
    ),
  ]);

  return { entries: dataRes.rows, total: countRes.rows[0].total };
}

export interface AuditStats {
  totalCalls: number;
  errorCount: number;
  errorRate: number;
  avgDuration: number;
  topTools: Array<{ tool: string; count: number; avg_duration: number }>;
  topApiKeys: Array<{ api_key_prefix: string; count: number }>;
  callsPerHour: Array<{ hour: string; count: number; errors: number }>;
}

export async function getAuditStats(hours: number = 24): Promise<AuditStats> {
  if (!pool) {
    return { totalCalls: 0, errorCount: 0, errorRate: 0, avgDuration: 0, topTools: [], topApiKeys: [], callsPerHour: [] };
  }

  const [statsRes, toolsRes, keysRes, timelineRes] = await Promise.all([
    pool.query(`
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_error)::int AS errors,
             ROUND(AVG(duration_ms)::numeric, 1)::float AS avg_duration
      FROM mcp_audit_log WHERE timestamp >= now() - interval '1 hour' * $1
    `, [hours]),
    pool.query(`
      SELECT tool, COUNT(*)::int AS count, ROUND(AVG(duration_ms)::numeric, 1)::float AS avg_duration
      FROM mcp_audit_log WHERE timestamp >= now() - interval '1 hour' * $1
      GROUP BY tool ORDER BY count DESC LIMIT 10
    `, [hours]),
    pool.query(`
      SELECT api_key_prefix, COUNT(*)::int AS count
      FROM mcp_audit_log WHERE timestamp >= now() - interval '1 hour' * $1 AND api_key_prefix IS NOT NULL
      GROUP BY api_key_prefix ORDER BY count DESC LIMIT 10
    `, [hours]),
    pool.query(`
      SELECT date_trunc('hour', timestamp) AS hour, COUNT(*)::int AS count,
             COUNT(*) FILTER (WHERE is_error)::int AS errors
      FROM mcp_audit_log WHERE timestamp >= now() - interval '1 hour' * $1
      GROUP BY date_trunc('hour', timestamp) ORDER BY hour
    `, [hours]),
  ]);

  const s = statsRes.rows[0];
  return {
    totalCalls: s.total,
    errorCount: s.errors,
    errorRate: s.total > 0 ? Math.round((s.errors / s.total) * 1000) / 10 : 0,
    avgDuration: s.avg_duration || 0,
    topTools: toolsRes.rows,
    topApiKeys: keysRes.rows,
    callsPerHour: timelineRes.rows.map(r => ({ hour: r.hour, count: r.count, errors: r.errors })),
  };
}

export async function getDistinctTools(): Promise<string[]> {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT DISTINCT tool FROM mcp_audit_log ORDER BY tool');
  return rows.map(r => r.tool);
}

export async function getDistinctApiKeys(): Promise<string[]> {
  if (!pool) return [];
  const { rows } = await pool.query('SELECT DISTINCT api_key_prefix FROM mcp_audit_log WHERE api_key_prefix IS NOT NULL ORDER BY api_key_prefix');
  return rows.map(r => r.api_key_prefix);
}

/** Derive distinct backend prefixes from tool names (everything before the first underscore). */
export async function getDistinctBackends(): Promise<string[]> {
  if (!pool) return [];
  const { rows } = await pool.query(`SELECT DISTINCT split_part(tool, '_', 1) AS backend FROM mcp_audit_log WHERE tool LIKE '%_%' ORDER BY backend`);
  return rows.map(r => r.backend);
}

/** Delete audit log entries older than the given number of days (default: 90). */
export async function cleanupAuditLog(retentionDays: number = 90): Promise<number> {
  if (!pool || !tableExists) return 0;
  try {
    const result = await pool.query(
      `DELETE FROM mcp_audit_log WHERE timestamp < now() - interval '1 day' * $1`,
      [retentionDays],
    );
    const deleted = result.rowCount ?? 0;
    if (deleted > 0) {
      logger.info({ deleted, retentionDays }, 'Audit log cleanup: old entries removed');
    }
    return deleted;
  } catch (err) {
    logger.error({ err }, 'Audit log cleanup failed');
    return 0;
  }
}

export async function closeAuditLog(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
