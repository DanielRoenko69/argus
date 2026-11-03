/**
 * Workflow versioning — snapshot on every save + read/diff endpoints.
 *
 *   GET  /api/workflows/:id/versions             → last 50 version snapshots
 *   GET  /api/workflows/:id/versions/:v          → single version body
 *   POST /api/workflows/:id/versions/:v/restore  → bring version → current
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
  type AuthorizedWorkspaceScope,
} from '../auth/workspaceScope.js';
import { LEGACY_WORKFLOW_SCOPE, type WorkflowScope } from './workflowStore.js';

export async function snapshotVersion(
  pool: pg.Pool,
  workflowId: number,
  savedBy: string | null,
  comment?: string | null,
  scope: WorkflowScope = LEGACY_WORKFLOW_SCOPE,
): Promise<number> {
  const { rows } = await pool.query<{
    steps: unknown; input_params: unknown; canvas_state: unknown;
    block_definitions: unknown; trigger_config: unknown; agent_requirements: unknown;
  }>(
    `SELECT steps, input_params, canvas_state, block_definitions, trigger_config, agent_requirements
     FROM mcp_workflows
     WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3`,
    [workflowId, scope.tenantKey, scope.workspaceKey]
  );
  const w = rows[0];
  if (!w) throw new Error(`workflow #${workflowId} not found`);
  // audit (race): the previous read-MAX-then-INSERT lost a snapshot under
  // concurrent saves (autosave + manual) → unique (workflow_id, version)
  // violation. Assign the version atomically inside the INSERT and retry on the
  // residual conflict that READ COMMITTED can still produce.
  let nextV = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ins = await pool.query<{ version: number }>(
        `INSERT INTO mcp_workflow_versions
           (workflow_id, version, steps, input_params, canvas_state, block_definitions, trigger_config, agent_requirements, saved_by, comment)
         SELECT $1, COALESCE(MAX(version), 0) + 1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9
         FROM mcp_workflow_versions WHERE workflow_id = $1
         RETURNING version`,
        [
          workflowId,
          JSON.stringify(w.steps), JSON.stringify(w.input_params),
          JSON.stringify(w.canvas_state), JSON.stringify(w.block_definitions),
          JSON.stringify(w.trigger_config), JSON.stringify(w.agent_requirements), savedBy, comment ?? null,
        ]
      );
      nextV = ins.rows[0]!.version;
      break;
    } catch (err) {
      if ((err as { code?: string })?.code === '23505' && attempt < 4) continue; // unique_violation → retry
      throw err;
    }
  }
  return nextV;
}

export function registerVersionRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: (req: Request, res: Response, next: () => void) => void,
): void {
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

  app.get('/api/workflows/:id/versions', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    if (!id) { res.status(400).json({ error: 'invalid id' }); return; }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows } = await pool.query(
        `SELECT version.id, version.version, version.saved_by, version.saved_at, version.comment,
                jsonb_array_length(version.steps) AS step_count
         FROM mcp_workflow_versions version
         JOIN mcp_workflows workflow ON workflow.id = version.workflow_id
         WHERE version.workflow_id = $1 AND workflow.tenant_key = $2 AND workflow.workspace_key = $3
         ORDER BY version.version DESC LIMIT 50`,
        [id, scope.tenantKey, scope.workspaceKey]
      );
      res.json({ versions: rows });
    } catch (err) {
      logger.error({ err: String(err) }, 'versions:list');
      res.status(500).json({ error: 'database error' });
    }
  });

  app.get('/api/workflows/:id/versions/:v', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const v = Number(req.params['v']);
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows } = await pool.query(
        `SELECT version.version, version.steps, version.input_params, version.canvas_state,
                version.block_definitions, version.trigger_config, version.agent_requirements,
                version.saved_at, version.saved_by, version.comment
         FROM mcp_workflow_versions version
         JOIN mcp_workflows workflow ON workflow.id = version.workflow_id
         WHERE version.workflow_id = $1 AND version.version = $2
           AND workflow.tenant_key = $3 AND workflow.workspace_key = $4`,
        [id, v, scope.tenantKey, scope.workspaceKey]
      );
      if (!rows[0]) { res.status(404).json({ error: 'version not found' }); return; }
      res.json(rows[0]);
    } catch {
      res.status(500).json({ error: 'database error' });
    }
  });

  app.post('/api/workflows/:id/versions/:v/restore', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const v = Number(req.params['v']);
    const user = getRbacUser(req);
    if (!isAdmin(user)) {
      res.status(403).json({ error: 'admin required for restore' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      const { rows } = await pool.query(
        `SELECT version.steps, version.input_params, version.canvas_state,
                version.block_definitions, version.trigger_config, version.agent_requirements
         FROM mcp_workflow_versions version
         JOIN mcp_workflows workflow ON workflow.id = version.workflow_id
         WHERE version.workflow_id = $1 AND version.version = $2
           AND workflow.tenant_key = $3 AND workflow.workspace_key = $4`,
        [id, v, scope.tenantKey, scope.workspaceKey]
      );
      const ver = rows[0];
      if (!ver) { res.status(404).json({ error: 'version not found' }); return; }
      // Snapshot current state first (so user can undo a bad restore).
      await snapshotVersion(
        pool,
        id,
        `restore-from-v${v}-by:${user.username ?? '?'}`,
        'pre-restore snapshot',
        scope,
      );
      await pool.query(
        `UPDATE mcp_workflows
         SET steps = $2::jsonb, input_params = $3::jsonb, canvas_state = $4::jsonb,
             block_definitions = $5::jsonb, trigger_config = $6::jsonb,
             agent_requirements = $7::jsonb,
             updated_at = now()
         WHERE id = $1 AND tenant_key = $8 AND workspace_key = $9`,
        [id, JSON.stringify(ver.steps), JSON.stringify(ver.input_params),
         JSON.stringify(ver.canvas_state), JSON.stringify(ver.block_definitions),
         JSON.stringify(ver.trigger_config), JSON.stringify(ver.agent_requirements),
         scope.tenantKey, scope.workspaceKey]
      );
      res.json({ ok: true, restored_version: v });
    } catch (err) {
      logger.error({ err: String(err), id, v }, 'versions:restore failed');
      res.status(500).json({ error: 'restore failed' });
    }
  });
}
