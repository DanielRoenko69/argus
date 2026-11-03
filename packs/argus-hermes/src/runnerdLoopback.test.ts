import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import { ManagedHermesRunService } from './managedRunService.js';
import { ManagedRunStore } from './managedRunStore.js';
import {
  createMcpAuthProxyServer,
  loadMcpAuthProxyConfig,
  readMcpAuthProxyGrant,
} from './mcpAuthProxy.js';
import { HermesRunnerBrokerClient } from './runnerBrokerClient.js';
import type { HermesRunnerdRun } from './runnerdContract.js';
import type { HermesRunnerdLauncher } from './runnerdLauncher.js';
import type { HermesRunnerdConfig } from './runnerdConfig.js';
import { createHermesRunnerdServer } from './runnerdServer.js';
import { HermesRunnerdService } from './runnerdService.js';
import { RunnerdRunStore } from './runnerdStore.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const REQUEST_ID = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
const LEASE_ID = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';
const BROKER_TOKEN = 'runnerd-loopback-service-token';
const EXECUTION_GRANT = 'eg_v1.opaque-payload.opaque-signature';

function request(coreRuntimeMcpOrigin = 'http://argus-core:3000'): ManagedHermesRunStartRequest {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: REQUEST_ID,
    mode: 'managed',
    run: {
      id: RUN_ID,
      rootTraceId: TRACE_ID,
      messageId: 'message-42',
      sessionId: `managed:${RUN_ID}`,
      coreAgent: { id: 42, name: 'coder' },
      input: { text: 'private prompt stays in the one-time launch envelope' },
      instructions: 'private instructions are not durable lifecycle evidence',
    },
    runtimeMcpLease: {
      kind: 'argus.runtime-mcp-lease/v1alpha1',
      leaseId: LEASE_ID,
      endpoint: `${coreRuntimeMcpOrigin}/mcp/runtime/${LEASE_ID}`,
      executionGrant: EXECUTION_GRANT,
      expiresAt: '2026-08-31T14:15:00.000Z',
      rootTraceId: TRACE_ID,
      bundleIds: [3],
      serverName: 'argus_core',
    },
    limits: { deadlineAt: '2026-08-31T14:15:00.000Z', maxToolCalls: 20, maxOutputBytes: 65_536 },
  };
}

class LoopbackLauncher implements HermesRunnerdLauncher {
  launchCount = 0;
  statusCount = 0;
  grantWasPresentedExactlyOnce = false;
  receivedOnlyPinnedCoreLease = false;

  availability() {
    return { state: 'ready' as const, detail: 'loopback launcher ready' };
  }

  async launch(input: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    this.launchCount += 1;
    // The launcher receives the grant only during this call. Retain booleans
    // for this test, not the secret-bearing request itself.
    this.grantWasPresentedExactlyOnce = input.runtimeMcpLease.executionGrant === EXECUTION_GRANT;
    this.receivedOnlyPinnedCoreLease = input.runtimeMcpLease.endpoint === `http://argus-core:3000/mcp/runtime/${LEASE_ID}`;
    return {
      id: input.run.id,
      nativeRunId: 'native-loopback-42',
      state: 'running',
      evidence: { phase: 'started' },
    };
  }

  async status(runId: string): Promise<HermesRunnerdRun> {
    this.statusCount += 1;
    return {
      id: runId,
      nativeRunId: 'native-loopback-42',
      state: 'completed',
      evidence: { outcome: 'completed' },
    };
  }

  async cancel(runId: string): Promise<HermesRunnerdRun> {
    return { id: runId, state: 'cancelled' };
  }
}

/**
 * Test-only privileged boundary. It deliberately does not start Hermes or a
 * container: it proves that the exact launch envelope can hand the grant to
 * the real proxy through the production Linux secret-file path and nothing
 * else. No request object or grant is retained after `launch()` returns.
 */
class LinuxProxySmokeLauncher implements HermesRunnerdLauncher {
  launchCount = 0;
  statusCount = 0;
  proxyCallSucceeded = false;
  grantFile?: string;
  grantFileMode?: number;

  constructor(
    private readonly coreRuntimeMcpOrigin: string,
    private readonly secretDirectory: string,
  ) {}

  availability() {
    return { state: 'ready' as const, detail: 'Linux proxy smoke launcher ready' };
  }

