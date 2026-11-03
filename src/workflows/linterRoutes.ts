/**
 * Smart workflow linter — LLM reviews the workflow for issues and optimizations.
 *
 *   POST /api/workflows/:id/lint    body: { steps?: WorkflowStep[] }
 *     → { findings: [{ severity, step_id?, title, suggestion }] }
 *
 * If `steps` body present (e.g. unsaved draft from builder), lints that;
 * else loads the persisted workflow.
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { runAgentChatSync } from '../agents/agentRunner.js';
import type { Config } from '../config/env.js';
import type { WorkflowStep } from './types.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';

const LINT_SYSTEM = `You are the Argus Workflow Linter. The user shows you a workflow
(list of steps with their type, dependencies, and configs). Analyze it and return findings
about issues, performance bottlenecks, or possible simplifications.

Return ONLY a JSON object:
{
  "findings": [
    { "severity": "error" | "warning" | "info",
      "step_id": "<id or null for whole-workflow>",
      "title": "<short title>",
      "suggestion": "<concrete actionable advice>" }
  ]
}

Focus on:
- Logical bugs (cycles, dead-end branches, missing required args)
- Performance: steps that could run in parallel but are serial
- Cost: expensive agents called where cheaper ones suffice
- Reliability: missing on_error, no timeout on long-running calls
- Argus best-practices: prefer logic.response as terminal, name labels clearly
Max 8 findings, prioritize critical ones. Be concise.`.trim();

export function registerLinterRoutes(
  app: Express,
  pool: pg.Pool,
  config: Config,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
  app.post('/api/workflows/:id/lint', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    if (!id) { res.status(400).json({ error: 'invalid id' }); return; }
    let scope;
    try {
      scope = resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      throw error;
    }

    let steps: WorkflowStep[];
    const fromBody = (req.body as { steps?: WorkflowStep[] })?.steps;
    if (Array.isArray(fromBody) && fromBody.length > 0) {
      steps = fromBody;
    } else {
      const { rows } = await pool.query<{ steps: WorkflowStep[] }>(
        `SELECT steps FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
        [id, scope.tenantKey, scope.workspaceKey]
      );
      if (!rows[0]) { res.status(404).json({ error: 'workflow not found' }); return; }
      steps = rows[0]?.steps ?? [];
    }
    if (steps.length === 0) {
      res.json({ findings: [] });
      return;
    }

    // Lookup the copilot agent (re-using its skill is fine — we override
    // the prompt at user-message level).
    const { rows: agentRows } = await pool.query<{ id: number }>(
      `SELECT id FROM mcp_agents WHERE name = 'workflow_copilot' AND enabled = true LIMIT 1`
    );
    const agentId = agentRows[0]?.id;
    if (!agentId) {
      res.status(503).json({ error: 'workflow_copilot agent not found (run migration 090)' });
      return;
    }

    // Build a compact step description for the LLM.
    const compact = steps.map((s) => ({
      id: s.id, type: s.type ?? 'argus.tool', label: s.label,
      tool: s.tool, agent_id: s.agent_id, skill_id: s.skill_id,
      condition: s.condition, depends_on: s.depends_on, on_error: s.on_error,
    }));

    const userMessage = [
      'LINT MODE — return JSON {findings:[...]} only, no other text.',
      '',
      LINT_SYSTEM,
      '',
      '== Workflow steps (JSON) ==',
      JSON.stringify(compact, null, 2),
    ].join('\n');

    try {
      const sessionId = `lint-${randomUUID()}`;
      const result = await runAgentChatSync(agentId, sessionId, userMessage, pool, config);
      const content = (result.response ?? '').trim();
      let parsed: { findings?: Array<{ severity: string; step_id?: string; title: string; suggestion: string }> };
      try {
        parsed = JSON.parse(content);
      } catch {
        // Best-effort: try to extract a JSON object from the response
        const m = content.match(/\{[\s\S]*\}/);
        if (!m) {
          res.status(502).json({ error: 'linter did not return JSON', raw: content.slice(0, 300) });
          return;
        }
        parsed = JSON.parse(m[0]);
      }
      res.json({ findings: parsed.findings ?? [] });
    } catch (err) {
      logger.error({ err: String(err), id }, 'lint failed');
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}
