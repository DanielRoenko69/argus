import { describe, expect, it, jest } from '@jest/globals';
import type { ExecutionGrantClaims, ExecutionGrantIssueInput, IssuedExecutionGrant } from '../executionGrant.js';
import type { ManagedRuntimeRunStatusResult } from '../runtimeAdapterClient.js';
import {
  ExplicitManagedRuntimeReadOnlyPolicy,
  ManagedRuntimeCoordinator,
  type ManagedRuntimeAdapterGateway,
  type ManagedRuntimeGrantIssuer,
  type ManagedRuntimeLaunchInput,
  type ManagedRuntimeLeaseGateway,
} from '../managedRuntimeCoordinator.js';
import type { RuntimeMcpLease } from '../runtimeMcpLeases.js';

const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
const rootTraceId = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
const messageId = '2f5c6a21-854a-4573-b3e7-8c74f91a43e3';
const requestId = 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd';
const leaseId = '81d84476-b44e-4bb3-9d10-9f44ec04d4f1';

const claims: ExecutionGrantClaims = {
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
  coreAgents: [{ id: 42, name: 'planner' }],
  messageId,
  rootTraceId,
  workspaceRoot: '/workspace/ARGUS-42',
  workspaceAccess: 'write',
  executionSurface: 'runtime_mcp',
  policy: 'mcp-bundle-v1',
  iat: 1_788_100_000,
  exp: 1_788_100_900,
};

