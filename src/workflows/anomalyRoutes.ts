/**
 * Spend anomaly cron worker + admin endpoints.
 *
 * Every 15 minutes:
 *   - per user: sum spend in last hour vs avg-hourly over last 7 days
 *   - if ratio > 3.0 AND current > 0.10 USD/EUR → write mcp_spend_anomalies row
 *   - POST to ALERTS_WEBHOOK_URL if configured
 *
 *   GET  /api/admin/anomalies              → unacknowledged (last 100)
 *   POST /api/admin/anomalies/:id/ack      → acknowledge
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';

const POLL_INTERVAL_MS = 15 * 60 * 1000;
const ANOMALY_RATIO = Number(process.env['SPEND_ANOMALY_RATIO'] ?? 3);
const ANOMALY_MIN = Number(process.env['SPEND_ANOMALY_MIN'] ?? 0.10);

interface UserSpend { user_id: number; username: string; current: number; avg_hourly_7d: number }

async function detectAnomalies(pool: pg.Pool): Promise<UserSpend[]> {
  // mcp_spend_logs schema may vary — keep query defensive.
  const probe = await pool.query<{ table_exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mcp_spend_logs') AS table_exists`
  );
  if (!probe.rows[0]?.table_exists) return [];

  const { rows } = await pool.query<UserSpend>(`
    WITH current_hour AS (
      SELECT user_id, COALESCE(SUM(cost_usd), 0)::float AS s
      FROM mcp_spend_logs WHERE timestamp > now() - interval '1 hour' AND user_id IS NOT NULL
      GROUP BY user_id
    ),
    week_baseline AS (
      SELECT user_id, COALESCE(SUM(cost_usd), 0)::float / 168.0 AS hourly_avg
      FROM mcp_spend_logs WHERE timestamp > now() - interval '7 days' AND user_id IS NOT NULL
      GROUP BY user_id
    )
    SELECT c.user_id,
           COALESCE(u.username, 'user-' || c.user_id::text) AS username,
           c.s AS current,
           COALESCE(w.hourly_avg, 0) AS avg_hourly_7d
    FROM current_hour c
    LEFT JOIN week_baseline w ON w.user_id = c.user_id
    LEFT JOIN mcp_users u ON u.id = c.user_id
    WHERE c.s > $1 AND (w.hourly_avg = 0 OR c.s / w.hourly_avg > $2)
  `, [ANOMALY_MIN, ANOMALY_RATIO]).catch((err) => {
    logger.warn({ err: String(err) }, 'anomalies: spend query skipped (schema mismatch?)');
    return { rows: [] as UserSpend[] };
  });
  return rows;
}

async function persistAnomalies(pool: pg.Pool, items: UserSpend[]): Promise<void> {
  for (const it of items) {
    // Skip if already exists in last 2h (avoid noise)
    const dup = await pool.query<{ id: number }>(
      `SELECT id FROM mcp_spend_anomalies
       WHERE user_id = $1 AND detected_at > now() - interval '2 hours' LIMIT 1`,
      [it.user_id]
    );
    if (dup.rows[0]) continue;
    await pool.query(
      `INSERT INTO mcp_spend_anomalies (user_id, username, current_spend, avg_7d, ratio)
       VALUES ($1, $2, $3, $4, $5)`,
      [it.user_id, it.username, it.current, it.avg_hourly_7d,
       it.avg_hourly_7d > 0 ? it.current / it.avg_hourly_7d : 999]
    );
    // Fire webhook (best-effort)
    const url = process.env['ALERTS_WEBHOOK_URL'];
    if (url) {
      void fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `⚠️ Spend anomaly: ${it.username} spent ${it.current.toFixed(4)} in last hour (avg=${it.avg_hourly_7d.toFixed(4)})`,
          source: 'argus-spend-anomaly',
        }),
      }).catch(() => {});
    }
  }
}

export function startAnomalyWorker(pool: pg.Pool): NodeJS.Timeout {
  logger.info({ intervalMs: POLL_INTERVAL_MS, ratio: ANOMALY_RATIO }, 'spend-anomaly worker started');
  const timer = setInterval(async () => {
    try {
      const items = await detectAnomalies(pool);
      if (items.length > 0) {
        await persistAnomalies(pool, items);
        logger.warn({ count: items.length }, 'spend anomalies detected');
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'anomaly worker tick failed');
    }
  }, POLL_INTERVAL_MS);
  timer.unref();
  return timer;
}

export function registerAnomalyRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  app.get('/api/admin/anomalies', requireAuth, async (req, res) => {
    if (!isAdmin(getRbacUser(req))) { res.status(403).json({ error: 'admin only' }); return; }
    const { rows } = await pool.query(
      `SELECT id, user_id, username, current_spend, avg_7d, ratio, detected_at, acknowledged_at, acknowledged_by
       FROM mcp_spend_anomalies ORDER BY detected_at DESC LIMIT 100`
    );
    res.json({ anomalies: rows });
  });
  app.post('/api/admin/anomalies/:id/ack', requireAuth, async (req, res) => {
    const u = getRbacUser(req);
    if (!isAdmin(u)) { res.status(403).json({ error: 'admin only' }); return; }
    await pool.query(
      `UPDATE mcp_spend_anomalies SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`,
      [Number(req.params['id']), u.username ?? 'admin']
    );
    res.json({ ok: true });
  });
}
