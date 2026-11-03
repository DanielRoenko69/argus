import { describe, expect, it, jest } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { checkpointGrantProvenance, checkpointRetryBody, createCodingCheckpointRetryRouter, qaResponseRecheckBody } from '../codingCheckpointRetry.js';
import { signExecutionGrant, verifyExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';

const secret = 'checkpoint-test-only-'.repeat(3);
const id = randomUUID(); const checkpointId = randomUUID(); const workspaceDigest = 'a'.repeat(64);
const oldClaims = (): ExecutionGrantClaims => ({ v: 1, jti: randomUUID(), iss: 'argus.core', aud: 'argus.dev', agent: 'coding-orchestrator',
  sub: 'user:3', principalKind: 'user', principalId: '3', bundleIds: [47], coreAgentIds: [2], coreAgents: [{ id: 2, name: 'coder' }],
  messageId: randomUUID(), rootTraceId: id, workspaceRoot: '/workspace/TICKET', executionSurface: 'agent',
  policy: 'mcp-bundle-v1', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 });

function fixture(options: { userId?: number; bundles?: number[]; revoked?: boolean; available?: boolean; auditFails?: boolean; drift?: boolean; qa?: boolean; qaRetry?: boolean; omission?: boolean } = {}) {
  const qa = options.qa || options.qaRetry;
  const claims = oldClaims(); const token = signExecutionGrant(secret, claims);
  const context = { threadId: id, executionGrant: token, metadata: { execution_principal: 'user:3', execution_grant_id: claims.jti },
    available: options.available ?? true, node: 'coder', checkpointId, workspaceDigest: options.drift ? 'b'.repeat(64) : workspaceDigest,
    ...(qa ? { reviewDigest: 'c'.repeat(64), sourceTraceId: randomUUID(), testPlan: 'validated QA', repairCount: 1 } : {}),
    ...(options.omission ? { retryKind: 'missing_reviews', missingDecisionIds: ['delivery_boundary'], receipt: { response: 'private original answer' } } : {}) };
  const fetchFn = jest.fn<any>().mockImplementation(async (_url: string, init: RequestInit) => new Response(JSON.stringify(init.method === 'GET'
    ? context : { thread_id: id, run_id: randomUUID(), node: 'coder', status: 'queued' }), { status: 200 }));
  const pool = { query: jest.fn<any>().mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT status')
    ? [{ status: options.revoked ? 'revoked' : 'active' }] : options.auditFails ? [] : [{ id: 1 }] })) };
  const issuer = { assertRepositoryCheckout: jest.fn<any>().mockResolvedValue(undefined), checkBundleCapabilities: jest.fn<any>().mockResolvedValue({ ok: true }),
    issueWithClaims: jest.fn<any>().mockResolvedValue({ token: 'fresh-secret-token', claims: {} }) };
  const router = createCodingCheckpointRetryRouter(pool as never, issuer as never, secret, fetchFn as never, options.qaRetry ? 'qa-retry' : qa ? 'qa-response-recheck' : 'checkpoint-retry');
  const call = async (method: 'get' | 'post', body: unknown = { checkpointId, workspaceDigest, ...(qa ? { reviewDigest: 'c'.repeat(64) } : {}) }) => {
    const route = router.stack[method === 'get' ? 0 : 1]!.route!;
    const handler = route.stack.at(-1)!.handle;
    const req = { params: { id }, body, header: () => undefined, user: { id: options.userId ?? 3, username: 'fixture', allowed_bundles: options.bundles ?? [47] } };
    let status = 200; let data: any;
    const res = { status: (value: number) => { status = value; return res; }, json: (value: unknown) => { data = value; }, setHeader: () => {} };
    await handler(req as never, res as never, () => {});
    return { status, data };
  };
  return { call, issuer, fetchFn, pool, token, router };
}
describe('checkpoint continuation authorization boundary', () => {
  it('verifies historical signatures without making expired grants executable', () => {
    const token = signExecutionGrant(secret, oldClaims());
    expect(() => verifyExecutionGrant(secret, token)).toThrow('expired');
    expect(checkpointGrantProvenance(secret, token).principalId).toBe('3');
    expect(() => checkpointGrantProvenance(secret, token.slice(0, -4) + 'AAAA')).toThrow();
    expect(() => checkpointGrantProvenance(secret, 'malformed')).toThrow();
  });
  it('rejects replacement inputs, bundles, approvals and arbitrary destinations', () => {
    expect(checkpointRetryBody({ checkpointId, workspaceDigest })).toEqual({ checkpointId, workspaceDigest });
    for (const body of [null, {}, { checkpointId, workspaceDigest, approved: true }, { checkpointId, workspaceDigest, bundleIds: [9] }, { checkpointId, workspaceDigest, input: {} }]) {
      expect(() => checkpointRetryBody(body)).toThrow();
    }
  });
  it('projects safe read-only eligibility with no grant or metadata exposure', async () => {
    const f = fixture(); const result = await f.call('get');
    expect(result.status).toBe(200); expect(result.data).toEqual({ available: true, node: 'coder', checkpointId, workspaceDigest });
    expect(JSON.stringify(result.data)).not.toContain(f.token); expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
  });
  it('blocks wrong owner, revoked authority, denied Bundles, drift and missing audit before dispatch', async () => {
    for (const options of [{ userId: 4 }, { revoked: true }, { bundles: [3] }, { available: false }, { drift: true }, { auditFails: true }]) {
      const f = fixture(options); expect((await f.call('post')).status).toBeGreaterThanOrEqual(400);
      expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    }
  });
  it('renews exact original scope and forwards the token only to the Pack', async () => {
    const f = fixture(); const result = await f.call('post'); expect(result.status).toBe(202);
    expect(f.issuer.issueWithClaims).toHaveBeenCalledWith(expect.objectContaining({ principalId: '3', requestedBundleIds: [47], workspaceRoot: '/workspace/TICKET', rootTraceId: id }));
    expect(JSON.stringify(result.data)).not.toContain('fresh-secret-token'); expect(f.fetchFn).toHaveBeenCalledTimes(2);
    const forwarded = JSON.parse((f.fetchFn.mock.calls[1]![1] as RequestInit).body as string); expect(forwarded.grant).toBe('fresh-secret-token');
  });
  it('registers auth and permission guards only on the two new routes, not unrelated callbacks', () => {
    const f = fixture(); expect(f.router.stack).toHaveLength(2);
    for (const layer of f.router.stack) {
      expect(layer.route?.path).toBe('/threads/:id/checkpoint-retry');
      expect(layer.route?.stack[0]?.handle.name).toBe('requireAuth');
    }
  });
  it('QA recheck preserves owner, bundle, revocation, drift and audit boundaries', async () => {
    for (const options of [{ userId: 4 }, { revoked: true }, { bundles: [3] }, { available: false }, { drift: true }, { auditFails: true }]) {
      const f = fixture({ ...options, qa: true }); expect((await f.call('post')).status).toBeGreaterThanOrEqual(400);
      expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    }
  });
  it('QA preview does not issue authority; resume rejects response text and stale review hash', async () => {
    const f = fixture({ qa: true }); const preview = await f.call('get');
    expect(preview.data.reviewDigest).toBe('c'.repeat(64)); expect(JSON.stringify(preview.data)).not.toContain(f.token);
    expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    expect(() => qaResponseRecheckBody({ checkpointId, workspaceDigest, reviewDigest: 'c'.repeat(64), response: 'invented' })).toThrow();
    expect((await f.call('post', { checkpointId, workspaceDigest, reviewDigest: 'd'.repeat(64) })).status).toBe(409);
    expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    expect((await f.call('post')).status).toBe(202);
    expect(String(f.fetchFn.mock.calls.at(-1)![0])).toMatch(/qa-response-recheck$/);
    expect(f.pool.query.mock.calls.some(c => Array.isArray(c[1]) && c[1].includes('workflow_qa_response_recovery_requested'))).toBe(true);
  });
  it('fresh QA retry keeps all authorization boundaries and audits a distinct paid execution request', async () => {
    for (const options of [{ userId: 4 }, { revoked: true }, { bundles: [3] }, { available: false }, { drift: true }, { auditFails: true }]) {
      const f = fixture({ ...options, qaRetry: true }); expect((await f.call('post')).status).toBeGreaterThanOrEqual(400);
      expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    }
    const f = fixture({ qaRetry: true });
    expect((await f.call('get')).status).toBe(200); expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    expect((await f.call('post', { checkpointId, workspaceDigest, reviewDigest: '0'.repeat(64) })).status).toBe(409);
    expect((await f.call('post', { checkpointId, workspaceDigest, reviewDigest: 'c'.repeat(64), node: 'coder' })).status).toBe(400);
    expect((await f.call('post')).status).toBe(202);
    expect(String(f.fetchFn.mock.calls.at(-1)![0])).toMatch(/qa-retry$/);
    expect(f.pool.query.mock.calls.some(c => Array.isArray(c[1]) && c[1].includes('workflow_qa_retry_requested'))).toBe(true);
    expect(f.issuer.issueWithClaims).toHaveBeenCalledTimes(1);
  });
  it('projects omission details, never private answers; requires exact reviewed fingerprints and unchanged authority', async () => {
    const f = fixture({ qaRetry: true, omission: true });
    const preview = await f.call('get');
    expect(preview.data.retryKind).toBe('missing_reviews'); expect(preview.data.missingDecisionIds).toEqual(['delivery_boundary']);
    expect(JSON.stringify(preview.data)).not.toContain('private original answer');
    expect(f.issuer.issueWithClaims).not.toHaveBeenCalled();
    for (const extra of [{ missingDecisionIds: ['other'] }, { retryKind: 'format' }, { response: 'accept all' }, { approved: true }]) {
      expect((await f.call('post', { checkpointId, workspaceDigest, reviewDigest: 'c'.repeat(64), ...extra })).status).toBe(400);
    }
    expect((await f.call('post')).status).toBe(202);
    expect(f.issuer.issueWithClaims).toHaveBeenCalledTimes(1);
    expect(f.issuer.issueWithClaims).toHaveBeenCalledWith(expect.objectContaining({ principalId: '3', requestedBundleIds: [47], workspaceRoot: '/workspace/TICKET' }));
    const audit = f.pool.query.mock.calls.find(c => Array.isArray(c[1]) && c[1].includes('workflow_qa_retry_requested'));
    expect(JSON.stringify(audit)).toContain('missing_reviews'); expect(JSON.stringify(audit)).not.toContain('private original answer');
  });
});
