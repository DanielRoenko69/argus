import { describe, expect, it, jest } from '@jest/globals';
import type { Express, RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { registerCodeGenerationRoutes } from '../codeGenerationRoutes.js';
import { codegenHash, parseCodegenPlan, parseCodegenFiles, codegenBytesHash } from '../codeGenerationContract.js';
function fixture() {
  let handler: RequestHandler;
  const grant = { aud: 'argus.dev', agent: 'coding-orchestrator', workspaceRoot: '/workspace/FIXTURE', rootTraceId: randomUUID(),
    testEnvironmentPolicy: 'general-stack-v1', codeGeneration: { version: 1, allowedPaths: ['client.ts'] },
    principalId: '3', principalKind: 'user', coreAgentIds: [2], coreAgents: [{ id: 2, name: 'reviewer' }] };
  const plan = { version: 1, summary: 'fixture', setup: 'install', start: '', generate: 'generate', outputPaths: ['client.ts'] };
  const input = { action: 'generate', baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), sourceSha256: 'c'.repeat(64), plan };
  const receipt = { version: 1, threadId: grant.rootTraceId, basisSha256: input.basisSha256, sourceSha256: input.sourceSha256,
    requestSha256: codegenHash({ ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot, allowedPaths: grant.codeGeneration.allowedPaths }),
    planSha256: codegenHash(plan), brokerRequestSha256: 'd'.repeat(64), baseImage: 'sha256:' + 'e'.repeat(64),
    resultSourceSha256: 'f'.repeat(64), applied: true,
    outputs: [{ path: 'client.ts', beforeSha256: null, sha256: '1'.repeat(64) }], finishedAt: new Date().toISOString() };
  const order: string[] = [];
  const auditFn = jest.fn<any>(async () => { order.push('audit'); });
  const fetchFn = jest.fn<any>(async () => { order.push('worker'); return Response.json(receipt); });
  let enabled = true;
  registerCodeGenerationRoutes({ post: (_: string, ...handlers: RequestHandler[]) => { handler = handlers.at(-1)!; } } as Express,
    {} as never, ((_req, _res, next) => next()) as RequestHandler, { enabled: () => enabled, fetchFn, auditFn });
  async function call(overrides = {}) {
    let status = 200, body: any;
    const res = { status: (s: number) => { status = s; return res; }, json: (v: unknown) => { body = v; }, setHeader: () => {} };
    await handler({ params: { id: '2' }, body: input, executionGrant: grant, ...overrides } as never, res as never, () => {});
    return { status, body };
  }
  return { call, grant, input, receipt, fetchFn, auditFn, order, disable: () => { enabled = false; } };
}
describe('isolated code generation authority and receipts', () => {
  it('does not promote old grants into mutable workspace authority', async () => {
    const f = fixture(), body = { ...f.input, executionMode: 'workspace-session-v1' };
    expect((await f.call({ body })).status).toBe(403);
    expect((await f.call({ executionGrant: { ...f.grant, testEnvironmentPolicy: 'workspace-session-v1' } })).status).toBe(403);
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('requires its new signed capability, named Reviewer, workspace and flag', async () => {
    const f = fixture();
    for (const grant of [null, { ...f.grant, codeGeneration: undefined }, { ...f.grant, testEnvironmentPolicy: undefined },
      { ...f.grant, workspaceRoot: null }, { ...f.grant, aud: 'argus.aiops' }, { ...f.grant, executionSurface: 'runtime_mcp' },
      { ...f.grant, coreAgentIds: [] }, { ...f.grant, coreAgents: [{ id: 2, name: 'coder' }] }])
      expect((await f.call({ executionGrant: grant })).status).toBe(403);
    f.disable(); expect((await f.call()).status).toBe(503); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('denies caller authority injection and out-of-scope or protected outputs', async () => {
    const f = fixture();
    for (const delta of [{ threadId: randomUUID() }, { allowedPaths: [] }, { workspaceRoot: '/workspace/OTHER' }, { mounts: ['/'] },
      ...['other.ts', '.env', '../client.ts', 'package.json', 'Dockerfile', 'nested/AGENTS.md', 'client.ts/client.ts'].map(p => ({ plan: { ...f.input.plan, outputPaths: [p] } })),
      { plan: { ...f.input.plan, image: 'arbitrary' } }])
      expect((await f.call({ body: { ...f.input, ...delta } })).status).toBe(400);
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.auditFn).not.toHaveBeenCalled();
  });
  it('audits hash-only metadata before write and before returning evidence', async () => {
    const f = fixture(); expect((await f.call()).status).toBe(200);
    expect(f.order).toEqual(['audit', 'worker', 'audit']);
    const sent = JSON.parse((f.fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(sent.workspaceRoot).toBe(f.grant.workspaceRoot); expect(sent.allowedPaths).toEqual(['client.ts']);
    for (const call of f.auditFn.mock.calls) {
      expect(call[3]).not.toHaveProperty('plan'); expect(JSON.stringify(call[3])).not.toContain('"setup"');
    }
  });
  it('fails closed on audit errors, swapped receipts and duplicate outputs, with no replay', async () => {
    const f = fixture(); f.auditFn.mockRejectedValue(new Error('offline'));
    expect((await f.call()).status).toBe(503); expect(f.fetchFn).not.toHaveBeenCalled();
    for (const delta of [{ requestSha256: '0'.repeat(64) }, { sourceSha256: '0'.repeat(64) }, { threadId: randomUUID() },
      { planSha256: '0'.repeat(64) }, { applied: false }, { outputs: [] }, { outputs: [fixture().receipt.outputs[0], fixture().receipt.outputs[0]] }]) {
      const t = fixture(); t.fetchFn.mockResolvedValue(Response.json({ ...t.receipt, ...delta }));
      expect((await t.call()).status).toBe(503); expect(t.fetchFn).toHaveBeenCalledTimes(1);
    }
  });
  it('cancel requires server-bound scope and confirmed stop', async () => {
    const f = fixture(), body = { action: 'cancel', baseCommitSha: f.input.baseCommitSha, basisSha256: f.input.basisSha256 };
    f.fetchFn.mockResolvedValue(Response.json({ stopped: true })); expect((await f.call({ body })).status).toBe(200);
    f.fetchFn.mockResolvedValue(Response.json({ stopped: false })); expect((await f.call({ body })).status).toBe(503);
    expect((await f.call({ body: { ...body, threadId: randomUUID() } })).status).toBe(400);
  });
  it('returns bounded failure output but keeps script output out of canonical audit', async () => {
    const f = fixture();
    const failure = { phase: 'generate', status: 'failed', exitCode: 2, stdout: '', stderr: 'generator fixture failed', durationMs: 1,
      outputSha256: codegenHash(['', 'generator fixture failed']) };
    f.fetchFn.mockResolvedValue(Response.json({ code: 'codegen_generation_failed_no_import', failure }, { status: 409 }));
    const response = await f.call(); expect(response.status).toBe(409); expect(response.body.failure).toEqual(failure);
    expect(f.auditFn.mock.calls.at(-1)![3]).toMatchObject({ applied: false, outputSha256: failure.outputSha256 });
    expect(JSON.stringify(f.auditFn.mock.calls)).not.toContain('generator fixture failed');
    f.fetchFn.mockResolvedValue(Response.json({ code: 'codegen_generation_failed_no_import', failure: { ...failure, stderr: 'tampered' } }, { status: 409 }));
    expect((await f.call()).status).toBe(503);
  });
  it('preserves a workspace capacity rejection through Core without a retry', async () => {
    const f = fixture(), code = 'codegen_stack_session_capacity';
    f.fetchFn.mockResolvedValue(Response.json({ code, privateDetails: 'PRIVATE' }, { status: 409 }));
    expect(await f.call()).toEqual({ status: 409, body: { code } });
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    expect(f.auditFn.mock.calls.at(-1)![3]).toMatchObject({ applied: false, code });
    expect(JSON.stringify(f.auditFn.mock.calls)).not.toContain('PRIVATE');
  });
  it('recovers only an exact workspace-session import and audits it separately', async () => {
    const previous = process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'];
    process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] = 'true';
    try {
      const f = fixture(), recoveryDigest = '9'.repeat(64);
      f.grant.testEnvironmentPolicy = 'workspace-session-v1';
      Object.assign(f.input, { executionMode: 'workspace-session-v1' });
      Object.assign(f.receipt, { executionMode: 'workspace-session-v1' });
      f.receipt.requestSha256 = codegenHash({ ...f.input, threadId: f.grant.rootTraceId,
        workspaceRoot: f.grant.workspaceRoot, allowedPaths: f.grant.codeGeneration.allowedPaths });
      const response = await f.call({ path: '/api/agents/2/code-generation/recover', body: { ...f.input, recoveryDigest } });
      expect(response.status).toBe(200);
      expect(f.fetchFn.mock.calls[0]![0]).toContain('/code-generation/recover');
      expect(JSON.parse((f.fetchFn.mock.calls[0]![1] as { body: string }).body)).toMatchObject({ recoveryDigest });
      expect(f.auditFn.mock.calls.map(call => call[2])).toEqual(['recovery_requested', 'recovery_result']);
      expect(f.auditFn.mock.calls[0]![3]).toMatchObject({ recoveryDigest });
      const invalid = fixture();
      invalid.grant.testEnvironmentPolicy = 'workspace-session-v1';
      expect((await invalid.call({ path: '/api/agents/2/code-generation/recover',
        body: { ...invalid.input, executionMode: 'workspace-session-v1', recoveryDigest: 'bad' } })).status).toBe(400);
      expect(invalid.fetchFn).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'];
      else process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] = previous;
    }
  });
  it('validates exact bounded text outputs rather than trusting container hashes', () => {
    const plan = parseCodegenPlan(fixture().input.plan, []);
    const bytes = Buffer.from('generated\n'), file = { path: 'client.ts', beforeSha256: null, sha256: codegenBytesHash(bytes), content: bytes.toString('base64') };
    expect(parseCodegenFiles([file], plan)).toEqual([file]);
    for (const delta of [{ content: '???' }, { sha256: 'a'.repeat(64) }, { path: 'other.ts' }, { beforeSha256: '' }, { content: Buffer.from([0]).toString('base64'), sha256: codegenBytesHash(Buffer.from([0])) }])
      expect(() => parseCodegenFiles([{ ...file, ...delta }], plan)).toThrow();
  });
});
