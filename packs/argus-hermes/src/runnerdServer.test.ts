import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  type HermesRunnerdRun,
} from './runnerdContract.js';
import type { HermesRunnerdLauncher } from './runnerdLauncher.js';
import type { HermesRunnerdConfig } from './runnerdConfig.js';
import { HermesRunnerdService } from './runnerdService.js';
import { createHermesRunnerdServer, runnerdServiceTokenMatches } from './runnerdServer.js';
import { RunnerdRunStore } from './runnerdStore.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const REQUEST_ID = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
const TOKEN = 'runnerd-test-service-token';

function config(stateDirectory: string): HermesRunnerdConfig {
  return {
    port: 0,
    serviceToken: TOKEN,
    coreRuntimeMcpOrigin: 'http://argus-core:3000',
    stateDirectory,
  };
}

function headers(contentType = false): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    'x-argus-hermes-runnerd-protocol': ARGUS_HERMES_RUNNERD_PROTOCOL,
    ...(contentType ? { 'content-type': 'application/json' } : {}),
  };
}

function launchRequest(): Record<string, unknown> {
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    request: {
      apiVersion: 'argus-runtime-v1alpha1',
      requestId: REQUEST_ID,
      mode: 'managed',
      run: {
        id: RUN_ID,
        rootTraceId: TRACE_ID,
        messageId: 'message-42',
        sessionId: `managed:${RUN_ID}`,
        coreAgent: { id: 42, name: 'coder' },
        input: { text: 'private prompt must never leave the runner boundary' },
        instructions: 'private instructions must never appear in runnerd output',
      },
      runtimeMcpLease: {
        kind: 'argus.runtime-mcp-lease/v1alpha1',
        leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
        endpoint: 'http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
        executionGrant: 'eg_v1.opaque-payload.opaque-signature',
        expiresAt: '2026-08-31T14:15:00.000Z',
        rootTraceId: TRACE_ID,
        bundleIds: [3],
        serverName: 'argus_core',
      },
      limits: { deadlineAt: '2026-08-31T14:15:00.000Z', maxToolCalls: 20, maxOutputBytes: 65_536 },
    },
  };
}

class TestLauncher implements HermesRunnerdLauncher {
  launchCount = 0;
  cancelReasons: string[] = [];
  private run?: HermesRunnerdRun;

  availability() {
    return { state: 'ready' as const, detail: 'test launcher ready' };
  }

  async launch(request: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    this.launchCount += 1;
    this.run = {
      id: request.run.id,
      nativeRunId: 'native-run-42',
      state: 'running',
      evidence: { phase: 'started', attempt: 1 },
    };
    return this.run;
  }

  async status(runId: string): Promise<HermesRunnerdRun> {
    return this.run ?? { id: runId, nativeRunId: 'native-run-42', state: 'running' };
  }

  async cancel(runId: string, reason?: string): Promise<HermesRunnerdRun> {
    this.cancelReasons.push(`${runId}:${reason ?? ''}`);
    this.run = { id: runId, state: 'cancelled' };
    return this.run;
  }
}

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-runnerd-server-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(
  directory: string,
  run: (baseUrl: string) => Promise<void>,
  service?: HermesRunnerdService,
): Promise<void> {
  const server = createHermesRunnerdServer({ config: config(directory), ...(service ? { service } : {}) });
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

test('keeps runnerd liveness separate and defaults every authenticated lifecycle route to fail-closed', async () => {
  await withDirectory(async directory => {
    await withServer(directory, async baseUrl => {
      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
      assert.deepEqual(await health.json(), { status: 'ok' });

      const anonymous = await fetch(`${baseUrl}/v1/ready`, {
        headers: { 'x-argus-hermes-runnerd-protocol': ARGUS_HERMES_RUNNERD_PROTOCOL },
      });
      assert.equal(anonymous.status, 401);
      assert.equal((await anonymous.json() as { error: { code: string } }).error.code, 'UNAUTHENTICATED');

      const missingProtocol = await fetch(`${baseUrl}/v1/ready`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(missingProtocol.status, 400);
      assert.equal((await missingProtocol.json() as { error: { code: string } }).error.code, 'INVALID_RUNNERD_PROTOCOL');

      const ready = await fetch(`${baseUrl}/v1/ready`, { headers: headers() });
      assert.equal(ready.status, 503);
      assert.equal((await ready.json() as { error: { code: string } }).error.code, 'RUNNERD_NOT_PROVISIONED');

      // The server rejects before parsing the bearer-grant body while no
      // provisioner exists, so no validation diagnostic can reflect it.
      const start = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST', headers: headers(true), body: JSON.stringify(launchRequest()),
      });
      assert.equal(start.status, 503);
      const body = JSON.stringify(await start.json());
      assert.doesNotMatch(body, /eg_v1\.|private prompt|argus-core/i);
    });
  });
});

