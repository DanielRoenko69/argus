import assert from 'node:assert/strict';
import test from 'node:test';
import { Agent } from 'undici';

// Disposable test authority only. No real service/model is contacted.
const envKeys = ['WORKSPACE_SECRET', 'AGENT_WORKSPACE_URL', 'ARGUS_URL', 'ARGUS_CODEX_TIMEOUT_SEC', 'ARGUS_CLAUDE_TIMEOUT_SEC'] as const;
const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.WORKSPACE_SECRET = 'fixture-only';
process.env.AGENT_WORKSPACE_URL = 'http://workspace.invalid';
process.env.ARGUS_URL = 'http://core.invalid';
process.env.ARGUS_CODEX_TIMEOUT_SEC = '900';
process.env.ARGUS_CLAUDE_TIMEOUT_SEC = '900';
const { callCodexWorker } = await import('./codex.js');
const { callClaudeWorker } = await import('./claude.js');
for (const key of envKeys) {
  if (saved[key] === undefined) delete process.env[key];
  else process.env[key] = saved[key];
}

for (const [provider, worker] of [['codex', callCodexWorker], ['claude', callClaudeWorker]] as const) {
  for (const scenario of ['success', 'headers-timeout', 'body-timeout', 'worker-timeout'] as const) {
    test(`${provider} ${scenario}: scoped long timeout, correlated result and no retry`, async t => {
      let runs = 0;
      let runId = '';
      const deadlines: number[] = [];
      t.mock.method(AbortSignal, 'timeout', (ms: number) => {
        deadlines.push(ms);
        return new AbortController().signal;
      });
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit & { dispatcher?: Agent }) => {
        const url = String(input);
        if (url.endsWith('/status')) {
          assert.equal(init?.dispatcher, undefined);
          return Response.json({ enabled: true, authenticated: true, authMethod: 'fixture' });
        }
        if (url.includes('/telemetry/')) {
          assert.equal(init?.dispatcher, undefined);
          return Response.json({ ok: true });
        }
        assert.equal(url, `http://workspace.invalid/${provider}/run`);
        runs++;
        assert.ok(init?.dispatcher instanceof Agent);
        assert.ok(init.signal instanceof AbortSignal);
        const body = JSON.parse(String(init.body));
        runId = body.runId;
        assert.equal(body.timeoutSec, 900);
        assert.equal(body.rootTraceId, 'fixture-trace');
        if (scenario === 'headers-timeout') throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
        if (scenario === 'body-timeout') {
          return { ok: true, text: async () => { throw new TypeError('terminated', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } }); } };
        }
        if (scenario === 'worker-timeout') return Response.json({ code: 'runtime_timeout', error: 'Worker deadline exceeded', runId }, { status: 504 });
        return Response.json({ response: 'fixture result', model: 'fixture', events: [], durationMs: 305_000, runId });
      });
      const input = { prompt: 'fixture', cwd: '/fixture', rootTraceId: 'fixture-trace', agentId: 1, taskType: 'implement_ticket' as const };
      if (scenario === 'success') {
        const result = await worker(input);
        assert.equal(result.response, 'fixture result');
        assert.equal(result.runId, runId);
      } else {
        await assert.rejects(worker(input), error => {
          assert.ok(error instanceof Error);
          assert.ok(error.message.includes(runId));
          assert.match(error.message, scenario === 'headers-timeout' ? /response-header timeout/ : scenario === 'body-timeout' ? /response-body timeout/ : /HTTP 504.*runtime_timeout/);
          return true;
        });
      }
      assert.equal(runs, 1);
      assert.equal(deadlines.filter(ms => ms === 930_000).length, 1);
      assert.ok(deadlines.every(ms => ms === 930_000 || ms === 5_000));
    });
  }
}

test('technical Codex calls request the enforced read-only sandbox without changing legacy calls', async t => {
  const modes: Array<string | undefined> = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/status')) return Response.json({ enabled: true, authenticated: true, authMethod: 'fixture' });
    if (url.includes('/telemetry/')) return Response.json({ ok: true });
    const body = JSON.parse(String(init?.body)); modes.push(body.executionMode);
    return Response.json({ response: 'fixture', model: 'fixture', events: [], durationMs: 1, runId: body.runId });
  });
  const input = { prompt: 'fixture', cwd: '/fixture', rootTraceId: 'fixture-trace', agentId: 1, taskType: 'plan' as const };
  await callCodexWorker({ ...input, readOnly: true });
  await callCodexWorker(input);
  assert.deepEqual(modes, ['workspace-read-only', undefined]);
});
