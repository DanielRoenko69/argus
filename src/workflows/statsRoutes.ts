/**
 * Workflow stats, tag updates, cost predictor, audit-trail viewer.
 *
 *   GET  /api/workflows/:id/stats       → 30-day aggregates
 *   PUT  /api/workflows/:id/tags        → replace tags array
 *   POST /api/workflows/cost-predict    → predict cost from step list
 *   GET  /api/workflows/:id/runs/:rid/audit → audit log slice for that run
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import type { WorkflowStep } from './types.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { canReadLegacyTimeWindowEvidence } from './legacyRunEvidence.js';

interface Stats30d {
  runs:        number;
  succeeded:   number;
  failed:      number;
  success_rate: number;
  avg_duration_ms: number;
  p99_duration_ms: number;
  last_run_at: string | null;
}

export function registerStatsRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  const requestScope = (req: Request, res: Response) => {
    try {
      return resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(404).json({ error: 'workflow not found' });
        return null;
      }
      throw error;
    }
  };

  // ── GET /api/workflows/:id/stats ─────────────────────────────
  app.get('/api/workflows/:id/stats', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    if (!id) { res.status(400).json({ error: 'invalid id' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows } = await pool.query<{
        runs: string; succeeded: string; failed: string;
        avg_ms: string | null; p99_ms: string | null; last_run: string | null;
      }>(`
        SELECT
          COUNT(*) AS runs,
          COUNT(*) FILTER (WHERE status = 'completed') AS succeeded,
          COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
          AVG(duration_ms)                              AS avg_ms,
          percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms,
          MAX(started_at)                               AS last_run
        FROM mcp_workflow_executions
        WHERE workflow_id = $1 AND tenant_key = $2 AND workspace_key = $3
          AND started_at > now() - interval '30 days'
      `, [id, scope.tenantKey, scope.workspaceKey]);
      const r = rows[0]!;
      const runs = Number(r.runs);
      const out: Stats30d = {
        runs,
        succeeded: Number(r.succeeded),
        failed:    Number(r.failed),
        success_rate: runs > 0 ? Number(r.succeeded) / runs : 0,
        avg_duration_ms: r.avg_ms ? Math.round(Number(r.avg_ms)) : 0,
        p99_duration_ms: r.p99_ms ? Math.round(Number(r.p99_ms)) : 0,
        last_run_at: r.last_run,
      };
      res.json(out);
    } catch (err) {
      logger.error({ err: String(err), id }, 'stats failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── PUT /api/workflows/:id/tags ─────────────────────────────
  app.put('/api/workflows/:id/tags', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const body = (req.body ?? {}) as { tags?: string[] };
    if (!id || !Array.isArray(body.tags)) {
      res.status(400).json({ error: 'tags[] required' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    const sanitized = body.tags
      .map((t) => String(t).trim().toLowerCase())
      .filter((t) => t.length > 0 && t.length <= 32 && /^[a-z0-9_:-]+$/.test(t))
      .slice(0, 20);
    try {
      const result = await pool.query(
        `UPDATE mcp_workflows SET tags = $2::text[], updated_at = now()
         WHERE id = $1 AND tenant_key = $3 AND workspace_key = $4`,
        [id, sanitized, scope.tenantKey, scope.workspaceKey]
      );
      if (result.rowCount === 0) { res.status(404).json({ error: 'workflow not found' }); return; }
      res.json({ tags: sanitized });
    } catch (err) {
      logger.error({ err: String(err), id }, 'tags update failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── POST /api/workflows/cost-predict ────────────────────────
  // Heuristic estimate: per agent-step, sum input + output token cost.
  // Model rates come from mcp_models if available; else fall back to defaults.
  app.post('/api/workflows/cost-predict', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { steps?: WorkflowStep[] };
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (steps.length === 0) {
      res.json({ total_usd: 0, breakdown: [] });
      return;
    }
    // Pull agent → model mapping for any agent_id in the workflow
    const agentIds = [...new Set(steps.filter((s) => s.type === 'argus.agent').map((s) => s.agent_id).filter(Boolean))] as number[];
    const agentModels = new Map<number, { model: string; max_tokens: number }>();
    if (agentIds.length > 0) {
      const { rows } = await pool.query<{ id: number; model: string; max_tokens: number }>(
        `SELECT id, model, max_tokens FROM mcp_agents WHERE id = ANY($1::int[])`,
        [agentIds]
      );
      for (const r of rows) agentModels.set(r.id, { model: r.model, max_tokens: r.max_tokens });
    }
    // Pull model rates
    const modelNames = [...new Set([...agentModels.values()].map((m) => m.model))];
    const modelRates = new Map<string, { input_per_1m: number; output_per_1m: number }>();
    if (modelNames.length > 0) {
      const { rows } = await pool.query<{ model_name: string; input_cost_per_million: string; output_cost_per_million: string }>(
        `SELECT model_name, input_cost_per_million, output_cost_per_million FROM mcp_models WHERE model_name = ANY($1::text[])`,
        [modelNames]
      ).catch(() => ({ rows: [] }));
      for (const r of rows) modelRates.set(r.model_name, {
        input_per_1m:  Number(r.input_cost_per_million)  || 0,
        output_per_1m: Number(r.output_cost_per_million) || 0,
      });
    }
    // Defaults for common models (USD per million)
    const defaultRates: Record<string, { input_per_1m: number; output_per_1m: number }> = {
      'gpt-4o':        { input_per_1m: 2.5,  output_per_1m: 10 },
      'gpt-4o-mini':   { input_per_1m: 0.15, output_per_1m: 0.6 },
      'gpt-5.1':       { input_per_1m: 1.5,  output_per_1m: 8 },
      'claude-opus-4-6': { input_per_1m: 15, output_per_1m: 75 },
      'claude-haiku-4-5': { input_per_1m: 1, output_per_1m: 5 },
    };

    let total = 0;
    const breakdown: Array<{ step_id: string; estimated_usd: number; reason: string }> = [];
    for (const s of steps) {
      let usd = 0; let reason = '';
      if (s.type === 'argus.agent' && s.agent_id) {
        const ag = agentModels.get(s.agent_id);
        if (ag) {
          const rates = modelRates.get(ag.model) ?? defaultRates[ag.model] ?? { input_per_1m: 1, output_per_1m: 3 };
          // Rough: prompt-length tokens ≈ chars/4; output ≈ max_tokens
          const promptStr = typeof s.args?.['prompt'] === 'string' ? (s.args['prompt'] as string) : '';
          const inTokens = Math.ceil(promptStr.length / 4);
          const outTokens = ag.max_tokens;
          usd = (inTokens * rates.input_per_1m + outTokens * rates.output_per_1m) / 1_000_000;
          reason = `${ag.model}: ~${inTokens} in + ${outTokens} out`;
        }
      } else if (s.type === 'argus.tool' || !s.type) {
        usd = 0; reason = 'tool call (no LLM cost)';
      } else if (s.type === 'argus.knowledge') {
        usd = 0.0002; reason = 'RAG embedding + search';
      }
      total += usd;
      breakdown.push({ step_id: s.id, estimated_usd: Math.round(usd * 10000) / 10000, reason });
    }
    res.json({ total_usd: Math.round(total * 10000) / 10000, breakdown });
  });

  // ── GET /api/workflows/:id/runs/:rid/audit ──────────────────
  // Returns audit log entries during this execution's time window.
  app.get('/api/workflows/:id/runs/:rid/audit', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const runId = Number(req.params['rid']);
    if (!wfId || !runId) { res.status(400).json({ error: 'invalid ids' }); return; }
    const user = getRbacUser(req);
    if (!isAdmin(user) && (user.allowed_bundles ?? []).length === 0) {
      res.status(403).json({ error: 'audit access denied' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows: runs } = await pool.query<{ started_at: string; completed_at: string | null; triggered_by: string | null }>(
        `SELECT started_at, completed_at, triggered_by
         FROM mcp_workflow_executions
         WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
        [runId, wfId, scope.tenantKey, scope.workspaceKey]
      );
      const run = runs[0];
      if (!run) { res.status(404).json({ error: 'run not found' }); return; }
      // Find audit entries overlapping the run window. Match also by triggered_by string.
      const endTs = run.completed_at ?? new Date().toISOString();
      const { rows: probe } = await pool.query<{ tbl: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='mcp_immutable_audit_log') AS tbl`
      );
      if (!probe[0]?.tbl) { res.json({ entries: [], note: 'no immutable audit log present' }); return; }
      // The legacy gateway audit table predates tenant attribution. Never use
      // a timestamp-only slice for a non-default workspace: it could mix
      // unrelated tenants. Canonical scoped evidence replaces this in the
      // dedicated Logs/Search P0. Even in default/default the slice is not
      // run-attributed, so it is limited to principals with audit.read.
      const legacyAllowed = canReadLegacyTimeWindowEvidence((req as AuthenticatedRequest).user, scope);
      const { rows: entries } = legacyAllowed
        ? await pool.query(
            `SELECT id, ts, event_type, api_key_prefix, model, tool, parameters, risk_level, error_type
             FROM mcp_immutable_audit_log
             WHERE ts BETWEEN $1 AND $2
             ORDER BY ts ASC LIMIT 500`,
            [run.started_at, endTs]
          ).catch(() => ({ rows: [] }))
        : { rows: [] as unknown[] };
      res.json({
        entries,
        run_window: { started_at: run.started_at, completed_at: run.completed_at, triggered_by: run.triggered_by },
        legacy_audit_unavailable: !legacyAllowed,
      });
    } catch (err) {
      logger.error({ err: String(err), wfId, runId }, 'audit fetch failed');
      res.status(500).json({ error: 'database error' });
    }
  });
}
