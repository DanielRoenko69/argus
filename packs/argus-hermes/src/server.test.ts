import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArgusHermesConfig } from './config.js';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import { ManagedHermesRunService } from './managedRunService.js';
import { ManagedRunStore } from './managedRunStore.js';
import type { ManagedHermesRunner, ManagedHermesRunnerCallbacks } from './managedRunner.js';
import { ARGUS_HERMES_PACK_MANIFEST } from './packManifest.js';
import { HERMES_RUNTIME_CAPABILITY_CEILING } from './runtimeTypes.js';
import {
  createArgusHermesServer,
  managedRunSseSnapshot,
  MAX_MANAGED_RUN_SSE_SNAPSHOT_BYTES,
  runtimeCapabilities,
  runtimeStatus,
  serializeManagedRunSseEvent,
} from './server.js';

function validManagedRunRequest() {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
    mode: 'managed',
    run: {
      id: '950610b9-97b4-41cb-908f-46cc80bd22a2',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      messageId: 'message-42',
      sessionId: 'hermes:81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      coreAgent: { id: 42, name: 'coder' },
      input: { text: 'Analyse the task and implement the scoped change.' },
    },
    runtimeMcpLease: {
      kind: 'argus.runtime-mcp-lease/v1alpha1',
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      endpoint: 'http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      executionGrant: 'eg_v1.opaque-payload.opaque-signature',
      expiresAt: '2026-08-30T14:15:00.000Z',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      bundleIds: [3, 7],
      serverName: 'argus_core',
    },
    limits: { deadlineAt: '2026-08-30T14:15:00.000Z', maxToolCalls: 40, maxOutputBytes: 262144 },
  };
}

function validManagedRunCancelRequest() {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: '0348e241-0c5b-41a4-9b24-ae7263b3e18a',
    rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
    reason: 'Operator cancelled the run.',
  };
}

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  configOverrides: Partial<ArgusHermesConfig> = {},
  managedRuns?: ManagedHermesRunService,
  attachedRuns?: {
    startRun(input: string): Promise<{ id: string; mode: 'attached'; state: 'running'; updatedAt: string }>;
    getRun(runId: string): Promise<{ id: string; mode: 'attached'; state: 'completed'; updatedAt: string; output: string }>;
    stopRun(runId: string): Promise<{ id: string; mode: 'attached'; state: 'stopping'; updatedAt: string }>;
  },
) {
  const server = createArgusHermesServer({
    config: {
      port: 0,
      publicUrl: 'http://127.0.0.1:0',
      discoveryToken: 'pack-test-token',
      requestTimeoutMs: 5000,
      ...configOverrides,
    },
    ...(managedRuns ? { managedRuns } : {}),
    ...(attachedRuns ? { attachedRuns } : {}),
    probe: {
      status: async () => ({
        configured: false,
        mode: 'attached',
        state: 'not_configured',
        checkedAt: '2026-08-30T12:00:00.000Z',
        detail: 'No external Hermes API service is configured yet.',
      }),
    },
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

class HoldingManagedRunner implements ManagedHermesRunner {
  callbacks?: ManagedHermesRunnerCallbacks;
  cancelRequested = false;

  availability() {
    return { state: 'ready' as const, detail: 'Isolated runner broker is ready.' };
  }

  async provision(_request: ManagedHermesRunStartRequest, callbacks: ManagedHermesRunnerCallbacks): Promise<void> {
    this.callbacks = callbacks;
    await callbacks.onStarted('native-run-100');
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true;
  }
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      last = error;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw last;
}

test('exposes an unauthenticated liveness check but protects Pack and runtime discovery', async () => {
  await withServer(async baseUrl => {
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await health.json() as { pack: string }).pack, 'argus.hermes');

    assert.equal((await fetch(`${baseUrl}/readyz`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/.well-known/argus-solution-pack.yaml`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2`)).status, 401);
  });
});

test('fails closed for every route except healthz when no Pack service credential is configured', async () => {
  await withServer(async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    for (const path of [
      '/readyz',
      '/.well-known/argus-solution-pack.yaml',
      '/runtime/v1/adapters/hermes-http/capabilities',
      '/runtime/v1/adapters/hermes-http/status',
      '/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2',
    ]) {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 503, path);
      assert.equal((await response.json() as { error: { code: string } }).error.code, 'SERVICE_CREDENTIAL_REQUIRED');
    }
  }, { discoveryToken: undefined });
});

