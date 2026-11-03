import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { Pool } from 'pg';
import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_VERSION,
  A2aProtocolError,
  a2aErrorBody,
  buildArgusAiopsAgentCard,
  cancelA2aTask,
  sendA2aMessage,
} from './a2a.js';
import { ARGUS_AIOPS_PACK_MANIFEST } from './packManifest.js';
import { ArgusCoreClient } from './coreClient.js';
import { InvestigationRunner, type InvestigationExecutor } from './investigationRunner.js';
import { PostgresTaskStore, type TaskListCursor, type TaskStore } from './taskStore.js';

const MAX_BODY_BYTES = 1024 * 1024;
const TASK_PATH = /^\/tasks\/([A-Za-z0-9._~-]{1,128})(:cancel)?$/;
const TASK_LIST_LIMIT = 20;
const TASK_LIST_MAX_LIMIT = 50;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(res: ServerResponse, status: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function a2aJson(res: ServerResponse, status: number, body: unknown): void {
  json(res, status, body, `${A2A_CONTENT_TYPE}; charset=utf-8`);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new A2aProtocolError(413, 'REQUEST_TOO_LARGE', 'request body exceeds 1 MiB');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new A2aProtocolError(400, 'INVALID_JSON', 'request body must be a JSON object');
  }
}

function secretMatches(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readDiscoveryToken(filename: string): string {
  if (!filename) return '';
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024) throw new Error('pack discovery credential exceeds 8 KiB');
  const token = raw.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('pack discovery credential is empty or malformed');
  return token;
}

function parseTaskListLimit(value: string | null): number {
  if (value === null) return TASK_LIST_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > TASK_LIST_MAX_LIMIT) {
    throw new A2aProtocolError(400, 'INVALID_LIMIT', `limit must be an integer from 1 to ${TASK_LIST_MAX_LIMIT}`);
  }
  return limit;
}

function encodeTaskCursor(cursor: TaskListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTaskCursor(value: string | null): TaskListCursor | undefined {
  if (value === null) return undefined;
  if (value.length < 1 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new A2aProtocolError(400, 'INVALID_CURSOR', 'cursor is malformed');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
    const cursor = parsed as Record<string, unknown>;
    if (typeof cursor['updatedAt'] !== 'string' || Number.isNaN(Date.parse(cursor['updatedAt']))
      || typeof cursor['taskId'] !== 'string' || !UUID_PATTERN.test(cursor['taskId'])) {
      throw new Error('invalid cursor fields');
    }
    return { updatedAt: cursor['updatedAt'], taskId: cursor['taskId'] };
  } catch {
    throw new A2aProtocolError(400, 'INVALID_CURSOR', 'cursor is malformed');
  }
}

export interface ServerOptions {
  store: TaskStore;
  publicUrl: string;
  discoveryToken?: string;
  executor?: InvestigationExecutor;
}

export function createArgusAiopsServer(options: ServerOptions) {
  const authorized = (req: IncomingMessage): boolean => {
    if (!options.discoveryToken) return true;
    const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
    return Boolean(match && secretMatches(match[1]!, options.discoveryToken));
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', options.publicUrl);
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') {
        json(res, 200, { status: 'ok', pack: 'argus.aiops', version: ARGUS_AIOPS_PACK_MANIFEST.metadata.version });
        return;
      }
      if (!authorized(req)) throw new A2aProtocolError(401, 'UNAUTHENTICATED', 'invalid Pack service credential');
      if (req.method === 'GET' && url.pathname === '/readyz') {
        const ready = await options.store.ready();
        json(res, ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready', persistence: ready });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/.well-known/argus-solution-pack.yaml') {
        json(res, 200, ARGUS_AIOPS_PACK_MANIFEST, 'application/yaml; charset=utf-8');
        return;
      }
      if (req.method === 'GET' && url.pathname === A2A_AGENT_CARD_PATH) {
        a2aJson(res, 200, buildArgusAiopsAgentCard(options.publicUrl, Boolean(options.discoveryToken)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/tasks') {
        const page = await options.store.list(
          parseTaskListLimit(url.searchParams.get('limit')),
          decodeTaskCursor(url.searchParams.get('cursor')),
        );
        a2aJson(res, 200, {
          tasks: page.items,
          nextCursor: page.nextCursor ? encodeTaskCursor(page.nextCursor) : null,
        });
        return;
      }
      const taskMatch = TASK_PATH.exec(url.pathname);
      if (taskMatch && req.method === 'GET' && !taskMatch[2]) {
        const task = await options.store.get(taskMatch[1]!);
        if (!task) throw new A2aProtocolError(404, 'TASK_NOT_FOUND', 'task not found');
        a2aJson(res, 200, task);
        return;
      }
      if (taskMatch && req.method === 'POST' && taskMatch[2] === ':cancel') {
        a2aJson(res, 200, await cancelA2aTask(options.store, taskMatch[1]!));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/message:send') {
        if (String(req.headers['a2a-version'] ?? '') !== A2A_VERSION) {
          throw new A2aProtocolError(400, 'VERSION_NOT_SUPPORTED', `A2A-Version ${A2A_VERSION} is required`);
        }
        if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith(A2A_CONTENT_TYPE)) {
          throw new A2aProtocolError(415, 'CONTENT_TYPE_NOT_SUPPORTED', `Content-Type must be ${A2A_CONTENT_TYPE}`);
        }
        const task = await sendA2aMessage(options.store, await readJson(req), {
          executionGrant: String(req.headers['x-argus-execution-grant'] ?? ''),
          rootTraceId: String(req.headers['x-argus-root-trace-id'] ?? ''),
        }, options.executor);
        a2aJson(res, 200, { task });
        return;
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (cause) {
      const error = cause instanceof A2aProtocolError
        ? cause
        : new A2aProtocolError(500, 'INTERNAL_ERROR', cause instanceof Error ? cause.message : 'internal error');
      a2aJson(res, error.status, a2aErrorBody(error));
    }
  });
}

export async function startServer(): Promise<void> {
  const port = Number.parseInt(process.env['PORT'] ?? '2030', 10);
  const publicUrl = process.env['ARGUS_A2A_PUBLIC_URL'] ?? `http://localhost:${port}`;
  const pool = new Pool({
    connectionString: process.env['POSTGRES_CONNECTION_URL'] ?? 'postgresql://aiops:aiops123@localhost:5432/aiops',
    max: 5,
  });
  const store = new PostgresTaskStore(pool);
  await store.setup();
  const core = new ArgusCoreClient({
    baseUrl: process.env['ARGUS_URL'] ?? 'http://mcp-server:3000',
    timeoutMs: Number.parseInt(process.env['ARGUS_CORE_AGENT_TIMEOUT_MS'] ?? '300000', 10),
  });
  const executor = new InvestigationRunner(store, core);
  const discoveryToken = readDiscoveryToken(process.env['ARGUS_PACK_DISCOVERY_TOKEN_FILE'] ?? '');
  const server = createArgusAiopsServer({ store, publicUrl, discoveryToken, executor });
  server.listen(port, '0.0.0.0', () => {
    console.log(JSON.stringify({ level: 'info', service: 'argus-aiops', message: 'server started', port }));
  });
  const shutdown = () => server.close(() => pool.end().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) {
  startServer().catch(cause => {
    console.error(cause);
    process.exit(1);
  });
}
