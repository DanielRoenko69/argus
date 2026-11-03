import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { CustomBackendRow } from './customBackends.js';
import { buildAuthHeaders, assertSsrfSafe, findBackendByName } from './customBackends.js';
import { assertServiceCredentialAdapter } from './backendAuthentication.js';
import { sanitizeToolName, sanitizeDescription } from '../tools/dynamic/index.js';
import { Agent } from 'undici';
import { logger } from '../lib/logger.js';
import pg from 'pg';
import {
  reconcileMcpRegistry,
  type McpRegistryEntry,
  type McpTrustStatus,
  type RegistryToolDescriptor,
} from './mcpRegistry.js';

// ── Types ────────────────────────────────────────────────────

export interface RemoteToolInfo {
  name: string;           // original name on remote server
  prefixedName: string;   // namespaced: backendname_toolname
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface RemoteMcpConnection {
  backendId: number;
  backendName: string;
  client: Client;
  transport: StreamableHTTPClientTransport | SSEClientTransport;
  tools: RemoteToolInfo[];
  connected: boolean;
  lastError: string | null;
  lastConnectedAt: Date | null;
  trustStatus: McpTrustStatus;
}

// ── In-memory connection registry ────────────────────────────

const connections = new Map<number, RemoteMcpConnection>();

export function getRemoteConnections(): Map<number, RemoteMcpConnection> {
  return connections;
}

export function getRemoteConnection(backendId: number): RemoteMcpConnection | undefined {
  return connections.get(backendId);
}

export function setRemoteMcpTrustStatus(backendId: number, trustStatus: McpTrustStatus): void {
  const connection = connections.get(backendId);
  if (connection) connection.trustStatus = trustStatus;
}

// ── Tool lookup helpers ──────────────────────────────────────

export function findConnectionForTool(prefixedName: string): RemoteMcpConnection | undefined {
  for (const conn of connections.values()) {
    if (conn.tools.some(t => t.prefixedName === prefixedName)) {
      return conn;
    }
  }
  return undefined;
}

export function getOriginalToolName(prefixedName: string): string | undefined {
  for (const conn of connections.values()) {
    const tool = conn.tools.find(t => t.prefixedName === prefixedName);
    if (tool) return tool.name;
  }
  return undefined;
}

/** Get all remote tools across all connections */
export function getAllRemoteTools(): RemoteToolInfo[] {
  const all: RemoteToolInfo[] = [];
  for (const conn of connections.values()) {
    if (conn.connected && conn.trustStatus !== 'changed' && conn.trustStatus !== 'quarantined') {
      all.push(...conn.tools);
    }
  }
  return all;
}

// ── Tool name prefixing ─────────────────────────────────────

function prefixToolName(backendName: string, toolName: string): string {
  const prefix = backendName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `${prefix}_${toolName}`;
}

// ── Connect to a remote MCP server ──────────────────────────

// audit (gateway resilience): bound how long a single remote-MCP connect/
// discovery may take. Without this, one slow/dead marketplace backend (e.g. a
// supergateway pod still downloading its npx server, or a creds-less server
// that never responds) blocked the whole connect loop and could starve the
// /mcp gateway of ALL tools, including builtins.
const REMOTE_MCP_CONNECT_TIMEOUT_MS = 8000;
const REMOTE_MCP_HEALTH_TIMEOUT_MS = 5000;

/** Reject after `ms` so a slow/dead remote backend can't block the caller. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(`remote MCP timeout after ${ms}ms (${label})`)), ms);
      if (typeof (t as { unref?: () => void }).unref === 'function') (t as { unref: () => void }).unref();
    }),
  ]);
}

export async function connectRemoteMcp(backend: CustomBackendRow): Promise<RemoteMcpConnection> {
  // The registry is shared across users. Delegation requires a per-user session
  // adapter; never put a personal token (or a silent service substitute) here.
  assertServiceCredentialAdapter(backend.id, backend.auth_mode);
  const base = backend.base_url.replace(/\/$/, '');
  const endpoint = backend.mcp_endpoint || '/mcp';
  const transportType = backend.transport_type || 'streamable-http';
  const url = new URL(`${base}${endpoint}`);

  // SECURITY (audit M2): guard the federated backend URL the same way the HTTP
  // tool dispatcher does — without this a backend pointed at 169.254.169.254 /
  // kubernetes.default / other internal hosts would be dialled (SSRF), reachable
  // by anyone who can create a backend.
  assertSsrfSafe(url.toString());

  logger.info({ backend: backend.name, url: url.toString(), transport: transportType }, 'Connecting to remote MCP server');

  const client = new Client(
    { name: 'ai-ops-gateway', version: '1.0.0' },
    { capabilities: {} },
  );

  // Build auth headers from backend config
  const headers = buildAuthHeaders(backend);
  // M1/M4: block tls_skip_verify in production, warn otherwise
  if (backend.tls_skip_verify) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({ backend: backend.name }, 'tls_skip_verify=true is not allowed in production — aborting MCP connection');
      throw new Error(`Backend '${backend.name}': TLS verification cannot be disabled in production.`);
    }
    logger.warn(
      { backend: backend.name, url: url.toString() },
      'TLS certificate verification DISABLED for remote MCP backend — MITM attacks possible. Only use in trusted networks.',
    );
  }
  const dispatcher = backend.tls_skip_verify
    ? new Agent({ connect: { rejectUnauthorized: false } })
    : undefined;
  const requestInit: RequestInit & { dispatcher?: Agent } = {
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };
  const hasRequestInit = Object.keys(requestInit).length > 0;

  let transport: StreamableHTTPClientTransport | SSEClientTransport;

  if (transportType === 'sse') {
    transport = new SSEClientTransport(url, {
      requestInit: hasRequestInit ? (requestInit as RequestInit) : undefined,
    });
  } else {
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: hasRequestInit ? (requestInit as RequestInit) : undefined,
    });
  }

  const conn: RemoteMcpConnection = {
    backendId: backend.id,
    backendName: backend.name,
    client,
    transport,
    tools: [],
    connected: false,
    lastError: null,
    lastConnectedAt: null,
    trustStatus: 'unverified',
  };

  try {
    await withTimeout(client.connect(transport), REMOTE_MCP_CONNECT_TIMEOUT_MS, `connect ${backend.name}`);
    conn.connected = true;
    conn.lastConnectedAt = new Date();

    // Discover tools (also time-bounded)
    conn.tools = await withTimeout(discoverTools(client, backend.name), REMOTE_MCP_CONNECT_TIMEOUT_MS, `discover ${backend.name}`);

    logger.info({
      backend: backend.name,
      toolCount: conn.tools.length,
      tools: conn.tools.map(t => t.prefixedName),
    }, 'Remote MCP server connected, tools discovered');
  } catch (err) {
    conn.connected = false;
    conn.lastError = err instanceof Error ? err.message : String(err);
    // Free the (possibly still-pending) transport so a timed-out connect can't
    // leak the socket / keep the npx child alive.
    try { await client.close(); } catch { /* ignore */ }
    logger.error({ err, backend: backend.name }, 'Failed to connect to remote MCP server');
  }

  connections.set(backend.id, conn);
  return conn;
}

