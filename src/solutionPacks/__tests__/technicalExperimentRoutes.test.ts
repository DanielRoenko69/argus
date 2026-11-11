import { describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import type { Express, RequestHandler } from 'express';
import { registerTechnicalExperimentRoute } from '../technicalExperimentRoutes.js';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function fixture() {
  let handler: RequestHandler;
  const grant = { aud: 'argus.dev', agent: 'coding-orchestrator', workspaceRoot: '/workspace/FIXTURE', rootTraceId: randomUUID(),
    principalId: '7', principalKind: 'user', coreAgentIds: [1], coreAgents: [{ id: 1, name: 'planner' }] };
  const input = { baseCommitSha: 'a'.repeat(40), basisSha256: 'b'.repeat(64), requestSha256: 'c'.repeat(64), script: 'print(42)' };
  const receipt = { version: 1, threadId: grant.rootTraceId, ...input, scriptSha256: hash(input.script),
    snapshotSha256: 'd'.repeat(64), profile: 'python-bwrap-v1', status: 'completed', exitCode: 0, stdout: '42', stderr: '',
    outputSha256: hash(JSON.stringify(['42', ''])), startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    durationMs: 1, files: 1, excludedFiles: 0, pythonVersion: '3.12.14', limits: { wallMs: 30000, cpuSeconds: 20, memoryBytes: 536870912,
      outputBytes: 32768, scriptBytes: 24000, snapshotBytes: 67108864, snapshotFiles: 3000 } };
  delete (receipt as Partial<typeof receipt>).script;
  const order: string[] = [];
  const audit = jest.fn<(...args: any[]) => any>(async () => { order.push('audit'); });
  const fetchFn = jest.fn<(...args: any[]) => any>(async () => { order.push('worker'); return Response.json(receipt); });
  let enabled = true;
  registerTechnicalExperimentRoute({ post: (_path: string, ...h: RequestHandler[]) => { handler = h.at(-1)!; } } as Express,
    {} as never, ((_req, _res, next) => next()) as RequestHandler, { enabled: () => enabled, auditFn: audit, fetchFn });
  async function call(overrides: Record<string, unknown> = {}) {
    let status = 200, body: any;
    const response = { status: (s: number) => { status = s; return response; }, json: (b: unknown) => { body = b; }, setHeader: () => {} };
    await handler({ params: { id: '1' }, executionGrant: grant, body: input, ...overrides } as never, response as never, () => {});
    return { status, body };
  }
  return { call, input, grant, receipt, audit, fetchFn, order, disable: () => { enabled = false; } };
}
describe('bounded technical experiment route', () => {
  it('requires enabled server policy and exact workspace-bound Planner grant; session/API key are insufficient', async () => {
    const f = fixture();
    for (const grant of [undefined, { ...f.grant, workspaceRoot: '' }, { ...f.grant, coreAgentIds: [2] },
      { ...f.grant, coreAgents: [{ id: 1, name: 'coder' }] }, { ...f.grant, aud: 'argus.aiops' }]) {
      expect((await f.call({ executionGrant: grant, user: { id: 7 }, apiKeyId: 1 })).status).toBe(403);
    }
    f.disable(); expect((await f.call()).status).toBe(503);
    expect(f.audit).not.toHaveBeenCalled(); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('rejects authority/mount/command overrides and multibyte oversized source before dispatch', async () => {
    const f = fixture();
    for (const change of [{ workspaceRoot: '/workspace/other' }, { threadId: randomUUID() }, { cmd: 'sh' }, { script: 'é'.repeat(13000) }, { snapshotFileBytes: 33554432 }]) {
      expect((await f.call({ body: { ...f.input, ...change } })).status).toBe(400);
    }
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it('audits before dispatch and before returning exact immutable evidence, without source/output/credential payload', async () => {
    const f = fixture(); expect((await f.call()).status).toBe(200);
    expect(f.order).toEqual(['audit', 'worker', 'audit']);
    const sent = JSON.parse((f.fetchFn.mock.calls[0]![1] as { body: string }).body);
    expect(sent.workspaceRoot).toBe(f.grant.workspaceRoot); expect(sent.threadId).toBe(f.grant.rootTraceId);
    for (const call of f.audit.mock.calls) {
      expect(call[3]).not.toHaveProperty('script'); expect(call[3]).not.toHaveProperty('stdout'); expect(call[3]).not.toHaveProperty('token');
    }
    expect((f.audit.mock.calls[1]![3] as { outputSha256: string }).outputSha256).toBe(f.receipt.outputSha256);
  });
  it('audit failure prevents execution; unavailable or mismatched receipt never auto-retries', async () => {
    const blocked = fixture(); blocked.audit.mockRejectedValue(new Error('unavailable'));
    expect((await blocked.call()).status).toBe(503); expect(blocked.fetchFn).not.toHaveBeenCalled();
    for (const change of [{ stdout: 'different' }, { threadId: randomUUID() }, { scriptSha256: 'f'.repeat(64) }, { exitCode: 1 }]) {
      const f = fixture(); f.fetchFn.mockResolvedValue(Response.json({ ...f.receipt, ...change }));
      expect((await f.call()).status).toBe(503); expect(f.fetchFn).toHaveBeenCalledTimes(1); expect(f.audit).toHaveBeenCalledTimes(1);
    }
    const f = fixture(); f.fetchFn.mockRejectedValue(new Error('lost response'));
    expect((await f.call()).status).toBe(503); expect(f.fetchFn).toHaveBeenCalledTimes(1);
  });
  it('accepts bounded operator snapshot limits and rejects limits above the hard ceiling', async () => {
    for (const [fileMiB, totalMiB, status] of [[16, 128, 200], [32, 256, 200], [33, 256, 503], [16, 257, 503], [16, 8, 503], [1.5, 128, 503]]) {
      const f = fixture();
      f.fetchFn.mockResolvedValue(Response.json({ ...f.receipt, limits: { ...f.receipt.limits,
        snapshotFileBytes: fileMiB! * 1048576, snapshotBytes: totalMiB! * 1048576 } }));
      expect((await f.call()).status).toBe(status);
      expect(f.fetchFn).toHaveBeenCalledTimes(1);
    }
  });
  it('returns audited source-bound preparation failure without inventing execution evidence', async () => {
    const f = fixture();
    const { threadId, baseCommitSha, basisSha256, requestSha256, scriptSha256 } = f.receipt;
    const receipt = { version: 1, threadId, baseCommitSha, basisSha256, requestSha256, scriptSha256,
      status: 'preparation_failed', executionStarted: false, reason: 'snapshot_file_size_limit',
      actual: 16777217, limit: 16777216, filePath: 'public/banner.jpg',
      limits: { ...f.receipt.limits, snapshotFileBytes: 16777216, snapshotBytes: 134217728 } };
    f.fetchFn.mockResolvedValue(Response.json(receipt));
    expect(await f.call()).toEqual({ status: 200, body: receipt });
    expect(f.order).toEqual(['audit', 'audit']); // mocked worker has no order side effect
    expect(f.fetchFn).toHaveBeenCalledTimes(1);
    expect(f.audit.mock.calls[1]![3]).toMatchObject({ status: 'preparation_failed', executionStarted: false, reason: 'snapshot_file_size_limit' });
    expect(f.audit.mock.calls[1]![3]).not.toHaveProperty('filePath');
    for (const change of [{ executionStarted: true }, { threadId: randomUUID() }, { requestSha256: 'f'.repeat(64) },
      { actual: receipt.limit }, { limit: 2097152 }, { filePath: '../secret' }, { filePath: 'public/\nfile' },
      { stdout: '' }, { reason: 'unknown' }]) {
      const invalid = fixture();
      invalid.fetchFn.mockResolvedValue(Response.json({ ...receipt, threadId: invalid.grant.rootTraceId, ...change }));
      expect((await invalid.call()).status).toBe(503);
      expect(invalid.fetchFn).toHaveBeenCalledTimes(1);
      expect(invalid.audit).toHaveBeenCalledTimes(1);
    }
  });
});
