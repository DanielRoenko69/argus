import pg from 'pg';
import { logger } from './logger.js';
import { registry } from './metrics.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export interface DashboardMetrics {
  totalToolCalls: number;
  toolCallsToday: number;
  toolCallsThisWeek: number;
  errorRate24h: number;
  avgDuration24h: number;
  activeApiKeys24h: number;
  toolCallsTimeline: Array<{ hour: string; count: number; errors: number }>;
  topTools: Array<{ tool: string; count: number; avg_duration: number }>;
  topApiKeys: Array<{ api_key_prefix: string; count: number }>;
}

export async function initMetricsStore(connectionUrl: string): Promise<void> {
  pool = new Pool({ connectionString: connectionUrl, max: 3 });

  // Ensure tables exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mcp_metrics_snapshots (
      id              BIGSERIAL PRIMARY KEY,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
      metric_name     VARCHAR(128) NOT NULL,
      metric_value    DOUBLE PRECISION NOT NULL,
      labels          JSONB DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_metrics_ts ON mcp_metrics_snapshots (timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_mcp_metrics_name_ts ON mcp_metrics_snapshots (metric_name, timestamp DESC);

    CREATE TABLE IF NOT EXISTS mcp_metrics_hourly (
      id              BIGSERIAL PRIMARY KEY,
      hour            TIMESTAMPTZ NOT NULL,
      metric_name     VARCHAR(128) NOT NULL,
      sum_value       DOUBLE PRECISION NOT NULL DEFAULT 0,
      count_value     INTEGER NOT NULL DEFAULT 0,
      min_value       DOUBLE PRECISION,
      max_value       DOUBLE PRECISION,
      avg_value       DOUBLE PRECISION,
      labels          JSONB DEFAULT '{}',
      UNIQUE (hour, metric_name, labels)
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_metrics_hourly_ts ON mcp_metrics_hourly (hour DESC);

    CREATE TABLE IF NOT EXISTS mcp_server_events (
      id              BIGSERIAL PRIMARY KEY,
      timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
      event_type      VARCHAR(32) NOT NULL CHECK (event_type IN ('start', 'stop', 'error')),
      details         JSONB DEFAULT '{}'
    );
  `);

  logger.info('Metrics store initialized');
}

export async function closeMetricsStore(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/** Record a server lifecycle event. */
export async function recordServerEvent(eventType: 'start' | 'stop' | 'error', details: Record<string, unknown> = {}): Promise<void> {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO mcp_server_events (event_type, details) VALUES ($1, $2)',
      [eventType, JSON.stringify(details)],
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to record server event');
  }
}

/** Take a snapshot of current Prometheus metrics and write to DB. */
export async function snapshotMetrics(): Promise<void> {
  if (!pool) return;
  try {
    const metricsJson = await registry.getMetricsAsJSON();
    const values: Array<[string, number, Record<string, string>]> = [];

    for (const metric of metricsJson) {
      if (String(metric.type) === 'gauge' || String(metric.type) === 'counter') {
        for (const val of metric.values) {
          values.push([metric.name, val.value, val.labels as Record<string, string>]);
        }
      }
    }

    if (values.length === 0) return;

    // Batch insert
    const placeholders: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    for (const [name, value, labels] of values) {
      placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2})`);
      params.push(name, value, JSON.stringify(labels));
      idx += 3;
    }

    await pool.query(
      `INSERT INTO mcp_metrics_snapshots (metric_name, metric_value, labels) VALUES ${placeholders.join(', ')}`,
      params,
    );

    logger.debug({ count: values.length }, 'Metrics snapshot saved');
  } catch (err) {
    logger.warn({ err }, 'Failed to snapshot metrics');
  }
}

/** Aggregate raw snapshots into hourly buckets and cleanup old data. */
export async function aggregateHourlyMetrics(): Promise<void> {
  if (!pool) return;
  try {
    // Aggregate snapshots from the last 2 hours into hourly buckets
    await pool.query(`
      INSERT INTO mcp_metrics_hourly (hour, metric_name, sum_value, count_value, min_value, max_value, avg_value, labels)
      SELECT
        date_trunc('hour', timestamp) AS hour,
        metric_name,
        SUM(metric_value),
        COUNT(*)::int,
        MIN(metric_value),
        MAX(metric_value),
        AVG(metric_value),
        labels
      FROM mcp_metrics_snapshots
      WHERE timestamp >= date_trunc('hour', now()) - interval '2 hours'
      GROUP BY date_trunc('hour', timestamp), metric_name, labels
      ON CONFLICT (hour, metric_name, labels)
      DO UPDATE SET
        sum_value = EXCLUDED.sum_value,
        count_value = EXCLUDED.count_value,
        min_value = EXCLUDED.min_value,
        max_value = EXCLUDED.max_value,
        avg_value = EXCLUDED.avg_value
    `);

    // Cleanup: delete raw snapshots older than 7 days
    const { rowCount: deleted } = await pool.query(
      `DELETE FROM mcp_metrics_snapshots WHERE timestamp < now() - interval '7 days'`,
    );
    if (deleted && deleted > 0) {
      logger.info({ deleted }, 'Cleaned up old metric snapshots');
    }

    // Cleanup: delete hourly data older than 90 days
    await pool.query(
      `DELETE FROM mcp_metrics_hourly WHERE hour < now() - interval '90 days'`,
    );
  } catch (err) {
    logger.warn({ err }, 'Failed to aggregate hourly metrics');
  }
}

