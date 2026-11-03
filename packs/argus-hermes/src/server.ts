import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AttachedHermesClient, AttachedHermesRunError } from './attachedHermes.js';
import { loadConfig, type ArgusHermesConfig } from './config.js';
import { ARGUS_HERMES_PACK_MANIFEST } from './packManifest.js';
import {
  ManagedRunContractError,
  managedRunNotProvisioned,
  parseManagedHermesRunCancelRequest,
  parseManagedHermesRunId,
  parseManagedHermesRunStartRequest,
} from './managedRunContract.js';
import type { ManagedHermesRunEvent } from './managedRunContract.js';
import { ManagedHermesRunService, ManagedRunServiceError } from './managedRunService.js';
import { ManagedRunStore } from './managedRunStore.js';
import { createConfiguredManagedHermesRunner } from './runnerBrokerClient.js';
import {
  ARGUS_RUNTIME_PROTOCOL,
  type ArgusRuntimeAdapterCapabilities,
  type ArgusRuntimeAdapterIdentity,
  type ArgusRuntimeAdapterModeStatus,
  type ArgusRuntimeAdapterState,
  type ArgusRuntimeAdapterStatus,
  HERMES_RUNTIME_CAPABILITY_CEILING,
  HERMES_RUNTIME_ADAPTER_ID,
  HERMES_RUNTIME_UNPROVISIONED_CAPABILITIES,
  type HermesAttachedRuntimeStatus,
} from './runtimeTypes.js';

function json(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function authorized(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
  return Boolean(match && secretMatches(match[1]!, expected));
}

export interface ArgusHermesServerOptions {
  config: ArgusHermesConfig;
  probe?: Pick<AttachedHermesClient, 'status'>;
  attachedRuns?: Pick<AttachedHermesClient, 'startRun' | 'getRun' | 'stopRun'>;
  /**
   * Deliberately optional until an operator installs the isolated runner
   * broker. The default Pack cannot accept managed work and stays fail-closed.
   */
  managedRuns?: ManagedHermesRunService;
}

function adapterIdentity(): ArgusRuntimeAdapterIdentity {
  return {
    id: HERMES_RUNTIME_ADAPTER_ID,
    runtime: 'hermes' as const,
    protocol: ARGUS_RUNTIME_PROTOCOL,
  };
}

export function runtimeCapabilities(managedReady = false, attachedRunsReady = false): ArgusRuntimeAdapterCapabilities {
  return {
    adapter: adapterIdentity(),
    modes: ['attached', 'managed'],
    // Capability discovery describes operations that are actually usable now,
    // not roadmap endpoints. `managedReady` is true only when an injected
    // isolated broker exists; the default Pack still exposes health only.
    capabilities: managedReady
      ? HERMES_RUNTIME_CAPABILITY_CEILING
      : attachedRunsReady
        ? ['health', 'runs', 'cancel']
        : HERMES_RUNTIME_UNPROVISIONED_CAPABILITIES,
  };
}

const ATTACHED_RUNS_PATH = `/runtime/v1/adapters/${HERMES_RUNTIME_ADAPTER_ID}/attached/runs`;

function parseAttachedStartRequest(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached run request must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['apiVersion', 'input'].includes(key))
    || input.apiVersion !== ARGUS_RUNTIME_PROTOCOL
    || !input.input || typeof input.input !== 'object' || Array.isArray(input.input)) {
    throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached run request is invalid');
  }
  const runInput = input.input as Record<string, unknown>;
  if (Object.keys(runInput).some(key => key !== 'text') || typeof runInput.text !== 'string') {
    throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached run input is invalid');
  }
  return runInput.text;
}

function parseAttachedStopRequest(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached stop request must be a JSON object');
  }
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'apiVersion') || input.apiVersion !== ARGUS_RUNTIME_PROTOCOL) {
    throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached stop request is invalid');
  }
}

