import { describe, expect, it, jest } from '@jest/globals';
import { SolutionPackReconcilerClient } from '../reconcilerClient.js';
import type { SolutionPackRollbackRequest } from '../discovery.js';

const REQUEST_ID = '8ecf0e84-4a12-4f61-9a1a-5c3cfbf1e820';

function rollback(status: SolutionPackRollbackRequest['status']): SolutionPackRollbackRequest {
  return {
    id: REQUEST_ID, packId: 'argus.dev', requestedBy: 'Alex', reason: 'reconcile release',
    sourceRevision: 8, currentVersion: '0.5.0', targetVersion: '0.4.0',
    targetManifest: { metadata: { id: 'argus.dev', version: '0.4.0' } } as never,
    status, error: null, requestedAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:00.000Z', appliedAt: null,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('Solution-Pack reconciler client', () => {
  it('uses the internal secret and supports list, claim and result calls', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('?status=pending')) return response({ requests: [rollback('pending')] });
      if (url.endsWith('/claim')) return response({ rollback: rollback('accepted') });
      return response({ rollback: rollback('applied') });
    });
    const client = new SolutionPackReconcilerClient({
      baseUrl: 'http://core:3000/', workspaceSecret: 'internal-secret', fetchFn,
    });
    await expect(client.listPending(5)).resolves.toHaveLength(1);
    await expect(client.claim(REQUEST_ID, 'controller-1', 600)).resolves.toMatchObject({ status: 'accepted' });
    await expect(client.report(REQUEST_ID, 'controller-1', 'applied')).resolves.toMatchObject({ status: 'applied' });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('http://core:3000/api/internal/solution-packs/rollback-requests?status=pending&limit=5');
    expect(calls[1]?.init?.headers).toMatchObject({ 'X-Workspace-Secret': 'internal-secret' });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ workerId: 'controller-1', leaseSeconds: 600 });
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ workerId: 'controller-1', status: 'applied' });
  });

  it('polls, skips a concurrent claim and reports apply failures', async () => {
    const first = rollback('pending');
    const second = { ...rollback('pending'), id: '9ecf0e84-4a12-4f61-9a1a-5c3cfbf1e821' };
    const calls: string[] = [];
    const fetchFn = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.includes('?status=pending')) return response({ requests: [first, second] });
      if (url.includes(`${first.id}/claim`)) return response({ rollback: { ...first, status: 'accepted' } });
      if (url.includes(`${second.id}/claim`)) return response({ error: 'already claimed' }, 409);
      return response({ rollback: { ...first, status: 'failed' } });
    });
    const client = new SolutionPackReconcilerClient({ baseUrl: 'http://core:3000', workspaceSecret: 'secret', fetchFn });
    const summary = await client.pollOnce('controller-1', async () => { throw new Error('apply failed'); });
    expect(summary).toEqual({ listed: 2, claimed: 1, applied: 0, failed: 1, skipped: 1, reportErrors: 0 });
    expect(calls.some(call => call.includes(`${first.id}/result`))).toBe(true);
    expect(calls.some(call => call.includes(`${second.id}/claim`))).toBe(true);
  });

  it('rejects invalid controller configuration before making network calls', () => {
    expect(() => new SolutionPackReconcilerClient({ baseUrl: 'file:///tmp/core', workspaceSecret: 'secret' })).toThrow(/http or https/);
    expect(() => new SolutionPackReconcilerClient({ baseUrl: 'http://core:3000', workspaceSecret: '' })).toThrow(/workspaceSecret/);
  });
});
