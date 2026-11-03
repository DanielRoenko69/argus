import type { ArgusHermesConfig } from './config.js';
import type { ManagedHermesRunStartRequest } from './managedRunContract.js';
import {
  ManagedHermesRunnerUnavailableError,
  UnprovisionedManagedHermesRunner,
  type ManagedHermesRunner,
  type ManagedHermesRunnerAvailability,
  type ManagedHermesRunnerCallbacks,
} from './managedRunner.js';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  HERMES_RUNNERD_READY_PATH,
  HERMES_RUNNERD_RUNS_PATH,
  createHermesRunnerdCancelRequest,
  createHermesRunnerdLaunchRequest,
  hermesRunnerdRunPath,
  isHermesRunnerdTerminalState,
  parseHermesRunnerdReadyResponse,
  parseHermesRunnerdRunResponse,
  type HermesRunnerdRun,
} from './runnerdContract.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CONSECUTIVE_STATUS_FAILURES = 3;
const BROKER_REQUEST_TIMEOUT_MS = 5_000;
const BROKER_LAUNCH_TIMEOUT_MS = 30_000;
// Cancellation can be serialized behind an in-flight launch so cleanup is
// the final resource action. Its transport deadline must therefore cover the
// bounded launch window plus a small response margin.
const BROKER_CANCEL_TIMEOUT_MS = 35_000;
const DEFAULT_POLL_MS = 1_000;

export class HermesRunnerBrokerClientError extends Error {
  constructor(readonly code: 'BROKER_UNAVAILABLE' | 'BROKER_REJECTED' | 'BROKER_PROTOCOL_INVALID', message: string) {
    super(message);
  }
}

export interface HermesRunnerBrokerClientOptions {
  brokerUrl: string;
  brokerToken: string;
  pollMs?: number;
  fetchFn?: typeof fetch;
}

interface RunWatcher {
  callbacks: ManagedHermesRunnerCallbacks;
  started: boolean;
  settled: boolean;
  failedPolls: number;
  timer?: ReturnType<typeof setTimeout>;
}

function normalizeBrokerOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('runner broker URL must be a valid HTTP(S) origin');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('runner broker URL must be a credential-free HTTP(S) origin');
  }
  return parsed.origin;
}

function validateToken(value: string): string {
  if (!value || Buffer.byteLength(value, 'utf8') > 8 * 1024 || /[\r\n\u0000]/.test(value)) {
    throw new Error('runner broker token is malformed');
  }
  return value;
}

async function boundedText(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker response exceeds the allowed limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker response exceeds the allowed limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker returned invalid JSON');
  }
}

/**
 * Pack-side client for the separately privileged runner broker.
 *
 * The Pack has no Docker socket, Kubernetes credential or runner image
 * controls. Its sole privileged launch message is the already-validated
 * managed-run envelope; runnerd must put the opaque execution grant into a
 * per-run proxy secret and never make it visible to Hermes itself.
 */
export class HermesRunnerBrokerClient implements ManagedHermesRunner {
  private readonly brokerUrl: string;
  private readonly brokerToken: string;
  private readonly pollMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly watchers = new Map<string, RunWatcher>();
  private currentAvailability: ManagedHermesRunnerAvailability = {
    state: 'unavailable',
    detail: 'The isolated runner broker has not passed startup preflight.',
  };

  constructor(options: HermesRunnerBrokerClientOptions) {
    this.brokerUrl = normalizeBrokerOrigin(options.brokerUrl);
    this.brokerToken = validateToken(options.brokerToken);
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    if (!Number.isInteger(this.pollMs) || this.pollMs < 1 || this.pollMs > 30_000) {
      throw new Error('runner broker poll interval must be an integer from 1 to 30000');
    }
    this.fetchFn = options.fetchFn ?? fetch;
  }

  availability(): ManagedHermesRunnerAvailability {
    return this.currentAvailability;
  }

