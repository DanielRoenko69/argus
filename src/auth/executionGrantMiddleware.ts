import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import {
  assertExecutionGrantActive,
  ExecutionGrantError,
  verifyExecutionGrant,
  executionGrantWorkspaceScope,
  type ExecutionGrantClaims,
} from '../solutionPacks/executionGrant.js';
import {
  RuntimeMcpLeaseError,
  RuntimeMcpLeaseStore,
  type RuntimeMcpLeaseBinding,
} from '../solutionPacks/runtimeMcpLeases.js';
import { withRequestContext } from '../lib/requestContext.js';
import { logger } from '../lib/logger.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { WORKSPACE_TOOLS } from '../tools/workspace.js';
import { isToolAllowedByPatterns } from './apiKeyRbac.js';

export interface ExecutionGrantRequestState {
  executionGrant?: ExecutionGrantClaims;
  apiKeyPrefix?: string;
  allowedBundles?: number[] | null;
  allowedTools?: string[] | null;
  deniedTools?: string[] | null;
  apiKeyScope?: string;
  callingUser?: { id: number; entra_groups: string[] };
  runtimeMcpLease?: RuntimeMcpLeaseBinding;
  tenantKey?: string;
  workspaceKey?: string;
}

function bearer(req: Request): string | null {
  const header = String(req.headers['authorization'] ?? '');
  if (!header.startsWith('Bearer eg_v1.')) return null;
  return header.slice('Bearer '.length);
}

/** A Pack may narrow its signed Bundle catalog per worker, never widen it. */
export function narrowExecutionGrantTools(grantedTools: string[], allowPatterns: string[]): string[] {
  if (allowPatterns.length === 0) return [];
  return grantedTools.filter(tool => isToolAllowedByPatterns({
    allowedTools: allowPatterns,
    deniedTools: null,
    apiKeyPrefix: 'execution_grant_subset',
  }, tool));
}

function isBundleGitCredentialRequest(path: string): boolean {
  return /^\/api\/internal\/bundle-creds\/[1-9]\d*\/git\/?$/.test(path);
}

function runtimeMcpLeaseId(path: string): string | null {
  const match = /^\/mcp\/runtime\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/?$/i.exec(path);
  return match?.[1] ?? null;
}

