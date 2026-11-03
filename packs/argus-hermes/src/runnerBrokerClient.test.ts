import assert from 'node:assert/strict';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import type { ManagedHermesRunnerCallbacks } from './managedRunner.js';
import {
  HermesRunnerBrokerClient,
  HermesRunnerBrokerClientError,
} from './runnerBrokerClient.js';
import { ARGUS_HERMES_RUNNERD_PROTOCOL } from './runnerdContract.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';

function request(): ManagedHermesRunStartRequest {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
    mode: 'managed',
    run: {
      id: RUN_ID,
      rootTraceId: TRACE_ID,
      messageId: 'message-42',
      sessionId: `managed:${RUN_ID}`,
      coreAgent: { id: 42, name: 'coder' },
      input: { text: 'inspect the bounded sample' },
    },
    runtimeMcpLease: {
      kind: 'argus.runtime-mcp-lease/v1alpha1',
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      endpoint: 'http://mcp-server:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      executionGrant: 'eg_v1.opaque-payload.opaque-signature',
      expiresAt: '2026-08-30T14:15:00.000Z',
      rootTraceId: TRACE_ID,
      bundleIds: [3],
      serverName: 'argus_core',
    },
    limits: { deadlineAt: '2026-08-30T14:15:00.000Z', maxToolCalls: 20, maxOutputBytes: 65_536 },
  };
}

function readyResponse() {
  return { apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'ready' };
}

function runResponse(state: 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval', extra: Record<string, unknown> = {}) {
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    run: {
      id: RUN_ID,
      state,
      ...(['running', 'completed', 'awaiting_approval'].includes(state) ? { nativeRunId: 'native-run-42' } : {}),
      ...(state === 'failed' ? { errorCode: 'RUNNER_FAILED' } : {}),
      ...extra,
    },
  };
}

function callbacks(events: string[], outputs: string[] = []): ManagedHermesRunnerCallbacks {
  return {
    onStarted: async nativeRunId => { events.push(`started:${nativeRunId}`); },
    onToolCompleted: async () => { events.push('tool'); },
    onNativeApprovalRequested: async () => { events.push('approval'); },
    onCompleted: async (_evidence, output) => {
      events.push('completed');
      if (output !== undefined) outputs.push(output);
    },
    onFailed: async code => { events.push(`failed:${code}`); },
    onCancelled: async () => { events.push('cancelled'); },
  };
}

async function eventually(assertion: () => void | Promise<void>): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
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

test('passes authenticated startup preflight before advertising the managed runner', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new HermesRunnerBrokerClient({
    brokerUrl: 'http://argus-hermes-runnerd:2050/',
    brokerToken: 'runnerd-test-token',
    fetchFn: async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify(readyResponse()), { status: 200 });
    },
  });

  assert.equal(client.availability().state, 'unavailable');
  assert.equal((await client.preflight()).state, 'ready');
  assert.equal(calls[0]?.url, 'http://argus-hermes-runnerd:2050/v1/ready');
  assert.deepEqual(calls[0]?.init?.headers, {
    authorization: 'Bearer runnerd-test-token',
    accept: 'application/json',
    'x-argus-hermes-runnerd-protocol': ARGUS_HERMES_RUNNERD_PROTOCOL,
  });
  assert.equal(calls[0]?.init?.redirect, 'manual');
});

