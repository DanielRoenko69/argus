/**
 * Workflow approval-flow routes.
 *
 *   POST /api/workflows/:id/submit-for-review   → draft → review
 *   POST /api/workflows/:id/approve             → review → production (4-eyes: not the submitter)
 *   POST /api/workflows/:id/reject              → review → draft + comment
 *   POST /api/workflows/:id/withdraw            → review → draft (only submitter or admin)
 *   GET  /api/workflows/:id/approvals           → audit-trail
 *   GET  /api/workflows/in-review               → pending-review list for admin/reviewer dashboard
 */

import type { Express, Request, Response } from 'express';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { getRbacUser } from './rbacHelpers.js';
import { hasRole } from '../auth/roles.js';
import { buildUserLifecycleAuditContext } from '../auth/userLifecycleAuditContext.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import {
  resolveAuthorizedWorkspaceScope,
  WorkspaceScopeAccessError,
  type AuthorizedWorkspaceScope,
} from '../auth/workspaceScope.js';
import {
  transitionWorkflowApprovalAudited,
  WorkflowApprovalTransitionError,
  type WorkflowApprovalAction,
} from './workflowApprovalLifecycle.js';

export function canSubmitWorkflowForReview(role: string | undefined): boolean {
  return hasRole(role, 'developer');
}

export function canDecideWorkflowReview(role: string | undefined): boolean {
  return hasRole(role, 'agent_operator');
}

export function canOverrideWorkflowFourEyes(role: string | undefined): boolean {
  return hasRole(role, 'platform_admin');
}

