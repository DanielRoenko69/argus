import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  HERMES_RUNNERD_READY_PATH,
  HermesRunnerdContractError,
  createHermesRunnerdCancelRequest,
  createHermesRunnerdLaunchRequest,
  hermesRunnerdRunPath,
  isHermesRunnerdTerminalState,
  parseHermesRunnerdCancelRequest,
  parseHermesRunnerdLaunchRequest,
  parseHermesRunnerdReadyResponse,
  parseHermesRunnerdRunResponse,
} from './runnerdContract.js';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';

function managedRunRequest(): ManagedHermesRunStartRequest {
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
      input: { text: 'Private task context must only reach the isolated runner.' },
      instructions: 'Use only the managed MCP proxy.',
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

function runningResponse() {
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    run: {
      id: '950610b9-97b4-41cb-908f-46cc80bd22a2',
      nativeRunId: 'hermes-run-42',
      state: 'running',
      evidence: { phase: 'runner_started', attempt: 1 },
    },
  };
}

test('creates and independently validates the only permitted runnerd launch envelope', () => {
  const request = managedRunRequest();
  const launch = createHermesRunnerdLaunchRequest(request);
  assert.deepEqual(Object.keys(launch).sort(), ['apiVersion', 'request']);
  assert.equal(launch.apiVersion, ARGUS_HERMES_RUNNERD_PROTOCOL);
  assert.equal(launch.request.runtimeMcpLease.executionGrant, request.runtimeMcpLease.executionGrant);

  const parsed = parseHermesRunnerdLaunchRequest(launch, { coreRuntimeMcpOrigin: 'http://argus-core:3000' });
  assert.equal(parsed.request.run.id, request.run.id);
  assert.equal(parsed.request.runtimeMcpLease.leaseId, request.runtimeMcpLease.leaseId);
  assert.equal(parsed.request.runtimeMcpLease.executionGrant, request.runtimeMcpLease.executionGrant);
});

test('rejects caller-controlled launch controls and never reflects the opaque grant in a validation error', () => {
  const launch = createHermesRunnerdLaunchRequest(managedRunRequest());
  const invalid = { ...launch, image: 'evil/image:latest' };
  assert.throws(
    () => parseHermesRunnerdLaunchRequest(invalid),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_REQUEST',
  );

  const nested = structuredClone(launch) as unknown as Record<string, unknown>;
  const request = nested['request'] as Record<string, unknown>;
  request['network'] = 'host';
  try {
    parseHermesRunnerdLaunchRequest(nested);
    assert.fail('expected nested control to be rejected');
  } catch (error) {
    assert.ok(error instanceof HermesRunnerdContractError);
    assert.equal(error.code, 'INVALID_RUNNERD_REQUEST');
    assert.doesNotMatch(error.message, /eg_v1\./);
    assert.doesNotMatch(error.message, /opaque-payload/);
  }
});

test('parses a bounded redacted runnerd status and binds it to the requested run', () => {
  const response = parseHermesRunnerdRunResponse(runningResponse(), '950610b9-97b4-41cb-908f-46cc80bd22a2');
  assert.equal(response.run.state, 'running');
  assert.equal(response.run.nativeRunId, 'hermes-run-42');
  assert.deepEqual(response.run.evidence, { phase: 'runner_started', attempt: 1 });
  assert.equal(isHermesRunnerdTerminalState(response.run.state), false);

  const complete = parseHermesRunnerdRunResponse({
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    run: {
      id: '950610b9-97b4-41cb-908f-46cc80bd22a2',
      nativeRunId: 'hermes-run-42',
      state: 'completed',
      evidence: { result: 'redacted' },
      output: '- src/parser.ts\nImplemented the requested fix.',
      usage: {
        inputTokens: 120, outputTokens: 30, totalTokens: 150,
        cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
      },
    },
  });
  assert.equal(isHermesRunnerdTerminalState(complete.run.state), true);
  assert.match(complete.run.output ?? '', /src\/parser\.ts/);
  assert.deepEqual(complete.run.usage, {
    inputTokens: 120, outputTokens: 30, totalTokens: 150,
    cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
  });
});