  async launch(input: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    this.launchCount += 1;
    const grantFile = join(this.secretDirectory, `${input.run.id}.grant`);
    this.grantFile = grantFile;
    // A real provisioner writes the opaque grant only to a per-run 0600
    // secret file for the proxy. This fake follows that same narrow handoff
    // without creating a container or invoking Hermes.
    await writeFile(grantFile, input.runtimeMcpLease.executionGrant, { encoding: 'utf8', mode: 0o600 });
    await chmod(grantFile, 0o600);
    this.grantFileMode = (await stat(grantFile)).mode & 0o777;

    const config = loadMcpAuthProxyConfig({
      ARGUS_MCP_PROXY_PORT: '3002',
      // This is runnerd/test configuration, never the caller's endpoint.
      ARGUS_MCP_PROXY_CORE_ORIGIN: this.coreRuntimeMcpOrigin,
      ARGUS_MCP_PROXY_LEASE_ID: input.runtimeMcpLease.leaseId,
      ARGUS_MCP_PROXY_ROOT_TRACE_ID: input.run.rootTraceId,
      ARGUS_MCP_PROXY_GRANT_FILE: grantFile,
    });
    const proxy = createMcpAuthProxyServer({
      config,
      executionGrant: readMcpAuthProxyGrant(grantFile),
    });
    try {
      await withLoopbackServer(proxy, async proxyOrigin => {
        const response = await fetch(`${proxyOrigin}/mcp`, {
          method: 'POST',
          headers: {
            authorization: 'Bearer caller-controlled-value',
            'content-type': 'application/json',
            'mcp-session-id': 'fake-hermes-session',
            'x-forwarded-for': '203.0.113.42',
          },
          body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
        });
        const body = await response.text();
        if (response.status !== 200 || body !== '{"jsonrpc":"2.0","result":{"tools":[]}}') {
          throw new Error('fake Hermes MCP request did not complete');
        }
      });
      this.proxyCallSucceeded = true;
    } finally {
      await rm(grantFile, { force: true });
    }

    return {
      id: input.run.id,
      nativeRunId: 'native-linux-proxy-smoke-42',
      state: 'running',
      evidence: { phase: 'mcp_proxy_smoke_started' },
    };
  }

  async status(runId: string): Promise<HermesRunnerdRun> {
    this.statusCount += 1;
    return {
      id: runId,
      nativeRunId: 'native-linux-proxy-smoke-42',
      state: 'completed',
      evidence: { outcome: 'mcp_proxy_smoke_completed' },
    };
  }

