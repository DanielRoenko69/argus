import { describe, expect, it, jest } from '@jest/globals';
import type {
  AttachedRuntimeLifecycleInput,
  AttachedRuntimeRunResult,
  RuntimeAdapterGateway,
} from '../../solutionPacks/runtimeAdapterClient.js';
import type { ManagedRuntimeLifecycleGateway } from '../../solutionPacks/managedRuntimeCoordinator.js';
import {
  assertAttachedHermesExecutionScope,
  buildAttachedHermesInput,
  buildManagedHermesInput,
  compactManagedHermesTask,
  selectManagedHermesBundleIds,
  HermesRuntimeExecutor,
} from '../hermesRuntimeExecutor.js';
import type { AgentRuntimeAssignment } from '../runtimeProfiles.js';

test('narrows a wider Argus Dev workflow grant to operator-approved read-only Bundles', () => {
  expect(selectManagedHermesBundleIds([212, 161, 212, 213], [161, 999])).toEqual([161]);
  expect(selectManagedHermesBundleIds([212, 213], [161])).toEqual([]);
});

function assignment(overrides: Partial<AgentRuntimeAssignment> = {}): AgentRuntimeAssignment {
  return {
    agent_id: 7, agent_name: 'hermes-chat', runtime_type: 'hermes', profile_id: 12,
    profile_name: 'hermes-attached-local', profile_label: 'Hermes · Existing service',
    auth_mode: 'runtime_adapter', auth_ref: 'argus.hermes/hermes-http', model: 'hermes-upstream',
    reasoning_effort: null, code_context_mode: 'metadata_only', code_context_max_results: 4,
    code_context_max_bytes: 12000, max_concurrent_runs: 1, profile_enabled: true,
    adapter_pack_id: 'argus.hermes', adapter_id: 'hermes-http', execution_strategy: 'attached',
    adapter_credential_ref: 'pack-service-token', native_profile_ref: null, workspace_policy: 'context_only',
    memory_policy: 'none', native_tool_policy: 'external_attested', session_policy: 'clean', adapter_config: {},
    ...overrides,
  };
}

function adapterRun(state: 'queued' | 'running' | 'awaiting_approval' | 'completed' | 'failed', output?: string) {
  return {
    apiVersion: 'argus-runtime-v1alpha1' as const,
    trust: 'external_attested' as const,
    governance: { coreMcpLease: false as const, nativeToolsExternallyGoverned: true as const },
    run: {
      id: 'hermes-run-1', mode: 'attached' as const, state,
      updatedAt: new Date().toISOString(), ...(output === undefined ? {} : { output }),
    },
  };
}

