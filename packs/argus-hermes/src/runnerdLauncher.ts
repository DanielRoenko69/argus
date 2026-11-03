import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import type { HermesRunnerdRun } from './runnerdContract.js';

/**
 * Privileged runnerd-side execution boundary.
 *
 * This intentionally receives the managed start request only for the short
 * duration of `launch()`. Implementations must pass the execution grant only
 * to a per-run MCP auth proxy and must never retain it in a runnerd record,
 * response, log, environment visible to Hermes, or native Hermes profile.
 *
 * The first implementation is deliberately unavailable. A later operator
 * provisioned launcher can implement the same constrained interface for
 * Docker or Kubernetes without widening the Pack-to-runnerd HTTP protocol.
 */
export interface HermesRunnerdLauncher {
  availability(): HermesRunnerdLauncherAvailability;
  launch(request: ManagedHermesRunStartRequest): Promise<HermesRunnerdRun>;
  status(runId: string): Promise<HermesRunnerdRun>;
  cancel(runId: string, reason?: string): Promise<HermesRunnerdRun>;
}

export interface HermesRunnerdLauncherAvailability {
  state: 'ready' | 'unavailable';
  /** Safe operator-facing summary; never an endpoint, secret, or raw error. */
  detail: string;
}

export class HermesRunnerdLauncherUnavailableError extends Error {
  constructor() {
    super('No isolated managed Hermes launcher is provisioned.');
  }
}

/**
 * Secure default for the standalone runnerd process. It exposes no host
 * control, no container engine and no fallback to an attached Hermes service.
 */
export class UnprovisionedHermesRunnerdLauncher implements HermesRunnerdLauncher {
  availability(): HermesRunnerdLauncherAvailability {
    return {
      state: 'unavailable',
      detail: 'No isolated managed Hermes launcher is provisioned.',
    };
  }

  async launch(): Promise<HermesRunnerdRun> {
    throw new HermesRunnerdLauncherUnavailableError();
  }

  async status(): Promise<HermesRunnerdRun> {
    throw new HermesRunnerdLauncherUnavailableError();
  }

  async cancel(): Promise<HermesRunnerdRun> {
    throw new HermesRunnerdLauncherUnavailableError();
  }
}
