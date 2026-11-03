import type {
  ManagedHermesRunCancelRequest,
  ManagedHermesRunEvent,
  ManagedHermesRunStartRequest,
  ManagedHermesRunSummary,
} from './managedRunContract.js';
import {
  ManagedRunStore,
  ManagedRunStoreError,
  type StoredManagedHermesRun,
} from './managedRunStore.js';
import {
  ManagedHermesRunnerUnavailableError,
  type ManagedHermesRunner,
} from './managedRunner.js';

export class ManagedRunServiceError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'MANAGED_RUNNER_NOT_PROVISIONED' | 'RUN_NOT_FOUND' | 'RUN_REQUEST_CONFLICT' | 'RUN_STATE_CONFLICT',
    message: string,
  ) {
    super(message);
  }
}

function toServiceError(cause: unknown): ManagedRunServiceError {
  if (cause instanceof ManagedRunServiceError) return cause;
  if (cause instanceof ManagedHermesRunnerUnavailableError) {
    return new ManagedRunServiceError(409, 'MANAGED_RUNNER_NOT_PROVISIONED', 'No isolated managed Hermes runner is provisioned.');
  }
  if (cause instanceof ManagedRunStoreError) {
    if (cause.code === 'RUN_NOT_FOUND') return new ManagedRunServiceError(404, 'RUN_NOT_FOUND', 'Managed run does not exist.');
    if (cause.code === 'RUN_REQUEST_CONFLICT') return new ManagedRunServiceError(409, 'RUN_REQUEST_CONFLICT', 'Managed run request conflicts with an existing run.');
    if (cause.code === 'RUN_EVENT_CURSOR_UNKNOWN') return new ManagedRunServiceError(409, 'RUN_STATE_CONFLICT', 'Managed run event cursor is unavailable.');
    return new ManagedRunServiceError(409, 'RUN_STATE_CONFLICT', 'Managed run lifecycle transition is not allowed.');
  }
  return new ManagedRunServiceError(409, 'RUN_STATE_CONFLICT', 'Managed run lifecycle could not be advanced.');
}

function sameBinding(existing: StoredManagedHermesRun, request: ManagedHermesRunStartRequest): boolean {
  return existing.id === request.run.id
    && existing.rootTraceId === request.run.rootTraceId
    && existing.leaseId === request.runtimeMcpLease.leaseId
    && existing.coreAgent.id === request.run.coreAgent.id
    && existing.coreAgent.name === request.run.coreAgent.name;
}

/**
 * Pack-local lifecycle coordinator. It persists only redacted lifecycle
 * evidence; the opaque grant is kept solely in the in-memory provision call.
 *
 * V1 intentionally treats any native Hermes approval as a terminal failure.
 * Argus approvals will be bridged later through a signed, fingerprint-bound
 * Core approval lifecycle — never by forwarding Hermes session/always choices.
 */
export class ManagedHermesRunService {
  /** Terminal model text is intentionally process-local, never in the durable redacted store. */
  private readonly outputs = new Map<string, string>();
  /** Token/cost accounting is process-local alongside terminal model text. */
  private readonly usage = new Map<string, NonNullable<ManagedHermesRunSummary['usage']>>();

  constructor(
    private readonly store: ManagedRunStore,
    private readonly runner: ManagedHermesRunner,
  ) {}

  availability() {
    return this.runner.availability();
  }

