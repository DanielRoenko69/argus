import { timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';

const EXECUTION_GRANT = /^eg_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 1024 * 1024;
const ALLOWED_REQUEST_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;
const ALLOWED_RESPONSE_HEADERS = [
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'cache-control',
] as const;

export interface McpAuthProxyConfig {
  port: number;
  coreRuntimeMcpOrigin: string;
  leaseId: string;
  rootTraceId: string;
  grantFile: string;
}

export interface McpAuthProxyServerOptions {
  config: McpAuthProxyConfig;
  /** Read exactly once at start; never store, log, or return this value. */
  executionGrant: string;
  fetchFn?: typeof fetch;
}

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ARGUS_MCP_PROXY_CORE_ORIGIN must be a valid HTTP(S) origin');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ARGUS_MCP_PROXY_CORE_ORIGIN must be a credential-free HTTP(S) origin');
  }
  return url.origin;
}

function parsePort(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '3002', 10);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error('ARGUS_MCP_PROXY_PORT must be an integer from 1 to 65535');
  }
  return value;
}

function parseLeaseId(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!UUID.test(value)) throw new Error('ARGUS_MCP_PROXY_LEASE_ID must be a UUID');
  return value;
}

function parseGrantFilename(raw: string | undefined): string {
  const value = raw?.trim() ?? '';
  if (!value || value.length > 1_024 || /[\r\n\u0000]/.test(value)) {
    throw new Error('ARGUS_MCP_PROXY_GRANT_FILE is malformed');
  }
  return value;
}

/**
 * Configures the proxy from a runnerd-created, per-run container only. There
 * is intentionally no inline grant environment variable.
 */
export function loadMcpAuthProxyConfig(env: NodeJS.ProcessEnv = process.env): McpAuthProxyConfig {
  if (process.platform === 'win32' && env['ARGUS_MCP_PROXY_ALLOW_INSECURE_WINDOWS_LOCAL'] !== 'true') {
    throw new Error('MCP auth proxy requires a Linux container with POSIX secret-file permissions');
  }
  return {
    port: parsePort(env['ARGUS_MCP_PROXY_PORT']),
    coreRuntimeMcpOrigin: normalizeOrigin(env['ARGUS_MCP_PROXY_CORE_ORIGIN'] ?? ''),
    leaseId: parseLeaseId(env['ARGUS_MCP_PROXY_LEASE_ID']),
    rootTraceId: parseLeaseId(env['ARGUS_MCP_PROXY_ROOT_TRACE_ID']),
    grantFile: parseGrantFilename(env['ARGUS_MCP_PROXY_GRANT_FILE']),
  };
}

/**
 * Reads the one-time grant from a 0600 secret file. On Windows no equivalent
 * POSIX permission proof exists, so the production proxy refuses to start
 * there in `loadMcpAuthProxyConfig`.
 */
export function readMcpAuthProxyGrant(filename: string): string {
  const stat = statSync(filename);
  if (!stat.isFile()) throw new Error('MCP auth proxy grant must be a regular file');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    throw new Error('MCP auth proxy grant file must not be readable by group or others');
  }
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) throw new Error('MCP auth proxy grant file exceeds 16 KiB');
  const grant = raw.trim();
  if (!EXECUTION_GRANT.test(grant) || /[\r\n\u0000]/.test(grant)) {
    throw new Error('MCP auth proxy grant file is malformed');
  }
  return grant;
}

/**
 * A Docker provisioner has to create the proxy container before it can copy
 * the one-time grant into that container's private tmpfs. Keep the startup
 * race bounded and retry only a missing file; malformed permissions or grant
 * bytes still fail immediately and never fall back to another source.
 */
export async function waitForMcpAuthProxyGrant(
  filename: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return readMcpAuthProxyGrant(filename);
    } catch (cause) {
      const code = cause && typeof cause === 'object' && 'code' in cause
        ? String((cause as NodeJS.ErrnoException).code)
        : undefined;
      if (code !== 'ENOENT' || Date.now() >= deadline) throw cause;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function validateProvidedGrant(value: string): string {
  if (!EXECUTION_GRANT.test(value) || value.length > 16 * 1024 || /[\r\n\u0000]/.test(value)) {
    throw new Error('MCP auth proxy execution grant is malformed');
  }
  return value;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function sameGrant(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function jsonRpcMethodCount(body: Buffer | undefined, method: string): number {
  if (!body) return 0;
  try {
    const value = JSON.parse(body.toString('utf8')) as unknown;
    const messages = Array.isArray(value) ? value : [value];
    return Math.min(1_000, messages.filter(message => (
      message !== null
      && typeof message === 'object'
      && !Array.isArray(message)
      && (message as Record<string, unknown>).method === method
    )).length);
  } catch {
    return 0;
  }
}

async function advertisedToolCount(response: Response, listRequests: number): Promise<number> {
  if (listRequests < 1) return 0;
  try {
    const text = await response.clone().text();
    if (Buffer.byteLength(text, 'utf8') > MAX_REQUEST_BYTES) return 0;
    const contentType = response.headers.get('content-type') ?? '';
    const payloads = contentType.includes('application/json')
      ? [text]
      : contentType.includes('text/event-stream')
        ? text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim())
        : [];
    const messages = payloads.flatMap(payload => {
      const value = JSON.parse(payload) as unknown;
      return Array.isArray(value) ? value : [value];
    });
    return Math.min(10_000, messages.reduce((count, message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return count;
      const result = (message as Record<string, unknown>).result;
      if (!result || typeof result !== 'object' || Array.isArray(result)) return count;
      const tools = (result as Record<string, unknown>).tools;
      return count + (Array.isArray(tools) ? tools.length : 0);
    }, 0));
  } catch {
    return 0;
  }
}

function safeHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !value || value.length > 4_096 || /[\r\n\u0000]/.test(value)) return undefined;
  return value;
}

function forwardedRequestHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = safeHeader(req.headers[name]);
    if (value) headers[name] = value;
  }
  return headers;
}

function forwardedResponseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = safeHeader(headers.get(name) ?? undefined);
    if (value) output[name] = value;
  }
  return output;
}

async function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(bytes);
  }
  return size ? Buffer.concat(chunks) : undefined;
}

async function writeBody(res: ServerResponse, body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) {
    res.end();
    return;
  }
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (!res.write(Buffer.from(value))) await once(res, 'drain');
    }
    res.end();
  } finally {
    reader.releaseLock();
  }
}

/**
 * A minimal per-run auth proxy. Hermes may only call `/mcp`; the proxy always
 * targets the Core-owned exact runtime lease endpoint and replaces any caller
 * authorization header with its private one-time grant. It is meant to live
 * on a run-private Docker/Kubernetes network with no published host port.
 */
export function createMcpAuthProxyServer(options: McpAuthProxyServerOptions) {
  const coreOrigin = normalizeOrigin(options.config.coreRuntimeMcpOrigin);
  const leaseId = parseLeaseId(options.config.leaseId);
  const executionGrant = validateProvidedGrant(options.executionGrant);
  const target = `${coreOrigin}/mcp/runtime/${leaseId}`;
  const fetchFn = options.fetchFn ?? fetch;
  let attemptedToolCalls = 0;
  let successfulToolCalls = 0;
  let failedToolCalls = 0;
  let advertisedTools = 0;

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://argus-mcp-proxy.invalid');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      json(res, 200, {
        status: 'ok',
        toolCallAttempts: attemptedToolCalls,
        toolCalls: successfulToolCalls,
        toolCallFailures: failedToolCalls,
        advertisedTools,
      });
      return;
    }
    if (!['POST', 'GET', 'DELETE'].includes(req.method ?? '') || url.pathname !== '/mcp' || url.search) {
      json(res, 404, { error: 'route not found' });
      return;
    }
    let requestToolCalls = 0;
    try {
      const controller = new AbortController();
      req.once('aborted', () => controller.abort());
      const body = await readBody(req);
      requestToolCalls = jsonRpcMethodCount(body, 'tools/call');
      const requestToolLists = jsonRpcMethodCount(body, 'tools/list');
      attemptedToolCalls = Math.min(1_000_000, attemptedToolCalls + requestToolCalls);
      // `Blob` is an explicit Fetch BodyInit across Node's DOM typings while
      // preserving the bounded raw MCP JSON bytes without decoding them.
      const bodyBytes = body === undefined ? undefined : new Uint8Array(body.byteLength);
      if (bodyBytes && body) bodyBytes.set(body);
      const requestBody = bodyBytes === undefined ? undefined : new Blob([bodyBytes]);
      const response = await fetchFn(target, {
        method: req.method,
        headers: {
          ...forwardedRequestHeaders(req),
          // Never forward caller `Authorization`, Host, X-Forwarded-* or any
          // arbitrary header. The proxy is the only bearer holder, and the
          // runner-provided root trace is the only trace identity Core may
          // use to validate this grant.
          authorization: `Bearer ${executionGrant}`,
          'x-argus-root-trace-id': options.config.rootTraceId,
        },
        ...(requestBody === undefined ? {} : { body: requestBody }),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (!response.ok) {
        failedToolCalls = Math.min(1_000_000, failedToolCalls + requestToolCalls);
        // Core's error response might be safe, but this boundary must never
        // turn an accidental proxy into a diagnostic oracle for Hermes.
        json(res, 502, { error: 'runtime MCP request failed' });
        return;
      }
      advertisedTools = Math.max(advertisedTools, await advertisedToolCount(response, requestToolLists));
      successfulToolCalls = Math.min(1_000_000, successfulToolCalls + requestToolCalls);
      res.writeHead(response.status, {
        ...forwardedResponseHeaders(response.headers),
        'cache-control': 'no-store',
      });
      await writeBody(res, response.body);
    } catch (cause) {
      failedToolCalls = Math.min(1_000_000, failedToolCalls + requestToolCalls);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (cause instanceof Error && cause.message === 'request_too_large') {
        json(res, 413, { error: 'request exceeds proxy limit' });
        return;
      }
      json(res, 502, { error: 'runtime MCP request failed' });
    }
  });
}

export async function startMcpAuthProxy(): Promise<void> {
  const config = loadMcpAuthProxyConfig();
  const executionGrant = await waitForMcpAuthProxyGrant(config.grantFile);
  const server = createMcpAuthProxyServer({ config, executionGrant });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, '0.0.0.0', () => resolve());
  });
  process.stdout.write(`Argus managed MCP auth proxy listening on port ${config.port}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  startMcpAuthProxy().catch(() => {
    // Deliberately do not serialize a file path, target origin or grant error.
    process.stderr.write('Argus managed MCP auth proxy failed to start\n');
    process.exitCode = 1;
  });
}

// Keep the imported timing-safe helper observable in unit tests without ever
// exposing the grant. This is also a useful cheap regression guard against
// accidentally switching the proxy to ordinary string equality for a future
// administrative health endpoint.
export const mcpAuthProxyGrantMatches = sameGrant;