function attachedLifecycleRunId(pathname: string): { runId: string; operation: 'status' | 'stop' } | null {
  if (!pathname.startsWith(`${ATTACHED_RUNS_PATH}/`)) return null;
  const parts = pathname.slice(ATTACHED_RUNS_PATH.length + 1).split('/');
  if (parts.length === 1 && parts[0]) return { runId: parts[0], operation: 'status' };
  if (parts.length === 2 && parts[0] && parts[1] === 'stop') return { runId: parts[0], operation: 'stop' };
  throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached run lifecycle path is invalid');
}

function attachedRunResponse(run: Awaited<ReturnType<AttachedHermesClient['getRun']>>) {
  return {
    apiVersion: ARGUS_RUNTIME_PROTOCOL,
    trust: 'external_attested' as const,
    governance: {
      coreMcpLease: false,
      nativeToolsExternallyGoverned: true,
    },
    run,
  };
}

function attachedError(res: ServerResponse, cause: AttachedHermesRunError): void {
  json(res, cause.status, { error: { code: cause.code, message: cause.message } });
}

function attachedState(status: HermesAttachedRuntimeStatus): ArgusRuntimeAdapterState {
  if (status.state === 'ready') return 'ready';
  if (status.state === 'degraded') return 'degraded';
  return 'unavailable';
}

function attachedDetail(status: HermesAttachedRuntimeStatus): string {
  if (status.state === 'ready') {
    return 'External / attested Hermes capability handshake succeeded. Attached mode never accepts a Core-issued runtime MCP lease or MCP Fabric credentials.';
  }
  if (status.state === 'not_configured') {
    return 'No external Hermes service is attached. Attached mode is external / attested and has no runtime MCP lease capability.';
  }
  if (status.state === 'unreachable') {
    return 'The configured external Hermes service is unreachable. Attached mode remains external / attested and has no runtime MCP lease capability.';
  }
  return 'The external Hermes capability handshake is degraded. Attached mode remains external / attested and has no runtime MCP lease capability.';
}

export function runtimeStatus(
  attached: HermesAttachedRuntimeStatus,
  managed?: { state: 'ready' | 'unavailable'; detail: string },
): ArgusRuntimeAdapterStatus {
  const attachedMode: ArgusRuntimeAdapterModeStatus = {
    mode: 'attached',
    state: attachedState(attached),
    detail: attachedDetail(attached),
  };
  const managedMode: ArgusRuntimeAdapterModeStatus = {
    mode: 'managed',
    state: managed?.state ?? 'unavailable',
    detail: managed?.detail ?? 'No Argus-managed Hermes runner is provisioned.',
  };
  return {
    adapter: adapterIdentity(),
    state: managedMode.state === 'ready' || attachedMode.state === 'ready'
      ? 'ready'
      : attachedMode.state === 'degraded' ? 'degraded' : 'unavailable',
    checkedAt: attached.checkedAt,
    modes: [attachedMode, managedMode],
  };
}

async function requestJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 128 * 1024) {
      throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtime request exceeds 128 KiB');
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtime request body is required');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtime request must be valid JSON');
  }
}

function managedAvailability(
  service: ManagedHermesRunService | undefined,
  config?: Pick<ArgusHermesConfig, 'coreRuntimeMcpOrigin'>,
) {
  // A real runner would otherwise receive a caller-chosen MCP endpoint plus
  // its one-time grant. Do not merely rely on a future broker to remember
  // this check: the Pack's public lifecycle surface itself stays unavailable
  // until the operator pins the Core origin.
  if (service && config && !config.coreRuntimeMcpOrigin) {
    return {
      state: 'unavailable' as const,
      detail: 'ARGUS_CORE_RUNTIME_MCP_ORIGIN must be configured before an Argus-managed Hermes runner can be enabled.',
    };
  }
  return service?.availability() ?? {
    state: 'unavailable' as const,
    detail: 'No Argus-managed Hermes runner is provisioned.',
  };
}

function managedError(res: ServerResponse, cause: ManagedRunServiceError): void {
  json(res, cause.status, { error: { code: cause.code, message: cause.message } });
}