async function canSeeWorkflow(
  pool: pg.Pool,
  workflowId: number,
  allowedBundles: number[] | null,
  scope: AuthorizedWorkspaceScope,
): Promise<boolean> {
  const { rows } = await pool.query<{ visible: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM mcp_workflows w
       WHERE w.id = $1
         AND w.tenant_key = $2
         AND w.workspace_key = $3
         AND ($4::int[] IS NULL OR (
           NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles wb WHERE wb.workflow_id = w.id)
           OR EXISTS (
             SELECT 1 FROM mcp_workflow_bundles wb
             WHERE wb.workflow_id = w.id AND wb.bundle_id = ANY($4::int[])
           )
         ))
     ) AS visible`,
    [workflowId, scope.tenantKey, scope.workspaceKey, allowedBundles],
  );
  return rows[0]?.visible === true;
}

function authenticatedApprovalActor(user: ReturnType<typeof getRbacUser>): { id: number; username: string; role: string } | null {
  return Number.isSafeInteger(user.id) && user.id! > 0 && Boolean(user.username) && Boolean(user.role)
    ? { id: user.id!, username: user.username!, role: user.role! }
    : null;
}

function sendTransitionError(res: Response, error: unknown, workflowId: number, action: WorkflowApprovalAction): void {
  if (error instanceof WorkspaceScopeAccessError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof WorkflowApprovalTransitionError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  logger.error({ err: String(error), id: workflowId, action }, 'workflow approval transition failed');
  res.status(500).json({ error: 'database error' });
}

export function registerApprovalRoutes(
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

  // submit-for-review: draft → review
  app.post('/api/workflows/:id/submit-for-review', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const user = getRbacUser(req);
    const actor = authenticatedApprovalActor(user);
    const comment = String((req.body as { comment?: string })?.comment ?? '').slice(0, 1000) || null;
    if (!actor) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'invalid workflow id' }); return; }
    if (!canSubmitWorkflowForReview(user.role)) {
      res.status(403).json({ error: 'developer role required to submit workflows for review' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      if (!await canSeeWorkflow(pool, id, user.allowed_bundles, scope)) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      const result = await transitionWorkflowApprovalAudited(
        pool, id, 'submitted', actor, comment, false,
        { ...buildUserLifecycleAuditContext(req, actor), ...scope },
      );
      res.json({ ok: true, status: result.status, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
    } catch (err) {
      sendTransitionError(res, err, id, 'submitted');
    }
  });

  // approve: review → production (must be different actor than the submitter; admin can override)
  app.post('/api/workflows/:id/approve', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const user = getRbacUser(req);
    const actor = authenticatedApprovalActor(user);
    const comment = String((req.body as { comment?: string })?.comment ?? '').slice(0, 1000) || null;
    if (!actor) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'invalid workflow id' }); return; }
    if (!canDecideWorkflowReview(user.role)) {
      res.status(403).json({ error: 'reviewer role required' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      if (!await canSeeWorkflow(pool, id, user.allowed_bundles, scope)) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      const result = await transitionWorkflowApprovalAudited(
        pool, id, 'approved', actor, comment, canOverrideWorkflowFourEyes(actor.role),
        { ...buildUserLifecycleAuditContext(req, actor), ...scope },
      );
      res.json({ ok: true, status: result.status, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
    } catch (err) {
      sendTransitionError(res, err, id, 'approved');
    }
  });

  app.post('/api/workflows/:id/reject', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const user = getRbacUser(req);
    const actor = authenticatedApprovalActor(user);
    const comment = String((req.body as { comment?: string })?.comment ?? '').slice(0, 1000) || null;
    if (!actor) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'invalid workflow id' }); return; }
    if (!canDecideWorkflowReview(user.role)) {
      res.status(403).json({ error: 'reviewer role required' });
      return;
    }
    if (!comment) {
      res.status(400).json({ error: 'comment is required for rejection' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      if (!await canSeeWorkflow(pool, id, user.allowed_bundles, scope)) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      const result = await transitionWorkflowApprovalAudited(
        pool, id, 'rejected', actor, comment, canOverrideWorkflowFourEyes(actor.role),
        { ...buildUserLifecycleAuditContext(req, actor), ...scope },
      );
      res.json({ ok: true, status: result.status, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
    } catch (err) {
      sendTransitionError(res, err, id, 'rejected');
    }
  });

  app.post('/api/workflows/:id/withdraw', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const user = getRbacUser(req);
    const actor = authenticatedApprovalActor(user);
    if (!actor) { res.status(401).json({ error: 'not authenticated' }); return; }
    if (!Number.isSafeInteger(id) || id < 1) { res.status(400).json({ error: 'invalid workflow id' }); return; }
    if (!canSubmitWorkflowForReview(user.role)) {
      res.status(403).json({ error: 'developer role required' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    try {
      if (!await canSeeWorkflow(pool, id, user.allowed_bundles, scope)) {
        res.status(404).json({ error: 'workflow not found' });
        return;
      }
      const result = await transitionWorkflowApprovalAudited(
        pool, id, 'withdrawn', actor, null, canOverrideWorkflowFourEyes(actor.role),
        { ...buildUserLifecycleAuditContext(req, actor), ...scope },
      );
      res.json({ ok: true, status: result.status, replayed: result.replayed, auditEventId: result.auditEvent.eventId });
    } catch (err) {
      sendTransitionError(res, err, id, 'withdrawn');
    }
  });

  app.get('/api/workflows/:id/approvals', requireAuth, async (req, res) => {
    const id = Number(req.params['id']);
    const user = getRbacUser(req);
    if (!Number.isInteger(id) || id < 1) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }
    const scope = requestScope(req, res);
    if (!scope) return;
    if (!await canSeeWorkflow(pool, id, user.allowed_bundles, scope)) {
      res.status(404).json({ error: 'workflow not found' });
      return;
    }
    const { rows } = await pool.query(
      `SELECT id, action, actor_username, actor_role, comment, workflow_version, created_at
       FROM mcp_workflow_approvals
       WHERE workflow_id = $1 AND tenant_key = $2 AND workspace_key = $3
       ORDER BY created_at DESC LIMIT 100`,
      [id, scope.tenantKey, scope.workspaceKey]
    );
    res.json({ approvals: rows });
  });

  app.get('/api/workflows/in-review', requireAuth, async (req, res) => {
    const user = getRbacUser(req);
    const selectedScope = requestScope(req, res);
    if (!selectedScope) return;
    const params: unknown[] = [selectedScope.tenantKey, selectedScope.workspaceKey];
    const scope = user.allowed_bundles === null
      ? ''
      : `AND (
          NOT EXISTS (
            SELECT 1 FROM mcp_workflow_bundles wb
            WHERE wb.workflow_id = mcp_workflows.id
          )
          OR EXISTS (
            SELECT 1 FROM mcp_workflow_bundles wb
            WHERE wb.workflow_id = mcp_workflows.id
              AND wb.bundle_id = ANY($3::int[])
          )
        )`;
    if (user.allowed_bundles !== null) params.push(user.allowed_bundles);
    const { rows } = await pool.query(
      `SELECT id, name, description, updated_at,
        (SELECT actor_username FROM mcp_workflow_approvals
         WHERE workflow_id = mcp_workflows.id AND action = 'submitted'
         ORDER BY created_at DESC LIMIT 1) AS submitted_by
       FROM mcp_workflows
       WHERE lifecycle_status = 'review'
         AND tenant_key = $1
         AND workspace_key = $2
       ${scope}
       ORDER BY updated_at DESC
       LIMIT 50`,
      params,
    );
    res.json({ workflows: rows });
  });
}
