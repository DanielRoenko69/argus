import { describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import { registerQaTestsRoutes } from '../qaTestsRoutes.js';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
function fixture(environmentsEnabled = false) {
  let handler: RequestHandler;
  const grant = { aud: 'argus.dev', agent: 'coding-orchestrator', workspaceRoot: '/workspace/FIXTURE', rootTraceId: randomUUID(),
    principalId: '7', principalKind: 'user', coreAgentIds: [2], coreAgents: [{ id: 2, name: 'reviewer' }] };
  const input = { action: 'run', baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64),
    files: [{ id: 'seed', content: 'def test_seed(): assert True' }] };
  const request = { ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot };
  const receipt = { version: 1, threadId: grant.rootTraceId, basisSha256: input.basisSha256, sourceSha256: input.sourceSha256,
    testSha256: hash(input.files), requestSha256: hash(request), profile: 'python-bwrap-v1', status: 'completed', exitCode: 0,
    stdout: 'fixture', stderr: '', durationMs: 1, passed: true, assertionFailed: false, collected: 1, nodes: ['test_seed.py::test_seed'],
    outputSha256: hash(['fixture', '']), finishedAt: new Date().toISOString() };
  const order: string[] = [];
  const audit = jest.fn<(...args: any[]) => any>(async () => { order.push('audit'); });
  const fetchFn = jest.fn<(...args: any[]) => any>(async () => { order.push('worker'); return Response.json(receipt); });
  let enabled = true;
  registerQaTestsRoutes({ post: (_path: string, ...h: RequestHandler[]) => { handler = h.at(-1)!; } } as Express,
    {} as never, ((_req, _res, next) => next()) as RequestHandler, { enabled: () => enabled, environmentsEnabled: () => environmentsEnabled, auditFn: audit, fetchFn });
  async function call(overrides: Record<string, unknown> = {}) {
    let status = 200, body: any;
    const response = { status: (s: number) => { status = s; return response; }, json: (b: unknown) => { body = b; }, setHeader: () => {} };
    await handler({ params: { id: '2' }, executionGrant: grant, body: input, ...overrides } as never, response as never, () => {});
    return { status, body };
  }
  return { call, input, grant, receipt, audit, fetchFn, order, disable: () => { enabled = false; } };
}
describe('independent QA route', () => {
  it('requires opt-in for structured supplements and rejects authority overrides', async () => {
    const f = fixture(true);
    const needs = [{ requirement: 'hypothesis>=6', reason: 'Independent property tests' }];
    for (const delta of [{ environmentRequirements: needs },
      { environmentPolicyVersion: 1, environmentPlanSha256: 'd'.repeat(64), environmentRequirements: [{ ...needs[0], registry: 'evil' }] },
      { environmentPolicyVersion: 1, environmentPlanSha256: 'd'.repeat(64), environmentRequirements: [{ requirement: 'x @ https://evil', reason: 'untrusted' }] }]) {
      expect((await f.call({ body: { ...f.input, ...delta } })).status).toBe(400);
    }
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
  });
  it('requires frozen run Reviewer identity and a workspace-bound grant, not a browser session/API key', async () => {
    const f = fixture();
    for (const grant of [undefined, { ...f.grant, workspaceRoot: '' }, { ...f.grant, coreAgentIds: [3] },
      { ...f.grant, coreAgents: [{ id: 2, name: 'coder' }] }, { ...f.grant, aud: 'argus.aiops' }]) {
      expect((await f.call({ executionGrant: grant, user: { id: 7 }, apiKeyId: 1 })).status).toBe(403);
    }
    f.disable(); expect((await f.call()).status).toBe(503);
    expect(f.audit).not.toHaveBeenCalled(); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('rejects path/command/authority overrides, duplicate IDs and byte limits before executing', async () => {
    const f = fixture();
    for (const change of [{ workspaceRoot: '/workspace/OTHER' }, { threadId: randomUUID() }, { cmd: 'sh' },
      { files: [{ id: '../product', content: 'x' }] }, { files: [...f.input.files, ...f.input.files] },
      { files: [{ id: 'too_big', content: 'é'.repeat(9000) }] }]) {
      expect((await f.call({ body: { ...f.input, ...change } })).status).toBe(400);
    }
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('audits before dispatch and return, binds receipt, and keeps code/output/secrets out of audit', async () => {
    const f = fixture(); expect((await f.call()).status).toBe(200);
    expect(f.order).toEqual(['audit', 'worker', 'audit']);
    const sent = JSON.parse((f.fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(sent.workspaceRoot).toBe(f.grant.workspaceRoot); expect(sent.threadId).toBe(f.grant.rootTraceId);
    for (const call of f.audit.mock.calls) {
      expect(call[3]).not.toHaveProperty('files'); expect(call[3]).not.toHaveProperty('stdout'); expect(call[3]).not.toHaveProperty('token');
    }
  });
  it('fails closed without automatic replay on failed audit, stale hashes or lost result', async () => {
    const blocked = fixture(); blocked.audit.mockRejectedValue(new Error('unavailable'));
    expect((await blocked.call()).status).toBe(503); expect(blocked.fetchFn).not.toHaveBeenCalled();
    for (const change of [{ stdout: 'tampered' }, { threadId: randomUUID() }, { sourceSha256: 'f'.repeat(64) },
      { testSha256: 'f'.repeat(64) }, { requestSha256: 'f'.repeat(64) }, { exitCode: 1 }, { collected: 0 }]) {
      const f = fixture(); f.fetchFn.mockResolvedValue(Response.json({ ...f.receipt, ...change }));
      expect((await f.call()).status).toBe(503); expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.audit).toHaveBeenCalledTimes(1);
    }
    const f = fixture(); f.fetchFn.mockRejectedValue(new Error('lost response'));
    expect((await f.call()).status).toBe(503); expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it('inspection has no execution artifact or write audit', async () => {
    const f = fixture(), snapshot = { sourceSha256: 'd'.repeat(64), files: 5, excludedFiles: 2, python: true };
    f.fetchFn.mockResolvedValue(Response.json(snapshot));
    expect((await f.call({ body: { action: 'inspect', baseCommitSha: f.input.baseCommitSha, basisSha256: f.input.basisSha256 } })).body).toEqual(snapshot);
    expect(f.audit).not.toHaveBeenCalled();
  });
  it('keeps environment installation disabled by default and rejects unbound plans/package overrides', async () => {
    const f = fixture();
    expect((await f.call({ body: { ...f.input, environmentPolicyVersion: 1, environmentPlanSha256: 'd'.repeat(64) } })).status).toBe(503);
    expect(f.fetchFn).not.toHaveBeenCalled();
    const enabled = fixture(true);
    for (const extra of [{ environmentPolicyVersion: 1 }, { environmentPlanSha256: 'd'.repeat(64) },
      { environmentPolicyVersion: 1, environmentPlanSha256: 'd'.repeat(64), packages: ['arbitrary'] }]) {
      expect((await enabled.call({ body: { ...enabled.input, ...extra } })).status).toBe(400);
    }
    expect(enabled.fetchFn).not.toHaveBeenCalled();
  });
  it('binds environment receipts, rejects false passes and audits preparation failures without source/output', async () => {
    const plan = { version: 1, status: 'ready', languages: ['python'], manifestSha256: '1'.repeat(64), profileId: 'fixture',
      profileSha256: '2'.repeat(64), runtime: 'cpython-3.12.13-linux-aarch64', reasons: [] };
    const environment = { version: 1, status: 'blocked', reason: 'environment_install_failed',
      plan: { ...plan, planSha256: hash([plan.version, plan.status, plan.languages, plan.manifestSha256, plan.profileId, plan.profileSha256, plan.runtime, plan.reasons]) },
      packages: [], installationOutputSha256: '3'.repeat(64), preflightOutputSha256: null };
    for (const delta of [{}, { passed: true }, { executionStarted: true }, { status: 'completed' }, { collected: 1 }, { environment: undefined }]) {
      const f = fixture(true);
      const input = { ...f.input, environmentPolicyVersion: 1, environmentPlanSha256: environment.plan.planSha256 };
      f.fetchFn.mockImplementation(async (_url: string, options: RequestInit) => Response.json({ ...f.receipt,
        requestSha256: hash(JSON.parse(options.body as string)), status: 'preparation_failed', passed: false, assertionFailed: false,
        executionStarted: false, collected: 0, nodes: [], exitCode: null, environment, ...delta }));
      const result = await f.call({ body: input });
      expect(result.status).toBe(Object.keys(delta).length ? 503 : 200);
      if (!Object.keys(delta).length) {
        const details = f.audit.mock.calls[1]![3] as Record<string, unknown>;
        expect(details.environmentStatus).toBe('blocked'); expect(details.executionStarted).toBe(false);
        expect(details).not.toHaveProperty('packages'); expect(details).not.toHaveProperty('stdout');
      }
    }
  });
});
