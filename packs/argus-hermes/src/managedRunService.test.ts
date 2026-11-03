import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import { ManagedHermesRunService, ManagedRunServiceError } from './managedRunService.js';
import { ManagedRunStore } from './managedRunStore.js';
import type { ManagedHermesRunner, ManagedHermesRunnerCallbacks } from './managedRunner.js';
import { UnprovisionedManagedHermesRunner } from './managedRunner.js';

function request(): ManagedHermesRunStartRequest {
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
      input: { text: 'private prompt: inspect a sensitive source file' },
      instructions: 'Do not leak internal evidence.',
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

class CompletingRunner implements ManagedHermesRunner {
  launches: ManagedHermesRunStartRequest[] = [];

  availability() {
    return { state: 'ready' as const, detail: 'Isolated runner broker is ready.' };
  }

  async provision(run: ManagedHermesRunStartRequest, callbacks: ManagedHermesRunnerCallbacks): Promise<void> {
    this.launches.push(run);
    await callbacks.onStarted('native-run-42');
    await callbacks.onToolCompleted({ tool: 'github_read', success: true });
    await callbacks.onCompleted(
      { outcome: 'redacted' },
      '- src/parser.ts',
      {
        inputTokens: 120,
        outputTokens: 30,
        totalTokens: 150,
        cacheReadInputTokens: 40,
        reasoningTokens: 12,
        apiCalls: 3,
        estimatedCostUsd: 0.0042,
      },
    );
  }

  async cancel(): Promise<void> {
    throw new Error('cancel should not be reached by this runner');
  }
}

class HoldingRunner implements ManagedHermesRunner {
  callbacks?: ManagedHermesRunnerCallbacks;
  cancelled = false;
  provisionCalls = 0;

  availability() {
    return { state: 'ready' as const, detail: 'Isolated runner broker is ready.' };
  }

  async provision(_run: ManagedHermesRunStartRequest, callbacks: ManagedHermesRunnerCallbacks): Promise<void> {
    this.provisionCalls += 1;
    this.callbacks = callbacks;
    await callbacks.onStarted('native-run-43');
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
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

async function withStateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-run-store-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('durably accepts a managed run without persisting its grant, prompt, instructions, or Core endpoint', async () => {
  await withStateDirectory(async directory => {
    const store = new ManagedRunStore({ stateDirectory: directory });
    const runner = new CompletingRunner();
    const service = new ManagedHermesRunService(store, runner);

    const accepted = await service.start(request());
    assert.equal(accepted.state, 'queued');
    await eventually(async () => {
      const completed = await service.status(request().run.id);
      assert.equal(completed.state, 'completed');
      assert.equal(completed.output, '- src/parser.ts');
      assert.deepEqual(completed.usage, {
        inputTokens: 120, outputTokens: 30, totalTokens: 150,
        cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
      });
    });
    assert.equal(runner.launches.length, 1);
    assert.equal(runner.launches[0]?.runtimeMcpLease.executionGrant, request().runtimeMcpLease.executionGrant);

    const persisted = await readFile(join(directory, 'managed-runs.json'), 'utf8');
    assert.doesNotMatch(persisted, /eg_v1\./);
    assert.doesNotMatch(persisted, /private prompt/);
    assert.doesNotMatch(persisted, /Do not leak internal evidence/);
    assert.doesNotMatch(persisted, /http:\/\/argus-core:3000/);
    assert.doesNotMatch(persisted, /src\/parser\.ts/);
    assert.match(persisted, /native-run-42/);

    const events = await service.events(request().run.id);
    assert.deepEqual(events.map(event => event.type), [
      'run.accepted', 'run.provisioning', 'run.started', 'tool.completed', 'run.completed',
    ]);
    const resumed = await service.events(request().run.id, events[1]?.eventId);
    assert.deepEqual(resumed.map(event => event.type), ['run.started', 'tool.completed', 'run.completed']);
    assert.deepEqual(await service.events(request().run.id, events.at(-1)?.eventId), []);
    await assert.rejects(() => service.events(request().run.id, 'unknown-cursor'), ManagedRunServiceError);

    // The opaque SSE cursor is a UUID, not the old short numeric cursor.
    // Re-open the durable store to prove the Pack can resume after a restart
    // without rejecting its own persisted cursor.
    const restarted = new ManagedRunStore({ stateDirectory: directory });
    const restartedEvents = await restarted.events(request().run.id, events[1]?.eventId);
    assert.deepEqual(restartedEvents.map(event => event.type), ['run.started', 'tool.completed', 'run.completed']);

    const duplicate = await service.start(request());
    assert.equal(duplicate.id, accepted.id);
    assert.equal(duplicate.output, '- src/parser.ts');
    assert.equal(runner.launches.length, 1);
  });
});

test('rejects unprovisioned managed execution without creating a durable run record', async () => {
  await withStateDirectory(async directory => {
    const service = new ManagedHermesRunService(
      new ManagedRunStore({ stateDirectory: directory }),
      new UnprovisionedManagedHermesRunner(),
    );

    await assert.rejects(
      () => service.start(request()),
      error => error instanceof ManagedRunServiceError && error.code === 'MANAGED_RUNNER_NOT_PROVISIONED',
    );
    await assert.rejects(() => readFile(join(directory, 'managed-runs.json'), 'utf8'));
  });
});

test('provisions an idempotent concurrent start exactly once', async () => {
  await withStateDirectory(async directory => {
    const runner = new HoldingRunner();
    const service = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);

    const [first, retry] = await Promise.all([service.start(request()), service.start(request())]);
    assert.equal(first.id, request().run.id);
    assert.equal(retry.id, first.id);
    await eventually(async () => assert.equal((await service.status(request().run.id)).state, 'running'));
    assert.equal(runner.provisionCalls, 1);
  });
});

test('keeps native approval fail-closed and records cancellation as a normalized lifecycle', async () => {
  await withStateDirectory(async directory => {
    const runner = new HoldingRunner();
    const service = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);
    await service.start(request());
    await eventually(async () => assert.equal((await service.status(request().run.id)).state, 'running'));

    const cancelled = await service.cancel(request().run.id, {
      apiVersion: 'argus-runtime-v1alpha1',
      requestId: '0348e241-0c5b-41a4-9b24-ae7263b3e18a',
      rootTraceId: request().run.rootTraceId,
      reason: 'operator cancelled',
    });
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(runner.cancelled, true);
    assert.ok(runner.callbacks);
    // A duplicate terminal callback from a concurrently settling broker is
    // idempotent and cannot replace the successful cancellation.
    await runner.callbacks.onCancelled();
    assert.equal((await service.status(request().run.id)).state, 'cancelled');

    const nextRequest = request();
    nextRequest.requestId = 'b4ef9637-7f5a-4a5e-9ec0-765fbf4273cd';
    nextRequest.run.id = '16f2b691-7041-4c7d-93ef-904402c6e9e7';
    nextRequest.run.sessionId = `hermes:${nextRequest.run.id}`;
    const approvalRunner = new HoldingRunner();
    const approvalService = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: join(directory, 'approval') }), approvalRunner);
    await approvalService.start(nextRequest);
    await eventually(async () => assert.equal((await approvalService.status(nextRequest.run.id)).state, 'running'));
    assert.ok(approvalRunner.callbacks);
    await approvalRunner.callbacks.onNativeApprovalRequested();
    assert.equal(approvalRunner.cancelled, true);
    assert.equal((await approvalService.status(nextRequest.run.id)).state, 'failed');
  });
});

test('fails incomplete runs closed after a Pack restart and asks the broker to stop them', async () => {
  await withStateDirectory(async directory => {
    const runner = new HoldingRunner();
    const firstProcess = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);
    await firstProcess.start(request());
    await eventually(async () => assert.equal((await firstProcess.status(request().run.id)).state, 'running'));

    // A fresh service and store model a Pack process restart: its in-memory
    // callback/grant cannot be reconstructed from the redacted state file.
    const restarted = new ManagedHermesRunService(new ManagedRunStore({ stateDirectory: directory }), runner);
    assert.equal(await restarted.recoverAfterRestart(), 1);
    assert.equal(runner.cancelled, true);
    assert.equal((await restarted.status(request().run.id)).state, 'failed');
    assert.equal((await restarted.events(request().run.id)).at(-1)?.type, 'run.failed');
  });
});