async function handleRunStart(
  req: IncomingMessage,
  res: ServerResponse,
  config: ArgusHermesConfig,
  service: ManagedHermesRunService | undefined,
): Promise<void> {
  try {
    const request = parseManagedHermesRunStartRequest(await requestJson(req), {
      coreRuntimeMcpOrigin: config.coreRuntimeMcpOrigin,
    });
    if (managedAvailability(service).state !== 'ready' || !service) {
      json(res, 409, managedRunNotProvisioned());
      return;
    }
    const run = await service.start(request);
    json(res, 202, { apiVersion: ARGUS_RUNTIME_PROTOCOL, run });
  } catch (cause) {
    if (cause instanceof ManagedRunServiceError) {
      managedError(res, cause);
      return;
    }
    if (cause instanceof ManagedRunContractError) {
      json(res, cause.code === 'ATTACHED_MCP_LEASE_UNSUPPORTED' ? 409 : 400, {
        error: { code: cause.code, message: cause.message },
      });
      return;
    }
    json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'runtime bridge request failed' } });
  }
}

async function handleRunCancel(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  service: ManagedHermesRunService | undefined,
): Promise<void> {
  try {
    const request = parseManagedHermesRunCancelRequest(await requestJson(req));
    if (managedAvailability(service).state !== 'ready' || !service) {
      // Do not acknowledge or synthesize a cancellation while the Pack has no
      // isolated runner/registry. In particular, never route this to attached
      // Hermes as a fallback.
      json(res, 409, managedRunNotProvisioned());
      return;
    }
    const run = await service.cancel(runId, request);
    json(res, 200, { apiVersion: ARGUS_RUNTIME_PROTOCOL, run });
  } catch (cause) {
    if (cause instanceof ManagedRunServiceError) {
      managedError(res, cause);
      return;
    }
    if (cause instanceof ManagedRunContractError) {
      json(res, 400, { error: { code: cause.code, message: cause.message } });
      return;
    }
    json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'runtime bridge request failed' } });
  }
}

type ManagedLifecycleOperation = 'status' | 'cancel' | 'events';

interface ManagedLifecycleRoute {
  operation: ManagedLifecycleOperation;
  runId: string;
}

/**
 * Treat every lifecycle path under `/runs/` as a strict contract route. This
 * means malformed Run IDs fail as invalid runtime requests rather than being
 * accidentally handled by a future generic route.
 */
function parseManagedLifecycleRoute(pathname: string): ManagedLifecycleRoute | null {
  const prefix = `/runtime/v1/adapters/${HERMES_RUNTIME_ADAPTER_ID}/runs/`;
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split('/');
  if (parts.length < 1 || parts.length > 2 || !parts[0]) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtime lifecycle path is invalid');
  }
  const runId = parseManagedHermesRunId(parts[0]);
  if (parts.length === 1) return { operation: 'status', runId };
  if (parts[1] === 'cancel') return { operation: 'cancel', runId };
  if (parts[1] === 'events') return { operation: 'events', runId };
  throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtime lifecycle operation is invalid');
}

function handleUnprovisionedLifecycle(res: ServerResponse): void {
  // Deliberately JSON, even for the future SSE path: there is no event source
  // to subscribe to before a managed runner exists.
  json(res, 409, managedRunNotProvisioned());
}

// Core deliberately bounds adapter bodies to 64 KiB. Keep a safety margin
// for transport variation and make a long history resumable through the
// opaque Last-Event-ID cursor rather than returning a response Core rejects.
export const MAX_MANAGED_RUN_SSE_SNAPSHOT_BYTES = 60 * 1024;

export function serializeManagedRunSseEvent(event: ManagedHermesRunEvent): string {
  const data = JSON.stringify(event);
  // Keep the SSE envelope stable. The normalized lifecycle type belongs in
  // the signed-shaped JSON payload; Core deliberately accepts only this one
  // Pack event name and never treats a native Hermes event label as evidence.
  return `id: ${event.eventId}\nevent: argus.runtime.event\ndata: ${data}\n\n`;
}

