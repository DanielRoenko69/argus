/**
 * Inspector routes — surface auxiliary data per execution run for debugging.
 *
 *   GET /api/workflows/:id/runs/:rid/memories     → memories retrieved by agent steps
 *   GET /api/workflows/:id/runs/:rid/hooks        → tool-hook decisions for this run
 *   GET /api/workflows/:id/bundles                → all bundles referenced by workflow's steps
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';
import { canReadLegacyTimeWindowEvidence } from './legacyRunEvidence.js';

export function registerInspectorRoutes(
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

  app.get('/api/workflows/:id/runs/:rid/memories', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const runId = Number(req.params['rid']);
    if (!wfId || !runId) { res.status(400).json({ error: 'invalid ids' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      // Find the run's time-window first
      const { rows: runs } = await pool.query<{ started_at: string; completed_at: string | null }>(
        `SELECT started_at, completed_at FROM mcp_workflow_executions
         WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
        [runId, wfId, scope.tenantKey, scope.workspaceKey]
      );
      if (!runs[0]) { res.status(404).json({ error: 'run not found' }); return; }
      const end = runs[0].completed_at ?? new Date().toISOString();
      // memories accessed/stored during window — best-effort via valid_from.
      // Rows are not run-attributed, so only audit readers get this slice.
      const legacyAllowed = canReadLegacyTimeWindowEvidence((req as AuthenticatedRequest).user, scope);
      const { rows: memories } = legacyAllowed ? await pool.query(
        `SELECT id, agent_id, memory_type, content, importance, created_at
         FROM mcp_agent_memory
         WHERE created_at BETWEEN $1 AND $2
         ORDER BY created_at DESC LIMIT 50`,
        [runs[0].started_at, end]
      ).catch(() => ({ rows: [] })) : { rows: [] as unknown[] };
      res.json({ memories, run_window: runs[0], legacy_memory_unavailable: !legacyAllowed });
    } catch (err) {
      logger.warn({ err: String(err), wfId, runId }, 'memory inspector failed');
      res.json({ memories: [], error: 'memory table missing or query failed' });
    }
  });

  app.get('/api/workflows/:id/runs/:rid/hooks', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    const runId = Number(req.params['rid']);
    if (!wfId || !runId) { res.status(400).json({ error: 'invalid ids' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows: runs } = await pool.query<{ started_at: string; completed_at: string | null }>(
        `SELECT started_at, completed_at FROM mcp_workflow_executions
         WHERE id = $1 AND workflow_id = $2 AND tenant_key = $3 AND workspace_key = $4`,
        [runId, wfId, scope.tenantKey, scope.workspaceKey]
      );
      if (!runs[0]) { res.status(404).json({ error: 'run not found' }); return; }
      const end = runs[0].completed_at ?? new Date().toISOString();
      const legacyAllowed = canReadLegacyTimeWindowEvidence((req as AuthenticatedRequest).user, scope);
      const { rows: hooks } = legacyAllowed ? await pool.query(
        `SELECT id, ts, event_type, tool, parameters, risk_level, error_type
         FROM mcp_immutable_audit_log
         WHERE ts BETWEEN $1 AND $2 AND event_type = 'tool_hook_decision'
         ORDER BY ts ASC LIMIT 200`,
        [runs[0].started_at, end]
      ).catch(() => ({ rows: [] })) : { rows: [] as unknown[] };
      res.json({ hooks, legacy_hooks_unavailable: !legacyAllowed });
    } catch (err) {
      res.json({ hooks: [], error: err instanceof Error ? err.message : String(err) });
    }
  });

  // For Bundle-Badges per node: returns which bundles each tool/agent/skill
  // referenced in the workflow belongs to.
  app.get('/api/workflows/:id/bundles', requireAuth, async (req, res) => {
    const wfId = Number(req.params['id']);
    if (!wfId) { res.status(400).json({ error: 'invalid id' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows: wfRows } = await pool.query<{ steps: unknown[] }>(
        `SELECT steps FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
        [wfId, scope.tenantKey, scope.workspaceKey]
      );
      if (!wfRows[0]) { res.status(404).json({ error: 'workflow not found' }); return; }
      const steps = (wfRows[0]?.steps as Array<{ id: string; type?: string; tool?: string; agent_id?: number; skill_id?: number }>) ?? [];
      const toolNames = new Set<string>();
      const agentIds  = new Set<number>();
      const skillIds  = new Set<number>();
      for (const s of steps) {
        if ((s.type === 'argus.tool' || !s.type) && s.tool) toolNames.add(s.tool);
        if (s.type === 'argus.agent' && s.agent_id) agentIds.add(s.agent_id);
        if (s.type === 'argus.skill' && s.skill_id) skillIds.add(s.skill_id);
      }
      const stepToBundles: Record<string, string[]> = {};
      const bundleNames = new Map<number, string>();
      const { rows: allBundles } = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM mcp_service_bundles WHERE id IN (
           SELECT DISTINCT bundle_id FROM mcp_tool_bundles
           UNION SELECT DISTINCT unnest(bundle_ids) FROM mcp_agents WHERE bundle_ids IS NOT NULL
           UNION SELECT DISTINCT bundle_id FROM mcp_bundle_skills
         )`
      ).catch(() => ({ rows: [] }));
      for (const b of allBundles) bundleNames.set(b.id, b.name);

      // tool → bundles
      if (toolNames.size > 0) {
        const { rows } = await pool.query<{ name: string; bundle_id: number }>(
          `SELECT t.name, tb.bundle_id FROM mcp_tools t
             JOIN mcp_tool_bundles tb ON tb.tool_id = t.id
             WHERE t.name = ANY($1::text[])`,
          [[...toolNames]]
        );
        const map = new Map<string, number[]>();
        for (const r of rows) {
          if (!map.has(r.name)) map.set(r.name, []);
          map.get(r.name)!.push(r.bundle_id);
        }
        for (const s of steps) {
          if (s.tool && map.has(s.tool)) {
            stepToBundles[s.id] = map.get(s.tool)!.map((id) => bundleNames.get(id) ?? `#${id}`);
          }
        }
      }
      // agent → bundle_ids[]
      if (agentIds.size > 0) {
        const { rows } = await pool.query<{ id: number; bundle_ids: number[] | null }>(
          `SELECT id, bundle_ids FROM mcp_agents WHERE id = ANY($1::int[])`,
          [[...agentIds]]
        );
        const map = new Map<number, number[]>();
        for (const r of rows) map.set(r.id, r.bundle_ids ?? []);
        for (const s of steps) {
          if (s.agent_id && map.has(s.agent_id)) {
            stepToBundles[s.id] = (map.get(s.agent_id) ?? []).map((id) => bundleNames.get(id) ?? `#${id}`);
          }
        }
      }
      // skill → bundles via mcp_bundle_skills
      if (skillIds.size > 0) {
        const { rows } = await pool.query<{ skill_id: number; bundle_id: number }>(
          `SELECT skill_id, bundle_id FROM mcp_bundle_skills WHERE skill_id = ANY($1::int[])`,
          [[...skillIds]]
        );
        const map = new Map<number, number[]>();
        for (const r of rows) {
          if (!map.has(r.skill_id)) map.set(r.skill_id, []);
          map.get(r.skill_id)!.push(r.bundle_id);
        }
        for (const s of steps) {
          if (s.skill_id && map.has(s.skill_id)) {
            stepToBundles[s.id] = map.get(s.skill_id)!.map((id) => bundleNames.get(id) ?? `#${id}`);
          }
        }
      }
      res.json({ stepBundles: stepToBundles });
    } catch (err) {
      res.json({ stepBundles: {}, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
