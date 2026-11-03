import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_RUNTIME_LEASE_KIND,
  ManagedRunContractError,
  parseManagedHermesRunCancelRequest,
  parseManagedHermesRunId,
  parseManagedHermesRunStartRequest,
} from './managedRunContract.js';

export function validManagedRunRequest() {
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
      instructions: 'Use only the exposed MCP tools.',
    },
    runtimeMcpLease: {
      kind: MANAGED_RUNTIME_LEASE_KIND,
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      endpoint: 'http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
      executionGrant: 'eg_v1.opaque-payload.opaque-signature',
      expiresAt: '2026-08-30T14:15:00.000Z',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      bundleIds: [3, 7],
      serverName: 'argus_core',
    },
    limits: {
      deadlineAt: '2026-08-30T14:15:00.000Z',
      maxToolCalls: 40,
      maxOutputBytes: 262144,
    },
  };
}

function validManagedRunCancelRequest() {
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    requestId: '0348e241-0c5b-41a4-9b24-ae7263b3e18a',
    rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
    reason: 'Workflow superseded by an operator.',
  };
}

test('accepts only a managed request with a trace-bound opaque runtime lease', () => {
  const request = parseManagedHermesRunStartRequest(validManagedRunRequest());
  assert.equal(request.mode, 'managed');
  assert.equal(request.run.rootTraceId, request.runtimeMcpLease.rootTraceId);
  assert.equal(request.runtimeMcpLease.serverName, 'argus_core');
});

test('fails closed for lease trace mismatch and an attached lease attempt', () => {
  const mismatched = validManagedRunRequest();
  mismatched.runtimeMcpLease.rootTraceId = '2f89f365-0743-43f4-a9fa-69c716362ea8';
  assert.throws(() => parseManagedHermesRunStartRequest(mismatched), ManagedRunContractError);

  const attached = validManagedRunRequest();
  attached.mode = 'attached' as never;
  assert.throws(
    () => parseManagedHermesRunStartRequest(attached),
    error => error instanceof ManagedRunContractError && error.code === 'ATTACHED_MCP_LEASE_UNSUPPORTED',
  );
});

test('accepts only a credential-free exact runtime MCP lease endpoint and enforces a configured Core origin', () => {
  const options = { coreRuntimeMcpOrigin: 'http://argus-core:3000' };
  assert.doesNotThrow(() => parseManagedHermesRunStartRequest(validManagedRunRequest(), options));

  const cases: Array<[string, string]> = [
    ['http://user:password@argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1', 'userinfo'],
    ['http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1?debug=true', 'query'],
    ['http://argus-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1#fragment', 'fragment'],
    ['http://argus-core:3000/mcp/runtime/other-lease', 'wrong path'],
    ['http://untrusted-core:3000/mcp/runtime/81d84476-b44e-4bb3-9d10-9f44ec04d4f1', 'wrong origin'],
  ];
  for (const [endpoint, label] of cases) {
    const request = validManagedRunRequest();
    request.runtimeMcpLease.endpoint = endpoint;
    assert.throws(
      () => parseManagedHermesRunStartRequest(request, options),
      error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
      label,
    );
  }
});

test('requires at least one unique positive Bundle scope for a managed lease', () => {
  const empty = validManagedRunRequest();
  empty.runtimeMcpLease.bundleIds = [];
  assert.throws(
    () => parseManagedHermesRunStartRequest(empty),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );

  const duplicate = validManagedRunRequest();
  duplicate.runtimeMcpLease.bundleIds = [3, 3];
  assert.throws(
    () => parseManagedHermesRunStartRequest(duplicate),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );
});

test('strictly validates lifecycle run IDs and cancellation envelopes without accepting grants', () => {
  const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
  assert.equal(parseManagedHermesRunId(runId), runId);
  assert.throws(
    () => parseManagedHermesRunId('not-a-run-id'),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );

  const cancel = parseManagedHermesRunCancelRequest(validManagedRunCancelRequest());
  assert.equal(cancel.requestId, '0348e241-0c5b-41a4-9b24-ae7263b3e18a');
  assert.equal(cancel.rootTraceId, 'ab5513cf-5a7b-4c64-a235-2998c836766b');
  assert.equal(cancel.reason, 'Workflow superseded by an operator.');

  const grantCarrier = { ...validManagedRunCancelRequest(), executionGrant: 'eg_v1.not-allowed.here' };
  assert.throws(
    () => parseManagedHermesRunCancelRequest(grantCarrier),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );

  const malformed = { ...validManagedRunCancelRequest(), requestId: 'not-a-request-id' };
  assert.throws(
    () => parseManagedHermesRunCancelRequest(malformed),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );

  const malformedTrace = { ...validManagedRunCancelRequest(), rootTraceId: 'not-a-trace-id' };
  assert.throws(
    () => parseManagedHermesRunCancelRequest(malformedTrace),
    error => error instanceof ManagedRunContractError && error.code === 'INVALID_RUNTIME_REQUEST',
  );
});