// ── Tool discovery ──────────────────────────────────────────

async function discoverTools(client: Client, backendName: string): Promise<RemoteToolInfo[]> {
  const result = await client.listTools();
  return result.tools.map(tool => ({
    // H2: sanitize remote-sourced strings before they reach the LLM (prompt injection prevention)
    name: sanitizeToolName(tool.name),
    prefixedName: prefixToolName(backendName, sanitizeToolName(tool.name)),
    description: sanitizeDescription(tool.description || ''),
    inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
  }));
}

// ── Execute a tool on a remote server ───────────────────────

export async function executeRemoteTool(
  prefixedName: string,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const conn = findConnectionForTool(prefixedName);
  if (!conn) {
    return {
      content: [{ type: 'text', text: `No remote MCP connection found for tool '${prefixedName}'` }],
      isError: true,
    };
  }

  if (!conn.connected) {
    return {
      content: [{ type: 'text', text: `Remote MCP server '${conn.backendName}' is disconnected: ${conn.lastError}` }],
      isError: true,
    };
  }

  if (conn.trustStatus === 'changed' || conn.trustStatus === 'quarantined') {
    return {
      content: [{
        type: 'text',
        text: `Remote MCP server '${conn.backendName}' is ${conn.trustStatus}; an administrator must review its tool catalog before execution.`,
      }],
      isError: true,
    };
  }

  const originalName = getOriginalToolName(prefixedName);
  if (!originalName) {
    return {
      content: [{ type: 'text', text: `Could not resolve original tool name for '${prefixedName}'` }],
      isError: true,
    };
  }

  try {
    const backend = findBackendByName(conn.backendName);
    if (!backend) throw new Error('Remote backend is disabled or unavailable');
    assertServiceCredentialAdapter(backend.id, backend.auth_mode);
    const result = await conn.client.callTool({ name: originalName, arguments: args });

    if (result.content && Array.isArray(result.content)) {
      return {
        content: result.content.map((c: unknown) => {
          const item = c as Record<string, unknown>;
          if (item.type === 'text') return { type: 'text', text: String(item.text ?? '') };
          return { type: 'text', text: JSON.stringify(item, null, 2) };
        }),
        isError: (result.isError as boolean | undefined) ?? false,
      };
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // audit M4: only mark the WHOLE backend disconnected on a transport/
    // connection-level failure. A per-call tool error (bad args, upstream 500,
    // validation) must NOT disable every other tool of an otherwise-healthy
    // federated server until a manual reconnect.
    if (/\b(econn|etimedout|enotfound|socket|closed|terminated|disconnect|network|fetch failed|transport)\b/i.test(message)) {
      conn.connected = false;
      conn.lastError = message;
    }
    return {
      content: [{ type: 'text', text: `Error calling '${originalName}' on '${conn.backendName}': ${message}` }],
      isError: true,
    };
  }
}

// ── Health check ────────────────────────────────────────────

export async function checkRemoteMcp(backendId: number): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  toolCount: number;
}> {
  const conn = connections.get(backendId);
  if (!conn) {
    return { reachable: false, latencyMs: null, error: 'Not connected', toolCount: 0 };
  }

  try {
    const start = Date.now();
    await withTimeout(conn.client.ping(), REMOTE_MCP_HEALTH_TIMEOUT_MS, `health check ${conn.backendName}`);
    const latencyMs = Date.now() - start;
    return { reachable: true, latencyMs, error: null, toolCount: conn.tools.length };
  } catch (err) {
    conn.connected = false;
    conn.lastError = err instanceof Error ? err.message : String(err);
    return { reachable: false, latencyMs: null, error: conn.lastError, toolCount: conn.tools.length };
  }
}