export function managedRunSseSnapshot(events: readonly ManagedHermesRunEvent[]): ManagedHermesRunEvent[] {
  const selected: ManagedHermesRunEvent[] = [];
  let size = 0;
  for (const event of events) {
    const frameSize = Buffer.byteLength(serializeManagedRunSseEvent(event));
    // Store-side evidence bounds make a single frame much smaller than this
    // cap. If that invariant ever changes, fail closed instead of emitting a
    // response which Core cannot safely consume.
    if (frameSize > MAX_MANAGED_RUN_SSE_SNAPSHOT_BYTES) {
      throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'managed runtime lifecycle event exceeds the snapshot limit');
    }
    if (selected.length > 0 && size + frameSize > MAX_MANAGED_RUN_SSE_SNAPSHOT_BYTES) break;
    selected.push(event);
    size += frameSize;
  }
  return selected;
}

function writeSseEvent(res: ServerResponse, event: ManagedHermesRunEvent): void {
  res.write(serializeManagedRunSseEvent(event));
}

function eventCursor(req: IncomingMessage): string | undefined {
  const raw = req.headers['last-event-id'];
  if (raw === undefined) return undefined;
  const value = String(raw);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'Last-Event-ID must be a safe opaque event cursor');
  }
  return value;
}

async function handleRunEvents(
  req: IncomingMessage,
  res: ServerResponse,
  runId: string,
  service: ManagedHermesRunService | undefined,
): Promise<void> {
  if (managedAvailability(service).state !== 'ready' || !service) {
    handleUnprovisionedLifecycle(res);
    return;
  }
  try {
    const events = managedRunSseSnapshot(await service.events(runId, eventCursor(req)));
    // This foundation returns the durable event snapshot and closes. A future
    // broker event pump will add a single Pack-owned live subscription; raw
    // Hermes SSE must never be proxied directly to Core or a browser.
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'close',
      'x-accel-buffering': 'no',
    });
    for (const event of events) writeSseEvent(res, event);
    res.end();
  } catch (cause) {
    if (cause instanceof ManagedRunServiceError) {
      managedError(res, cause);
      return;
    }
    throw cause;
  }
}

