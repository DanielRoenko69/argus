/**
 * Visual Workflow Builder — backend routes.
 *
 * Endpoints serve the React workflow-builder app (in workflow-builder/).
 * The builder reads/writes flow definition + canvas state, and triggers
 * execution via the existing executor.ts.
 *
 * Routes:
 *   GET  /api/workflows/:id/flow       → workflow + canvas_state + block_definitions
 *   PUT  /api/workflows/:id/flow       → save visual state
 *   GET  /api/workflows/palette        → available skills/agents/tools/knowledge for builder fields
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import { snapshotVersion } from './versionRoutes.js';
import { normalizeWorkflowAgentRequirements } from './agentContracts.js';
import { buildWorkflowIntegrations, loadAccessibleWorkflowTools } from './integrationCatalog.js';
import { findInlineWorkflowCredentials } from './inlineCredentialPolicy.js';
import type { WorkflowAgentRequirement } from './types.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
  type AuthorizedWorkspaceScope,
} from '../auth/workspaceScope.js';

/** Shape of one entry in mcp_tools.parameters JSONB (P2-4). */
interface PaletteRagIndex {
  id: number;
  name: string;
  label: string;
  provider: string;
  description: string;
}

interface PaletteAgent {
  id: number;
  name: string;
  label: string;
  agent_mode: string;
  model: string;
  agent_role: string | null;
  runtime_type: string | null;
  runtime_profile_label: string | null;
  runtime_model: string | null;
  runtime_enabled: boolean | null;
}

interface FlowResponse {
  id: number;
  name: string;
  description: string;
  steps: unknown[];
  input_params: unknown[];
  canvas_state: Record<string, unknown>;
  trigger_config: Record<string, unknown>;
  block_definitions: unknown[];
  source: string;
  enabled: boolean;
  updated_at: string;
  agent_requirements: WorkflowAgentRequirement[];
  ai_act_governed: boolean;
  ai_system_id: string | null;
  ai_system_revision: number | null;
}

interface FlowUpdateBody {
  steps?: unknown[];
  input_params?: unknown[];
  canvas_state?: Record<string, unknown>;
  trigger_config?: Record<string, unknown>;
  block_definitions?: unknown[];
  agent_requirements?: WorkflowAgentRequirement[];
}

