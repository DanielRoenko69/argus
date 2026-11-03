import type { Express, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { requirePermission } from '../auth/sessionMiddleware.js';
import { writeAdminAudit } from '../lib/adminAudit.js';
import { logger } from '../lib/logger.js';
import {
  createWorkspaceTagAudited,
  deleteWorkspaceTagAudited,
  getWorkspaceTag,
  listResourceTags,
  listWorkspaceTags,
  replaceResourceTagsAudited,
  updateWorkspaceTagAudited,
  type TagAuditContext,
} from './store.js';
import {
  normalizeTagMutation,
  normalizeTagQuery,
  parseResourceId,
  parseTaggableResourceType,
  parseTagIds,
  TagValidationError,
} from './validation.js';

function tagError(res: Response, error: unknown): void {
  if (error instanceof TagValidationError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error({ err: error }, 'Workspace tag request failed');
  res.status(500).json({ error: 'Workspace tags could not be processed' });
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function requestHeader(req: Request, name: string): string | null {
  const value = req.headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !text.trim()) return null;
  const normalized = text.trim();
  if (!IDEMPOTENCY_KEY.test(normalized)) throw new TagValidationError(`${name} header is invalid`, 400);
  return normalized;
}

function auditContext(req: Request, user: NonNullable<AuthenticatedRequest['user']>): TagAuditContext {
  const idempotencyKey = requestHeader(req, 'idempotency-key');
  const requestId = requestHeader(req, 'x-request-id');
  return {
    producerEventId: idempotencyKey ?? requestId ?? randomUUID(),
    environment: process.env['NODE_ENV'] || 'development',
    actor: {
      type: 'human',
      id: String(user.id),
      ssoSubject: /^(?:entra|oidc):/.test(user.username) ? user.username : null,
      authMethod: /^(?:entra|oidc):/.test(user.username) ? 'oidc' : 'session',
      effectiveRoles: [user.role],
    },
    requestId,
  };
}

export function registerTagRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  requireSameOrigin: RequestHandler,
): void {
  const canReadTags = requirePermission('tags.read');
  const canManageTags = requirePermission('tags.manage');

  app.get('/api/ui/tags', requireAuth, canReadTags, async (req, res) => {
    try {
      const query = normalizeTagQuery(req.query['q']);
      res.json({ schemaVersion: 1, tags: await listWorkspaceTags(pool, undefined, query) });
    } catch (error) {
      tagError(res, error);
    }
  });

  app.post('/api/ui/tags', requireAuth, canManageTags, requireSameOrigin, async (req, res) => {
    try {
      const user = (req as AuthenticatedRequest).user!;
      const input = normalizeTagMutation(req.body ?? {});
      const result = await createWorkspaceTagAudited(pool, input, user.id, auditContext(req, user));
      const tag = result.value;
      if (!result.replayed) writeAdminAudit(pool, req, 'tag_created', 'mcp_workspace_tags', tag.id, tag.label, null, tag);
      res.status(201).json({ schemaVersion: 1, tag });
    } catch (error) {
      tagError(res, error);
    }
  });

  app.patch('/api/ui/tags/:tagId', requireAuth, canManageTags, requireSameOrigin, async (req, res) => {
    try {
      const tagId = parseResourceId(req.params['tagId']);
      const before = await getWorkspaceTag(pool, tagId);
      const patch = req.body ?? {};
      const normalized = normalizeTagMutation({
        slug: before.slug,
        label: patch['label'] ?? before.label,
        color: Object.prototype.hasOwnProperty.call(patch, 'color') ? patch['color'] : before.color,
        description: Object.prototype.hasOwnProperty.call(patch, 'description')
          ? patch['description']
          : before.description,
      }, false);
      const input = {
        label: normalized.label,
        color: normalized.color,
        description: normalized.description,
      };
      const result = await updateWorkspaceTagAudited(pool, tagId, input, auditContext(req, (req as AuthenticatedRequest).user!));
      const tag = result.value;
      if (!result.replayed) writeAdminAudit(
        pool, req, 'tag_updated', 'mcp_workspace_tags', tag.id, tag.label, result.before, tag,
      );
      res.json({ schemaVersion: 1, tag });
    } catch (error) {
      tagError(res, error);
    }
  });

  app.delete('/api/ui/tags/:tagId', requireAuth, canManageTags, requireSameOrigin, async (req, res) => {
    try {
      const tagId = parseResourceId(req.params['tagId']);
      const result = await deleteWorkspaceTagAudited(
        pool, tagId, auditContext(req, (req as AuthenticatedRequest).user!),
      );
      if (!result.replayed) {
        const before = result.before as { label?: string } | null;
        writeAdminAudit(pool, req, 'tag_deleted', 'mcp_workspace_tags', tagId, before?.label ?? null, before, null);
      }
      res.status(204).end();
    } catch (error) {
      tagError(res, error);
    }
  });

  app.get('/api/ui/resources/:resourceType/:resourceId/tags', requireAuth, canReadTags, async (req, res) => {
    try {
      const resourceType = parseTaggableResourceType(req.params['resourceType']);
      const resourceId = parseResourceId(req.params['resourceId']);
      const tags = await listResourceTags(pool, resourceType, resourceId);
      res.json({ schemaVersion: 1, resource: { type: resourceType, id: resourceId }, tags });
    } catch (error) {
      tagError(res, error);
    }
  });

  app.put(
    '/api/ui/resources/:resourceType/:resourceId/tags',
    requireAuth,
    canManageTags,
    requireSameOrigin,
    async (req: Request, res: Response) => {
      try {
        const user = (req as AuthenticatedRequest).user!;
        const resourceType = parseTaggableResourceType(req.params['resourceType']);
        const resourceId = parseResourceId(req.params['resourceId']);
        const tagIds = parseTagIds((req.body ?? {})['tagIds']);
        const result = await replaceResourceTagsAudited(
          pool, resourceType, resourceId, tagIds, user.id, auditContext(req, user),
        );
        const tags = result.value;
        if (!result.replayed) {
          writeAdminAudit(
            pool,
            req,
            'resource_tags_replaced',
            resourceType,
            resourceId,
            resourceType,
            { tags: result.before },
            { tags },
          );
        }
        res.json({ schemaVersion: 1, resource: { type: resourceType, id: resourceId }, tags });
      } catch (error) {
        tagError(res, error);
      }
    },
  );
}
