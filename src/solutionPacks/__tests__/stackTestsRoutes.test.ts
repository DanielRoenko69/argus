import { describe, expect, it, jest } from '@jest/globals';
import type { Express, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { registerStackTestsRoutes, STACK_WORKSPACE_TIMEOUT_MS } from '../stackTestsRoutes.js';
import { stackHash, stackRequestSchema } from '../stackEnvironment.js';
function fixture() {
  let handler: RequestHandler;
  const grant = { aud: 'argus.dev', agent: 'coding-orchestrator', workspaceRoot: '/workspace/FIXTURE', rootTraceId: randomUUID(),
    testEnvironmentPolicy: 'general-stack-v1',
    principalId: '3', principalKind: 'user', coreAgentIds: [2], coreAgents: [{ id: 2, name: 'reviewer' }] };
  const plan = { version: 1, summary: 'fixture', setup: 'install', start: '', test: 'test-command', python: '/usr/bin/python3' };
  const input = { action: 'project', baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), stackPlan: plan };
  const receipt = { version: 1, threadId: grant.rootTraceId, basisSha256: input.basisSha256, sourceSha256: input.sourceSha256,
    testSha256: stackHash(plan.test), requestSha256: stackHash({ ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot }),
    profile: 'stack-container-v1', status: 'completed', exitCode: 0, stdout: 'fixture', stderr: '', durationMs: 1,
    passed: true, assertionFailed: false, collected: 0, nodes: [], missingModules: [], executionStarted: true,
    stackEnvironment: { version: 1, phase: 'project', planSha256: stackHash(plan), brokerRequestSha256: 'd'.repeat(64),
      baseImage: 'sha256:' + 'e'.repeat(64), preparedImage: 'sha256:' + 'f'.repeat(64) },
    outputSha256: stackHash(['fixture', '']), finishedAt: new Date().toISOString() };
  const order: string[] = [];
  const auditFn = jest.fn<(...args: any[]) => any>(async () => { order.push('audit'); });
  const fetchFn = jest.fn<(...args: any[]) => any>(async () => { order.push('worker'); return Response.json(receipt); });
  let enabled = true;
  registerStackTestsRoutes({ post: (_: string, ...handlers: RequestHandler[]) => { handler = handlers.at(-1)!; } } as Express,
    {} as never, ((_req, _res, next) => next()) as RequestHandler, { enabled: () => enabled, fetchFn, auditFn });
  async function call(overrides = {}) {
    let status = 200, body: any;
    const res = { status: (s: number) => { status = s; return res; }, json: (v: unknown) => { body = v; }, setHeader: () => {} };
    await handler({ params: { id: '2' }, body: input, executionGrant: grant, ...overrides } as never, res as never, () => {});
    return { status, body };
  }
  return { call, grant, input, receipt, fetchFn, auditFn, order, disable: () => { enabled = false; } };
}
describe('governed general stack route', () => {
  it('requires a matching signed workspace policy, feature flag and mode-bound receipt', async () => {
    const f = fixture(), executionMode = 'workspace-session-v1';
    const body = { ...f.input, executionMode }, grant = { ...f.grant, testEnvironmentPolicy: executionMode };
    expect((await f.call({ body })).status).toBe(403);
    expect((await f.call({ executionGrant: grant })).status).toBe(403);
    const old = process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'];
    try {
      process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] = 'false';
      expect((await f.call({ body, executionGrant: grant })).status).toBe(503);
      expect(f.fetchFn).not.toHaveBeenCalled();
      process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] = 'true';
      const receipt = { ...f.receipt, profile: executionMode,
        requestSha256: stackHash({ ...stackRequestSchema.parse(body), threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot }),
        stackEnvironment: { ...f.receipt.stackEnvironment, executionMode, preparedImage: null, preparedSession: 'd'.repeat(64), sessionId: '1'.repeat(64) } };
      f.fetchFn.mockResolvedValue(Response.json(receipt));
      expect((await f.call({ body, executionGrant: grant })).status).toBe(200);
      f.fetchFn.mockResolvedValue(Response.json(f.receipt));
      expect((await f.call({ body, executionGrant: grant })).body.code).toBe('stack_invalid_evidence');
    } finally { if (old === undefined) delete process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED']; else process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] = old; }
  });
  it('preserves startup failure and rejects invented test execution or assertions', async () => {
    const f = fixture();
    const receipt = { ...f.receipt, passed: false, status: 'preparation_failed', exitCode: 1, executionStarted: false,
      stackEnvironment: { ...f.receipt.stackEnvironment, testStarted: false, executionStatus: 'failed' } };
    f.fetchFn.mockResolvedValue(Response.json(receipt));
    const response = await f.call(); expect(response.status).toBe(200);
    expect(response.body.executionStarted).toBe(false);
    expect(response.body.stackEnvironment.testStarted).toBe(false);
    for (const delta of [{ passed: true }, { assertionFailed: true }, { executionStarted: true }, { collected: 1 }, { nodes: ['invented'] }]) {
      f.fetchFn.mockResolvedValue(Response.json({ ...receipt, ...delta }));
      const rejected = await f.call();
      expect(rejected.status).toBe(503);
      expect(rejected.body.code).toBe('stack_invalid_evidence');
    }
  });
  it('propagates only bounded snapshot codes, never Docker paths or raw errors', async () => {
    const f = fixture();
    expect(STACK_WORKSPACE_TIMEOUT_MS).toBe(2_520_000 + 30_000);
    for (const code of ['stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped', 'stack_snapshot_reconciliation_required']) {
      f.fetchFn.mockResolvedValue(Response.json({ error: code, details: 'SECRET' }, { status: 409 }));
      expect((await f.call()).body).toEqual({ code, upstreamStatus: 409, rootTraceId: f.grant.rootTraceId });
    }
    for (const text of ['PRIVATE', JSON.stringify({ error: 'stack_SECRET' }), JSON.stringify({ error: 'stack_snapshot_timeout_no_replay', details: 'x'.repeat(8192) })]) {
      f.fetchFn.mockResolvedValue(new Response(text, { status: 409 }));
      expect((await f.call()).body.code).toBe('stack_workspace_http_error');
    }
  });
  it('reports bounded dependency status and distinguishes timeout, transport, audit and invalid evidence', async () => {
    const f = fixture();
    f.fetchFn.mockResolvedValue(Response.json({ error: 'SECRET', token: 'PRIVATE' }, { status: 409 }));
    expect((await f.call()).body).toEqual({ code: 'stack_workspace_http_error', upstreamStatus: 409, rootTraceId: f.grant.rootTraceId });
    f.fetchFn.mockRejectedValue(Object.assign(new Error('SECRET'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } }));
    expect((await f.call()).body.code).toBe('stack_workspace_timeout');
    f.fetchFn.mockRejectedValue(new Error('SECRET'));
    const transport = await f.call();
    expect(transport.body.code).toBe('stack_workspace_transport_error');
    expect(JSON.stringify(transport)).not.toMatch(/SECRET|PRIVATE/);
    f.fetchFn.mockResolvedValue(new Response('not JSON'));
    expect((await f.call()).body.code).toBe('stack_invalid_evidence');
    f.auditFn.mockRejectedValue(new Error('PRIVATE'));
    expect((await f.call()).body.code).toBe('stack_audit_unavailable');
  });
  it('preserves the actual setup stop and bounded capture in governed evidence and audit', async () => {
    const f = fixture();
    const environment = { ...f.receipt.stackEnvironment, phase: 'setup', preparedImage: null, executionStatus: 'output_limit',
      outputCapture: { version: 1, stdoutBytes: 40000, stderrBytes: 0, stdoutTruncated: true, stderrTruncated: false } };
    f.fetchFn.mockResolvedValue(Response.json({ ...f.receipt, passed: false, exitCode: 137, status: 'preparation_failed',
      executionStarted: false, stackEnvironment: environment }));
    const response = await f.call();
    expect(response.status).toBe(200); expect(response.body.stackEnvironment).toEqual(environment);
    expect(f.auditFn.mock.calls.at(-1)?.[3]).toMatchObject({ environment });
    f.fetchFn.mockResolvedValue(Response.json({ ...f.receipt, stackEnvironment: { ...f.receipt.stackEnvironment, executionStatus: 'timeout' } }));
    expect((await f.call()).status).toBe(503);
  });
  it('requires the run-bound Reviewer and explicit operator enablement', async () => {
    const f = fixture();
    for (const grant of [null, { ...f.grant, testEnvironmentPolicy: undefined }, { ...f.grant, workspaceRoot: null }, { ...f.grant, aud: 'argus.aiops' },
      { ...f.grant, coreAgentIds: [] }, { ...f.grant, coreAgents: [{ id: 2, name: 'coder' }] }])
      expect((await f.call({ executionGrant: grant })).status).toBe(403);
    f.disable(); expect((await f.call()).status).toBe(503);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('rejects client authority and malformed plans before any dispatch', async () => {
    const f = fixture();
    for (const delta of [{ threadId: randomUUID() }, { workspaceRoot: '/workspace/OTHER' }, { mounts: ['/'] },
      { stackPlan: { ...f.input.stackPlan, image: 'arbitrary' } }, { stackPlan: { ...f.input.stackPlan, test: '' } }])
      expect((await f.call({ body: { ...f.input, ...delta } })).status).toBe(400);
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.auditFn).not.toHaveBeenCalled();
  });
  it('audits metadata before execution and before returning bound evidence', async () => {
    const f = fixture(); expect((await f.call()).status).toBe(200);
    expect(f.order).toEqual(['audit', 'worker', 'audit']);
    expect(JSON.parse((f.fetchFn.mock.calls[0]![1] as { body: string }).body).workspaceRoot).toBe(f.grant.workspaceRoot);
    for (const call of f.auditFn.mock.calls) {
      expect(call[3]).not.toHaveProperty('stackPlan'); expect(call[3]).not.toHaveProperty('stdout');
    }
  });
  it('fails closed on audit failure, wrong binding or forged passing status', async () => {
    const f = fixture(); f.auditFn.mockRejectedValue(new Error('offline'));
    expect((await f.call()).status).toBe(503); expect(f.fetchFn).not.toHaveBeenCalled();
    for (const delta of [{ requestSha256: '0'.repeat(64) }, { sourceSha256: '0'.repeat(64) }, { stdout: 'tampered' },
      { exitCode: 1 }, { executionStarted: false }, { stackEnvironment: { ...fixture().receipt.stackEnvironment, preparedImage: null } }]) {
      const t = fixture(); t.fetchFn.mockResolvedValue(Response.json({ ...t.receipt, ...delta }));
      expect((await t.call()).status).toBe(503); expect(t.fetchFn).toHaveBeenCalledTimes(1);
    }
  });
  it('cancel is bound server-side and requires a confirmed stop', async () => {
    const f = fixture(); f.fetchFn.mockResolvedValue(Response.json({ stopped: true }));
    expect((await f.call({ body: { action: 'cancel', baseCommitSha: f.input.baseCommitSha, basisSha256: f.input.basisSha256 } })).status).toBe(200);
    f.fetchFn.mockResolvedValue(Response.json({ stopped: false }));
    expect((await f.call({ body: { action: 'cancel', baseCommitSha: f.input.baseCommitSha, basisSha256: f.input.basisSha256 } })).status).toBe(503);
  });
});