/** Get dashboard metrics combining audit log data with current Prometheus counters. */
export async function getDashboardMetrics(hours: number = 24, opts?: { backend?: string; toolsLimit?: number; keysLimit?: number }): Promise<DashboardMetrics> {
  const backendFilter = opts?.backend;
  const toolsLimit = Math.min(opts?.toolsLimit ?? 10, 50);
  const keysLimit = Math.min(opts?.keysLimit ?? 5, 20);
  if (!pool) {
    return {
      totalToolCalls: 0, toolCallsToday: 0, toolCallsThisWeek: 0,
      errorRate24h: 0, avgDuration24h: 0, activeApiKeys24h: 0,
      toolCallsTimeline: [], topTools: [], topApiKeys: [],
    };
  }

  try {
    // Build backend filter condition (tool names are prefixed with backend name)
    const bkWhere = backendFilter ? ` AND tool ILIKE $${2}||'%'` : '';
    const bkParams = backendFilter ? [hours, backendFilter + '_'] : [hours];
    // Ignore historical proxy audit rows when calculating MCP tool metrics.
    const gwExclude = ` AND tool NOT LIKE 'gateway.%'`;

    // All queries in parallel for performance
    const [totalRes, todayRes, weekRes, statsRes, timelineRes, topToolsRes, topKeysRes] = await Promise.all([
      // Total tool calls (all time)
      backendFilter
        ? pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE tool ILIKE $1||'%'${gwExclude}`, [backendFilter + '_'])
        : pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE 1=1${gwExclude}`),

      // Tool calls today
      backendFilter
        ? pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE timestamp >= date_trunc('day', now()) AND tool ILIKE $1||'%'${gwExclude}`, [backendFilter + '_'])
        : pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE timestamp >= date_trunc('day', now())${gwExclude}`),

      // Tool calls this week
      backendFilter
        ? pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE timestamp >= date_trunc('week', now()) AND tool ILIKE $1||'%'${gwExclude}`, [backendFilter + '_'])
        : pool.query(`SELECT COUNT(*)::int AS count FROM mcp_audit_log WHERE timestamp >= date_trunc('week', now())${gwExclude}`),

      // Error rate + avg duration (last N hours)
      pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE is_error)::int AS errors,
          ROUND(AVG(duration_ms)::numeric, 1)::float AS avg_duration,
          COUNT(DISTINCT api_key_prefix)::int AS active_keys
        FROM mcp_audit_log
        WHERE timestamp >= now() - interval '1 hour' * $1${bkWhere}${gwExclude}
      `, bkParams),

      // Timeline (hourly buckets for last N hours — generate_series fills gaps)
      pool.query(`
        SELECT
          s.hour,
          COALESCE(d.count, 0)::int AS count,
          COALESCE(d.errors, 0)::int AS errors
        FROM generate_series(
          date_trunc('hour', now() - interval '1 hour' * $1),
          date_trunc('hour', now()),
          interval '1 hour'
        ) AS s(hour)
        LEFT JOIN (
          SELECT
            date_trunc('hour', timestamp) AS hour,
            COUNT(*)::int AS count,
            COUNT(*) FILTER (WHERE is_error)::int AS errors
          FROM mcp_audit_log
          WHERE timestamp >= now() - interval '1 hour' * $1${bkWhere}${gwExclude}
          GROUP BY date_trunc('hour', timestamp)
        ) d ON d.hour = s.hour
        ORDER BY s.hour
      `, bkParams),

      // Top N tools
      pool.query(`
        SELECT tool, COUNT(*)::int AS count, ROUND(AVG(duration_ms)::numeric, 1)::float AS avg_duration
        FROM mcp_audit_log
        WHERE timestamp >= now() - interval '1 hour' * $1${bkWhere}${gwExclude}
        GROUP BY tool ORDER BY count DESC LIMIT ${toolsLimit}
      `, bkParams),

      // Top N API keys
      pool.query(`
        SELECT api_key_prefix, COUNT(*)::int AS count
        FROM mcp_audit_log
        WHERE timestamp >= now() - interval '1 hour' * $1 AND api_key_prefix IS NOT NULL${bkWhere}
        GROUP BY api_key_prefix ORDER BY count DESC LIMIT ${keysLimit}
      `, bkParams),
    ]);

    const stats = statsRes.rows[0];
    const total = stats.total || 0;
    const errors = stats.errors || 0;

    return {
      totalToolCalls: totalRes.rows[0].count,
      toolCallsToday: todayRes.rows[0].count,
      toolCallsThisWeek: weekRes.rows[0].count,
      errorRate24h: total > 0 ? Math.round((errors / total) * 1000) / 10 : 0,
      avgDuration24h: stats.avg_duration || 0,
      activeApiKeys24h: stats.active_keys || 0,
      toolCallsTimeline: timelineRes.rows.map(r => ({
        hour: r.hour,
        count: r.count,
        errors: r.errors,
      })),
      topTools: topToolsRes.rows,
      topApiKeys: topKeysRes.rows,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to get dashboard metrics');
    return {
      totalToolCalls: 0, toolCallsToday: 0, toolCallsThisWeek: 0,
      errorRate24h: 0, avgDuration24h: 0, activeApiKeys24h: 0,
      toolCallsTimeline: [], topTools: [], topApiKeys: [],
    };
  }
}
