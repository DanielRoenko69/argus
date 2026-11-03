import type { Request, Response } from 'express';
import type pg from 'pg';
import { createExecutionGrantMiddleware, narrowExecutionGrantTools } from '../executionGrantMiddleware.js';
import { signExecutionGrant, type ExecutionGrantClaims } from '../../solutionPacks/executionGrant.js';

const boundarySecret = 'x'.repeat(32);

function boundaryClaims(executionSurface?: 'agent' | 'runtime_mcp'): ExecutionGrantClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    jti: 'aa8fb9d8-bbef-482f-85e8-bad80f7c8675',
    iss: 'argus.core',
    aud: 'argus.dev',
    agent: 'coding-orchestrator',
    sub: 'user:7',
    principalKind: 'user',
    principalId: '7',
    bundleIds: [3],
    coreAgentIds: [42],
    coreAgents: [{ name: 'coder', id: 42 }],
    messageId: 'message-42',
    rootTraceId: 'f02a848e-9b3d-4c61-956f-00fd4d6dd37c',
    ...(executionSurface ? { executionSurface } : {}),
    policy: 'mcp-bundle-v1',
    iat: now - 1,
    exp: now + 600,
  };
}

function run(path: string, headers: Record<string, string> = {}): { nexted: boolean; status: number | null; body: unknown } {
  const middleware = createExecutionGrantMiddleware(null, boundarySecret);
  let nexted = false;
  let status: number | null = null;
  let body: unknown;
  const req = {
    path,
    headers: { authorization: 'Bearer eg_v1.payload.signature', ...headers },
  } as unknown as Request;
  const res = {
    status: (code: number) => { status = code; return res; },
    json: (value: unknown) => { body = value; return res; },
  } as unknown as Response;
  middleware(req, res, () => { nexted = true; });
  return { nexted, status, body };
}

describe('execution grant endpoint boundary', () => {
  it('lets the bundle-scoped Git credential route validate the grant itself', () => {
    const grant = boundaryClaims();
    expect(run('/api/internal/bundle-creds/3/git', {
      authorization: `Bearer ${signExecutionGrant(boundarySecret, grant)}`,
      'x-argus-root-trace-id': grant.rootTraceId,
    })).toEqual({
      nexted: true,
      status: null,
      body: undefined,
    });
  });

  it('rejects a runtime-MCP grant before the bundle credential route can resolve it', () => {
    const grant = boundaryClaims('runtime_mcp');
    const result = run('/api/internal/bundle-creds/3/git', {
      authorization: `Bearer ${signExecutionGrant(boundarySecret, grant)}`,
      'x-argus-root-trace-id': grant.rootTraceId,
    });
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body).toEqual(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
  });

  it.each([
    '/api/internal/agent-ids',
    '/api/internal/bundle-creds/not-a-number/git',
    '/api/internal/bundle-creds/3/other',
  ])('continues to reject an execution grant on %s', path => {
    const result = run(path);
    expect(result.nexted).toBe(false);
    expect(result.status).toBe(403);
    expect(result.body).toEqual(expect.objectContaining({ code: 'execution_grant_not_allowed' }));
  });
});

