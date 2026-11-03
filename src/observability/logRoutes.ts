import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { hasRole } from '../auth/roles.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { logger } from '../lib/logger.js';
import { getTelemetrySpan, getTelemetryTrace } from './telemetryStore.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerLogRoutes(
  app: Express,
  pool: pg.Pool | null,
  requireAuth: RequestHandler,
): void {
  app.get('/logs', requireAuth, (_req, res) => res.redirect(308, '/observe/logs'));

  app.get('/api/logs/indices', requireAuth, async (req, res) => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) { res.status(401).json({ error: 'Authentication required' }); return; }
    try {
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      res.set('Cache-Control', 'private, no-store');
      if (!pool) { res.json({ indices: [{ name: 'gateway', doc_count: 0 }] }); return; }
      const { rows } = await pool.query(
        `SELECT date_trunc('day', log.ts)::date::text AS name, count(*) AS doc_count
           FROM argus_logs log
          WHERE log.tenant_key=$1 AND log.workspace_key=$2
          GROUP BY 1 ORDER BY 1 DESC LIMIT 30`,
        [scope.tenantKey, scope.workspaceKey],
      );
      res.json({ indices: rows.length > 0 ? rows : [{ name: 'gateway', doc_count: 0 }] });
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      res.json({ indices: [{ name: 'gateway', doc_count: 0 }] });
    }
  });

  app.get('/api/logs/search', requireAuth, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user;
      if (!user) { res.status(401).json({ error: 'Authentication required' }); return; }
      const scope = resolveAuthorizedWorkspaceScope(req, user);
      res.set('Cache-Control', 'private, no-store');
      if (!pool) { res.json({ hits: [], total: '0' }); return; }

      const q = (req.query['q'] as string) || '';
      const level = (req.query['level'] as string) || '';
      const index = (req.query['index'] as string) || '';
      const source = (req.query['source'] as string) || '';
      const from = (req.query['from'] as string) || '';
      const to = (req.query['to'] as string) || '';
      const size = Math.min(parseInt(req.query['size'] as string) || 200, 1000);
      const traceId = (req.query['trace'] as string) || '';
      const rootTraceId = (req.query['root_trace'] as string) || '';
      const spanId = (req.query['span'] as string) || '';
      const agentId = req.query['agent'] == null ? null : Number(req.query['agent']);
      const workflowExecutionId = req.query['workflow_execution'] == null
        ? null
        : Number(req.query['workflow_execution']);

      for (const [label, value] of [['trace', traceId], ['root_trace', rootTraceId], ['span', spanId]]) {
        if (value && !UUID_PATTERN.test(value)) {
          res.status(400).json({ error: `Invalid ${label} id` });
          return;
        }
      }
      if (agentId != null && (!Number.isSafeInteger(agentId) || agentId <= 0)) {
        res.status(400).json({ error: 'Invalid agent id' });
        return;
      }
      if (workflowExecutionId != null && (!Number.isSafeInteger(workflowExecutionId) || workflowExecutionId <= 0)) {
        res.status(400).json({ error: 'Invalid workflow execution id' });
        return;
      }

      const telemetryAccess = {
        userId: user.id,
        observeAll: hasRole(user.role, 'agent_operator'),
        allowedBundleIds: user.allowed_bundles,
        tenantKey: scope.tenantKey,
        workspaceKey: scope.workspaceKey,
      };
      if (spanId && !await getTelemetrySpan(pool, spanId, telemetryAccess)) {
        res.status(404).json({ error: 'Span not found' });
        return;
      }
      for (const correlatedTraceId of [traceId, rootTraceId]) {
        if (correlatedTraceId && !await getTelemetryTrace(pool, correlatedTraceId, telemetryAccess)) {
          res.status(404).json({ error: 'Trace not found' });
          return;
        }
      }

      const conditions = ['log.tenant_key = $1', 'log.workspace_key = $2'];
      const params: unknown[] = [scope.tenantKey, scope.workspaceKey];
      let p = 3;

      if (q) {
        conditions.push(`(log.msg ILIKE $${p} OR log.data::text ILIKE $${p})`);
        params.push(`%${q}%`); p++;
      }
      if (level) { conditions.push(`log.level = $${p}`); params.push(level.toLowerCase()); p++; }
      if (index) { conditions.push(`log.ts::date = $${p}`); params.push(index); p++; }
      if (source) {
        conditions.push(`(log.backend ILIKE $${p} OR log.msg ILIKE $${p})`);
        params.push(`%${source}%`); p++;
      }
      if (from) { conditions.push(`log.ts >= $${p}`); params.push(new Date(from)); p++; }
      if (to) { conditions.push(`log.ts <= $${p}`); params.push(new Date(to)); p++; }
      if (traceId) { conditions.push(`log.trace_id = $${p}::uuid`); params.push(traceId); p++; }
      if (rootTraceId) { conditions.push(`log.root_trace_id = $${p}::uuid`); params.push(rootTraceId); p++; }
      if (spanId) { conditions.push(`log.span_id = $${p}::uuid`); params.push(spanId); p++; }
      if (agentId != null) { conditions.push(`log.agent_id = $${p}`); params.push(agentId); p++; }
      if (workflowExecutionId != null) {
        conditions.push(`log.workflow_execution_id = $${p}`); params.push(workflowExecutionId); p++;
      }

      const { rows } = await pool.query(
        `SELECT log.id, log.ts AS "@timestamp", log.level, log.msg AS message,
                log.tool, log.backend, log.req_id, log.root_trace_id, log.trace_id,
                log.span_id, log.agent_id, log.workflow_execution_id, log.data
           FROM argus_logs log
          WHERE ${conditions.join(' AND ')}
          ORDER BY log.ts DESC LIMIT $${p}`,
        [...params, size],
      );
      const total = rows.length === size ? `${size}+` : String(rows.length);
      res.json({ hits: rows, total });
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return;
      }
      logger.error({ err: error }, 'Failed to search logs');
      res.status(500).json({ error: 'Failed to search logs' });
    }
  });
}
