import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import { ManagedRunStore, ManagedRunStoreError } from './managedRunStore.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const REQUEST_ID = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
const LEASE_ID = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';

function request(): ManagedHermesRunStartRequest {
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
      input: { text: 'private prompt must not be accepted as lifecycle evidence' },
    },
    runtimeMcpLease: {
      kind: 'argus.runtime-mcp-lease/v1alpha1',
      leaseId: LEASE_ID,
      endpoint: `http://argus-core:3000/mcp/runtime/${LEASE_ID}`,
      executionGrant: 'eg_v1.opaque-payload.opaque-signature',
      expiresAt: '2026-08-31T14:15:00.000Z',
      rootTraceId: TRACE_ID,
      bundleIds: [3],
      serverName: 'argus_core',
    },
    limits: { deadlineAt: '2026-08-31T14:15:00.000Z', maxToolCalls: 20, maxOutputBytes: 65_536 },
  };
}

async function withStateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-managed-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('persists only compact machine-readable lifecycle evidence', async () => {
  await withStateDirectory(async directory => {
    const store = new ManagedRunStore({ stateDirectory: directory });
    await store.accept(request());
    await store.appendToolCompleted(RUN_ID, {
      tool: 'github_read',
      outcome: 'succeeded',
      attempt: 1,
      cache_hit: false,
    });
    const events = await store.events(RUN_ID);
    assert.deepEqual(events.at(-1)?.evidence, {
      tool: 'github_read',
      outcome: 'succeeded',
      attempt: 1,
      cache_hit: false,
    });
  });
});

test('rejects prompt, endpoint and free-text evidence before it can reach durable Pack state', async () => {
  await withStateDirectory(async directory => {
    const store = new ManagedRunStore({ stateDirectory: directory });
    await store.accept(request());
    const unsafe: Array<Record<string, string>> = [
      { detail: 'the user prompt is private' },
      { outcome: 'mcp-server:3000' },
      { output: 'private_result' },
      { phase: 'eg_v1.opaque-payload.opaque-signature' },
    ];
    for (const evidence of unsafe) {
      await assert.rejects(
        () => store.appendToolCompleted(RUN_ID, evidence),
        error => error instanceof ManagedRunStoreError && error.code === 'RUN_STORE_CORRUPT',
      );
    }
    const state = await readFile(join(directory, 'managed-runs.json'), 'utf8');
    assert.doesNotMatch(state, /the user prompt|mcp-server:3000|private_result|eg_v1\./);
    assert.equal((await store.events(RUN_ID)).length, 1);
  });
});