describe('HermesRuntimeExecutor', () => {
  it('builds a bounded, explicit external trust envelope', () => {
    const input = buildAttachedHermesInput('Be concise.', 'Explain the run.');
    expect(input).toContain('Be concise.');
    expect(input).toContain('Explain the run.');
    expect(input).toContain('externally attested, not Argus-governed');
    expect(buildAttachedHermesInput('x'.repeat(20_000), 'y'.repeat(60_000)).length).toBeLessThan(61_000);
  });

  it('builds a managed Dev envelope without transferring workflow or Git ownership', () => {
    const input = buildManagedHermesInput('Implement carefully.', 'Fix the parser.', '/workspace/ARGUS-42', 'write', {
      context: '<argus_workspace_memory>accepted fact</argus_workspace_memory>',
      allowProposals: true,
    });
    expect(input).toContain('/workspace/ARGUS-42');
    expect(input).toContain('Argus Dev owns those governed stages');
    expect(input).toContain('Native shell, filesystem, browser, network, memory and package installation are disabled');
    expect(input).toContain('prefer workspace_edit');
    expect(input).toContain('Use workspace_write only for new files');
    expect(input).toContain('accepted fact');
    expect(input).toContain('<argus_memory_proposal>');
    expect(input).toContain('remain inactive until Argus accepts them');
  });

  it('keeps task invariants and latest retry evidence when managed input is compacted', () => {
    const task = `TICKET_INVARIANT\n${'middle context\n'.repeat(5_000)}LATEST_RETRY_FAILURE`;
    const compacted = compactManagedHermesTask(task);
    expect(compacted.length).toBe(48_000);
    expect(compacted).toContain('TICKET_INVARIANT');
    expect(compacted).toContain('LATEST_RETRY_FAILURE');
    expect(compacted).toContain('omitted non-essential middle context');
  });

  it('permits plain chat but rejects Core-scoped or mutating execution shapes', () => {
    const chat = {
      agentMode: 'chat' as const,
      hasTechnicalIdentityToolPolicy: false,
      hasExecutionBundleOverride: false,
      hasToolAllowlist: false,
      hasImages: false,
      isConversationBranchOperation: false,
    };
    expect(() => assertAttachedHermesExecutionScope(chat)).not.toThrow();
    expect(() => assertAttachedHermesExecutionScope({ ...chat, agentMode: 'worker' })).toThrow('Managed Hermes');
    expect(() => assertAttachedHermesExecutionScope({ ...chat, hasToolAllowlist: true })).toThrow('Core-scoped tools');
    expect(() => assertAttachedHermesExecutionScope({ ...chat, hasImages: true })).toThrow('image attachments');
  });

  it('probes the declared attached mode without claiming Core governance', async () => {
    const gateway = {
      getCapabilities: jest.fn(async () => ({
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime', modes: ['attached'], capabilities: ['runs'] },
        capabilities: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, modes: ['attached'], capabilities: ['runs'] },
      })),
      getStatus: jest.fn(async () => ({
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime', modes: ['attached'], capabilities: ['runs'] },
        status: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, state: 'ready', modes: [{ mode: 'attached', state: 'ready' }] },
      })),
    } as unknown as RuntimeAdapterGateway;

    await expect(new HermesRuntimeExecutor(gateway).readiness(assignment())).resolves.toMatchObject({
      enabled: true, authenticated: true, trust: 'external_attested', maxConcurrentRuns: 1,
    });
  });

  it('normalizes an attached run and preserves only bounded output and usage', async () => {
    const getAttachedRunStatus = jest.fn<
      (input: AttachedRuntimeLifecycleInput) => Promise<AttachedRuntimeRunResult>
    >()
      .mockResolvedValueOnce(adapterRun('running'))
      .mockResolvedValueOnce({
        ...adapterRun('completed', 'Hermes answer'),
        run: { ...adapterRun('completed', 'Hermes answer').run, usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } },
      });
    const gateway = {
      getCapabilities: jest.fn(), getStatus: jest.fn(),
      startAttachedRun: jest.fn(async () => adapterRun('queued')),
      getAttachedRunStatus,
      stopAttachedRun: jest.fn(),
    } as unknown as RuntimeAdapterGateway;
    const executor = new HermesRuntimeExecutor(gateway, { pollIntervalMs: 10, timeoutMs: 2_000 });

    await expect(executor.execute(assignment(), { text: 'hello' })).resolves.toEqual({
      output: 'Hermes answer', externalRunId: 'hermes-run-1', trust: 'external_attested',
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    expect(getAttachedRunStatus).toHaveBeenCalledTimes(2);
  });

  it('stops and fails closed when attached Hermes requests native approval', async () => {
    const stopAttachedRun = jest.fn<
      (input: AttachedRuntimeLifecycleInput) => Promise<AttachedRuntimeRunResult>
    >(async () => adapterRun('failed'));
    const gateway = {
      getCapabilities: jest.fn(), getStatus: jest.fn(),
      startAttachedRun: jest.fn(async () => adapterRun('awaiting_approval')),
      getAttachedRunStatus: jest.fn(), stopAttachedRun,
    } as unknown as RuntimeAdapterGateway;

    await expect(new HermesRuntimeExecutor(gateway).execute(assignment(), { text: 'write it' }))
      .rejects.toThrow('use Managed Hermes');
    expect(stopAttachedRun).toHaveBeenCalledWith({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId: 'hermes-run-1',
    });
  });

  it('rejects widened attached policies before contacting the Pack', async () => {
    const gateway = { getCapabilities: jest.fn(), getStatus: jest.fn() } as unknown as RuntimeAdapterGateway;
    await expect(new HermesRuntimeExecutor(gateway).readiness(assignment({ workspace_policy: 'checkout' })))
      .rejects.toThrow('context_only');
    expect(gateway.getStatus).not.toHaveBeenCalled();
  });

  it('runs a managed worker through the Core coordinator and returns its bounded output', async () => {
    const gateway = {
      getCapabilities: jest.fn(async () => ({
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime', modes: ['managed'], capabilities: ['runs', 'mcp-fabric'] },
        capabilities: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, modes: ['managed'], capabilities: ['runs', 'mcp-fabric'] },
      })),
      getStatus: jest.fn(async () => ({
        adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1', endpoint: '/runtime', modes: ['managed'], capabilities: ['runs', 'mcp-fabric'] },
        status: { adapter: { id: 'hermes-http', runtime: 'hermes', protocol: 'argus-runtime-v1alpha1' }, state: 'ready', modes: [{ mode: 'managed', state: 'ready' }] },
      })),
    } as unknown as RuntimeAdapterGateway;
    const runId = '950610b9-97b4-41cb-908f-46cc80bd22a2';
    const rootTraceId = 'ab5513cf-5a7b-4c64-a235-2998c836766b';
    const lease = {
      leaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1', packId: 'argus.hermes', adapterId: 'hermes-http',
      coreAgentId: 7, runId, requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd', rootTraceId,
      mode: 'managed' as const, status: 'active' as const, issuedAt: '2026-09-01T10:00:00.000Z',
      activatedAt: '2026-09-01T10:00:00.000Z', expiresAt: '2026-09-01T10:10:00.000Z',
      revokedAt: null, terminalAt: null,
    };
    const managed = {
      launch: jest.fn(async () => ({
        idempotent: false,
        run: { id: runId, mode: 'managed' as const, rootTraceId, state: 'queued' as const, acceptedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' },
        lease,
      })),
      getStatus: jest.fn(async () => ({
        run: {
          id: runId, mode: 'managed' as const, rootTraceId, state: 'completed' as const,
          acceptedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:01.000Z',
          output: '- src/parser.ts',
          usage: {
            inputTokens: 120, outputTokens: 30, totalTokens: 150,
            cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
          },
        },
        lease: { ...lease, status: 'completed' as const },
      })),
      list: jest.fn(), cancel: jest.fn(), getEvents: jest.fn(),
    } as unknown as ManagedRuntimeLifecycleGateway;
    const executor = new HermesRuntimeExecutor(gateway, { pollIntervalMs: 10, timeoutMs: 2_000 }, managed);
    const managedAssignment = assignment({
      execution_strategy: 'managed', workspace_policy: 'checkout', memory_policy: 'propose_write',
      native_tool_policy: 'managed_mcp_only', session_policy: 'clean',
    });
    const context = {
      requestId: 'f6f42d6e-3c3a-4e94-8c74-6dfc5f69abdd', rootTraceId, coreAgentName: 'coder',
      principal: { kind: 'user' as const, id: '7', allowedBundleIds: [3] }, bundleIds: [3],
      workspaceRoot: '/workspace/ARGUS-42', workspaceAccess: 'write' as const,
    };

    await expect(executor.readiness(managedAssignment)).resolves.toMatchObject({
      enabled: true, authenticated: true, trust: 'core_governed',
    });
    await expect(executor.execute(managedAssignment, { text: 'implement', managed: context })).resolves.toEqual({
      output: '- src/parser.ts', externalRunId: runId, trust: 'core_governed',
      usage: {
        inputTokens: 120, outputTokens: 30, totalTokens: 150,
        cacheReadInputTokens: 40, reasoningTokens: 12, apiCalls: 3, estimatedCostUsd: 0.0042,
      },
    });
    expect(managed.launch).toHaveBeenCalledWith(expect.objectContaining({
      rootTraceId,
      workspace: { root: '/workspace/ARGUS-42', access: 'write' },
      bundleIds: [3],
    }));
    expect(managed.getStatus).toHaveBeenCalledWith(expect.objectContaining({
      packId: 'argus.hermes', adapterId: 'hermes-http', runId, includeOutput: true,
    }));
  });
});