function lease(overrides: Partial<RuntimeMcpLease> = {}): RuntimeMcpLease {
  return {
    leaseId,
    executionGrantId: claims.jti,
    packId: 'argus.hermes',
    adapterId: 'hermes-http',
    coreAgentId: 42,
    runId,
    requestId,
    rootTraceId,
    mode: 'managed',
    status: 'pending',
    issuedAt: '2026-08-30T14:00:00.000Z',
    activatedAt: null,
    expiresAt: '2026-08-30T14:15:00.000Z',
    revokedAt: null,
    terminalAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<ManagedRuntimeLaunchInput> = {}): ManagedRuntimeLaunchInput {
  return {
    packId: 'argus.hermes',
    adapterId: 'hermes-http',
    requestId,
    coreAgentName: 'planner',
    principal: { kind: 'user', id: '7', allowedBundleIds: [3] },
    bundleIds: [3],
    workspace: { root: '/workspace/ARGUS-42', access: 'write' },
    input: { text: 'Summarize the selected repository evidence.' },
    limits: { deadlineSeconds: 600, maxToolCalls: 16, maxOutputBytes: 64_000 },
    ...overrides,
  };
}

function setup(options: {
  existing?: RuntimeMcpLease | null;
  capabilityState?: 'ready' | 'unavailable';
  startError?: Error;
  statusError?: Error;
} = {}) {
  const calls: string[] = [];
  const issued: IssuedExecutionGrant = { token: 'eg_v1.redactedpayload.redactedsignature', claims };
  const grants: ManagedRuntimeGrantIssuer = {
    issueWithClaims: jest.fn(async (request: ExecutionGrantIssueInput) => {
      calls.push('grant');
      expect(request).toMatchObject({
        executionSurface: 'runtime_mcp',
        coreAgentNames: ['planner'],
        workspaceRoot: '/workspace/ARGUS-42',
        workspaceAccess: 'write',
      });
      return issued;
    }),
  };
  const leases: ManagedRuntimeLeaseGateway = {
    getByRequest: jest.fn(async () => options.existing ?? null),
    getByRun: jest.fn(async () => options.existing ?? lease({ status: 'active', activatedAt: '2026-08-30T14:00:01.000Z' })),
    listByPrincipal: jest.fn(async () => [options.existing ?? lease({ status: 'active', activatedAt: '2026-08-30T14:00:01.000Z' })]),
    createPending: jest.fn(async request => {
      calls.push('pending');
      expect(request).toMatchObject({ claims, coreAgentId: 42, runId, requestId });
      return lease();
    }),
    activate: jest.fn(async () => {
      calls.push('activate');
      return lease({ status: 'active', activatedAt: '2026-08-30T14:00:01.000Z' });
    }),
    complete: jest.fn(async () => {
      calls.push('complete');
      return lease({ status: 'completed', terminalAt: '2026-08-30T14:00:04.000Z' });
    }),
    fail: jest.fn(async () => {
      calls.push('fail');
      return lease({ status: 'failed', terminalAt: '2026-08-30T14:00:02.000Z' });
    }),
    beginRevocation: jest.fn(async () => {
      calls.push('revoking');
      return lease({ status: 'revoking' });
    }),
    revoke: jest.fn(async () => lease({ status: 'revoked' })),
  };
  const adapter: ManagedRuntimeAdapterGateway = {
    getCapabilities: jest.fn(async () => ({
      adapter: {
        id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' as const,
        endpoint: '/runtime/v1', modes: ['managed'] as Array<'managed'>,
        capabilities: ['runs', 'mcp-fabric', 'cancel', 'events-sse'],
      },
      capabilities: {
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' as const },
        modes: ['managed'] as Array<'managed'>,
        capabilities: ['runs', 'mcp-fabric', 'cancel', 'events-sse'],
      },
    })),
    getStatus: jest.fn(async () => ({
      adapter: {
        id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' as const,
        endpoint: '/runtime/v1', modes: ['managed'] as Array<'managed'>,
        capabilities: ['runs', 'mcp-fabric'],
      },
      status: {
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' as const },
        state: options.capabilityState ?? 'ready',
        modes: [{ mode: 'managed' as const, state: options.capabilityState ?? 'ready' }],
      },
    })),
    startManagedRun: jest.fn(async (request: Parameters<ManagedRuntimeAdapterGateway['startManagedRun']>[0]) => {
      calls.push('start');
      if (options.startError) throw options.startError;
      return {
        apiVersion: 'argus-runtime-v1alpha1' as const,
        run: {
          id: request.run.id,
          mode: 'managed' as const,
          rootTraceId: request.run.rootTraceId,
          state: 'queued' as const,
          acceptedAt: '2026-08-30T14:00:01.000Z',
          updatedAt: '2026-08-30T14:00:01.000Z',
        },
      };
    }),
    getManagedRunStatus: jest.fn(async () => {
      if (options.statusError) throw options.statusError;
      return {
        apiVersion: 'argus-runtime-v1alpha1' as const,
        run: {
          id: runId, mode: 'managed' as const, rootTraceId, state: 'running' as const,
          acceptedAt: '2026-08-30T14:00:01.000Z', updatedAt: '2026-08-30T14:00:02.000Z',
        },
      };
    }),
    getManagedRunEvents: jest.fn(async () => ({
      events: [{
        apiVersion: 'argus-runtime-v1alpha1' as const,
        eventId: 'event-1', sequence: 1, occurredAt: '2026-08-30T14:00:02.000Z',
        run: { id: runId, rootTraceId, state: 'running' as const }, type: 'run.started' as const,
      }],
      lastEventId: 'event-1',
    })),
    cancelManagedRun: jest.fn(async () => {
      calls.push('cancel');
      return {
        apiVersion: 'argus-runtime-v1alpha1' as const,
        run: {
          id: runId, mode: 'managed' as const, rootTraceId, state: 'cancelling' as const,
          acceptedAt: '2026-08-30T14:00:01.000Z', updatedAt: '2026-08-30T14:00:03.000Z',
        },
      };
    }),
  };
  const coordinator = new ManagedRuntimeCoordinator(
    grants,
    leases,
    adapter,
    new ExplicitManagedRuntimeReadOnlyPolicy([3]),
    {
      runtimeMcpOrigin: 'http://mcp-server:3000',
      now: () => new Date('2026-08-30T14:00:00.000Z'),
      randomId: (() => {
        const values = [runId, rootTraceId, messageId, '77b94eb1-c83d-42dd-b66e-17b2981e1b97'];
        return () => values.shift() ?? '77b94eb1-c83d-42dd-b66e-17b2981e1b97';
      })(),
    },
  );
  return { coordinator, grants, leases, adapter, calls };
}

describe('ManagedRuntimeCoordinator', () => {
  it('activates the exact runtime-only lease before handing the grant to the Pack', async () => {
    const { coordinator, adapter, calls } = setup();
    const result = await coordinator.launch(input());

    expect(calls).toEqual(['grant', 'pending', 'activate', 'start']);
    expect(result).toMatchObject({
      idempotent: false,
      run: { id: runId, rootTraceId, state: 'queued' },
      lease: { leaseId, status: 'active' },
    });
    expect(JSON.stringify(result)).not.toContain('eg_v1.');
    const startInput = (adapter.startManagedRun as jest.Mock).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(startInput).toMatchObject({
      runtimeMcpLease: {
        leaseId,
        endpoint: `http://mcp-server:3000/mcp/runtime/${leaseId}`,
        executionGrant: 'eg_v1.redactedpayload.redactedsignature',
      },
    });
  });

  it('returns an existing lease binding before creating a new grant or contacting the Pack', async () => {
    const { coordinator, grants, adapter } = setup({ existing: lease({ status: 'active', activatedAt: '2026-08-30T14:00:01.000Z' }) });
    const result = await coordinator.launch(input());

    expect(result).toMatchObject({ idempotent: true, run: { id: runId, state: 'running' } });
    expect(grants.issueWithClaims).not.toHaveBeenCalled();
    expect(adapter.startManagedRun).not.toHaveBeenCalled();
  });

  it('fails closed before grant issuance when the adapter is not managed-ready', async () => {
    const { coordinator, grants, leases } = setup({ capabilityState: 'unavailable' });

    await expect(coordinator.launch(input())).rejects.toMatchObject({
      code: 'managed_runtime_not_ready',
    });
    expect(grants.issueWithClaims).not.toHaveBeenCalled();
    expect(leases.createPending).not.toHaveBeenCalled();
  });

  it('requires an explicit Core read-only Bundle policy', async () => {
    const { coordinator, grants } = setup();

    await expect(coordinator.launch(input({ bundleIds: [9], principal: { kind: 'user' as const, id: '7', allowedBundleIds: [9] } }))).rejects.toMatchObject({
      code: 'managed_runtime_read_scope_denied',
    });
    expect(grants.issueWithClaims).not.toHaveBeenCalled();
  });

  it('best-effort cancels and fails the lease when Pack start cannot be confirmed', async () => {
    const { coordinator, leases, adapter, calls } = setup({
      startError: Object.assign(new Error('upstream accidentally reflected eg_v1.should-not-leak'), { status: 502, code: 'peer_unavailable' }),
    });

    await expect(coordinator.launch(input())).rejects.toMatchObject({
      code: 'peer_unavailable',
      message: 'managed runtime launch could not be completed',
    });
    expect(calls).toEqual(['grant', 'pending', 'activate', 'start', 'cancel', 'fail']);
    expect(leases.fail).toHaveBeenCalledWith(leaseId);
    expect(JSON.stringify((adapter.cancelManagedRun as jest.Mock).mock.calls)).not.toContain('eg_v1.');
  });

  it('reads normalized Pack lifecycle state through the Core run binding and closes a completed lease', async () => {
    const { coordinator, leases, adapter, calls } = setup();
    const completed: ManagedRuntimeRunStatusResult = {
      apiVersion: 'argus-runtime-v1alpha1',
      run: {
        id: runId, mode: 'managed', rootTraceId, state: 'completed' as const,
        acceptedAt: '2026-08-30T14:00:01.000Z', updatedAt: '2026-08-30T14:00:04.000Z',
      },
    };
    (adapter.getManagedRunStatus as unknown as { mockResolvedValue(value: ManagedRuntimeRunStatusResult): void })
      .mockResolvedValue(completed);

    await expect(coordinator.getStatus({ packId: 'argus.hermes', adapterId: 'hermes-http', runId })).resolves.toMatchObject({
      run: { state: 'completed' }, lease: { status: 'completed' },
    });
    expect(leases.getByRun).toHaveBeenCalledWith(runId, undefined);
    expect(adapter.getManagedRunStatus).toHaveBeenCalledWith({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, rootTraceId,
    });
    expect(calls).toContain('complete');
  });

  it('lists and resolves developer runs only through their server-derived principal', async () => {
    const { coordinator, leases } = setup();
    const principal = {
      kind: 'user' as const,
      id: '7',
      tenantKey: 'acme',
      workspaceKey: 'payments',
    };

    await expect(coordinator.list({
      packId: 'argus.hermes', adapterId: 'hermes-http', principal, limit: 10,
    })).resolves.toEqual([expect.objectContaining({
      run: expect.objectContaining({ id: runId, state: 'running' }),
      lease: expect.objectContaining({ leaseId }),
    })]);
    await coordinator.getStatus({ packId: 'argus.hermes', adapterId: 'hermes-http', runId, principal });

    expect(leases.listByPrincipal).toHaveBeenCalledWith(principal, 'argus.hermes', 'hermes-http', 10);
    expect(leases.getByRun).toHaveBeenLastCalledWith(runId, principal);
  });

  it('terminalizes an active lease when the Pack authoritatively forgot its native run', async () => {
    const missing = Object.assign(new Error('native run is gone'), {
      status: 404,
      code: 'managed_run_not_found',
    });
    const { coordinator, leases } = setup({ statusError: missing });
    const principal = { kind: 'user' as const, id: '7' };

    await expect(coordinator.list({
      packId: 'argus.hermes', adapterId: 'hermes-http', principal, limit: 10,
    })).resolves.toEqual([expect.objectContaining({
      run: expect.objectContaining({ id: runId, state: 'failed' }),
      lease: expect.objectContaining({ status: 'failed' }),
    })]);
    expect(leases.fail).toHaveBeenCalledWith(leaseId);
  });

  it('serves durable terminal state without reopening a dependency on Pack memory', async () => {
    const terminal = lease({ status: 'completed', terminalAt: '2026-08-30T14:00:04.000Z' });
    const { coordinator, adapter } = setup({ existing: terminal });

    await expect(coordinator.getStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId,
    })).resolves.toMatchObject({ run: { state: 'completed' }, lease: { status: 'completed' } });
    await expect(coordinator.cancel({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId,
      requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97',
    })).resolves.toMatchObject({ run: { state: 'completed' }, lease: { status: 'completed' } });
    expect(adapter.getManagedRunStatus).not.toHaveBeenCalled();
    expect(adapter.cancelManagedRun).not.toHaveBeenCalled();
  });

  it('re-reads bounded Pack output for an execution consumer after another observer completed the lease', async () => {
    const terminal = lease({ status: 'completed', terminalAt: '2026-08-30T14:00:04.000Z' });
    const { coordinator, adapter, leases } = setup({ existing: terminal });
    const completed: ManagedRuntimeRunStatusResult = {
      apiVersion: 'argus-runtime-v1alpha1',
      run: {
        id: runId, mode: 'managed', rootTraceId, state: 'completed',
        acceptedAt: '2026-08-30T14:00:01.000Z', updatedAt: '2026-08-30T14:00:04.000Z',
        output: 'Implemented the governed workspace change and added focused tests.',
      },
    };
    (adapter.getManagedRunStatus as unknown as { mockResolvedValue(value: ManagedRuntimeRunStatusResult): void })
      .mockResolvedValue(completed);

    await expect(coordinator.getStatus({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, includeOutput: true,
    })).resolves.toMatchObject({
      run: { state: 'completed', output: completed.run.output },
      lease: { status: 'completed' },
    });

    expect(adapter.getManagedRunStatus).toHaveBeenCalledWith({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, rootTraceId,
    });
    expect(leases.complete).not.toHaveBeenCalled();
  });

  it('revokes Core MCP access before forwarding a Pack cancellation and returns only normalized evidence', async () => {
    const { coordinator, leases, adapter, calls } = setup();
    const result = await coordinator.cancel({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId,
      requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97', reason: 'Operator stopped local smoke test',
    });

    expect(calls).toEqual(['revoking', 'cancel']);
    expect(result).toMatchObject({ run: { state: 'cancelling' }, lease: { status: 'revoking' } });
    expect(leases.beginRevocation).toHaveBeenCalledWith(leaseId);
    expect(adapter.cancelManagedRun).toHaveBeenCalledWith(expect.objectContaining({
      runId, rootTraceId, reason: 'Operator stopped local smoke test',
    }));
    expect(JSON.stringify(result)).not.toContain('eg_v1.');
  });

  it('preserves a native completion that wins the cancellation race after access is closed', async () => {
    const { coordinator, adapter, calls } = setup();
    (adapter.cancelManagedRun as jest.MockedFunction<ManagedRuntimeAdapterGateway['cancelManagedRun']>)
      .mockResolvedValue({
        apiVersion: 'argus-runtime-v1alpha1',
        run: {
          id: runId, mode: 'managed', rootTraceId, state: 'completed',
          acceptedAt: '2026-08-30T14:00:01.000Z', updatedAt: '2026-08-30T14:00:03.000Z',
        },
      });

    await expect(coordinator.cancel({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId,
      requestId: '77b94eb1-c83d-42dd-b66e-17b2981e1b97', reason: 'Stop requested as completion settled',
    })).resolves.toMatchObject({ run: { state: 'completed' }, lease: { status: 'completed' } });
    expect(calls).toEqual(['revoking', 'complete']);
  });

  it('returns Core-validated lifecycle events as a bounded JSON snapshot rather than raw native SSE', async () => {
    const { coordinator, adapter } = setup();
    const result = await coordinator.getEvents({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, after: 'event-0',
    });

    expect(result).toMatchObject({
      run: { id: runId, rootTraceId, state: 'running', eventCursor: 'event-1' },
      events: [{ eventId: 'event-1', type: 'run.started' }], lastEventId: 'event-1',
    });
    expect(adapter.getManagedRunEvents).toHaveBeenCalledWith({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, rootTraceId, after: 'event-0',
    });
    expect(JSON.stringify(result)).not.toContain('eg_v1.');
  });
});
