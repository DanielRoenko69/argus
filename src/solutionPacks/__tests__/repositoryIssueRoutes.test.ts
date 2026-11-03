import { describe, expect, it, jest } from '@jest/globals';
import type { Express, RequestHandler } from 'express';
import { registerRepositoryIssueRoutes } from '../repositoryIssueRoutes.js';

function fixture() {
  const routes = new Map<string, RequestHandler>();
  const app = { post: (path: string, ...handlers: RequestHandler[]) => routes.set(path, handlers.at(-1)!) } as unknown as Express;
  const load = jest.fn<any>().mockResolvedValue({ sha256: 'a'.repeat(64), number: 5 });
  const auth: RequestHandler = (_req, _res, next) => next();
  registerRepositoryIssueRoutes(app, {} as never, {} as never, auth, auth, load as never);
  const call = async (path: string, req: Record<string, unknown>) => {
    let status = 200; let body: any;
    const response = { status: (v: number) => { status = v; return response; }, json: (v: unknown) => { body = v; }, setHeader: () => {} };
    await routes.get(path)!({ params: { id: '3' }, ...req } as never, response as never, () => {});
    return { status, body };
  };
  return { call, load };
}
describe('issue preview and grant boundary', () => {
  it('rejects unauthorized or empty bundle selection before tool lookup', async () => {
    const f = fixture();
    for (const bundles of [[], [47]]) {
      const response = await f.call('/api/coding/repository-issue', { user: { id: 2, allowed_bundles: [3] }, body: { reference: '5', bundleIds: bundles } });
      expect([400, 403]).toContain(response.status);
    }
    expect(f.load).not.toHaveBeenCalled();
  });
  it('never accepts a browser snapshot or identity/authority override', async () => {
    const f = fixture();
    const r = await f.call('/api/coding/repository-issue', { user: { id: 2, allowed_bundles: null }, body: { reference: '5', bundleIds: [47], snapshot: {}, userId: 9 } });
    expect(r.status).toBe(400); expect(f.load).not.toHaveBeenCalled();
  });
  it('requires a workspace grant for the exact agent and a reviewed digest', async () => {
    const f = fixture();
    const valid = { workspaceRoot: '/workspace/run', coreAgentIds: [3], bundleIds: [47], rootTraceId: 'trace' };
    for (const grant of [undefined, { ...valid, workspaceRoot: '' }, { ...valid, coreAgentIds: [4] }]) {
      expect((await f.call('/api/agents/:id/repository-issue', { executionGrant: grant, body: { reference: '5', expectedSha256: 'a'.repeat(64) } })).status).toBe(403);
    }
    expect((await f.call('/api/agents/:id/repository-issue', { executionGrant: valid, body: { reference: '5' } })).status).toBe(400);
    expect(f.load).not.toHaveBeenCalled();
    expect((await f.call('/api/agents/:id/repository-issue', { executionGrant: valid, allowedTools: ['gitea_get_issue'], callingUser: { id: 2 }, body: { reference: '5', expectedSha256: 'a'.repeat(64) } })).status).toBe(200);
    expect(f.load).toHaveBeenCalledWith({}, {}, expect.objectContaining({ bundleIds: [47], userId: 2, rootTraceId: 'trace', allowedTools: ['gitea_get_issue'], expectedSha256: 'a'.repeat(64) }));
  });
});
