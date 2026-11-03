import { describe, expect, it, jest } from '@jest/globals';
import type { A2aAgentCard, A2aGateway, A2aTask } from '../../a2a/client.js';
import {
  HERMES_DEV_AGENT_ID,
  HERMES_DEV_PACK_ID,
  HermesDevBridge,
  HermesDevBridgeError,
  PostgresHermesDevBridgeTaskStore,
  type HermesDevBridgeTaskRecord,
  type HermesDevBridgeTaskStore,
} from '../hermesDevBridge.js';

const caller = {
  userId: 7,
  apiKeyPrefix: 'ak_hermes',
  allowedBundleIds: [11, 12],
};

function card(): A2aAgentCard {
  return {
    name: 'Argus Dev Coding Orchestrator',
    version: '0.4.0',
    supportedInterfaces: [{ url: 'http://argus-dev:2025', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: {},
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{
      id: 'ticket-to-pull-request',
      name: 'Ticket to pull request',
      description: 'Governed coding workflow',
      'x-argus-workflow': {
        inputSchema: [
          { name: 'ticket_id', type: 'text', required: true },
          { name: 'description', type: 'textarea', required: true },
        ],
        stages: [{ id: 'planner' }, { id: 'human_approval' }],
        approvalGates: ['code_approval'],
        requiredBundleCategories: ['repository', 'ci'],
      },
    }],
  };
}

function task(state: A2aTask['status']['state'] = 'TASK_STATE_WORKING'): A2aTask {
  return {
    id: 'task-42',
    contextId: 'context-42',
    status: { state },
    artifacts: [{
      artifactId: 'result-42',
      parts: [{ data: { workflowId: 'ticket-to-pull-request', currentStage: 'planner' } }],
    }],
  };
}

class MemoryTaskStore implements HermesDevBridgeTaskStore {
  readonly records = new Map<string, HermesDevBridgeTaskRecord>();

  async record(input: {
    taskId: string;
    contextId: string;
    principalUserId: number;
    apiKeyPrefix: string;
    rootTraceId: string;
    originSessionRef?: string;
  }): Promise<void> {
    this.records.set(input.taskId, {
      taskId: input.taskId,
      contextId: input.contextId,
      principalUserId: input.principalUserId,
      apiKeyPrefix: input.apiKeyPrefix,
      rootTraceId: input.rootTraceId,
      originSessionRefHash: input.originSessionRef ? 'hashed' : null,
      createdAt: '2026-08-31T10:00:00.000Z',
    });
  }

  async findOwned(taskId: string, principalUserId: number, apiKeyPrefix: string): Promise<HermesDevBridgeTaskRecord | null> {
    const record = this.records.get(taskId);
    return record?.principalUserId === principalUserId && record.apiKeyPrefix === apiKeyPrefix ? record : null;
  }
}

function gateway(overrides: Partial<A2aGateway> = {}): A2aGateway {
  return {
    getAgentCard: jest.fn(async () => card()),
    sendMessage: jest.fn(async () => ({ rootTraceId: '11111111-1111-4111-8111-111111111111', agentCard: card(), task: task() })),
    listTasks: jest.fn(async () => ({ tasks: [], nextCursor: null })),
    getTask: jest.fn(async () => task()),
    cancelTask: jest.fn(async () => task('TASK_STATE_CANCELED')),
    ...overrides,
  };
}

describe('HermesDevBridge', () => {
  it('discovers only the fixed certified Argus Dev workflow and projected Bundles', async () => {
    const a2a = gateway();
    const bridge = new HermesDevBridge(a2a, new MemoryTaskStore());

    const result = await bridge.capabilities(caller);

    expect(a2a.getAgentCard).toHaveBeenCalledWith(HERMES_DEV_PACK_ID, HERMES_DEV_AGENT_ID);
    expect(result).toMatchObject({
      bridgeVersion: 'v1',
      packId: 'argus.dev',
      agentId: 'coding-orchestrator',
      projectedBundleIds: [11, 12],
      workflow: {
        id: 'ticket-to-pull-request',
        approvalGates: ['code_approval'],
        requiredBundleCategories: ['repository', 'ci'],
      },
      workerRecursion: 'blocked-by-separate-mcp-catalog',
    });
  });

  it('preflights with the Core-owned principal and exact API-key Bundle projection', async () => {
    const a2a = gateway();
    const bridge = new HermesDevBridge(a2a, new MemoryTaskStore());

    await bridge.preflight(caller);

    expect(a2a.sendMessage).toHaveBeenCalledWith(
      'argus.dev',
      'coding-orchestrator',
      expect.objectContaining({ data: { operation: 'coding.preflight' } }),
      {
        principalKind: 'user',
        principalId: '7',
        tenantKey: 'default',
        workspaceKey: 'default',
        principalAllowedBundleIds: [11, 12],
        requestedBundleIds: [11, 12],
      },
    );
  });

  it('starts only the standard coding workflow and stores its owner and trace binding', async () => {
    const a2a = gateway();
    const tasks = new MemoryTaskStore();
    const bridge = new HermesDevBridge(a2a, tasks);

    const result = await bridge.start(caller, {
      ticketId: 'ARGUS-314',
      description: 'Add a bounded Hermes-first development bridge with tests.',
      originSessionRef: 'hermes-session-9',
    });

    expect(a2a.sendMessage).toHaveBeenCalledWith(
      'argus.dev',
      'coding-orchestrator',
      expect.objectContaining({
        data: {
          operation: 'coding.start',
          input: {
            ticket_id: 'ARGUS-314',
            description: 'Add a bounded Hermes-first development bridge with tests.',
          },
        },
      }),
      expect.objectContaining({ principalId: '7', requestedBundleIds: [11, 12] }),
    );
    expect(tasks.records.get('task-42')).toMatchObject({
      principalUserId: 7,
      apiKeyPrefix: 'ak_hermes',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      originSessionRefHash: 'hashed',
    });
    expect(result).toMatchObject({
      taskId: 'task-42',
      currentStage: 'planner',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
    });
    expect(JSON.stringify((a2a.sendMessage as jest.Mock).mock.calls)).not.toContain('hermes-session-9');
  });

  it('fails closed for unscoped personal-Hermes credentials', async () => {
    const bridge = new HermesDevBridge(gateway(), new MemoryTaskStore());

    await expect(bridge.preflight({ ...caller, allowedBundleIds: [] }))
      .rejects.toMatchObject({ status: 400, code: 'invalid_bridge_principal' });
  });

  it('compensates a remote start when durable Core ownership cannot be recorded', async () => {
    const a2a = gateway();
    const bridge = new HermesDevBridge(a2a, {
      record: async () => { throw new Error('database unavailable'); },
      findOwned: async () => null,
    });

    await expect(bridge.start(caller, {
      ticketId: 'ARGUS-315',
      description: 'This start must be canceled when its owner binding fails.',
    })).rejects.toMatchObject({ status: 503, code: 'bridge_task_binding_failed' });
    expect(a2a.cancelTask).toHaveBeenCalledWith('argus.dev', 'coding-orchestrator', 'task-42');
  });

  it('does not expose or cancel a task owned by another Hermes projection', async () => {
    const a2a = gateway();
    const tasks = new MemoryTaskStore();
    await tasks.record({
      taskId: 'foreign-task',
      contextId: 'foreign-context',
      principalUserId: 99,
      apiKeyPrefix: 'ak_foreign',
      rootTraceId: '22222222-2222-4222-8222-222222222222',
    });
    const bridge = new HermesDevBridge(a2a, tasks);

    await expect(bridge.getRun(caller, { taskId: 'foreign-task' }))
      .rejects.toEqual(new HermesDevBridgeError(404, 'bridge_task_not_found', 'Argus Dev run was not found'));
    await expect(bridge.cancel(caller, { taskId: 'foreign-task' }))
      .rejects.toMatchObject({ status: 404, code: 'bridge_task_not_found' });
    expect(a2a.getTask).not.toHaveBeenCalled();
    expect(a2a.cancelTask).not.toHaveBeenCalled();
  });

  it('returns final artifacts only after a terminal task state', async () => {
    const tasks = new MemoryTaskStore();
    await tasks.record({
      taskId: 'task-42',
      contextId: 'context-42',
      principalUserId: 7,
      apiKeyPrefix: 'ak_hermes',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
    });
    const getTask = jest.fn<() => Promise<A2aTask>>()
      .mockResolvedValueOnce(task())
      .mockResolvedValueOnce(task('TASK_STATE_COMPLETED'));
    const bridge = new HermesDevBridge(gateway({ getTask }), tasks);

    await expect(bridge.getResult(caller, { taskId: 'task-42' }))
      .rejects.toMatchObject({ status: 409, code: 'bridge_result_not_ready' });
    await expect(bridge.getResult(caller, { taskId: 'task-42' }))
      .resolves.toMatchObject({ terminal: true, successful: true, artifacts: expect.any(Array) });
  });

  it('projects bounded read-only workspace evidence only for an owned run', async () => {
    const tasks = new MemoryTaskStore();
    await tasks.record({
      taskId: 'task-42', contextId: 'context-42', principalUserId: 7,
      apiKeyPrefix: 'ak_hermes', rootTraceId: '11111111-1111-4111-8111-111111111111',
    });
    const evidenceTask = task();
    evidenceTask.artifacts = [{
      artifactId: 'result-42',
      parts: [{ data: {
        workflowId: 'ticket-to-pull-request', currentStage: 'test', repository: 'argus/core',
        branchName: 'feature/hermes', fileDiffs: [{ path: 'src/example.ts', patch: '+ safe change' }],
        testsPassed: true, testOutput: '7 tests passed', review: 'No blocking findings',
        workspacePath: 'C:/secret/workspace', providerToken: 'must-not-leak',
      } }],
    }];
    const bridge = new HermesDevBridge(gateway({ getTask: jest.fn(async () => evidenceTask) }), tasks);

    const result = await bridge.getWorkspaceEvidence(caller, { taskId: 'task-42' });

    expect(result).toMatchObject({
      repository: 'argus/core', branchName: 'feature/hermes', testsPassed: true,
      testOutput: '7 tests passed', scope: 'owned-run-bounded-evidence',
      fileDiffs: [{ path: 'src/example.ts', patch: '+ safe change' }],
    });
    expect(JSON.stringify(result)).not.toContain('secret/workspace');
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });
});

describe('PostgresHermesDevBridgeTaskStore', () => {
  it('stores only a SHA-256 hash of the native Hermes session reference', async () => {
    const query = jest.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const store = new PostgresHermesDevBridgeTaskStore({ query } as never);

    await store.record({
      taskId: 'task-42',
      contextId: 'context-42',
      principalUserId: 7,
      apiKeyPrefix: 'ak_hermes',
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      originSessionRef: 'hermes-session-9',
    });

    const parameters = query.mock.calls[0]?.[1] ?? [];
    expect(parameters).not.toContain('hermes-session-9');
    expect(parameters[7]).toMatch(/^[0-9a-f]{64}$/);
  });
});