test('serves a discoverable runtime adapter and validates a managed-run request before provisioning', async () => {
  await withServer(async baseUrl => {
    const headers = { authorization: 'Bearer pack-test-token' };
    const manifest = await fetch(`${baseUrl}/.well-known/argus-solution-pack.yaml`, { headers });
    assert.equal(manifest.status, 200);
    const document = await manifest.json() as { metadata: { id: string }; spec: { components: { runtimeAdapters: Array<{ runtime: string }> } } };
    assert.equal(document.metadata.id, 'argus.hermes');
    assert.equal(document.spec.components.runtimeAdapters[0]?.runtime, 'hermes');

    const capabilities = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/capabilities`, { headers });
    assert.deepEqual(await capabilities.json(), runtimeCapabilities());

    const status = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/status`, { headers });
    assert.deepEqual(await status.json(), runtimeStatus({
      configured: false,
      mode: 'attached',
      state: 'not_configured',
      checkedAt: '2026-08-30T12:00:00.000Z',
      detail: 'No external Hermes API service is configured yet.',
    }));

    const run = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validManagedRunRequest()),
    });
    assert.equal(run.status, 409);
    assert.equal((await run.json() as { error: { code: string } }).error.code, 'MANAGED_RUNNER_NOT_PROVISIONED');

    const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
    const runStatus = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/${runId}`, { headers });
    assert.equal(runStatus.status, 409);
    assert.equal((await runStatus.json() as { error: { code: string } }).error.code, 'MANAGED_RUNNER_NOT_PROVISIONED');

    const cancel = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(validManagedRunCancelRequest()),
    });
    assert.equal(cancel.status, 409);
    assert.equal((await cancel.json() as { error: { code: string } }).error.code, 'MANAGED_RUNNER_NOT_PROVISIONED');

    const events = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/${runId}/events`, {
      headers: { ...headers, accept: 'text/event-stream' },
    });
    assert.equal(events.status, 409);
    assert.match(events.headers.get('content-type') ?? '', /^application\/json/);
    assert.equal((await events.json() as { error: { code: string } }).error.code, 'MANAGED_RUNNER_NOT_PROVISIONED');

    const invalidRunId = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/not-a-run-id`, { headers });
    assert.equal(invalidRunId.status, 400);
    assert.equal((await invalidRunId.json() as { error: { code: string } }).error.code, 'INVALID_RUNTIME_REQUEST');

    const grantInCancel = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ ...validManagedRunCancelRequest(), executionGrant: 'eg_v1.not-allowed.here' }),
    });
    assert.equal(grantInCancel.status, 400);
    const grantError = await grantInCancel.json() as { error: { code: string; message: string } };
    assert.equal(grantError.error.code, 'INVALID_RUNTIME_REQUEST');
    assert.doesNotMatch(JSON.stringify(grantError), /eg_v1/);

    const attached = validManagedRunRequest();
    attached.mode = 'attached' as never;
    const attachedRun = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify(attached),
    });
    assert.equal(attachedRun.status, 409);
    assert.equal((await attachedRun.json() as { error: { code: string } }).error.code, 'ATTACHED_MCP_LEASE_UNSUPPORTED');
  });
});

test('labels attached Hermes as externally attested and never lease-capable', () => {
  const status = runtimeStatus({
    configured: true,
    mode: 'attached',
    state: 'ready',
    checkedAt: '2026-08-30T12:00:00.000Z',
    detail: 'External / attested Hermes v2026.7.7.2 capability handshake succeeded.',
  });
  const attached = status.modes.find(mode => mode.mode === 'attached');
  assert.match(attached?.detail ?? '', /External \/ attested/);
  assert.match(attached?.detail ?? '', /never accepts a Core-issued runtime MCP lease/);
});

test('rejects a managed lease endpoint outside the configured Core runtime MCP origin', async () => {
  await withServer(async baseUrl => {
    const request = validManagedRunRequest();
    request.runtimeMcpLease.endpoint = 'http://untrusted-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1';
    const response = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs`, {
      method: 'POST',
      headers: { authorization: 'Bearer pack-test-token', 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVALID_RUNTIME_REQUEST');
  }, { coreRuntimeMcpOrigin: 'http://argus-core:3000' });
});