  /**
   * Startup-only, authenticated preflight. We advertise the managed
   * capability only after the broker returns the exact pinned readiness
   * shape; a merely configured URL is not enough.
   */
  async preflight(): Promise<ManagedHermesRunnerAvailability> {
    try {
      const response = await this.request(HERMES_RUNNERD_READY_PATH, 'GET');
      parseHermesRunnerdReadyResponse(response);
      this.currentAvailability = {
        state: 'ready',
        detail: 'The isolated runner broker passed its startup preflight.',
      };
    } catch {
      // Do not report the broker URL, HTTP status, body, or transport
      // diagnostic. They are Pack-internal and not browser-safe evidence.
      this.currentAvailability = {
        state: 'unavailable',
        detail: 'The isolated runner broker did not pass startup preflight.',
      };
    }
    return this.currentAvailability;
  }

  async provision(request: ManagedHermesRunStartRequest, callbacks: ManagedHermesRunnerCallbacks): Promise<void> {
    if (this.currentAvailability.state !== 'ready') {
      throw new ManagedHermesRunnerUnavailableError();
    }
    const runId = request.run.id;
    if (this.watchers.has(runId)) {
      // Pack service idempotency prevents this path during normal operation;
      // treating duplicate callback registration as invalid is safer than
      // rebinding lifecycle evidence to another caller.
      throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker lifecycle is already registered for this run');
    }
    const watcher: RunWatcher = { callbacks, started: false, settled: false, failedPolls: 0 };
    this.watchers.set(runId, watcher);
    try {
      // The one-time Core grant exists only inside `request` while this POST
      // is in flight. It is never copied into a watcher, status result,
      // exception, Pack log or Pack state file.
      const raw = await this.request(HERMES_RUNNERD_RUNS_PATH, 'POST', createHermesRunnerdLaunchRequest(request));
      const response = parseHermesRunnerdRunResponse(raw, runId);
      await this.applyRun(runId, watcher, response.run);
    } catch (cause) {
      this.clearWatcher(runId, watcher);
      if (cause instanceof HermesRunnerBrokerClientError) throw cause;
      throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker returned an invalid launch response');
    }
  }

  async cancel(runId: string, reason?: string): Promise<void> {
    const watcher = this.watchers.get(runId);
    try {
      const raw = await this.request(`${hermesRunnerdRunPath(runId)}/cancel`, 'POST', createHermesRunnerdCancelRequest(reason));
      const response = parseHermesRunnerdRunResponse(raw, runId);
      // A Pack restart intentionally has no in-memory watcher. In that case
      // the durable recovery path owns the terminal transition rather than
      // inventing a callback from a fresh process.
      if (watcher) await this.applyRun(runId, watcher, response.run);
    } catch (cause) {
      if (cause instanceof HermesRunnerBrokerClientError) throw cause;
      throw new HermesRunnerBrokerClientError('BROKER_PROTOCOL_INVALID', 'runner broker returned an invalid cancel response');
    }
  }

