import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunnerdRunStore, RunnerdRunStoreError, type RunnerdRunAcceptInput } from './runnerdStore.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const REQUEST_ID = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';

async function withStateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-runnerd-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function acceptInput() {
  return { id: RUN_ID, requestId: REQUEST_ID, rootTraceId: TRACE_ID };
}

test('persists only the durable redacted runnerd identity, not a supplied launch envelope or grant', async () => {
  await withStateDirectory(async directory => {
    const store = new RunnerdRunStore({ stateDirectory: directory });
    // Runtime callers can be JavaScript, so demonstrate that extra launch
    // fields are ignored rather than accidentally copied into the state file.
    const acceptance = await store.accept({
      ...acceptInput(),
      runtimeMcpLease: {
        executionGrant: 'eg_v1.opaque-payload.opaque-signature',
        endpoint: 'http://argus-core:3000/mcp/runtime/lease',
      },
      input: { text: 'private prompt must never reach runnerd state' },
      instructions: 'private instructions must never reach runnerd state',
    } as unknown as RunnerdRunAcceptInput);
    assert.equal(acceptance.created, true);
    assert.equal(acceptance.run.state, 'accepted');
    assert.deepEqual(Object.keys(acceptance.run).sort(), [
      'acceptedAt', 'id', 'requestId', 'rootTraceId', 'state', 'updatedAt',
    ]);

    const persisted = await readFile(join(directory, 'runnerd-runs.json'), 'utf8');
    assert.doesNotMatch(persisted, /eg_v1\.|argus-core|private prompt|private instructions/);
    assert.doesNotMatch(persisted, /lease|endpoint|grant|input|instructions/i);

    const restarted = new RunnerdRunStore({ stateDirectory: directory });
    assert.deepEqual(await restarted.get(RUN_ID), acceptance.run);
    const retry = await restarted.accept(acceptInput());
    assert.equal(retry.created, false);
    assert.equal(retry.run.id, RUN_ID);
  });
});

test('serializes an idempotent request once and fails closed on a mismatched request binding', async () => {
  await withStateDirectory(async directory => {
    const store = new RunnerdRunStore({ stateDirectory: directory });
    const results = await Promise.all([store.accept(acceptInput()), store.accept(acceptInput())]);
    assert.deepEqual(results.map(result => result.created).sort(), [false, true]);

    await assert.rejects(
      () => store.accept({ ...acceptInput(), rootTraceId: 'b4ef9637-7f5a-4a5e-9ec0-765fbf4273cd' }),
      error => error instanceof RunnerdRunStoreError && error.code === 'RUN_REQUEST_CONFLICT',
    );
  });
});

test('binds a native run exactly once and permits only normalized lifecycle transitions', async () => {
  await withStateDirectory(async directory => {
    const store = new RunnerdRunStore({ stateDirectory: directory });
    await store.accept(acceptInput());

    const running = await store.bindNativeRun(RUN_ID, 'native-run-42', { phase: 'started' });
    assert.equal(running.state, 'running');
    assert.equal(running.nativeRunId, 'native-run-42');
    assert.deepEqual(running.evidence, { phase: 'started' });

    const repeated = await store.bindNativeRun(RUN_ID, 'native-run-42');
    assert.deepEqual(repeated, running);
    await assert.rejects(
      () => store.bindNativeRun(RUN_ID, 'other-native-run'),
      error => error instanceof RunnerdRunStoreError && error.code === 'RUN_STATE_CONFLICT',
    );

    const approval = await store.transition(RUN_ID, { state: 'awaiting_approval', evidence: { phase: 'approval' } });
    assert.equal(approval.nativeRunId, 'native-run-42');
    assert.equal(approval.state, 'awaiting_approval');
    const resumed = await store.transition(RUN_ID, { state: 'running' });
    assert.equal(resumed.state, 'running');
    const completed = await store.transition(RUN_ID, { state: 'completed', evidence: { outcome: 'redacted' } });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(await store.unfinished(), []);

    await assert.rejects(
      () => store.transition(RUN_ID, { state: 'running' }),
      error => error instanceof RunnerdRunStoreError && error.code === 'RUN_STATE_CONFLICT',
    );
  });
});

test('rejects secret-shaped runner evidence before it reaches durable runnerd state', async () => {
  await withStateDirectory(async directory => {
    const store = new RunnerdRunStore({ stateDirectory: directory });
    await store.accept(acceptInput());
    await assert.rejects(
      () => store.bindNativeRun(RUN_ID, 'native-run-42', {
        endpoint: 'http://argus-core:3000/mcp/runtime/lease',
        grant: 'eg_v1.opaque-payload.opaque-signature',
      }),
      error => error instanceof RunnerdRunStoreError && error.code === 'INVALID_RUNNERD_STATE',
    );

    const persisted = await readFile(join(directory, 'runnerd-runs.json'), 'utf8');
    assert.doesNotMatch(persisted, /eg_v1\.|argus-core|endpoint|grant/i);
    assert.equal((await store.get(RUN_ID)).state, 'accepted');

    const failed = await store.transition(RUN_ID, { state: 'failed', errorCode: 'RUNNER_LAUNCH_FAILED' });
    assert.equal(failed.errorCode, 'RUNNER_LAUNCH_FAILED');
    await assert.rejects(
      () => store.transition(RUN_ID, { state: 'completed' }),
      error => error instanceof RunnerdRunStoreError && error.code === 'RUN_STATE_CONFLICT',
    );
  });
});

test('fails closed when an on-disk record contains an unsupported secret field', async () => {
  await withStateDirectory(async directory => {
    await writeFile(join(directory, 'runnerd-runs.json'), JSON.stringify({
      version: 1,
      runs: {
        [RUN_ID]: {
          id: RUN_ID,
          requestId: REQUEST_ID,
          rootTraceId: TRACE_ID,
          state: 'accepted',
          acceptedAt: '2026-08-31T12:00:00.000Z',
          updatedAt: '2026-08-31T12:00:00.000Z',
          executionGrant: 'eg_v1.opaque-payload.opaque-signature',
        },
      },
    }));
    const store = new RunnerdRunStore({ stateDirectory: directory });
    await assert.rejects(
      () => store.get(RUN_ID),
      error => error instanceof RunnerdRunStoreError && error.code === 'RUN_STORE_CORRUPT',
    );
  });
});