test('accepts only the exact runnerd readiness response before managed work is advertised', () => {
  assert.equal(HERMES_RUNNERD_READY_PATH, '/v1/ready');
  assert.deepEqual(parseHermesRunnerdReadyResponse({
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    state: 'ready',
  }), {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    state: 'ready',
  });
  assert.throws(
    () => parseHermesRunnerdReadyResponse({ apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'degraded' }),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_RESPONSE',
  );
  assert.throws(
    () => parseHermesRunnerdReadyResponse({ apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'ready', extra: true }),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_RESPONSE',
  );
});

test('fails closed for response leaks, invalid state bindings and unbounded evidence', () => {
  const cases: Array<[string, unknown]> = [
    ['unexpected grant field', {
      ...runningResponse(),
      executionGrant: 'eg_v1.opaque-payload.opaque-signature',
    }],
    ['unexpected native config field', {
      ...runningResponse(),
      run: { ...runningResponse().run, mcpEndpoint: 'http://argus-core:3000/mcp/runtime/lease' },
    }],
    ['wrong run identity', {
      ...runningResponse(),
      run: { ...runningResponse().run, id: 'b4ef9637-7f5a-4a5e-9ec0-765fbf4273cd' },
    }],
    ['running without native ID', {
      ...runningResponse(),
      run: { id: '950610b9-97b4-41cb-908f-46cc80bd22a2', state: 'running' },
    }],
    ['output before completion', {
      ...runningResponse(),
      run: { ...runningResponse().run, output: 'not terminal' },
    }],
    ['usage before completion', {
      ...runningResponse(),
      run: { ...runningResponse().run, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
    }],
    ['invalid terminal usage', {
      ...runningResponse(),
      run: {
        ...runningResponse().run,
        state: 'completed',
        usage: { inputTokens: -1, outputTokens: 1, totalTokens: 0 },
      },
    }],
    ['unbounded terminal output', {
      ...runningResponse(),
      run: {
        ...runningResponse().run,
        state: 'completed',
        output: 'x'.repeat(32 * 1024 + 1),
      },
    }],
    ['failed without error code', {
      ...runningResponse(),
      run: { id: '950610b9-97b4-41cb-908f-46cc80bd22a2', state: 'failed' },
    }],
    ['unsafe evidence', {
      ...runningResponse(),
      run: { ...runningResponse().run, evidence: { raw: 'line one\nline two' } },
    }],
    ['secret-shaped evidence', {
      ...runningResponse(),
      run: { ...runningResponse().run, evidence: { grant: 'eg_v1.opaque-payload.opaque-signature' } },
    }],
    ['endpoint-shaped evidence', {
      ...runningResponse(),
      run: { ...runningResponse().run, evidence: { detail: 'http://argus-core:3000/mcp/runtime/lease' } },
    }],
    ['raw prompt-shaped evidence', {
      ...runningResponse(),
      run: { ...runningResponse().run, evidence: { phase: 'private_prompt_must_not_escape' } },
    }],
    ['bare host port evidence', {
      ...runningResponse(),
      run: { ...runningResponse().run, evidence: { phase: 'mcp-server:3000' } },
    }],
  ];
  for (const [label, response] of cases) {
    assert.throws(
      () => parseHermesRunnerdRunResponse(response, '950610b9-97b4-41cb-908f-46cc80bd22a2'),
      error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_RESPONSE',
      label,
    );
  }
});

test('uses a path-bound bounded cancellation envelope', () => {
  const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
  assert.equal(hermesRunnerdRunPath(runId), `/v1/runs/${runId}`);
  assert.throws(
    () => hermesRunnerdRunPath('not-a-uuid'),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_REQUEST',
  );
  const cancel = createHermesRunnerdCancelRequest('operator cancelled the run');
  assert.deepEqual(parseHermesRunnerdCancelRequest(cancel), cancel);
  assert.throws(
    () => parseHermesRunnerdCancelRequest({ ...cancel, runId }),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_REQUEST',
  );
  assert.throws(
    () => parseHermesRunnerdCancelRequest({ ...cancel, reason: 'bad\nreason' }),
    error => error instanceof HermesRunnerdContractError && error.code === 'INVALID_RUNNERD_REQUEST',
  );
});