  private async request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.brokerUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.brokerToken}`,
          accept: 'application/json',
          'x-argus-hermes-runnerd-protocol': ARGUS_HERMES_RUNNERD_PROTOCOL,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(
          method === 'POST' && path === HERMES_RUNNERD_RUNS_PATH
            ? BROKER_LAUNCH_TIMEOUT_MS
            : method === 'POST' && path.endsWith('/cancel')
              ? BROKER_CANCEL_TIMEOUT_MS
            : BROKER_REQUEST_TIMEOUT_MS,
        ),
      });
    } catch {
      throw new HermesRunnerBrokerClientError('BROKER_UNAVAILABLE', 'runner broker is unavailable');
    }
    let text: string;
    try {
      text = await boundedText(response);
    } catch (cause) {
      if (cause instanceof HermesRunnerBrokerClientError) throw cause;
      throw new HermesRunnerBrokerClientError('BROKER_UNAVAILABLE', 'runner broker is unavailable');
    }
    if (!response.ok) {
      throw new HermesRunnerBrokerClientError('BROKER_REJECTED', 'runner broker rejected the lifecycle request');
    }
    return parseJson(text);
  }

  private async applyRun(runId: string, watcher: RunWatcher, run: HermesRunnerdRun): Promise<void> {
    if (watcher.settled) return;
    watcher.failedPolls = 0;
    // A cancellation can arrive while runnerd is still binding the native
    // Docker run. In that race the terminal response may legitimately carry
    // a nativeRunId even though Pack state is already `cancelling`. Never emit
    // a late `onStarted` callback ahead of the authoritative terminal stop.
    if (run.state === 'cancelled') {
      this.clearWatcher(runId, watcher);
      await watcher.callbacks.onCancelled();
      return;
    }
    if (!watcher.started && run.nativeRunId) {
      watcher.started = true;
      await watcher.callbacks.onStarted(run.nativeRunId);
    }
    if (run.state === 'awaiting_approval') {
      // Native Hermes approvals are deliberately not Argus approvals. Remove
      // the watcher before the callback requests cancellation so a fast
      // broker `cancelled` reply cannot win over the mandated normalized
      // `NATIVE_APPROVAL_UNSUPPORTED` failure transition.
      this.clearWatcher(runId, watcher);
      await watcher.callbacks.onNativeApprovalRequested();
      return;
    }
    if (run.state === 'completed') {
      this.clearWatcher(runId, watcher);
      await watcher.callbacks.onCompleted(run.evidence, run.output, run.usage);
      return;
    }
    if (run.state === 'failed') {
      this.clearWatcher(runId, watcher);
      await watcher.callbacks.onFailed(run.errorCode ?? 'RUNNER_FAILED');
      return;
    }
    if (!isHermesRunnerdTerminalState(run.state)) this.schedulePoll(runId, watcher);
  }

  private schedulePoll(runId: string, watcher: RunWatcher): void {
    if (watcher.settled || watcher.timer) return;
    const timer = setTimeout(() => {
      watcher.timer = undefined;
      void this.poll(runId, watcher);
    }, this.pollMs);
    // A background reconciler must not keep an otherwise idle Pack process
    // alive during shutdown.
    timer.unref?.();
    watcher.timer = timer;
  }

  private async poll(runId: string, watcher: RunWatcher): Promise<void> {
    if (watcher.settled || this.watchers.get(runId) !== watcher) return;
    try {
      const raw = await this.request(hermesRunnerdRunPath(runId), 'GET');
      const response = parseHermesRunnerdRunResponse(raw, runId);
      await this.applyRun(runId, watcher, response.run);
    } catch {
      watcher.failedPolls += 1;
      if (watcher.failedPolls >= MAX_CONSECUTIVE_STATUS_FAILURES) {
        this.clearWatcher(runId, watcher);
        await watcher.callbacks.onFailed('RUNNER_STATUS_UNAVAILABLE');
        return;
      }
      this.schedulePoll(runId, watcher);
    }
  }

  private clearWatcher(runId: string, watcher: RunWatcher): void {
    watcher.settled = true;
    if (watcher.timer) clearTimeout(watcher.timer);
    watcher.timer = undefined;
    if (this.watchers.get(runId) === watcher) this.watchers.delete(runId);
  }
}

/**
 * Startup factory keeps the default Pack fail-closed. When configured, the
 * broker must still pass its authenticated preflight before the server
 * advertises managed lifecycle capabilities.
 */
export async function createConfiguredManagedHermesRunner(
  config: Pick<ArgusHermesConfig, 'managedRunnerBrokerUrl' | 'managedRunnerBrokerToken' | 'managedRunnerPollMs'>,
  options: Pick<HermesRunnerBrokerClientOptions, 'fetchFn'> = {},
): Promise<ManagedHermesRunner> {
  if (!config.managedRunnerBrokerUrl || !config.managedRunnerBrokerToken) {
    return new UnprovisionedManagedHermesRunner();
  }
  const runner = new HermesRunnerBrokerClient({
    brokerUrl: config.managedRunnerBrokerUrl,
    brokerToken: config.managedRunnerBrokerToken,
    pollMs: config.managedRunnerPollMs ?? DEFAULT_POLL_MS,
    ...options,
  });
  await runner.preflight();
  return runner;
}
