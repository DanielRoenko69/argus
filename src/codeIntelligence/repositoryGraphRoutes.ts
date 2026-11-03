import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { requirePermission } from '../auth/sessionMiddleware.js';
import { logger } from '../lib/logger.js';
import { loadRepositoryFullGraph, loadRepositoryGraphNeighborhood, loadRepositoryGraphOverview } from './repositoryGraphService.js';
import {
  PostgresRepositoryGraphDataSource,
  type RepositoryGraphDataSource,
} from './repositoryGraphStore.js';
import { parseRepositoryGraphQuery, RepositoryGraphValidationError } from './repositoryGraphValidation.js';

function snapshotId(value: string): number {
  if (!/^[1-9]\d*$/u.test(value)) throw new RepositoryGraphValidationError('snapshot id must be a positive integer');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RepositoryGraphValidationError('snapshot id must be a positive integer');
  return parsed;
}

export interface RepositoryGraphRouteOptions {
  enabled: boolean;
  source?: RepositoryGraphDataSource;
}

export function registerRepositoryGraphRoutes(
  app: Express,
  pool: pg.Pool,
  requireAuth: RequestHandler,
  options: RepositoryGraphRouteOptions,
): void {
  const source = options.source ?? new PostgresRepositoryGraphDataSource(pool);
  app.get(
    '/api/ui/knowledge/repository-snapshots/:id/overview',
    requireAuth,
    requirePermission('repository_graph.read'),
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once('aborted', abort);
      try {
        const user = (req as AuthenticatedRequest).user!;
        const rawSnapshotId = req.params['id'];
        const result = await loadRepositoryGraphOverview(
          source,
          snapshotId(Array.isArray(rawSnapshotId) ? rawSnapshotId[0] ?? '' : rawSnapshotId ?? ''),
          { allowedBundleIds: user.allowed_bundles, signal: controller.signal },
        );
        if (!controller.signal.aborted) res.json(result);
      } catch (error) {
        if (controller.signal.aborted || res.headersSent || res.writableEnded) return;
        if (error instanceof RepositoryGraphValidationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Repository graph overview request failed');
        res.status(500).json({ error: 'Repository graph overview could not be loaded' });
      } finally {
        req.off('aborted', abort);
      }
    },
  );
  app.get(
    '/api/ui/knowledge/repository-snapshots/:id/full-graph',
    requireAuth,
    requirePermission('repository_graph.read'),
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once('aborted', abort);
      try {
        const user = (req as AuthenticatedRequest).user!;
        const rawSnapshotId = req.params['id'];
        const result = await loadRepositoryFullGraph(
          source,
          snapshotId(Array.isArray(rawSnapshotId) ? rawSnapshotId[0] ?? '' : rawSnapshotId ?? ''),
          { allowedBundleIds: user.allowed_bundles, signal: controller.signal },
        );
        if (!controller.signal.aborted) res.json(result);
      } catch (error) {
        if (controller.signal.aborted || res.headersSent || res.writableEnded) return;
        if (error instanceof RepositoryGraphValidationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Repository full graph request failed');
        res.status(500).json({ error: 'Repository full graph could not be loaded' });
      } finally {
        req.off('aborted', abort);
      }
    },
  );
  app.get(
    '/api/ui/knowledge/repository-snapshots/:id/graph',
    requireAuth,
    requirePermission('repository_graph.read'),
    async (req, res) => {
      if (!options.enabled) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const controller = new AbortController();
      const abort = (): void => controller.abort();
      req.once('aborted', abort);
      try {
        const user = (req as AuthenticatedRequest).user!;
        const rawSnapshotId = req.params['id'];
        const result = await loadRepositoryGraphNeighborhood(
          source,
          snapshotId(Array.isArray(rawSnapshotId) ? rawSnapshotId[0] ?? '' : rawSnapshotId ?? ''),
          parseRepositoryGraphQuery(req.query as Record<string, unknown>),
          { allowedBundleIds: user.allowed_bundles, signal: controller.signal },
        );
        if (!controller.signal.aborted) res.json(result);
      } catch (error) {
        if (controller.signal.aborted || res.headersSent || res.writableEnded) return;
        if (error instanceof RepositoryGraphValidationError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        logger.error({ err: error }, 'Repository graph neighborhood request failed');
        res.status(500).json({ error: 'Repository graph could not be loaded' });
      } finally {
        req.off('aborted', abort);
      }
    },
  );
}