  async start(request: ManagedHermesRunStartRequest): Promise<ManagedHermesRunSummary> {
    if (this.runner.availability().state !== 'ready') {
      throw new ManagedRunServiceError(409, 'MANAGED_RUNNER_NOT_PROVISIONED', 'No isolated managed Hermes runner is provisioned.');
    }
    try {
      const existing = await this.store.findByRequestId(request.requestId);
      if (existing) {
        if (!sameBinding(existing, request)) {
          throw new ManagedRunServiceError(409, 'RUN_REQUEST_CONFLICT', 'Managed run request conflicts with an existing run.');
        }
        return this.status(existing.id);
      }
      const accepted = await this.store.accept(request);
      // Deliberately detached after durable acceptance. The Pack immediately
      // returns queued and starts lifecycle work without retaining this caller
      // connection or ever writing the grant to disk.
      // Only the transaction that created the record may provision it. A
      // concurrent idempotent retry can otherwise race after `findByRequestId`
      // and launch a second native Hermes run for the same Core request.
      if (accepted.created) void this.provision(request).catch(() => undefined);
      return accepted.run;
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  async status(runId: string): Promise<ManagedHermesRunSummary> {
    try {
      const run = await this.store.get(runId);
      const output = this.outputs.get(runId);
      const usage = this.usage.get(runId);
      return {
        ...run,
        ...(run.state === 'completed' && output !== undefined ? { output } : {}),
        ...(run.state === 'completed' && usage !== undefined ? { usage } : {}),
      };
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  async events(runId: string, afterEventId?: string): Promise<ManagedHermesRunEvent[]> {
    try {
      return await this.store.events(runId, afterEventId);
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  async cancel(runId: string, request: ManagedHermesRunCancelRequest): Promise<ManagedHermesRunSummary> {
    try {
      const record = await this.store.getRecord(runId);
      if (record.rootTraceId !== request.rootTraceId) {
        throw new ManagedRunServiceError(404, 'RUN_NOT_FOUND', 'Managed run does not exist.');
      }
      if (['cancelled', 'completed', 'failed'].includes(record.state)) return this.store.get(runId);
      const cancelling = await this.store.transition(runId, {
        state: 'cancelling',
        type: 'cancel.requested',
        evidence: { source: 'argus-core' },
      });
      try {
        await this.runner.cancel(runId, request.reason);
        // A resolved runner cancellation means the path-bound runtime stop
        // was acknowledged. Persist the terminal state here as well as via
        // the broker callback so a launch/cancel callback race cannot leave
        // the Pack indefinitely in `cancelling`.
        await this.advance(runId, {
          state: 'cancelled',
          type: 'run.cancelled',
        });
      } catch (cause) {
        if (cause instanceof ManagedHermesRunnerUnavailableError) throw cause;
        await this.store.transition(runId, {
          state: 'failed',
          type: 'run.failed',
          errorCode: 'RUNNER_CANCEL_FAILED',
        });
      }
      return this.store.get(runId);
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  /**
   * Fail closed after a Pack process restart. The Pack deliberately never
   * persists a Core grant, so it cannot safely reconstruct a runner/proxy
   * session. It therefore asks runnerd to stop each incomplete run and
   * records a terminal redacted failure regardless of whether that best-
   * effort stop request reaches the broker. Core will observe the terminal
   * state on its next lifecycle poll and revoke the matching lease.
   */
  async recoverAfterRestart(): Promise<number> {
    let recovered = 0;
    try {
      for (const record of await this.store.unfinished()) {
        try {
          await this.runner.cancel(record.id, 'pack restart recovery');
        } catch {
          // The lease deadline / runnerd watchdog remains the outer safety
          // boundary if the broker itself is unavailable at recovery time.
        }
        const current = await this.store.getRecord(record.id);
        if (['cancelled', 'completed', 'failed'].includes(current.state)) continue;
        await this.store.transition(record.id, {
          state: 'failed',
          type: 'run.failed',
          errorCode: 'PACK_RESTART_RECOVERY',
        });
        recovered += 1;
      }
      return recovered;
    } catch (cause) {
      throw toServiceError(cause);
    }
  }

  private async provision(request: ManagedHermesRunStartRequest): Promise<void> {
    try {
      await this.store.transition(request.run.id, {
        state: 'provisioning',
        type: 'run.provisioning',
        evidence: { driver: 'isolated-broker' },
      });
      await this.runner.provision(request, {
        onStarted: nativeRunId => this.advance(request.run.id, {
          state: 'running',
          type: 'run.started',
          nativeRunId,
          evidence: { runtime: 'hermes' },
        }),
        onToolCompleted: async evidence => {
          await this.store.appendToolCompleted(request.run.id, evidence);
        },
        onNativeApprovalRequested: async () => {
          // Do not turn a Hermes-native approval into Argus authority. Stop
          // the run and persist the normalized, non-sensitive failure only.
          await this.runner.cancel(request.run.id, 'native approval is unsupported');
          await this.advance(request.run.id, {
            state: 'failed',
            type: 'run.failed',
            errorCode: 'NATIVE_APPROVAL_UNSUPPORTED',
          });
        },
        onCompleted: async (evidence, output, usage) => {
          if (output !== undefined) this.outputs.set(request.run.id, output.slice(0, 32 * 1024));
          if (usage !== undefined) this.usage.set(request.run.id, usage);
          await this.advance(request.run.id, {
            state: 'completed',
            type: 'run.completed',
            evidence,
          });
        },
        onFailed: errorCode => this.advance(request.run.id, {
          state: 'failed',
          type: 'run.failed',
          errorCode,
        }),
        onCancelled: () => this.advance(request.run.id, {
          state: 'cancelled',
          type: 'run.cancelled',
        }),
      });
    } catch {
      // A launch failure must not expose raw runner/broker diagnostics. If a
      // terminal callback won the race, this transition is harmlessly ignored.
      // A concurrent cancellation also owns the terminal outcome; a late
      // launch callback must not turn an acknowledged stop into a failure.
      try {
        const current = await this.store.getRecord(request.run.id);
        if (current.state === 'cancelling' || current.state === 'cancelled') return;
        await this.advance(request.run.id, {
          state: 'failed',
          type: 'run.failed',
          errorCode: 'RUNNER_PROVISION_FAILED',
        });
      } catch {
        // There is no safe recovery here: Core's TTL/lease watchdog remains
        // authoritative when the Pack cannot persist a terminal transition.
      }
    }
  }

  private async advance(
    runId: string,
    input: Parameters<ManagedRunStore['transition']>[1],
  ): Promise<void> {
    const current = await this.store.getRecord(runId);
    if (['cancelled', 'completed', 'failed'].includes(current.state)) return;
    if (current.state === 'cancelling' && !['cancelled', 'failed'].includes(input.state)) return;
    await this.store.transition(runId, input);
  }
}
