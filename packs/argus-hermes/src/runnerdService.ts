import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  isHermesRunnerdTerminalState,
  parseHermesRunnerdRunResponse,
  type HermesRunnerdRun,
  type HermesRunnerdRunState,
} from './runnerdContract.js';
import type { HermesRunnerdLauncher, HermesRunnerdLauncherAvailability } from './runnerdLauncher.js';
import {
  RunnerdRunStore,
  RunnerdRunStoreError,
  type RunnerdStoredRun,
} from './runnerdStore.js';

export class HermesRunnerdServiceError extends Error {
  constructor(
    readonly code:
      | 'RUNNERD_NOT_PROVISIONED'
      | 'RUN_NOT_FOUND'
      | 'RUN_CONFLICT'
      | 'RUNNERD_LAUNCH_FAILED'
      | 'RUNNERD_STATUS_UNAVAILABLE'
      | 'RUNNERD_CANCEL_UNAVAILABLE'
      | 'RUNNERD_RESTART_RECOVERY',
    readonly status: 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

function publicRun(run: RunnerdStoredRun): HermesRunnerdRun {
  if (run.state === 'accepted') {
    // An accepted record has no reliable native run binding. It is a crash
    // marker rather than a public lifecycle state and must never escape.
    throw new HermesRunnerdServiceError(
      'RUNNERD_RESTART_RECOVERY',
      503,
      'runnerd recovered an incomplete launch and failed it closed',
    );
  }
  try {
    return parseHermesRunnerdRunResponse({
      apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
      run: {
        id: run.id,
        state: run.state,
        ...(run.nativeRunId === undefined ? {} : { nativeRunId: run.nativeRunId }),
        ...(run.evidence === undefined ? {} : { evidence: run.evidence }),
        ...(run.errorCode === undefined ? {} : { errorCode: run.errorCode }),
      },
    }, run.id).run;
  } catch {
    // Store validation already makes this unreachable. Keep this projection
    // fail-closed should a future store change weaken that invariant.
    throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
  }
}

function isTerminal(state: RunnerdStoredRun['state']): boolean {
  return state !== 'accepted' && isHermesRunnerdTerminalState(state);
}

function launcherRun(run: HermesRunnerdRun, expectedRunId: string): HermesRunnerdRun {
  try {
    // Treat launcher output as untrusted at this control-plane boundary. The
    // parser rejects secret-shaped evidence and unsupported response fields.
    return parseHermesRunnerdRunResponse({
      apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
      run,
    }, expectedRunId).run;
  } catch {
    throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd launcher returned invalid lifecycle state');
  }
}

function storeError(cause: RunnerdRunStoreError): HermesRunnerdServiceError {
  if (cause.code === 'RUN_NOT_FOUND') {
    return new HermesRunnerdServiceError('RUN_NOT_FOUND', 404, 'runnerd run was not found');
  }
  if (cause.code === 'RUN_REQUEST_CONFLICT' || cause.code === 'RUN_STATE_CONFLICT') {
    return new HermesRunnerdServiceError('RUN_CONFLICT', 409, 'runnerd run lifecycle conflicts with the stored state');
  }
  return new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
}

/**
 * Binds the generic runnerd HTTP server to one restricted launcher and a
 * durable redacted registry. It intentionally never stores or returns the
 * start request itself: the request's prompt, instructions, Core endpoint and
 * execution grant exist only while `launcher.launch()` is executing.
 */
export class HermesRunnerdService {
  private readonly runOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly store: RunnerdRunStore,
    private readonly launcher: HermesRunnerdLauncher,
  ) {}

  availability(): HermesRunnerdLauncherAvailability {
    return this.launcher.availability();
  }

  async start(request: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    return this.exclusiveRun(request.run.id, () => this.startExclusive(request));
  }

  private async startExclusive(request: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun> {
    this.requireReady();
    let acceptance;
    try {
      acceptance = await this.store.accept({
        id: request.run.id,
        requestId: request.requestId,
        rootTraceId: request.run.rootTraceId,
      });
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }

    if (!acceptance.created) {
      if (acceptance.run.state === 'accepted') {
        // The request may have reached a privileged launcher before a process
        // loss. It is never safe to replay it because that could duplicate a
        // sidecar and native run. Mark the unknown result failed instead.
        return this.failAccepted(acceptance.run.id, 'RUNNERD_LAUNCH_OUTCOME_UNKNOWN');
      }
      return publicRun(acceptance.run);
    }

    try {
      // Keep this value scoped to the launcher call. Do not put `request` in
      // an async closure, record, error, response or logging context.
      const launched = launcherRun(await this.launcher.launch(request), request.run.id);
      return await this.reconcile(acceptance.run, launched);
    } catch {
      // A launcher may have created a native process and then returned a
      // malformed response or lost its response. Do not leave the durable
      // `accepted` crash marker behind: a retry would otherwise be ambiguous
      // and could re-run a request whose one-time grant we deliberately do
      // not persist. Ask the launcher to stop by the path-bound Argus run ID
      // and record only a static terminal code.
      return this.failLaunchPath(acceptance.run.id);
    }
  }

  async status(runId: string): Promise<HermesRunnerdRun> {
    return this.exclusiveRun(runId, () => this.statusExclusive(runId));
  }

  private async statusExclusive(runId: string): Promise<HermesRunnerdRun> {
    this.requireReady();
    let current: RunnerdStoredRun;
    try {
      current = await this.store.get(runId);
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
    if (current.state === 'accepted') return this.failAccepted(current.id, 'RUNNERD_LAUNCH_OUTCOME_UNKNOWN');
    if (isTerminal(current.state)) return publicRun(current);
    try {
      const observed = launcherRun(await this.launcher.status(current.id), current.id);
      return await this.reconcile(current, observed);
    } catch (cause) {
      if (cause instanceof HermesRunnerdServiceError) throw cause;
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd launcher status is unavailable');
    }
  }

  async cancel(runId: string, reason?: string): Promise<HermesRunnerdRun> {
    return this.exclusiveRun(runId, () => this.cancelExclusive(runId, reason));
  }

  private async cancelExclusive(runId: string, reason?: string): Promise<HermesRunnerdRun> {
    this.requireReady();
    let current: RunnerdStoredRun;
    try {
      current = await this.store.get(runId);
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
    if (current.state === 'accepted') {
      // The launch may already have crossed the privileged boundary even
      // though its native binding is not durable yet. Path-bound cancellation
      // is safe and must be attempted so a concurrent launch cannot leave an
      // orphan after this durable state becomes terminal.
      try {
        await this.launcher.cancel(current.id, reason);
      } catch {
        // The durable terminal state remains fail-closed; the launch path's
        // own recovery and deadline are the outer cleanup boundaries.
      }
      return this.transition(current.id, { state: 'cancelled' });
    }
    if (isTerminal(current.state)) return publicRun(current);
    try {
      const observed = launcherRun(await this.launcher.cancel(current.id, reason), current.id);
      return await this.reconcile(current, observed);
    } catch (cause) {
      if (cause instanceof HermesRunnerdServiceError) throw cause;
      throw new HermesRunnerdServiceError('RUNNERD_CANCEL_UNAVAILABLE', 503, 'runnerd launcher cancellation is unavailable');
    }
  }

  /**
   * A restart has lost the one-time grant and in-memory native process owner.
   * Do not attempt to rebuild either. Any incomplete durable run is marked
   * terminal so Core can revoke its lease rather than continuing blindly.
   */
  async recoverAfterRestart(): Promise<void> {
    let unfinished: RunnerdStoredRun[];
    try {
      unfinished = await this.store.unfinished();
    } catch {
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
    for (const run of unfinished) {
      if (run.state === 'accepted') {
        await this.transition(run.id, { state: 'failed', errorCode: 'RUNNERD_RESTART_RECOVERY' });
        continue;
      }
      try {
        await this.launcher.cancel(run.id, 'runnerd restart recovery');
      } catch {
        // The terminal state below is the fail-closed control-plane truth;
        // a future privileged launcher owns hard-stop/cleanup enforcement.
      }
      await this.transition(run.id, {
        state: 'failed',
        ...(run.nativeRunId === undefined ? {} : { nativeRunId: run.nativeRunId }),
        errorCode: 'RUNNERD_RESTART_RECOVERY',
      });
    }
  }

  private requireReady(): void {
    if (this.launcher.availability().state !== 'ready') {
      throw new HermesRunnerdServiceError('RUNNERD_NOT_PROVISIONED', 503, 'no isolated managed Hermes launcher is provisioned');
    }
  }

  /**
   * Runnerd lifecycle requests for one run must be linearizable. In
   * particular, a status poll must not inspect the brief interval after a
   * concurrent cancel removed Docker resources but before cancellation became
   * durable, otherwise it can misclassify an acknowledged stop as a crash.
   */
  private async exclusiveRun<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runOperations.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => gate, () => gate);
    this.runOperations.set(runId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.runOperations.get(runId) === queued) this.runOperations.delete(runId);
    }
  }

  private async reconcile(current: RunnerdStoredRun, observed: HermesRunnerdRun): Promise<HermesRunnerdRun> {
    if (current.state === 'accepted') {
      if (observed.state === 'running') {
        const bound = await this.bindNativeRun(current.id, observed.nativeRunId!, observed.evidence);
        return publicRun(bound);
      }
      if (observed.state === 'awaiting_approval' || observed.state === 'completed') {
        const bound = await this.bindNativeRun(current.id, observed.nativeRunId!);
        if (observed.state === 'awaiting_approval') {
          return this.failNativeApproval(bound.id);
        }
        const transitioned = await this.transition(bound.id, {
          state: observed.state,
          nativeRunId: observed.nativeRunId,
          ...(observed.evidence === undefined ? {} : { evidence: observed.evidence }),
        });
        return {
          ...transitioned,
          ...(observed.output === undefined ? {} : { output: observed.output }),
          ...(observed.usage === undefined ? {} : { usage: observed.usage }),
        };
      }
      if (observed.state === 'failed' || observed.state === 'cancelled') {
        return this.transition(current.id, {
          state: observed.state,
          ...(observed.evidence === undefined ? {} : { evidence: observed.evidence }),
          ...(observed.errorCode === undefined ? {} : { errorCode: observed.errorCode }),
        });
      }
    }

    if (current.state === observed.state) {
      if (current.nativeRunId !== observed.nativeRunId) {
        throw new HermesRunnerdServiceError('RUN_CONFLICT', 409, 'runnerd native run identity changed unexpectedly');
      }
      return publicRun(current);
    }
    if (isTerminal(current.state)) {
      throw new HermesRunnerdServiceError('RUN_CONFLICT', 409, 'runnerd terminal run state cannot change');
    }
    if (observed.state === 'awaiting_approval') {
      return this.failNativeApproval(current.id);
    }
    const transitioned = await this.transition(current.id, {
      state: observed.state,
      ...(observed.nativeRunId === undefined ? {} : { nativeRunId: observed.nativeRunId }),
      ...(observed.evidence === undefined ? {} : { evidence: observed.evidence }),
      ...(observed.errorCode === undefined ? {} : { errorCode: observed.errorCode }),
    });
    return {
      ...transitioned,
      ...(observed.output === undefined ? {} : { output: observed.output }),
      ...(observed.usage === undefined ? {} : { usage: observed.usage }),
    };
  }

  private async bindNativeRun(
    runId: string,
    nativeRunId: string,
    evidence?: HermesRunnerdRun['evidence'],
  ): Promise<RunnerdStoredRun> {
    try {
      return await this.store.bindNativeRun(runId, nativeRunId, evidence);
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
  }

  private async transition(
    runId: string,
    input: {
      state: HermesRunnerdRunState;
      nativeRunId?: string;
      evidence?: HermesRunnerdRun['evidence'];
      errorCode?: string;
    },
  ): Promise<HermesRunnerdRun> {
    try {
      return publicRun(await this.store.transition(runId, input));
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
  }

  private async failAccepted(runId: string, errorCode: string): Promise<HermesRunnerdRun> {
    return this.transition(runId, { state: 'failed', errorCode });
  }

  /**
   * A failed launch can still have crossed the privileged launcher boundary.
   * The only safe recovery is a best-effort path-bound stop followed by a
   * redacted terminal failure; never replay the launch envelope or retain its
   * grant for later recovery.
   */
  private async failLaunchPath(runId: string): Promise<HermesRunnerdRun> {
    let current: RunnerdStoredRun;
    try {
      current = await this.store.get(runId);
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
    if (isTerminal(current.state)) return publicRun(current);
    try {
      await this.launcher.cancel(runId, 'runnerd launch recovery');
    } catch {
      // A future privileged launcher owns force-stop/cleanup. The durable
      // terminal state below is still required so Core can revoke the lease.
    }
    try {
      current = await this.store.get(runId);
    } catch (cause) {
      if (cause instanceof RunnerdRunStoreError) throw storeError(cause);
      throw new HermesRunnerdServiceError('RUNNERD_STATUS_UNAVAILABLE', 503, 'runnerd state is unavailable');
    }
    if (isTerminal(current.state)) return publicRun(current);
    return this.transition(current.id, { state: 'failed', errorCode: 'RUNNERD_LAUNCH_FAILED' });
  }

  /**
   * Hermes-native approval prompts cannot become Argus authority in V1. Stop
   * native work immediately and report a normalized failure instead of
   * leaving an `awaiting_approval` process alive for an unbounded period.
   */
  private async failNativeApproval(runId: string): Promise<HermesRunnerdRun> {
    try {
      await this.launcher.cancel(runId, 'native approval is unsupported');
    } catch {
      // The launcher implementation is responsible for hard cleanup; retain
      // only this static failure code at the control-plane boundary.
    }
    return this.transition(runId, { state: 'failed', errorCode: 'NATIVE_APPROVAL_UNSUPPORTED' });
  }
}