function fail(res: Response, cause: unknown): void {
  if (cause instanceof ExecutionGrantError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  if (cause instanceof RuntimeMcpLeaseError) {
    res.status(cause.status).json({ error: cause.message, code: cause.code });
    return;
  }
  res.status(401).json({ error: 'invalid execution grant', code: 'invalid_execution_grant' });
}

/**
 * Authenticates the narrow callback surface used by out-of-process Solution
 * Packs. The signed grant is not a general Argus API credential: it is accepted
 * only for the declared Core Agent IDs and carries an exact MCP Bundle scope.
 */
export function createExecutionGrantMiddleware(pool: pg.Pool | null, secret: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = bearer(req);
    if (!token) {
      next();
      return;
    }
    // This single internal endpoint validates the same signed grant itself,
    // including its bundle id, root trace id and revocation state. Let it own
    // that check because credential lookup is bundle-scoped rather than tied
    // to one concrete Core agent. Every other non-agent endpoint remains
    // closed to execution grants.
    if (isBundleGitCredentialRequest(req.path)
      || /^\/api\/internal\/dev-git\/(?:[1-9]\d*\/reference|operate|ci-authorization)\/?$/.test(req.path)) {
      try {
        const rootTraceId = String(req.headers['x-argus-root-trace-id'] ?? '');
        if (!rootTraceId) throw new ExecutionGrantError(401, 'execution_trace_required', 'execution grant requires the bound root trace');
        // Verify the protected surface before delegating bundle-specific
        // validation to the internal credential route. A managed-runtime
        // bearer is never a credential-resolution bearer, even though both
        // paths eventually use the same selected bundle.
        verifyExecutionGrant(secret, token, { rootTraceId, executionSurface: 'agent' });
      } catch (cause) {
        logger.warn({ path: req.path, error: cause instanceof Error ? cause.message : String(cause) }, 'Solution Pack execution grant rejected');
        fail(res, cause);
        return;
      }
      next();
      return;
    }
    const leaseId = runtimeMcpLeaseId(req.path);
    if (!pool || !secret || (!leaseId && !req.path.startsWith('/api/agents/'))) {
      res.status(403).json({ error: 'execution grants are not accepted on this endpoint', code: 'execution_grant_not_allowed' });
      return;
    }
    const agentMatch = /^\/api\/agents\/(\d+)(?:\/|$)/.exec(req.path);
    const coreAgentId = agentMatch ? Number(agentMatch[1]) : undefined;
    if (!leaseId && !coreAgentId) {
      res.status(403).json({ error: 'execution grant requires a concrete Core agent', code: 'execution_grant_not_allowed' });
      return;
    }
    try {
      const rootTraceId = String(req.headers['x-argus-root-trace-id'] ?? '');
      if (!rootTraceId) throw new ExecutionGrantError(401, 'execution_trace_required', 'execution grant requires the bound root trace');
      // The bearer is deliberately single-surface. Runtime grants may reach
      // only the exact lease URL; Agent grants may reach only a concrete Core
      // Agent route. This also keeps old grants Agent-only by construction.
      const claims = verifyExecutionGrant(secret, token, {
        coreAgentId,
        rootTraceId,
        executionSurface: leaseId ? 'runtime_mcp' : 'agent',
      });
      await assertExecutionGrantActive(pool, claims.jti);
      const runtimeMcpLease = leaseId
        ? await new RuntimeMcpLeaseStore(pool).getActiveBinding(leaseId, claims)
        : undefined;
      const state = req as Request & ExecutionGrantRequestState;
      state.executionGrant = claims;
      const workspaceScope = executionGrantWorkspaceScope(claims);
      state.tenantKey = workspaceScope.tenantKey;
      state.workspaceKey = workspaceScope.workspaceKey;
      state.apiKeyPrefix = runtimeMcpLease ? `runtime_${runtimeMcpLease.lease.leaseId.slice(0, 8)}` : `eg_${claims.jti.slice(0, 8)}`;
      if (runtimeMcpLease) state.runtimeMcpLease = runtimeMcpLease;
      state.allowedBundles = claims.bundleIds;
      // A signed Pack grant is an exact capability boundary, not merely an
      // Agent-access check. Resolve the selected Bundle policy now and pass an
      // explicit allowlist into the Agent runner so local workspace, RAG and
      // delegation tools cannot bypass the grant through normal Agent defaults.
      let grantedTools = await loadAllowedToolNames(pool, claims.bundleIds, {
        includeUnscoped: false,
      });
      if (claims.toolNames) {
        const exactProfileTools = new Set(claims.toolNames);
        grantedTools = new Set([...grantedTools].filter(tool => exactProfileTools.has(tool)));
      }
      // Coding packs are the sole exception: their signed grant binds one
      // immutable /workspace root, so Core may add its local workspace tools.
      // Ordinary Agent grants keep the historical full tool set. A managed
      // runtime lease receives only read/list or read/list/write according to
      // the separately signed access claim; workspace_exec is never exposed.
      if (!runtimeMcpLease && claims.workspaceRoot) {
        for (const tool of WORKSPACE_TOOLS) grantedTools.add(tool.function.name);
      } else if (runtimeMcpLease && claims.workspaceRoot && claims.workspaceAccess) {
        grantedTools.add('workspace_ls');
        grantedTools.add('workspace_read');
        if (claims.workspaceAccess === 'write') {
          grantedTools.add('workspace_edit');
          grantedTools.add('workspace_write');
        }
      }
      state.allowedTools = [...grantedTools].sort();
      state.deniedTools = null;
      state.apiKeyScope = runtimeMcpLease ? 'runtime_mcp' : 'agents';
      if (claims.principalKind === 'user' && /^\d+$/.test(claims.principalId)) {
        state.callingUser = { id: Number(claims.principalId), entra_groups: [] };
      }
      const requestContext = state.callingUser
        ? { callingUser: { id: state.callingUser.id, entra_groups: [] } }
        : {};
      withRequestContext(requestContext, () => next());
    } catch (cause) {
      logger.warn({ path: req.path, error: cause instanceof Error ? cause.message : String(cause) }, 'Solution Pack execution grant rejected');
      fail(res, cause);
    }
  };
}
