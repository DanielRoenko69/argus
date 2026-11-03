import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  HERMES_RUNNERD_READY_PATH,
  HERMES_RUNNERD_RUNS_PATH,
  parseHermesRunnerdCancelRequest,
  parseHermesRunnerdLaunchRequest,
  parseHermesRunnerdRunResponse,
} from './runnerdContract.js';
import { UnprovisionedHermesRunnerdLauncher } from './runnerdLauncher.js';
import { createConfiguredDockerRunnerdLauncher } from './dockerRunnerdConfig.js';
import { loadHermesRunnerdConfig, type HermesRunnerdConfig } from './runnerdConfig.js';
import { HermesRunnerdService, HermesRunnerdServiceError } from './runnerdService.js';
import { RunnerdRunStore } from './runnerdStore.js';
import { parseManagedHermesRunId } from './managedRunContract.js';

const MAX_REQUEST_BYTES = 128 * 1024;

class RunnerdHttpError extends Error {
  constructor(readonly status: 400 | 413 | 415, readonly code: 'INVALID_RUNNERD_REQUEST' | 'REQUEST_TOO_LARGE' | 'UNSUPPORTED_MEDIA_TYPE') {
    super(code);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(data);
}

function safeError(res: ServerResponse, status: number, code: string, message: string): void {
  // `message` must always be a static implementation string. Do not put an
  // exception, request property, native Hermes response or configuration in
  // this envelope: any one could contain a grant, prompt or endpoint.
  json(res, status, { error: { code, message } });
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isAuthorized(req: IncomingMessage, expected: string): boolean {
  const value = req.headers.authorization;
  if (Array.isArray(value)) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(value ?? '');
  return Boolean(match && tokenMatches(match[1]!, expected));
}

function hasProtocolHeader(req: IncomingMessage): boolean {
  const value = req.headers['x-argus-hermes-runnerd-protocol'];
  return !Array.isArray(value) && value === ARGUS_HERMES_RUNNERD_PROTOCOL;
}

function hasJsonContentType(req: IncomingMessage): boolean {
  const value = req.headers['content-type'];
  return !Array.isArray(value) && /^application\/json(?:\s*;|\s*$)/i.test(value ?? '');
}

async function requestJson(req: IncomingMessage): Promise<unknown> {
  if (!hasJsonContentType(req)) throw new RunnerdHttpError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const advertised = req.headers['content-length'];
  if (!Array.isArray(advertised) && advertised !== undefined) {
    const size = Number(advertised);
    if (!Number.isSafeInteger(size) || size < 1) throw new RunnerdHttpError(400, 'INVALID_RUNNERD_REQUEST');
    if (size > MAX_REQUEST_BYTES) throw new RunnerdHttpError(413, 'REQUEST_TOO_LARGE');
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new RunnerdHttpError(413, 'REQUEST_TOO_LARGE');
    chunks.push(bytes);
  }
  if (size === 0) throw new RunnerdHttpError(400, 'INVALID_RUNNERD_REQUEST');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RunnerdHttpError(400, 'INVALID_RUNNERD_REQUEST');
  }
}

function runnerdResponse(run: unknown, expectedRunId: string) {
  // Revalidate immediately before serializing. This makes a future launcher
  // unable to smuggle a raw native field through a service implementation.
  return parseHermesRunnerdRunResponse({
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    run,
  }, expectedRunId);
}

function routeRunId(pathname: string): string | undefined {
  const match = new RegExp(`^${HERMES_RUNNERD_RUNS_PATH}/([^/]+)$`).exec(pathname);
  if (!match) return undefined;
  return parseManagedHermesRunId(match[1]);
}

function routeCancelRunId(pathname: string): string | undefined {
  const match = new RegExp(`^${HERMES_RUNNERD_RUNS_PATH}/([^/]+)/cancel$`).exec(pathname);
  if (!match) return undefined;
  return parseManagedHermesRunId(match[1]);
}

function replyServiceError(res: ServerResponse, cause: HermesRunnerdServiceError): void {
  safeError(res, cause.status, cause.code, {
    RUNNERD_NOT_PROVISIONED: 'no isolated managed Hermes launcher is provisioned',
    RUN_NOT_FOUND: 'runnerd run was not found',
    RUN_CONFLICT: 'runnerd run lifecycle conflicts with the stored state',
    RUNNERD_LAUNCH_FAILED: 'runnerd could not start the managed run',
    RUNNERD_STATUS_UNAVAILABLE: 'runnerd lifecycle state is unavailable',
    RUNNERD_CANCEL_UNAVAILABLE: 'runnerd could not cancel the managed run',
    RUNNERD_RESTART_RECOVERY: 'runnerd recovered an incomplete run and failed it closed',
  }[cause.code]);
}

export interface HermesRunnerdServerOptions {
  config: HermesRunnerdConfig;
  /** Injectable only for the controlled launcher implementation and tests. */
  service?: HermesRunnerdService;
}

/**
 * Private authenticated HTTP broker for the Pack. There is intentionally no
 * unauthenticated health route, generic proxy path, event relay or dynamic
 * container-control endpoint.
 */
export function createHermesRunnerdServer(options: HermesRunnerdServerOptions) {
  const service = options.service ?? new HermesRunnerdService(
    new RunnerdRunStore({ stateDirectory: options.config.stateDirectory }),
    new UnprovisionedHermesRunnerdLauncher(),
  );
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://argus-hermes-runnerd.invalid');
      if (url.search || url.hash) {
        safeError(res, 404, 'NOT_FOUND', 'route not found');
        return;
      }
      // Liveness deliberately says nothing about launcher availability,
      // configuration or recorded runs. The Pack never uses this route for
      // authorization or capability discovery.
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok' });
        return;
      }
      if (!isAuthorized(req, options.config.serviceToken)) {
        safeError(res, 401, 'UNAUTHENTICATED', 'runnerd service authentication is required');
        return;
      }
      if (!hasProtocolHeader(req)) {
        safeError(res, 400, 'INVALID_RUNNERD_PROTOCOL', 'runnerd protocol header is required');
        return;
      }
      if (req.method === 'GET' && url.pathname === HERMES_RUNNERD_READY_PATH) {
        if (service.availability().state !== 'ready') {
          safeError(res, 503, 'RUNNERD_NOT_PROVISIONED', 'no isolated managed Hermes launcher is provisioned');
          return;
        }
        json(res, 200, { apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'ready' });
        return;
      }
      if (req.method === 'POST' && url.pathname === HERMES_RUNNERD_RUNS_PATH) {
        // Do not read a grant-bearing body at all when the privileged
        // provisioner is absent. The Pack will keep managed capability off.
        if (service.availability().state !== 'ready') {
          safeError(res, 503, 'RUNNERD_NOT_PROVISIONED', 'no isolated managed Hermes launcher is provisioned');
          return;
        }
        const launch = parseHermesRunnerdLaunchRequest(await requestJson(req), {
          coreRuntimeMcpOrigin: options.config.coreRuntimeMcpOrigin,
        });
        const run = await service.start(launch.request);
        json(res, 202, runnerdResponse(run, launch.request.run.id));
        return;
      }
      const statusRunId = routeRunId(url.pathname);
      if (statusRunId !== undefined && req.method === 'GET') {
        if (service.availability().state !== 'ready') {
          safeError(res, 503, 'RUNNERD_NOT_PROVISIONED', 'no isolated managed Hermes launcher is provisioned');
          return;
        }
        json(res, 200, runnerdResponse(await service.status(statusRunId), statusRunId));
        return;
      }
      const cancelRunId = routeCancelRunId(url.pathname);
      if (cancelRunId !== undefined && req.method === 'POST') {
        if (service.availability().state !== 'ready') {
          safeError(res, 503, 'RUNNERD_NOT_PROVISIONED', 'no isolated managed Hermes launcher is provisioned');
          return;
        }
        const cancellation = parseHermesRunnerdCancelRequest(await requestJson(req));
        json(res, 200, runnerdResponse(await service.cancel(cancelRunId, cancellation.reason), cancelRunId));
        return;
      }
      if (url.pathname === HERMES_RUNNERD_READY_PATH || url.pathname === HERMES_RUNNERD_RUNS_PATH
        || statusRunId !== undefined || cancelRunId !== undefined) {
        safeError(res, 405, 'METHOD_NOT_ALLOWED', 'method is not allowed for this runnerd route');
        return;
      }
      safeError(res, 404, 'NOT_FOUND', 'route not found');
    } catch (cause) {
      if (cause instanceof HermesRunnerdServiceError) {
        replyServiceError(res, cause);
        return;
      }
      if (cause instanceof RunnerdHttpError) {
        safeError(res, cause.status, cause.code, {
          INVALID_RUNNERD_REQUEST: 'runnerd request is invalid',
          REQUEST_TOO_LARGE: 'runnerd request exceeds the allowed limit',
          UNSUPPORTED_MEDIA_TYPE: 'runnerd requests must use application/json',
        }[cause.code]);
        return;
      }
      // Contract parsers and a future launcher must never have their raw
      // diagnostics reflected to the Pack; they could include a grant or
      // upstream/native detail. Use one generic error for every unknown path.
      safeError(res, 400, 'INVALID_RUNNERD_REQUEST', 'runnerd request is invalid');
    }
  });
}

/**
 * Runnable, fail-closed standalone process. The script deliberately creates
 * only the unavailable launcher: publishing `/v1/ready` as ready requires a
 * separately reviewed privileged launcher injection, not a Docker socket or
 * environment switch in this Pack image.
 */
export async function startRunnerd(): Promise<void> {
  const config = loadHermesRunnerdConfig();
  const launcher = createConfiguredDockerRunnerdLauncher(config) ?? new UnprovisionedHermesRunnerdLauncher();
  const service = new HermesRunnerdService(
    new RunnerdRunStore({ stateDirectory: config.stateDirectory }),
    launcher,
  );
  await service.recoverAfterRestart();
  const server = createHermesRunnerdServer({ config, service });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => resolve());
  });
  process.stdout.write(`Argus managed Hermes runnerd listening on port ${config.port}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startRunnerd().catch(() => {
    // Do not print configuration, request or launcher errors: this process is
    // specifically expected to receive one-time grants after activation.
    process.stderr.write('Argus managed Hermes runnerd failed to start\n');
    process.exitCode = 1;
  });
}

// Exposed only for unit coverage of constant-time service auth.
export const runnerdServiceTokenMatches = tokenMatches;
