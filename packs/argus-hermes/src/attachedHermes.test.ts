import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTACHED_HERMES_CAPABILITY_CONTRACT,
  AttachedHermesClient,
  AttachedHermesRunError,
  validateAttachedHermesCapabilities,
  validateAttachedHermesHealth,
} from './attachedHermes.js';

function healthPayload(version: string = ATTACHED_HERMES_CAPABILITY_CONTRACT.version) {
  return {
    status: 'ok',
    platform: 'hermes-agent',
    version,
  };
}

function capabilitiesPayload(runtime: Record<string, unknown> = {}) {
  return {
    object: 'hermes.api_server.capabilities',
    platform: 'hermes-agent',
    runtime: {
      mode: 'server_agent',
      tool_execution: 'server',
      split_runtime: false,
      ...runtime,
    },
  };
}

test('reports a clean not-configured state until an external Hermes service is attached', async () => {
  const client = new AttachedHermesClient({ requestTimeoutMs: 5000 }, fetch, () => new Date('2026-08-30T12:00:00.000Z'));
  assert.deepEqual(await client.status(), {
    configured: false,
    mode: 'attached',
    state: 'not_configured',
    checkedAt: '2026-08-30T12:00:00.000Z',
    detail: 'No external Hermes API service is configured yet.',
  });
});

test('requires both documented Hermes endpoints for an attached service to be ready', async () => {
  const calls: string[] = [];
  const client = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test',
    hermesApiKey: 'redacted-test-key',
    requestTimeoutMs: 5000,
  }, async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.headers && new Headers(init.headers).get('authorization'), 'Bearer redacted-test-key');
    const payload = String(input).endsWith('/health/detailed')
      ? healthPayload()
      : capabilitiesPayload();
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  }, () => new Date('2026-08-30T12:00:00.000Z'));

  const status = await client.status();
  assert.equal(status.state, 'ready');
  assert.equal(status.mode, 'attached');
  assert.deepEqual(calls.sort(), [
    'https://hermes.example.test/health/detailed',
    'https://hermes.example.test/v1/capabilities',
  ]);
  assert.doesNotMatch(JSON.stringify(status), /redacted-test-key/);
});

test('locks the v2026.7.7.2 release to package version 0.18.2 and its server-side execution contract', () => {
  assert.equal(validateAttachedHermesHealth(healthPayload()), undefined);
  assert.equal(validateAttachedHermesCapabilities(capabilitiesPayload()), undefined);

  assert.match(
    validateAttachedHermesCapabilities(capabilitiesPayload({ mode: 'client_agent' })) ?? '',
    /runtime\.mode/,
  );
  assert.match(
    validateAttachedHermesCapabilities(capabilitiesPayload({ tool_execution: 'client' })) ?? '',
    /runtime\.tool_execution/,
  );
  assert.match(
    validateAttachedHermesCapabilities(capabilitiesPayload({ split_runtime: true })) ?? '',
    /split_runtime/,
  );
  assert.match(
    validateAttachedHermesHealth(healthPayload('0.18.3')) ?? '',
    /pinned version/,
  );
});

test('marks a reachable attached service degraded when its JSON contract is unsafe', async () => {
  const client = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test',
    requestTimeoutMs: 5000,
  }, async input => {
    const payload = String(input).endsWith('/health/detailed')
      ? healthPayload()
      : capabilitiesPayload({ split_runtime: true });
    return new Response(JSON.stringify(payload), { status: 200 });
  });

  const status = await client.status();
  assert.equal(status.state, 'degraded');
  assert.equal(status.health?.ok, true);
  assert.equal(status.capabilities?.ok, false);
  assert.match(status.capabilities?.error ?? '', /split_runtime/);
  assert.match(status.detail, /external-attested/);
  assert.match(status.detail, /v2026\.7\.7\.2/);
});

test('marks an attached service degraded when its capability handshake fails', async () => {
  const client = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test',
    requestTimeoutMs: 5000,
  }, async input => new Response(
    String(input).endsWith('/health/detailed') ? JSON.stringify(healthPayload()) : '{}',
    { status: String(input).endsWith('/health/detailed') ? 200 : 404 },
  ));

  const status = await client.status();
  assert.equal(status.state, 'degraded');
  assert.equal(status.capabilities?.error, 'HTTP 404');
});

test('starts, polls and stops a bounded attached Hermes run without exposing its API key', async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null; body?: string }> = [];
  const client = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test',
    hermesApiKey: 'attached-secret',
    requestTimeoutMs: 5000,
  }, async (input, init) => {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      authorization: new Headers(init?.headers).get('authorization'),
      ...(body === undefined ? {} : { body }),
    });
    if (String(input).endsWith('/stop')) {
      return new Response(JSON.stringify({ status: 'stopping' }), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({ run_id: 'run_safe-42', status: 'started' }), { status: 202 });
    }
    return new Response(JSON.stringify({
      object: 'hermes.run', run_id: 'run_safe-42', status: 'completed', output: 'Smoke test complete.',
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    }), { status: 200 });
  }, () => new Date('2026-08-31T12:00:00.000Z'));

  assert.deepEqual(await client.startRun('Perform a read-only smoke test.'), {
    id: 'run_safe-42', mode: 'attached', state: 'running', updatedAt: '2026-08-31T12:00:00.000Z',
  });
  assert.deepEqual(await client.getRun('run_safe-42'), {
    id: 'run_safe-42', mode: 'attached', state: 'completed', updatedAt: '2026-08-31T12:00:00.000Z',
    output: 'Smoke test complete.', usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 },
  });
  assert.deepEqual(await client.stopRun('run_safe-42'), {
    id: 'run_safe-42', mode: 'attached', state: 'stopping', updatedAt: '2026-08-31T12:00:00.000Z',
  });
  assert.equal(JSON.parse(calls[0]!.body ?? '{}').input, 'Perform a read-only smoke test.');
  assert.ok(calls.every(call => call.authorization === 'Bearer attached-secret'));
  assert.doesNotMatch(JSON.stringify(await client.getRun('run_safe-42')), /attached-secret/);
});

test('fails attached execution closed without credentials or with unsafe upstream state', async () => {
  const noCredential = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test', requestTimeoutMs: 5000,
  });
  await assert.rejects(noCredential.startRun('smoke'), (cause: unknown) =>
    cause instanceof AttachedHermesRunError && cause.code === 'ATTACHED_HERMES_AUTH_REQUIRED');

  const unsafe = new AttachedHermesClient({
    hermesBaseUrl: 'https://hermes.example.test', hermesApiKey: 'secret', requestTimeoutMs: 5000,
  }, async () => new Response(JSON.stringify({ run_id: '../escape', status: 'mystery' }), { status: 202 }));
  await assert.rejects(unsafe.startRun('smoke'), (cause: unknown) =>
    cause instanceof AttachedHermesRunError && cause.code === 'INVALID_ATTACHED_RUN_REQUEST');
});
