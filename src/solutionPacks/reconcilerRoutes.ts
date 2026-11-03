import express, { type Request, type Response, type Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';
import type { SolutionPackRollbackRequest } from './discovery.js';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORKER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const ROLLBACK_STATUSES = new Set<SolutionPackRollbackRequest['status']>([
  'pending', 'accepted', 'applied', 'failed', 'canceled',
]);

export interface SolutionPackRollbackReconcilerStore {
  listRollbackRequests(status: SolutionPackRollbackRequest['status'], limit: number): Promise<SolutionPackRollbackRequest[]>;
  claimRollbackRequest(id: string, workerId: string, leaseSeconds?: number): Promise<SolutionPackRollbackRequest | null>;
  completeRollbackRequest(
    id: string,
    workerId: string,
    status: Extract<SolutionPackRollbackRequest['status'], 'applied' | 'failed'>,
    error: string | null,
  ): Promise<SolutionPackRollbackRequest | null>;
}

function safeEqual(left: string, right: string): boolean {
  if (!left || left.length !== right.length) return false;
  try {
    return timingSafeEqual(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  } catch {
    return false;
  }
}

function authenticate(req: Request, res: Response): boolean {
  const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
  const providedSecret = String(req.header('x-workspace-secret') ?? '');
  if (!expectedSecret) {
    logger.error('solution-pack-reconciler: WORKSPACE_SECRET not set');
    res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    return false;
  }
  if (!safeEqual(providedSecret, expectedSecret)) {
    logger.warn({ ip: req.ip, path: req.path }, 'solution-pack-reconciler: auth failed');
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
}

function requestId(value: string | string[]): string {
  return Array.isArray(value) ? value[0] ?? '' : value;
}

function validRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

export function createSolutionPackReconcilerRouter(store: SolutionPackRollbackReconcilerStore): Router {
  const router = express.Router();

  router.get('/api/internal/solution-packs/rollback-requests', async (req, res) => {
    if (!authenticate(req, res)) return;
    const status = String(req.query['status'] ?? 'pending') as SolutionPackRollbackRequest['status'];
    const rawLimit = String(req.query['limit'] ?? '20');
    const limit = Number(rawLimit);
    if (!ROLLBACK_STATUSES.has(status) || !Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: 'status must be a valid rollback status and limit must be an integer from 1 to 100' });
      return;
    }
    try {
      const requests = await store.listRollbackRequests(status, limit);
      res.json({ requests, total: requests.length });
    } catch (cause) {
      logger.error({ err: cause }, 'solution-pack-reconciler: list failed');
      res.status(500).json({ error: 'rollback request listing failed' });
    }
  });

  router.post('/api/internal/solution-packs/rollback-requests/:requestId/claim', async (req, res) => {
    if (!authenticate(req, res)) return;
    const id = requestId(req.params['requestId'] ?? '');
    const body = req.body as unknown;
    const workerId = body && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>)['workerId'] ?? '').trim()
      : '';
    const rawLeaseSeconds = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)['leaseSeconds']
      : undefined;
    const leaseSeconds = rawLeaseSeconds === undefined ? 300 : Number(rawLeaseSeconds);
    if (!validRequestId(id) || !WORKER_ID_PATTERN.test(workerId)
      || !Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
      res.status(400).json({ error: 'requestId must be a UUID, workerId must be 1-128 safe characters, and leaseSeconds must be an integer from 30 to 3600' });
      return;
    }
    try {
      const request = await store.claimRollbackRequest(id, workerId, leaseSeconds);
      if (!request) {
        res.status(409).json({ error: 'rollback request is not pending or does not exist', code: 'rollback_not_claimable' });
        return;
      }
      res.status(200).json({ rollback: request });
    } catch (cause) {
      logger.error({ err: cause, requestId: id }, 'solution-pack-reconciler: claim failed');
      res.status(500).json({ error: 'rollback request claim failed' });
    }
  });

  router.post('/api/internal/solution-packs/rollback-requests/:requestId/result', async (req, res) => {
    if (!authenticate(req, res)) return;
    const id = requestId(req.params['requestId'] ?? '');
    const body = req.body as unknown;
    const input = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {};
    const status = input['status'];
    const workerId = typeof input['workerId'] === 'string' ? input['workerId'].trim() : '';
    const error = input['error'] == null ? null : String(input['error']).trim();
    if (!validRequestId(id) || !WORKER_ID_PATTERN.test(workerId) || (status !== 'applied' && status !== 'failed')) {
      res.status(400).json({ error: 'requestId must be a UUID, workerId must be 1-128 safe characters, and status must be applied or failed' });
      return;
    }
    if (error && error.length > 2_000) {
      res.status(400).json({ error: 'error must not exceed 2000 characters' });
      return;
    }
    if (status === 'failed' && !error) {
      res.status(400).json({ error: 'failed results require an error message' });
      return;
    }
    try {
      const request = await store.completeRollbackRequest(id, workerId, status, error);
      if (!request) {
        res.status(409).json({ error: 'rollback request is not accepted or does not exist', code: 'rollback_not_accepted' });
        return;
      }
      res.status(200).json({ rollback: request });
    } catch (cause) {
      logger.error({ err: cause, requestId: id }, 'solution-pack-reconciler: result failed');
      res.status(500).json({ error: 'rollback result update failed' });
    }
  });

  return router;
}