test('accepts only a fixed authenticated protocol and returns redacted run projections', async () => {
  await withDirectory(async directory => {
    const launcher = new TestLauncher();
    const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory: directory }), launcher);
    await withServer(directory, async baseUrl => {
      const ready = await fetch(`${baseUrl}/v1/ready`, { headers: headers() });
      assert.deepEqual(await ready.json(), { apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'ready' });

      const invalid = structuredClone(launchRequest()) as Record<string, unknown>;
      (invalid['request'] as Record<string, unknown>)['containerImage'] = 'attacker/image:latest';
      const rejected = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST', headers: headers(true), body: JSON.stringify(invalid),
      });
      assert.equal(rejected.status, 400);
      const rejectedText = JSON.stringify(await rejected.json());
      assert.doesNotMatch(rejectedText, /eg_v1\.|attacker\/image|argus-core/i);
      assert.equal(launcher.launchCount, 0);

      const launched = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST', headers: headers(true), body: JSON.stringify(launchRequest()),
      });
      assert.equal(launched.status, 202);
      const launchBody = await launched.json() as { apiVersion: string; run: { id: string; state: string; nativeRunId?: string } };
      assert.deepEqual(launchBody, {
        apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
        run: { id: RUN_ID, nativeRunId: 'native-run-42', state: 'running', evidence: { phase: 'started', attempt: 1 } },
      });
      assert.equal(launcher.launchCount, 1);
      assert.doesNotMatch(JSON.stringify(launchBody), /eg_v1\.|private prompt|private instructions|argus-core/i);

      const duplicate = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST', headers: headers(true), body: JSON.stringify(launchRequest()),
      });
      assert.equal(duplicate.status, 202);
      assert.equal(launcher.launchCount, 1);

      const status = await fetch(`${baseUrl}/v1/runs/${RUN_ID}`, { headers: headers() });
      assert.equal(status.status, 200);
      assert.equal((await status.json() as { run: { state: string } }).run.state, 'running');

      const persisted = await readFile(join(directory, 'runnerd-runs.json'), 'utf8');
      assert.doesNotMatch(persisted, /eg_v1\.|private prompt|private instructions|argus-core|endpoint/i);

      const cancel = await fetch(`${baseUrl}/v1/runs/${RUN_ID}/cancel`, {
        method: 'POST', headers: headers(true), body: JSON.stringify({
          apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
          reason: 'operator request',
        }),
      });
      assert.equal(cancel.status, 200);
      // Native identity and already-normalized evidence are immutable
      // redacted lifecycle facts, so terminal cancellation retains them.
      assert.deepEqual((await cancel.json() as { run: { state: string } }).run, {
        id: RUN_ID,
        nativeRunId: 'native-run-42',
        state: 'cancelled',
        evidence: { phase: 'started', attempt: 1 },
      });
      assert.deepEqual(launcher.cancelReasons, [`${RUN_ID}:operator request`]);
    }, service);
  });
});

test('fails malformed paths, bodies, queries and oversized inputs without exposing their content', async () => {
  await withDirectory(async directory => {
    const launcher = new TestLauncher();
    const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory: directory }), launcher);
    await withServer(directory, async baseUrl => {
      const query = await fetch(`${baseUrl}/v1/ready?debug=http://argus-core:3000`, { headers: headers() });
      assert.equal(query.status, 404);
      assert.doesNotMatch(JSON.stringify(await query.json()), /argus-core/i);

      const badCancel = await fetch(`${baseUrl}/v1/runs/${RUN_ID}/cancel`, {
        method: 'POST', headers: headers(true), body: JSON.stringify({
          apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
          executionGrant: 'eg_v1.please-do-not-echo.signature',
        }),
      });
      assert.equal(badCancel.status, 400);
      assert.doesNotMatch(JSON.stringify(await badCancel.json()), /eg_v1\./);

      const tooLarge = await fetch(`${baseUrl}/v1/runs`, {
        method: 'POST', headers: headers(true), body: 'x'.repeat(128 * 1024 + 1),
      });
      assert.equal(tooLarge.status, 413);
      assert.equal((await tooLarge.json() as { error: { code: string } }).error.code, 'REQUEST_TOO_LARGE');

      const malformedId = await fetch(`${baseUrl}/v1/runs/not-a-run-id`, { headers: headers() });
      assert.equal(malformedId.status, 400);
      assert.doesNotMatch(JSON.stringify(await malformedId.json()), /not-a-run-id/);
    }, service);
  });
});

test('uses constant-time comparison semantics for runnerd service credentials', () => {
  assert.equal(runnerdServiceTokenMatches(TOKEN, TOKEN), true);
  assert.equal(runnerdServiceTokenMatches(TOKEN, `${TOKEN}-wrong`), false);
});