// ── Refresh tools ───────────────────────────────────────────

export async function refreshRemoteMcpTools(backendId: number): Promise<RemoteToolInfo[]> {
  const conn = connections.get(backendId);
  if (!conn || !conn.connected) {
    throw new Error(`Remote MCP server not connected (backend ${backendId})`);
  }

  const tools = await discoverTools(conn.client, conn.backendName);
  conn.tools = tools;
  logger.info({ backend: conn.backendName, toolCount: tools.length }, 'Remote MCP tools refreshed');
  return tools;
}

// ── Persist discovered tools to DB ──────────────────────────

export async function persistDiscoveredTools(
  pool: pg.Pool,
  backendId: number,
  tools: RemoteToolInfo[],
): Promise<McpRegistryEntry> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previousResult = await client.query<{
      tool_name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>(
      `SELECT tool_name, description, input_schema
       FROM mcp_remote_tools
       WHERE backend_id = $1
       ORDER BY tool_name`,
      [backendId],
    );
    const previousTools: RegistryToolDescriptor[] = previousResult.rows.map(tool => ({
      name: tool.tool_name,
      description: tool.description ?? '',
      inputSchema: tool.input_schema ?? {},
    }));
    const registry = await reconcileMcpRegistry(client, backendId, previousTools, tools);
    await client.query('DELETE FROM mcp_remote_tools WHERE backend_id = $1', [backendId]);
    for (const tool of tools) {
      await client.query(
        `INSERT INTO mcp_remote_tools (backend_id, tool_name, prefixed_name, description, input_schema)
         VALUES ($1, $2, $3, $4, $5)`,
        [backendId, tool.name, tool.prefixedName, tool.description, JSON.stringify(tool.inputSchema)],
      );
    }
    await client.query('COMMIT');
    setRemoteMcpTrustStatus(backendId, registry.trust_status);
    if (registry.trust_status === 'changed' || registry.trust_status === 'quarantined') {
      logger.warn({
        backendId,
        trustStatus: registry.trust_status,
        fingerprint: registry.catalog_fingerprint,
        changes: registry.change_summary,
      }, 'Remote MCP catalog is blocked pending trust review');
    }
    return registry;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Disconnect ──────────────────────────────────────────────

export async function disconnectRemoteMcp(backendId: number): Promise<void> {
  const conn = connections.get(backendId);
  if (!conn) return;

  try {
    await conn.transport.close();
  } catch (err) {
    logger.warn({ err, backend: conn.backendName }, 'Error closing remote MCP connection');
  }
  connections.delete(backendId);
  logger.info({ backend: conn.backendName }, 'Remote MCP connection disconnected');
}

export async function disconnectAllRemoteMcp(): Promise<void> {
  for (const [id] of connections) {
    await disconnectRemoteMcp(id);
  }
}