export function createArgusHermesServer(options: ArgusHermesServerOptions) {
  const attachedClient = new AttachedHermesClient(options.config);
  const probe = options.probe ?? attachedClient;
  const attachedRuns = options.attachedRuns ?? attachedClient;
  const managed = managedAvailability(options.managedRuns, options.config);
  // Keep an injected runner unreachable as well as unadvertised when the
  // trusted Core origin is absent. This is an explicit configuration gate,
  // not a best-effort validation performed later by the runner.
  const managedRuns = managed.state === 'ready' ? options.managedRuns : undefined;
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', options.config.publicUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok', pack: 'argus.hermes', version: ARGUS_HERMES_PACK_MANIFEST.metadata.version });
        return;
      }
      if (!options.config.discoveryToken) {
        json(res, 503, {
          error: {
            code: 'SERVICE_CREDENTIAL_REQUIRED',
            message: 'a Pack service credential must be configured before this route is available',
          },
        });
        return;
      }
      if (!authorized(req, options.config.discoveryToken)) {
        json(res, 401, { error: { code: 'UNAUTHENTICATED', message: 'invalid Pack service credential' } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const status = await probe.status();
        // The Pack itself is ready when no Hermes endpoint has been configured:
        // that is the normal state directly after installation, before an admin
        // chooses Attach existing Hermes or launches a managed runtime.
        const ready = status.state === 'ready' || status.state === 'not_configured';
        // Keep the raw probe Pack-internal: it may contain an externally
        // configured endpoint or upstream diagnostics. The Core-visible
        // normalized adapter status is available on its dedicated route.
        json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'degraded', connector: { state: status.state } });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/argus-solution-pack.yaml') {
        json(res, 200, ARGUS_HERMES_PACK_MANIFEST, 'application/yaml; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === `/runtime/v1/adapters/${HERMES_RUNTIME_ADAPTER_ID}/capabilities`) {
        const attached = await probe.status();
        json(res, 200, runtimeCapabilities(
          managed.state === 'ready',
          attached.state === 'ready' && Boolean(options.config.hermesApiKey),
        ));
        return;
      }
      if (req.method === 'GET' && url.pathname === `/runtime/v1/adapters/${HERMES_RUNTIME_ADAPTER_ID}/status`) {
        json(res, 200, runtimeStatus(await probe.status(), managed));
        return;
      }
      if (req.method === 'POST' && url.pathname === `/runtime/v1/adapters/${HERMES_RUNTIME_ADAPTER_ID}/runs`) {
        await handleRunStart(req, res, options.config, managedRuns);
        return;
      }
      if (req.method === 'POST' && url.pathname === ATTACHED_RUNS_PATH) {
        const run = await attachedRuns.startRun(parseAttachedStartRequest(await requestJson(req)));
        json(res, 202, attachedRunResponse(run));
        return;
      }
      const attachedLifecycle = attachedLifecycleRunId(url.pathname);
      if (attachedLifecycle) {
        if (attachedLifecycle.operation === 'status' && req.method === 'GET') {
          json(res, 200, attachedRunResponse(await attachedRuns.getRun(attachedLifecycle.runId)));
          return;
        }
        if (attachedLifecycle.operation === 'stop' && req.method === 'POST') {
          parseAttachedStopRequest(await requestJson(req));
          json(res, 200, attachedRunResponse(await attachedRuns.stopRun(attachedLifecycle.runId)));
          return;
        }
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method is not allowed for this attached lifecycle operation' } });
        return;
      }
      const lifecycle = parseManagedLifecycleRoute(url.pathname);
      if (lifecycle) {
        if (lifecycle.operation === 'status' && req.method === 'GET') {
          if (managed.state !== 'ready' || !managedRuns) handleUnprovisionedLifecycle(res);
          else json(res, 200, { apiVersion: ARGUS_RUNTIME_PROTOCOL, run: await managedRuns.status(lifecycle.runId) });
          return;
        }
        if (lifecycle.operation === 'cancel' && req.method === 'POST') {
          await handleRunCancel(req, res, lifecycle.runId, managedRuns);
          return;
        }
        if (lifecycle.operation === 'events' && req.method === 'GET') {
          await handleRunEvents(req, res, lifecycle.runId, managedRuns);
          return;
        }
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method is not allowed for this runtime lifecycle operation' } });
        return;
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (cause) {
      if (cause instanceof ManagedRunServiceError) {
        managedError(res, cause);
        return;
      }
      if (cause instanceof AttachedHermesRunError) {
        attachedError(res, cause);
        return;
      }
      if (cause instanceof ManagedRunContractError) {
        json(res, cause.code === 'ATTACHED_MCP_LEASE_UNSUPPORTED' ? 409 : 400, {
          error: { code: cause.code, message: cause.message },
        });
        return;
      }
      // Deliberately avoid forwarding upstream error details or request headers.
      json(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'runtime bridge request failed' } });
    }
  });
}

export async function startServer(): Promise<void> {
  const config = loadConfig();
  // The ordinary Pack remains health-only until the operator configures both
  // the broker origin and its service credential. In the configured case,
  // runnerd must still pass its authenticated preflight before `managed`
  // becomes advertised. The Pack never receives a Docker socket here.
  let managedRuns: ManagedHermesRunService | undefined;
  if (config.managedRunnerBrokerUrl && config.managedRunnerBrokerToken) {
    const runner = await createConfiguredManagedHermesRunner(config);
    managedRuns = new ManagedHermesRunService(
      new ManagedRunStore({ stateDirectory: config.managedRunStateDirectory ?? '/var/lib/argus-hermes' }),
      runner,
    );
    // A redacted registry survives process restarts, while the one-time grant
    // and in-memory callback never do. Fail every incomplete entry closed
    // before accepting another managed request from Core.
    await managedRuns.recoverAfterRestart();
  }
  const server = createArgusHermesServer({ config, ...(managedRuns ? { managedRuns } : {}) });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => resolve());
  });
  process.stdout.write(`Argus.Hermes listening on port ${config.port}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startServer().catch(error => {
    process.stderr.write(`Argus.Hermes startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export type { HermesAttachedRuntimeStatus };