  async cancel(runId: string): Promise<HermesRunnerdRun> {
    return { id: runId, state: 'cancelled' };
  }
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (cause) {
      last = cause;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  throw last;
}

async function withDirectories(run: (packDirectory: string, runnerdDirectory: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'argus-hermes-runnerd-loopback-'));
  try {
    await run(join(root, 'pack'), join(root, 'runnerd'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withLoopbackServer<T>(server: Server, run: (origin: string) => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

interface FakeCoreRuntimeMcpCall {
  method: string | undefined;
  path: string | undefined;
  authorization: string | string[] | undefined;
  forwardedFor: string | string[] | undefined;
  sessionId: string | string[] | undefined;
  rootTraceId: string | string[] | undefined;
  body: string;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function withFakeCoreRuntimeMcp<T>(
  run: (origin: string, calls: FakeCoreRuntimeMcpCall[]) => Promise<T>,
): Promise<T> {
  const calls: FakeCoreRuntimeMcpCall[] = [];
  const server = createServer(async (req, res) => {
    calls.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      forwardedFor: req.headers['x-forwarded-for'],
      sessionId: req.headers['mcp-session-id'],
      rootTraceId: req.headers['x-argus-root-trace-id'],
      body: await readRequestBody(req),
    });
    const body = '{"jsonrpc":"2.0","result":{"tools":[]}}';
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    res.end(body);
  });
  return withLoopbackServer(server, origin => run(origin, calls));
}

async function withRunnerd(
  stateDirectory: string,
  launcher: HermesRunnerdLauncher,
  run: (baseUrl: string) => Promise<void>,
  coreRuntimeMcpOrigin = 'http://argus-core:3000',
): Promise<void> {
  const config: HermesRunnerdConfig = {
    port: 0,
    serviceToken: BROKER_TOKEN,
    coreRuntimeMcpOrigin,
    stateDirectory,
  };
  const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory }), launcher);
  const server = createHermesRunnerdServer({ config, service });
  await withLoopbackServer(server, run);
}

test('completes the Pack to authenticated runnerd lifecycle without persisting or returning the one-time Core grant', async () => {
  await withDirectories(async (packDirectory, runnerdDirectory) => {
    const launcher = new LoopbackLauncher();
    await withRunnerd(runnerdDirectory, launcher, async brokerUrl => {
      const runner = new HermesRunnerBrokerClient({
        brokerUrl,
        brokerToken: BROKER_TOKEN,
        pollMs: 1,
      });
      assert.equal((await runner.preflight()).state, 'ready');

      const packService = new ManagedHermesRunService(
        new ManagedRunStore({ stateDirectory: packDirectory }),
        runner,
      );
      await packService.start(request());

      await eventually(async () => {
        assert.equal((await packService.status(RUN_ID)).state, 'completed');
      });
      assert.equal(launcher.launchCount, 1);
      assert.ok(launcher.statusCount >= 1);
      assert.equal(launcher.grantWasPresentedExactlyOnce, true);
      assert.equal(launcher.receivedOnlyPinnedCoreLease, true);

      const events = await packService.events(RUN_ID);
      assert.deepEqual(events.map(event => event.type), [
        'run.accepted',
        'run.provisioning',
        'run.started',
        'run.completed',
      ]);
      const evidence = JSON.stringify(events);
      assert.doesNotMatch(evidence, /eg_v1\.|argus-core|private prompt|private instructions|runnerd-loopback-service-token/i);

      const [packState, runnerdState] = await Promise.all([
        readFile(join(packDirectory, 'managed-runs.json'), 'utf8'),
        readFile(join(runnerdDirectory, 'runnerd-runs.json'), 'utf8'),
      ]);
      for (const state of [packState, runnerdState]) {
        assert.doesNotMatch(state, /eg_v1\.|argus-core|private prompt|private instructions|runnerd-loopback-service-token/i);
        assert.doesNotMatch(state, /executionGrant|endpoint|instructions|input/i);
      }
    });
  });
});

test('on Linux, bridges the launch grant through the real local MCP auth proxy without enabling Docker or Hermes', {
  skip: process.platform !== 'linux',
}, async () => {
  await withDirectories(async (packDirectory, runnerdDirectory) => {
    const secretDirectory = await mkdtemp(join(tmpdir(), 'argus-hermes-linux-proxy-smoke-'));
    try {
      await withFakeCoreRuntimeMcp(async (coreRuntimeMcpOrigin, coreCalls) => {
        const launcher = new LinuxProxySmokeLauncher(coreRuntimeMcpOrigin, secretDirectory);
        await withRunnerd(runnerdDirectory, launcher, async brokerUrl => {
          const runner = new HermesRunnerBrokerClient({
            brokerUrl,
            brokerToken: BROKER_TOKEN,
            pollMs: 1,
          });
          assert.equal((await runner.preflight()).state, 'ready');

          const packService = new ManagedHermesRunService(
            new ManagedRunStore({ stateDirectory: packDirectory }),
            runner,
          );
          await packService.start(request(coreRuntimeMcpOrigin));
          await eventually(async () => {
            assert.equal((await packService.status(RUN_ID)).state, 'completed');
          });

          assert.equal(launcher.launchCount, 1);
          assert.ok(launcher.statusCount >= 1);
          assert.equal(launcher.proxyCallSucceeded, true);
          assert.equal(launcher.grantFileMode, 0o600);
          assert.deepEqual(coreCalls, [{
            method: 'POST',
            path: `/mcp/runtime/${LEASE_ID}`,
            // The proxy replaces the fake Hermes caller authorization with
            // the one-time Core grant; it does not forward X-Forwarded-*.
            authorization: `Bearer ${EXECUTION_GRANT}`,
            forwardedFor: undefined,
            sessionId: 'fake-hermes-session',
            rootTraceId: TRACE_ID,
            body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
          }]);

          const grantFile = launcher.grantFile;
          assert.ok(grantFile);
          await assert.rejects(readFile(grantFile, 'utf8'));

          const [packState, runnerdState] = await Promise.all([
            readFile(join(packDirectory, 'managed-runs.json'), 'utf8'),
            readFile(join(runnerdDirectory, 'runnerd-runs.json'), 'utf8'),
          ]);
          for (const state of [packState, runnerdState]) {
            assert.doesNotMatch(state, /eg_v1\.|127\.0\.0\.1|private prompt|private instructions|runnerd-loopback-service-token/i);
            assert.doesNotMatch(state, /executionGrant|endpoint|instructions|input/i);
          }
        }, coreRuntimeMcpOrigin);
      });
    } finally {
      await rm(secretDirectory, { recursive: true, force: true });
    }
  });
});
