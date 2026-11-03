import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createMcpAuthProxyServer,
  mcpAuthProxyGrantMatches,
  waitForMcpAuthProxyGrant,
  type McpAuthProxyServerOptions,
} from './mcpAuthProxy.js';

const LEASE_ID = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';
const ROOT_TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
const GRANT = 'eg_v1.opaque-payload.opaque-signature';

async function withServer<T>(server: Server, run: (origin: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function options(fetchFn: typeof fetch): McpAuthProxyServerOptions {
  return {
    config: {
      port: 3002,
      coreRuntimeMcpOrigin: 'http://argus-core:3000',
      leaseId: LEASE_ID,
      rootTraceId: ROOT_TRACE_ID,
      grantFile: '/run/secrets/runtime-grant',
    },
    executionGrant: GRANT,
    fetchFn,
  };
}

test('pins all Hermes MCP traffic to one Core runtime lease and replaces caller authorization', async () => {
  const calls: Array<{ url: string; init?: RequestInit; body: string }> = [];
  const server = createMcpAuthProxyServer(options(async (input, init) => {
    calls.push({
      url: String(input),
      init,
      body: init?.body === undefined ? '' : await new Response(init.body).text(),
    });
    return new Response('{"jsonrpc":"2.0","result":{"tools":[]}}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-42',
        'set-cookie': 'must-not-reach-hermes=true',
      },
    });
  }));

  await withServer(server, async origin => {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer attacker-controlled-value',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'session-42',
        'x-forwarded-host': 'attacker.invalid',
      },
      body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"jsonrpc":"2.0","result":{"tools":[]}}');
    assert.equal(response.headers.get('mcp-session-id'), 'session-42');
    assert.equal(response.headers.get('set-cookie'), null);

    const health = await fetch(`${origin}/healthz`);
    assert.deepEqual(await health.json(), {
      status: 'ok', toolCallAttempts: 0, toolCalls: 0, toolCallFailures: 0, advertisedTools: 0,
    });

    const toolCall = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"safe_read"},"id":2}',
    });
    assert.equal(toolCall.status, 200);
    const afterCall = await fetch(`${origin}/healthz`);
    assert.deepEqual(await afterCall.json(), {
      status: 'ok', toolCallAttempts: 1, toolCalls: 1, toolCallFailures: 0, advertisedTools: 0,
    });
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.url, `http://argus-core:3000/mcp/runtime/${LEASE_ID}`);
  assert.equal((calls[0]?.init?.headers as Record<string, string>).authorization, `Bearer ${GRANT}`);
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-argus-root-trace-id'], ROOT_TRACE_ID);
  assert.equal((calls[0]?.init?.headers as Record<string, string>)['x-forwarded-host'], undefined);
  assert.equal(calls[0]?.body, '{"jsonrpc":"2.0","method":"tools/list","id":1}');
  assert.equal(calls[0]?.init?.redirect, 'manual');
});

test('counts only Core-accepted tool calls and never tools/list discovery', async () => {
  let attempts = 0;
  const server = createMcpAuthProxyServer(options(async () => {
    attempts += 1;
    return new Response('{}', { status: attempts === 1 ? 500 : 200 });
  }));
  await withServer(server, async origin => {
    await fetch(`${origin}/mcp`, { method: 'POST', body: '{"method":"tools/call"}' });
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), {
      status: 'ok', toolCallAttempts: 1, toolCalls: 0, toolCallFailures: 1, advertisedTools: 0,
    });
    await fetch(`${origin}/mcp`, { method: 'POST', body: '{"method":"tools/list"}' });
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), {
      status: 'ok', toolCallAttempts: 1, toolCalls: 0, toolCallFailures: 1, advertisedTools: 0,
    });
  });
});

test('reports only the count of tools advertised by Core, never their schemas or names', async () => {
  const server = createMcpAuthProxyServer(options(async () => new Response(`data: ${JSON.stringify({
    jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read_one' }, { name: 'read_two' }] },
  })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })));
  await withServer(server, async origin => {
    await fetch(`${origin}/mcp`, { method: 'POST', body: '{"jsonrpc":"2.0","method":"tools/list","id":1}' });
    assert.deepEqual(await (await fetch(`${origin}/healthz`)).json(), {
      status: 'ok', toolCallAttempts: 0, toolCalls: 0, toolCallFailures: 0, advertisedTools: 2,
    });
  });
});

test('does not become an arbitrary HTTP proxy and hides upstream diagnostics', async () => {
  let calls = 0;
  const server = createMcpAuthProxyServer(options(async () => {
    calls += 1;
    return new Response(`private Core diagnostic for ${GRANT}`, { status: 500 });
  }));

  await withServer(server, async origin => {
    const forbidden = await fetch(`${origin}/mcp?target=http://attacker.invalid`, { method: 'POST' });
    assert.equal(forbidden.status, 404);
    assert.equal(calls, 0);

    const failed = await fetch(`${origin}/mcp`, { method: 'POST', body: '{}' });
    assert.equal(failed.status, 502);
    const text = await failed.text();
    assert.doesNotMatch(text, /private Core diagnostic|eg_v1/);
  });
});

test('keeps the grant comparison constant-time and private to the proxy process', () => {
  assert.equal(mcpAuthProxyGrantMatches(GRANT, GRANT), true);
  assert.equal(mcpAuthProxyGrantMatches(GRANT, 'eg_v1.other-payload.other-signature'), false);
});

test('waits only for the runnerd tmpfs grant-file creation race', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-mcp-proxy-grant-'));
  const filename = join(directory, 'grant');
  try {
    const waiting = waitForMcpAuthProxyGrant(filename, 1_000);
    await new Promise(resolve => setTimeout(resolve, 50));
    const temporary = `${filename}.tmp`;
    await writeFile(temporary, `${GRANT}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, filename);
    assert.equal(await waiting, GRANT);

    await writeFile(filename, 'not-a-grant\n', { encoding: 'utf8', mode: 0o600 });
    await assert.rejects(() => waitForMcpAuthProxyGrant(filename, 1_000), /malformed/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
