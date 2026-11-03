import type {
  ManagedHermesRunStartRequest,
  ManagedHermesRunUsage,
} from './managedRunContract.js';

export interface ManagedHermesRunnerAvailability {
  state: 'ready' | 'unavailable';
  /** A short, operator-safe reason. It must not contain endpoints or secrets. */
  detail: string;
}

export interface ManagedHermesRunnerCallbacks {
  onStarted(nativeRunId: string): Promise<void>;
  onToolCompleted(evidence: Record<string, string | number | boolean | null>): Promise<void>;
  /**
   * Native Hermes approvals are intentionally not bridged in v1. The service
   * fails the run closed when this callback is invoked.
   */
  onNativeApprovalRequested(): Promise<void>;
  onCompleted(
    evidence?: Record<string, string | number | boolean | null>,
    output?: string,
    usage?: ManagedHermesRunUsage,
  ): Promise<void>;
  onFailed(errorCode: string): Promise<void>;
  onCancelled(): Promise<void>;
}

/**
 * Execution-only interface for an isolated runner broker.
 *
 * The launch request has the short-lived Core grant because the per-run auth
 * proxy must receive it exactly once. Implementations must never persist it,
 * return it, log it, or make it readable by the Hermes container. The first
 * real implementation will call a narrow runnerd broker which launches a
 * separate proxy sidecar holding that grant.
 */
export interface ManagedHermesRunner {
  availability(): ManagedHermesRunnerAvailability;
  provision(request: ManagedHermesRunStartRequest, callbacks: ManagedHermesRunnerCallbacks): Promise<void>;
  cancel(runId: string, reason?: string): Promise<void>;
}

export class ManagedHermesRunnerUnavailableError extends Error {
  constructor() {
    super('No isolated managed Hermes runner is provisioned.');
  }
}

/** Default fail-closed runner used unless an explicit broker is installed. */
export class UnprovisionedManagedHermesRunner implements ManagedHermesRunner {
  availability(): ManagedHermesRunnerAvailability {
    return {
      state: 'unavailable',
      detail: 'No isolated managed Hermes runner is provisioned.',
    };
  }

  async provision(): Promise<void> {
    throw new ManagedHermesRunnerUnavailableError();
  }

  async cancel(): Promise<void> {
    throw new ManagedHermesRunnerUnavailableError();
  }
}
