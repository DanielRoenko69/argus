import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { logger } from '../lib/logger.js';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import type { McpServerResult } from './mcpServer.js';

type RuntimeMcpRequest = Request & ExecutionGrantRequestState;

export interface RuntimeMcpTransportHandlers {
  post: (req: Request, res: Response) => Promise<void>;
  get: (req: Request, res: Response) => Promise<void>;
  delete: (req: Request, res: Response) => Promise<void>;
}

export interface RuntimeMcpTransportOptions {
  /** Builds an MCP server with the lease's strict dynamic/remote tool catalog. */
  createServer: (req: RuntimeMcpRequest) => Promise<McpServerResult>;
}

function runtimeState(req: Request): RuntimeMcpRequest | null {
  const state = req as RuntimeMcpRequest;
  return state.executionGrant && state.runtimeMcpLease ? state : null;
}

/**
 * Unlike the generic API-key identity, runtime sessions bind the *full*
 * grant JTI, opaque lease ID and root trace.  This prevents a session from a
 * neighbouring managed run being resumed with a different scoped grant.
 */
export function runtimeMcpSessionOwner(req: Request): string | null {
  const state = runtimeState(req);
  if (!state) return null;
  return [
    'runtime',
    state.runtimeMcpLease!.lease.leaseId,
    state.executionGrant!.jti,
    state.executionGrant!.rootTraceId,
  ].join(':');
}

function rejectLease(res: Response): void {
  res.status(401).json({
    error: 'an active managed runtime MCP lease is required',
    code: 'runtime_mcp_lease_required',
  });
}

/**
 * Streamable HTTP transport dedicated to a Managed Runtime MCP lease.
 *
 * Authentication and active-lease verification are performed by the global
 * execution-grant middleware on every request. This transport additionally
 * binds each MCP session to the exact lease/JTI/trace triple.
 */
export function createRuntimeMcpTransportHandlers(options: RuntimeMcpTransportOptions): RuntimeMcpTransportHandlers {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const owners = new Map<string, string>();

  const post = async (req: Request, res: Response): Promise<void> => {
    const state = runtimeState(req);
    const owner = runtimeMcpSessionOwner(req);
    if (!state || !owner) {
      rejectLease(res);
      return;
    }
    const lease = state.runtimeMcpLease;
    if (!lease) {
      rejectLease(res);
      return;
    }
    const leaseId = lease.lease.leaseId;
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    try {
      let transport: StreamableHTTPServerTransport;
      if (sessionId && transports.has(sessionId)) {
        if (owners.get(sessionId) !== owner) {
          res.status(403).json({ error: 'MCP runtime session does not belong to this lease', code: 'runtime_mcp_session_mismatch' });
          return;
        }
        transport = transports.get(sessionId)!;
      } else {
        const sessionServer = await options.createServer(state);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            transports.set(id, transport);
            owners.set(id, owner);
            logger.info({ leaseId, sessionId: id }, 'Managed runtime MCP session initialized');
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
            owners.delete(transport.sessionId);
            logger.info({ leaseId, sessionId: transport.sessionId }, 'Managed runtime MCP session closed');
          }
        };
        await sessionServer.server.connect(transport);
      }
      await transport.handleRequest(req, res, req.body);
    } catch (cause) {
      logger.error({ err: cause, leaseId }, 'Managed runtime MCP POST failed');
      if (!res.headersSent) res.status(500).json({ error: 'runtime MCP request failed', code: 'runtime_mcp_failed' });
    }
  };

  const resume = async (req: Request, res: Response): Promise<void> => {
    const owner = runtimeMcpSessionOwner(req);
    if (!owner) {
      rejectLease(res);
      return;
    }
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid or missing runtime MCP session ID' });
      return;
    }
    if (owners.get(sessionId) !== owner) {
      res.status(403).json({ error: 'MCP runtime session does not belong to this lease', code: 'runtime_mcp_session_mismatch' });
      return;
    }
    try {
      await transports.get(sessionId)!.handleRequest(req, res);
    } catch (cause) {
      logger.error({ err: cause, sessionId }, 'Managed runtime MCP session request failed');
      if (!res.headersSent) res.status(500).json({ error: 'runtime MCP request failed', code: 'runtime_mcp_failed' });
    }
  };

  return { post, get: resume, delete: resume };
}