export function registerFlowRoutes(app: Express, pool: pg.Pool, requireAuth: (req: Request, res: Response, next: () => void) => void): void {
  const requestScope = (req: Request, res: Response): AuthorizedWorkspaceScope | null => {
    try {
      return resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(error.status).json({ error: error.message, code: error.code });
        return null;
      }
      throw error;
    }
  };

  // ── GET /api/workflows/:id/flow ─────────────────────────────
  app.get('/api/workflows/:id/flow', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }
    const user = getRbacUser(req);
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      // RBAC: bundle-overlap on mcp_workflow_bundles. Admins bypass the check.
      let sql = `SELECT id, name, description, steps, input_params,
                canvas_state, trigger_config, block_definitions,
                source, enabled, updated_at, tags, lifecycle_status,
                human_oversight_required, agent_requirements,
                ai_act_governed, ai_system_id, ai_system_revision
         FROM mcp_workflows
         WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
      const params: unknown[] = [id, scope.tenantKey, scope.workspaceKey];
      if (!isAdmin(user)) {
        sql += ` AND (
          NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id)
          OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = mcp_workflows.id AND wb.bundle_id = ANY($4::int[]))
        )`;
        params.push(user.allowed_bundles ?? []);
      }
      const { rows } = await pool.query<FlowResponse & { tags?: string[]; lifecycle_status?: string }>(sql, params);
      if (rows.length === 0) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      // can_edit: admin always; non-admin only if workflow has at least one
      // bundle the user is in. Production workflows = admin-only edit.
      let canEdit = true;
      if (!isAdmin(user)) {
        const { rows: wb } = await pool.query<{ has: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM mcp_workflow_bundles wb
             WHERE wb.workflow_id = $1 AND wb.bundle_id = ANY($2::int[])
           ) AS has`,
          [id, user.allowed_bundles ?? []]
        );
        canEdit = wb[0]?.has ?? false;
      }
      if (rows[0]!.lifecycle_status === 'production' && !isAdmin(user)) {
        canEdit = false;
      }
      res.json({ ...rows[0], can_edit: canEdit });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, id }, 'flow:get failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── PUT /api/workflows/:id/flow ─────────────────────────────
  app.put('/api/workflows/:id/flow', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }

    // RBAC: same bundle-overlap check as GET — can't save what you can't see.
    const user = getRbacUser(req);
    const scope = requestScope(req, res);
    if (!scope) return;
    {
      const visibilityParams: unknown[] = [id, scope.tenantKey, scope.workspaceKey];
      let visibilitySql = `SELECT id FROM mcp_workflows
        WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`;
      if (!isAdmin(user)) {
        visibilitySql += ` AND (
          NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = $1)
          OR EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = $1 AND wb.bundle_id = ANY($4::int[]))
        )`;
        visibilityParams.push(user.allowed_bundles ?? []);
      }
      const { rows: visible } = await pool.query<{ id: number }>(visibilitySql, visibilityParams);
      if (visible.length === 0) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
    }

    const body = (req.body ?? {}) as FlowUpdateBody;

    // audit (input validation): reject malformed/oversized arrays BEFORE writing
    // them to JSONB. A non-array `steps` crashes the executor/validator
    // (`steps.find`, `s.depends_on`) and an unbounded array bloats the row + every
    // version snapshot.
    const MAX_STEPS = 500;
    if (body.steps !== undefined && (!Array.isArray(body.steps) || body.steps.length > MAX_STEPS)) {
      res.status(400).json({ error: `steps must be an array of at most ${MAX_STEPS} entries` });
      return;
    }
    if (body.block_definitions !== undefined && (!Array.isArray(body.block_definitions) || body.block_definitions.length > MAX_STEPS)) {
      res.status(400).json({ error: `block_definitions must be an array of at most ${MAX_STEPS} entries` });
      return;
    }
    if (body.input_params !== undefined && !Array.isArray(body.input_params)) {
      res.status(400).json({ error: 'input_params must be an array' });
      return;
    }

    const inlineCredentials = findInlineWorkflowCredentials(
      body.steps ?? [],
      body.block_definitions ?? [],
      body.input_params ?? [],
    );
    if (inlineCredentials.length > 0) {
      res.status(422).json({
        error: 'Workflow credentials must be managed by MCP Fabric',
        issues: inlineCredentials,
      });
      return;
    }

    const fields: string[] = [];
    const params: unknown[] = [id];
    let idx = 2;

    if (body.steps !== undefined) {
      fields.push(`steps = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.steps));
    }
    if (body.input_params !== undefined) {
      fields.push(`input_params = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.input_params));
    }
    if (body.canvas_state !== undefined) {
      fields.push(`canvas_state = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.canvas_state));
    }
    if (body.trigger_config !== undefined) {
      fields.push(`trigger_config = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.trigger_config));
    }
    if (body.block_definitions !== undefined) {
      fields.push(`block_definitions = $${idx++}::jsonb`);
      params.push(JSON.stringify(body.block_definitions));
    }
    if (body.agent_requirements !== undefined) {
      try {
        fields.push(`agent_requirements = $${idx++}::jsonb`);
        params.push(JSON.stringify(normalizeWorkflowAgentRequirements(body.agent_requirements)));
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : 'invalid Agent requirements' });
        return;
      }
    }
    // Stamp source=visual so we know this was saved via the builder
    fields.push(`source = 'visual'`);
    fields.push(`updated_at = now()`);

    if (fields.length === 2) {
      res.status(400).json({ error: 'no fields to update' });
      return;
    }

    try {
      const { rowCount } = await pool.query(
        `UPDATE mcp_workflows SET ${fields.join(', ')}
          WHERE id = $1 AND tenant_key = $${idx} AND workspace_key = $${idx + 1}`,
        [...params, scope.tenantKey, scope.workspaceKey]
      );
      if (rowCount === 0) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      // Fire-and-forget version snapshot (failure mustn't block the save)
      void snapshotVersion(pool, id, user.username ?? 'anonymous', undefined, scope).catch((err) => {
        logger.warn({ err: String(err), id }, 'version snapshot failed');
      });
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg, id }, 'flow:put failed');
      res.status(500).json({ error: 'database error' });
    }
  });

  // ── GET /api/workflows/palette ──────────────────────────────
  // Returns Skills, Agents, Tools FILTERED by the requesting user's
  // allowed_bundles. Admins (allowed_bundles === null) see everything.
  // Bundle-overlap rule:
  //   * entity with no bundle bindings  → visible to all
  //   * entity with bundle bindings     → user must share at least one
  app.get('/api/workflows/palette', requireAuth, async (req, res) => {
    const user = getRbacUser(req);
    const admin = isAdmin(user);
    const bundles = admin ? null : (user.allowed_bundles ?? []);

    try {
      // Skills — bound via mcp_bundle_skills junction
      const skillsQ = admin
        ? pool.query<{ id: number; name: string; label: string; category: string }>(
            `SELECT id, name, label, category FROM mcp_skills WHERE enabled = true ORDER BY name`
          )
        : pool.query<{ id: number; name: string; label: string; category: string }>(
            `SELECT s.id, s.name, s.label, s.category
             FROM mcp_skills s
             WHERE s.enabled = true
               AND (NOT EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id)
                    OR EXISTS (SELECT 1 FROM mcp_bundle_skills bs WHERE bs.skill_id = s.id AND bs.bundle_id = ANY($1::int[])))
             ORDER BY s.name`,
            [bundles]
          );

      // Agents — bundle_ids is an INTEGER[] column on mcp_agents
      const agentsQ = admin
        ? pool.query<PaletteAgent>(
            `SELECT agent.id, agent.name, agent.label, agent.agent_mode, agent.model, agent.agent_role,
                    runtime.runtime_type,
                    runtime.label AS runtime_profile_label,
                    runtime.model AS runtime_model,
                    runtime.enabled AS runtime_enabled
             FROM mcp_agents agent
             LEFT JOIN mcp_agent_runtime_profiles runtime ON runtime.id = agent.runtime_profile_id
             WHERE agent.enabled = true
             ORDER BY agent.name`
          )
        : pool.query<PaletteAgent>(
            `SELECT agent.id, agent.name, agent.label, agent.agent_mode, agent.model, agent.agent_role,
                    runtime.runtime_type,
                    runtime.label AS runtime_profile_label,
                    runtime.model AS runtime_model,
                    runtime.enabled AS runtime_enabled
             FROM mcp_agents agent
             LEFT JOIN mcp_agent_runtime_profiles runtime ON runtime.id = agent.runtime_profile_id
             WHERE agent.enabled = true
               AND (agent.bundle_ids IS NULL OR agent.bundle_ids = '{}' OR agent.bundle_ids && $1::int[])
             ORDER BY agent.name`,
            [bundles]
          );

      // Tools — bound via mcp_tool_bundles junction.
      // P2-4: include each tool's parameters JSONB so the builder can render
      // a typed argument form. schema flag is derived below.
      const toolsQ = loadAccessibleWorkflowTools(pool, admin ? null : bundles);

      // Standalone Knowledge nodes need a real source picker. Admins see every
      // enabled source. Until Knowledge gets its own bundle junction, non-admins
      // only see sources attached to an agent that is visible through their
      // bundles. This preserves the palette's fail-closed RBAC behaviour.
      const ragIndexesQ = admin
        ? pool.query<PaletteRagIndex>(
            `SELECT id, name, label, provider, description
             FROM mcp_rag_indexes
             WHERE enabled = true
             ORDER BY label, name`
          )
        : pool.query<PaletteRagIndex>(
            `SELECT DISTINCT r.id, r.name, r.label, r.provider, r.description
             FROM mcp_rag_indexes r
             JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id
             JOIN mcp_agents a ON a.id = ar.agent_id
             WHERE r.enabled = true
               AND a.enabled = true
               AND (a.bundle_ids IS NULL OR a.bundle_ids = '{}' OR a.bundle_ids && $1::int[])
             ORDER BY r.label, r.name`,
            [bundles]
          );

      const [skills, agents, tools, ragIndexes] = await Promise.all([
        skillsQ.catch(() => ({ rows: [] })),
        agentsQ.catch(() => ({ rows: [] })),
        toolsQ.catch(() => []),
        ragIndexesQ.catch(() => ({ rows: [] as PaletteRagIndex[] })),
      ]);

      // Item 3: attach the (enabled) RAG indexes bound to each agent so the
      // builder can offer a per-agent subset selector. Scope is AGENT-BINDING
      // ONLY (mcp_rag_indexes has no bundle column); the agents list above is
      // already RBAC-filtered, so a batched join over those ids is safe.
      const agentIds = agents.rows.map((a) => a.id);
      const ragByAgent = new Map<number, Array<{ id: number; label: string; name: string }>>();
      if (agentIds.length > 0) {
        const { rows: ragRows } = await pool
          .query<{ agent_id: number; id: number; label: string; name: string }>(
            `SELECT ar.agent_id, r.id, r.label, r.name
             FROM mcp_agent_rag_indexes ar
             JOIN mcp_rag_indexes r ON r.id = ar.rag_index_id
             WHERE r.enabled = true AND ar.agent_id = ANY($1::int[])
             ORDER BY ar.priority, r.label`,
            [agentIds]
          )
          .catch(() => ({ rows: [] as Array<{ agent_id: number; id: number; label: string; name: string }> }));
        for (const row of ragRows) {
          const list = ragByAgent.get(row.agent_id) ?? [];
          list.push({ id: row.id, label: row.label, name: row.name });
          ragByAgent.set(row.agent_id, list);
        }
      }

      res.json({
        skills: skills.rows,
        agents: agents.rows.map((a) => ({ ...a, rag_indexes: ragByAgent.get(a.id) ?? [] })),
        rag_indexes: ragIndexes.rows,
        tools,
        integrations: buildWorkflowIntegrations(tools, admin),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err: msg }, 'palette:get failed');
      res.status(500).json({ error: 'database error' });
    }
  });
}