describe('execution grant tool scope', () => {
  const secret = 'test-execution-grant-secret-value-123456789';

  function claims(workspaceRoot?: string): ExecutionGrantClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      jti: '48b965a2-7888-4bd2-999b-132571107d82',
      iss: 'argus.core',
      aud: 'argus.aiops',
      agent: 'incident-orchestrator',
      sub: 'user:1',
      principalKind: 'user',
      principalId: '1',
      bundleIds: [28],
      coreAgentIds: [2],
      coreAgents: [{ name: 'researcher', id: 2 }],
      messageId: 'message-1',
      rootTraceId: 'ad7c7498-cdb5-4ac0-9cf5-9ecbe6601a4a',
      ...(workspaceRoot ? { workspaceRoot } : {}),
      policy: 'mcp-bundle-v1',
      iat: now - 1,
      exp: now + 600,
    };
  }

  async function authenticate(grantClaims: ExecutionGrantClaims): Promise<Request & { allowedTools?: string[] }> {
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM argus_execution_grants')) return { rows: [{ status: 'active' }] };
        if (sql.includes('WITH dynamic_candidates')) return { rows: [{ name: 'aiops_prometheus_query' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const req = {
      path: '/api/agents/2/chat',
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grantClaims)}`,
        'x-argus-root-trace-id': grantClaims.rootTraceId,
      },
    } as unknown as Request & { allowedTools?: string[] };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as unknown as Response;
    const next = jest.fn();
    await createExecutionGrantMiddleware(pool, secret)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    return req;
  }

  it('exposes only exact bundle tools to an observe-only pack', async () => {
    const req = await authenticate({ ...claims(), tenantKey: 'acme', workspaceKey: 'payments' });
    expect(req.allowedTools).toEqual(['aiops_prometheus_query']);
    expect(req.allowedTools).not.toContain('workspace_exec');
    expect((req as unknown as { tenantKey?: string }).tenantKey).toBe('acme');
    expect((req as unknown as { workspaceKey?: string }).workspaceKey).toBe('payments');
  });

  it('intersects bundle tools with the signed profile tool allowlist', async () => {
    const req = await authenticate({ ...claims(), toolNames: [] });
    expect(req.allowedTools).toEqual([]);
  });

  it('adds fixed Core workspace tools only for a workspace-bound coding grant', async () => {
    const req = await authenticate(claims('/workspace/argus-dev-task'));
    expect(req.allowedTools).toEqual([
      'aiops_prometheus_query',
      'workspace_exec',
      'workspace_ls',
      'workspace_read',
      'workspace_write',
    ]);
  });
});

describe('per-agent execution grant subset', () => {
  const granted = ['aiops_prometheus_query', 'argus_observe_search_logs', 'rag_operations', 'workspace_read'];

  it('can narrow a bundle catalog by role without adding tools', () => {
    expect(narrowExecutionGrantTools(granted, ['aiops_*', 'argus_observe_*'])).toEqual([
      'aiops_prometheus_query',
      'argus_observe_search_logs',
    ]);
    expect(narrowExecutionGrantTools(granted, ['not_in_grant'])).toEqual([]);
  });

  it('supports an intentionally tool-free reviewer', () => {
    expect(narrowExecutionGrantTools(granted, [])).toEqual([]);
  });
});

describe('managed runtime MCP lease boundary', () => {
  const secret = 'test-execution-grant-secret-value-123456789';
  const leaseId = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';

  function claims(): ExecutionGrantClaims {
    const now = Math.floor(Date.now() / 1000);
    return {
      v: 1,
      jti: '9d9e7f3b-4745-405a-83ec-91f3988f9ae4',
      iss: 'argus.core',
      aud: 'argus.hermes',
      agent: 'hermes-http',
      sub: 'user:7',
      principalKind: 'user',
      principalId: '7',
      bundleIds: [3],
      coreAgentIds: [42],
      coreAgents: [{ name: 'coder', id: 42 }],
      messageId: 'message-42',
      rootTraceId: 'ab5513cf-5a7b-4c64-a235-2998c836766b',
      workspaceRoot: '/workspace/managed-hermes',
      workspaceAccess: 'write',
      executionSurface: 'runtime_mcp',
      policy: 'mcp-bundle-v1',
      iat: now - 1,
      exp: now + 600,
    };
  }

  function activeLease(grant: ExecutionGrantClaims) {
    return {
      lease_id: leaseId,
      execution_grant_id: grant.jti,
      pack_id: grant.aud,
      adapter_id: 'hermes-http',
      core_agent_id: 42,
      run_id: '950610b9-97b4-41cb-908f-46cc80bd22a2',
      request_id: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd',
      root_trace_id: grant.rootTraceId,
      mode: 'managed',
      status: 'active',
      issued_at: new Date(),
      activated_at: new Date(),
      expires_at: new Date(Date.now() + 300_000),
      revoked_at: null,
      terminal_at: null,
      agent_name: 'coder',
    };
  }

  it('opens only the dedicated lease route and adds only the signed workspace subset', async () => {
    const grant = claims();
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM argus_execution_grants')) return { rows: [{ status: 'active' }] };
        if (sql.includes('FROM argus_runtime_mcp_leases')) return { rows: [activeLease(grant)] };
        if (sql.includes('WITH dynamic_candidates')) return { rows: [{ name: 'github_read_issue' }] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const req = {
      path: `/mcp/runtime/${leaseId}`,
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grant)}`,
        'x-argus-root-trace-id': grant.rootTraceId,
      },
    } as unknown as Request & { allowedTools?: string[]; apiKeyScope?: string; runtimeMcpLease?: { agentName: string } };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;
    const next = jest.fn();

    await createExecutionGrantMiddleware(pool, secret)(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.apiKeyScope).toBe('runtime_mcp');
    expect(req.allowedTools).toEqual([
      'github_read_issue',
      'workspace_edit',
      'workspace_ls',
      'workspace_read',
      'workspace_write',
    ]);
    expect(req.allowedTools).not.toContain('workspace_exec');
    expect(req.runtimeMcpLease).toMatchObject({ agentName: 'coder' });
  });

  it('fails closed when a valid grant does not have an active matching runtime lease', async () => {
    const grant = claims();
    const pool = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('FROM argus_execution_grants')) return { rows: [{ status: 'active' }] };
        if (sql.includes('FROM argus_runtime_mcp_leases')) return { rows: [] };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as pg.Pool;
    const req = {
      path: `/mcp/runtime/${leaseId}`,
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grant)}`,
        'x-argus-root-trace-id': grant.rootTraceId,
      },
    } as unknown as Request;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;

    await createExecutionGrantMiddleware(pool, secret)(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'runtime_lease_scope_mismatch' }));
  });

  it('rejects a runtime-MCP grant on an ordinary Core Agent route', async () => {
    const grant = claims();
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const req = {
      path: '/api/agents/42/chat',
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grant)}`,
        'x-argus-root-trace-id': grant.rootTraceId,
      },
    } as unknown as Request;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;

    await createExecutionGrantMiddleware(pool, secret)(req, res, jest.fn());

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
  });

  it('rejects a legacy Agent-surface grant on the runtime lease route', async () => {
    const grant = { ...claims(), executionSurface: undefined };
    const pool = { query: jest.fn() } as unknown as pg.Pool;
    const req = {
      path: `/mcp/runtime/${leaseId}`,
      headers: {
        authorization: `Bearer ${signExecutionGrant(secret, grant)}`,
        'x-argus-root-trace-id': grant.rootTraceId,
      },
    } as unknown as Request;
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response;

    await createExecutionGrantMiddleware(pool, secret)(req, res, jest.fn());

    expect(pool.query).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'execution_grant_scope_mismatch' }));
  });
});