test('advertises only the capability usable before the managed provisioner exists', () => {
  assert.deepEqual(runtimeCapabilities().capabilities, ['health']);
  assert.deepEqual(runtimeCapabilities(false, true).capabilities, ['health', 'runs', 'cancel']);
});

test('exposes authenticated external-attested attached run lifecycle without claiming Core tool governance', async () => {
  const calls: string[] = [];
  const attachedRuns = {
    async startRun(input: string) {
      calls.push(`start:${input}`);
      return { id: 'run_smoke-1', mode: 'attached' as const, state: 'running' as const, updatedAt: '2026-08-31T12:00:00.000Z' };
    },
    async getRun(runId: string) {
      calls.push(`get:${runId}`);
      return { id: runId, mode: 'attached' as const, state: 'completed' as const, updatedAt: '2026-08-31T12:00:01.000Z', output: 'ok' };
    },
    async stopRun(runId: string) {
      calls.push(`stop:${runId}`);
      return { id: runId, mode: 'attached' as const, state: 'stopping' as const, updatedAt: '2026-08-31T12:00:02.000Z' };
    },
  };
  await withServer(async baseUrl => {
    const headers = { authorization: 'Bearer pack-test-token', 'content-type': 'application/json' };
    const start = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/attached/runs`, {
      method: 'POST', headers, body: JSON.stringify({ apiVersion: 'argus-runtime-v1alpha1', input: { text: 'Read-only smoke.' } }),
    });
    assert.equal(start.status, 202);
    const started = await start.json() as { trust: string; governance: { coreMcpLease: boolean }; run: { id: string } };
    assert.equal(started.trust, 'external_attested');
    assert.equal(started.governance.coreMcpLease, false);
    assert.equal(started.run.id, 'run_smoke-1');

    const status = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/attached/runs/run_smoke-1`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { run: { state: string } }).run.state, 'completed');

    const stop = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/attached/runs/run_smoke-1/stop`, {
      method: 'POST', headers, body: JSON.stringify({ apiVersion: 'argus-runtime-v1alpha1' }),
    });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json() as { run: { state: string } }).run.state, 'stopping');
    assert.deepEqual(calls, ['start:Read-only smoke.', 'get:run_smoke-1', 'stop:run_smoke-1']);
  }, { hermesApiKey: 'configured-upstream-key' }, undefined, attachedRuns);
});

test('declares the full managed contract ceiling without advertising unavailable operations', () => {
  const adapter = ARGUS_HERMES_PACK_MANIFEST.spec.components.runtimeAdapters[0]!;
  assert.deepEqual(adapter.capabilities, HERMES_RUNTIME_CAPABILITY_CEILING);
  assert.deepEqual(runtimeCapabilities().capabilities, ['health']);
  assert.deepEqual(runtimeCapabilities(true).capabilities, HERMES_RUNTIME_CAPABILITY_CEILING);
});

test('bounds a durable SSE snapshot below Core\'s response limit while preserving cursor order', () => {
  const events = Array.from({ length: 128 }, (_, index) => ({
    apiVersion: 'argus-runtime-v1alpha1' as const,
    eventId: `cursor-${index + 1}`,
    sequence: index + 1,
    occurredAt: '2026-08-30T12:00:00.000Z',
    run: {
      id: '950610b9-97b4-41cb-908f-46cc80bd22a2',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      state: 'running' as const,
    },
    type: 'tool.completed' as const,
    evidence: {
      tool: 'github_read',
      phase: 'x'.repeat(128),
      outcome: 'x'.repeat(128),
      category: 'x'.repeat(128),
      adapter: 'x'.repeat(128),
    },
  }));
  const snapshot = managedRunSseSnapshot(events);
  assert.ok(snapshot.length > 0);
  assert.ok(snapshot.length < events.length);
  assert.deepEqual(snapshot, events.slice(0, snapshot.length));
  assert.ok(Buffer.byteLength(snapshot.map(serializeManagedRunSseEvent).join('')) <= MAX_MANAGED_RUN_SSE_SNAPSHOT_BYTES);
});

test('keeps an injected managed runner unavailable until the Core runtime MCP origin is pinned', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-server-origin-'));
  try {
    const runner = new HoldingManagedRunner();
    const managedRuns = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);
    await withServer(async baseUrl => {
      const headers = { authorization: 'Bearer pack-test-token', 'content-type': 'application/json' };
      const capabilities = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/capabilities`, { headers });
      assert.deepEqual((await capabilities.json() as { capabilities: string[] }).capabilities, ['health']);

      const start = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs`, {
        method: 'POST', headers, body: JSON.stringify(validManagedRunRequest()),
      });
      assert.equal(start.status, 409);
      assert.equal((await start.json() as { error: { code: string } }).error.code, 'MANAGED_RUNNER_NOT_PROVISIONED');
      assert.equal(runner.callbacks, undefined);
    }, {}, managedRuns);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('exposes only redacted managed lifecycle endpoints when an isolated runner service is injected', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-server-run-'));
  try {
    const runner = new HoldingManagedRunner();
    const managedRuns = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);
    await withServer(async baseUrl => {
      const headers = { authorization: 'Bearer pack-test-token', 'content-type': 'application/json' };
      const capabilities = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/capabilities`, { headers });
      const capabilityDocument = await capabilities.json() as { capabilities: string[] };
      assert.deepEqual(capabilityDocument.capabilities, ['health', 'runs', 'events-sse', 'cancel', 'mcp-fabric']);

      const start = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs`, {
        method: 'POST', headers, body: JSON.stringify(validManagedRunRequest()),
      });
      assert.equal(start.status, 202);
      assert.equal((await start.json() as { run: { state: string } }).run.state, 'queued');
      await eventually(async () => {
        const status = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2`, { headers });
        assert.equal(status.status, 200);
        assert.equal((await status.json() as { run: { state: string } }).run.state, 'running');
      });

      const events = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2/events`, {
        headers: { authorization: 'Bearer pack-test-token', accept: 'text/event-stream' },
      });
      assert.equal(events.status, 200);
      const eventText = await events.text();
      assert.match(eventText, /event: argus\.runtime\.event/);
      assert.match(eventText, /"type":"run\.accepted"/);
      assert.match(eventText, /"type":"run\.started"/);
      assert.doesNotMatch(eventText, /eg_v1\./);
      const eventIds = [...eventText.matchAll(/^id: ([A-Za-z0-9._:-]+)$/gm)].map(match => match[1]!);
      assert.equal(eventIds.length, 3);
      const resumedEvents = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2/events`, {
        headers: {
          authorization: 'Bearer pack-test-token',
          accept: 'text/event-stream',
          'last-event-id': eventIds[1]!,
        },
      });
      assert.equal(resumedEvents.status, 200);
      const resumedEventText = await resumedEvents.text();
      assert.match(resumedEventText, /"type":"run\.started"/);
      assert.doesNotMatch(resumedEventText, /"type":"run\.accepted"/);
      assert.doesNotMatch(resumedEventText, /"type":"run\.provisioning"/);

      const cancel = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2/cancel`, {
        method: 'POST', headers, body: JSON.stringify(validManagedRunCancelRequest()),
      });
      assert.equal(cancel.status, 200);
      assert.equal((await cancel.json() as { run: { state: string } }).run.state, 'cancelled');
      assert.equal(runner.cancelRequested, true);
      assert.ok(runner.callbacks);
      await runner.callbacks.onCancelled();
      const terminal = await fetch(`${baseUrl}/runtime/v1/adapters/hermes-http/runs/950610b9-97b4-41cb-908f-46cc80bd22a2`, { headers });
      assert.equal((await terminal.json() as { run: { state: string } }).run.state, 'cancelled');
    }, { coreRuntimeMcpOrigin: 'http://argus-core:3000' }, managedRuns);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
