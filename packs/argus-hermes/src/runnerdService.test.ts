import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import type { HermesRunnerdRun } from './runnerdContract.js';
import type { HermesRunnerdLauncher } from './runnerdLauncher.js';
import { HermesRunnerdService } from './runnerdService.js';
import { RunnerdRunStore } from './runnerdStore.js';

const RUN_ID = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const REQUEST_ID = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const TRACE_ID = 'ab5513cf-5a7b-4c64-a235-2998c836766b';

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
      input: { text: 'private prompt must be held only during launch' },
      instructions: 'private instructions must never be durable runnerd state',
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
  };
}

abstract class ReadyLauncher implements HermesRunnerdLauncher {
  readonly cancellationReasons: string[] = [];

  availability() {
    return { state: 'ready' as const, detail: 'test launcher ready' };
  }

  abstract launch(input: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun>;

  async status(runId: string): Promise<HermesRunnerdRun> {
    return { id: runId, nativeRunId: 'native-run-42', state: 'running' };
  }

  async cancel(runId: string, reason?: string): Promise<HermesRunnerdRun> {
    this.cancellationReasons.push(`${runId}:${reason ?? ''}`);
    return { id: runId, state: 'cancelled' };
  }
}

class InvalidLaunchResponseLauncher extends ReadyLauncher {
  async launch(): Promise<HermesRunnerdRun> {
    // `endpoint` is syntactically allowed by the TypeScript record type but
    // rejected by the runnerd contract before it can reach a Pack response.
    return {
      id: RUN_ID,
      nativeRunId: 'native-run-42',
      state: 'running',
      evidence: { endpoint: 'http://argus-core:3000/mcp/runtime/lease' },
    };
  }
}

class NativeApprovalLauncher extends ReadyLauncher {
  async launch(): Promise<HermesRunnerdRun> {
    return { id: RUN_ID, nativeRunId: 'native-run-42', state: 'awaiting_approval' };
  }
}

class BlockingLauncher extends ReadyLauncher {
  private releaseLaunch!: () => void;
  private markStarted!: () => void;
  readonly started = new Promise<void>(resolve => { this.markStarted = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseLaunch = resolve; });

  async launch(): Promise<HermesRunnerdRun> {
    this.markStarted();
    await this.released;
    return { id: RUN_ID, nativeRunId: 'native-run-42', state: 'running' };
  }

  continueLaunch(): void {
    this.releaseLaunch();
  }
}

async function withStateDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'argus-hermes-runnerd-service-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('fails a newly accepted run closed when the launcher returns malformed or secret-shaped lifecycle data', async () => {
  await withStateDirectory(async directory => {
    const launcher = new InvalidLaunchResponseLauncher();
    const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory: directory }), launcher);

    const result = await service.start(request());
    assert.deepEqual(result, {
      id: RUN_ID,
      state: 'failed',
      errorCode: 'RUNNERD_LAUNCH_FAILED',
    });
    assert.deepEqual(launcher.cancellationReasons, [`${RUN_ID}:runnerd launch recovery`]);
    assert.equal((await service.status(RUN_ID)).state, 'failed');

    const persisted = await readFile(join(directory, 'runnerd-runs.json'), 'utf8');
    assert.doesNotMatch(persisted, /eg_v1\.|private prompt|private instructions|argus-core|endpoint/i);
    assert.match(persisted, /RUNNERD_LAUNCH_FAILED/);
  });
});

test('stops and fails native Hermes approvals instead of leaving the runner awaiting approval', async () => {
  await withStateDirectory(async directory => {
    const launcher = new NativeApprovalLauncher();
    const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory: directory }), launcher);

    const result = await service.start(request());
    assert.deepEqual(result, {
      id: RUN_ID,
      nativeRunId: 'native-run-42',
      state: 'failed',
      errorCode: 'NATIVE_APPROVAL_UNSUPPORTED',
    });
    assert.deepEqual(launcher.cancellationReasons, [`${RUN_ID}:native approval is unsupported`]);
    assert.equal((await service.status(RUN_ID)).state, 'failed');
  });
});

test('path-cancels a run whose launch crossed the boundary before its native binding became durable', async () => {
  await withStateDirectory(async directory => {
    const launcher = new BlockingLauncher();
    const service = new HermesRunnerdService(new RunnerdRunStore({ stateDirectory: directory }), launcher);

    const starting = service.start(request());
    await launcher.started;
    let stopSettled = false;
    const stopping = service.cancel(RUN_ID, 'operator stop during launch')
      .finally(() => { stopSettled = true; });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(stopSettled, false);

    // Per-run service serialization lets the launch bind first, then makes
    // cancellation the final resource and durable-state operation. A status
    // poll cannot observe the cleanup gap between those two operations.
    launcher.continueLaunch();
    assert.equal((await starting).state, 'running');
    const cancelled = await stopping;
    assert.equal(cancelled.state, 'cancelled');
    assert.deepEqual(launcher.cancellationReasons, [`${RUN_ID}:operator stop during launch`]);
    assert.equal((await service.status(RUN_ID)).state, 'cancelled');
  });
});
