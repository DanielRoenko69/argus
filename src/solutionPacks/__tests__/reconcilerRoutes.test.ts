import { afterEach, describe, expect, it } from '@jest/globals';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createSolutionPackReconcilerRouter, type SolutionPackRollbackReconcilerStore } from '../reconcilerRoutes.js';
import type { SolutionPackRollbackRequest } from '../discovery.js';

const REQUEST_ID = '8ecf0e84-4a12-4f61-9a1a-5c3cfbf1e820';
const servers: Server[] = [];

function rollback(status: SolutionPackRollbackRequest['status']): SolutionPackRollbackRequest {
  return {
    id: REQUEST_ID, packId: 'argus.dev', requestedBy: 'Alex', reason: 'reconcile release',
    sourceRevision: 8, currentVersion: '0.5.0', targetVersion: '0.4.0',
    targetManifest: { metadata: { id: 'argus.dev', version: '0.4.0' } } as never,
    status, error: null, requestedAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:00.000Z', appliedAt: null,
  };
}

async function serve(store: SolutionPackRollbackReconcilerStore): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(createSolutionPackReconcilerRouter(store));
  const server = createServer(app);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  delete process.env['WORKSPACE_SECRET'];
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

describe('external Solution-Pack reconciler hand-off', () => {
  it('requires the internal secret and lists pending requests', async () => {
    process.env['WORKSPACE_SECRET'] = 'reconciler-secret';
    const calls: unknown[][] = [];
    const store: SolutionPackRollbackReconcilerStore = {
      async listRollbackRequests(status, limit) {
        calls.push([status, limit]);
        return [rollback('pending')];
      },
      async claimRollbackRequest() { return null; },
      async completeRollbackRequest() { return null; },
    };
    const baseUrl = await serve(store);
    const unauthorized = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests`, { headers: { connection: 'close' } });
    expect(unauthorized.status).toBe(401);
    const response = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests?status=pending&limit=5`, {
      headers: { connection: 'close', 'x-workspace-secret': 'reconciler-secret' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ total: 1, requests: [{ id: REQUEST_ID, status: 'pending' }] });
    expect(calls).toEqual([['pending', 5]]);
  });

  it('claims atomically and records an applied or failed result', async () => {
    process.env['WORKSPACE_SECRET'] = 'reconciler-secret';
    const calls: unknown[][] = [];
    const store: SolutionPackRollbackReconcilerStore = {
      async listRollbackRequests() { return []; },
      async claimRollbackRequest(id, workerId, leaseSeconds) {
        calls.push(['claim', id, workerId, leaseSeconds]);
        return rollback('accepted');
      },
      async completeRollbackRequest(id, workerId, status, error) {
        calls.push(['result', id, workerId, status, error]);
        return { ...rollback(status), error };
      },
    };
    const baseUrl = await serve(store);
    const claim = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests/${REQUEST_ID}/claim`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-workspace-secret': 'reconciler-secret' },
      body: JSON.stringify({ workerId: 'argus-dev-controller-1', leaseSeconds: 600 }),
    });
    expect(claim.status).toBe(200);
    const result = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests/${REQUEST_ID}/result`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-workspace-secret': 'reconciler-secret' },
      body: JSON.stringify({ workerId: 'argus-dev-controller-1', status: 'applied' }),
    });
    expect(result.status).toBe(200);
    expect(calls).toEqual([
      ['claim', REQUEST_ID, 'argus-dev-controller-1', 600],
      ['result', REQUEST_ID, 'argus-dev-controller-1', 'applied', null],
    ]);
  });

  it('rejects malformed claim and result payloads before touching the store', async () => {
    process.env['WORKSPACE_SECRET'] = 'reconciler-secret';
    let touched = false;
    const store: SolutionPackRollbackReconcilerStore = {
      async listRollbackRequests() { touched = true; return []; },
      async claimRollbackRequest() { touched = true; return null; },
      async completeRollbackRequest() { touched = true; return null; },
    };
    const baseUrl = await serve(store);
    const claim = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests/not-a-uuid/claim`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-workspace-secret': 'reconciler-secret' },
      body: JSON.stringify({ workerId: 'controller' }),
    });
    expect(claim.status).toBe(400);
    const result = await fetch(`${baseUrl}/api/internal/solution-packs/rollback-requests/${REQUEST_ID}/result`, {
      method: 'POST', headers: { connection: 'close', 'content-type': 'application/json', 'x-workspace-secret': 'reconciler-secret' },
      body: JSON.stringify({ status: 'pending' }),
    });
    expect(result.status).toBe(400);
    expect(touched).toBe(false);
  });
});