test('forwards the one-time managed envelope only to the fixed runnerd launch path and records redacted lifecycle callbacks', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new HermesRunnerBrokerClient({
    brokerUrl: 'http://argus-hermes-runnerd:2050',
    brokerToken: 'runnerd-test-token',
    pollMs: 1,
    fetchFn: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/ready')) return new Response(JSON.stringify(readyResponse()), { status: 200 });
      if (url.endsWith('/v1/runs')) return new Response(JSON.stringify(runResponse('running')), { status: 200 });
      if (url.endsWith(`/v1/runs/${RUN_ID}`)) {
        return new Response(JSON.stringify(runResponse('completed', {
          evidence: { outcome: 'redacted' },
          output: '- src/parser.ts',
        })), { status: 200 });
      }
      return new Response('', { status: 404 });
    },
  });
  await client.preflight();
  const events: string[] = [];
  const outputs: string[] = [];
  await client.provision(request(), callbacks(events, outputs));
  await eventually(() => assert.deepEqual(events, ['started:native-run-42', 'completed']));
  assert.deepEqual(outputs, ['- src/parser.ts']);

  const launch = calls.find(call => call.url.endsWith('/v1/runs'));
  assert.ok(launch);
  const body = JSON.parse(String(launch.init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['apiVersion', 'request']);
  assert.equal((body.request as ManagedHermesRunStartRequest).runtimeMcpLease.executionGrant, request().runtimeMcpLease.executionGrant);
  assert.doesNotMatch(JSON.stringify(events), /eg_v1|runnerd-test-token|mcp-server/);
  assert.equal(launch.init?.redirect, 'manual');
});

test('fails closed when a broker response attempts to surface secret-shaped evidence', async () => {
  const client = new HermesRunnerBrokerClient({
    brokerUrl: 'http://argus-hermes-runnerd:2050',
    brokerToken: 'runnerd-test-token',
    fetchFn: async input => String(input).endsWith('/v1/ready')
      ? new Response(JSON.stringify(readyResponse()), { status: 200 })
      : new Response(JSON.stringify(runResponse('completed', {
        evidence: { endpoint: 'http://private-core/mcp/runtime/lease' },
      })), { status: 200 }),
  });
  await client.preflight();
  const events: string[] = [];
  await assert.rejects(
    () => client.provision(request(), callbacks(events)),
    error => error instanceof HermesRunnerBrokerClientError && error.code === 'BROKER_PROTOCOL_INVALID',
  );
  assert.deepEqual(events, []);
});

test('uses a path-bound cancellation request and never repeats the execution grant', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new HermesRunnerBrokerClient({
    brokerUrl: 'http://argus-hermes-runnerd:2050',
    brokerToken: 'runnerd-test-token',
    pollMs: 30_000,
    fetchFn: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/ready')) return new Response(JSON.stringify(readyResponse()), { status: 200 });
      if (url.endsWith('/cancel')) return new Response(JSON.stringify(runResponse('cancelled')), { status: 200 });
      return new Response(JSON.stringify(runResponse('running')), { status: 200 });
    },
  });
  await client.preflight();
  const events: string[] = [];
  await client.provision(request(), callbacks(events));
  await client.cancel(RUN_ID, 'operator requested stop');

  assert.deepEqual(events, ['started:native-run-42', 'cancelled']);
  const cancel = calls.find(call => call.url.endsWith('/cancel'));
  assert.equal(cancel?.url, `http://argus-hermes-runnerd:2050/v1/runs/${RUN_ID}/cancel`);
  assert.deepEqual(JSON.parse(String(cancel?.init?.body)), {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    reason: 'operator requested stop',
  });
  assert.doesNotMatch(String(cancel?.init?.body), /eg_v1|mcp-server/);
});

test('prioritizes a terminal cancellation over a late native start binding', async () => {
  let releaseLaunch!: (response: Response) => void;
  const launchResponse = new Promise<Response>(resolve => { releaseLaunch = resolve; });
  const client = new HermesRunnerBrokerClient({
    brokerUrl: 'http://argus-hermes-runnerd:2050',
    brokerToken: 'runnerd-test-token',
    pollMs: 30_000,
    fetchFn: async input => {
      const url = String(input);
      if (url.endsWith('/v1/ready')) return new Response(JSON.stringify(readyResponse()), { status: 200 });
      if (url.endsWith('/cancel')) {
        return new Response(JSON.stringify(runResponse('cancelled', { nativeRunId: 'native-run-late' })), { status: 200 });
      }
      return launchResponse;
    },
  });
  await client.preflight();
  const events: string[] = [];
  const provisioning = client.provision(request(), callbacks(events));
  await client.cancel(RUN_ID, 'cancel raced with launch');
  releaseLaunch(new Response(JSON.stringify(runResponse('running')), { status: 200 }));
  await provisioning;

  assert.deepEqual(events, ['cancelled']);
});
