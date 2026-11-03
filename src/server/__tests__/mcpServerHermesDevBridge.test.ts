import { describe, expect, it, jest } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../../config/env.js';
import type { A2aGateway } from '../../a2a/client.js';
import { HermesDevBridge, type HermesDevBridgeTaskStore } from '../../solutionPacks/hermesDevBridge.js';
import { createMcpServer, type SessionContext } from '../mcpServer.js';

const noDatabaseConfig = {
  postgresEnabled: false,
  postgresConnectionUrl: '',
} as Config;

const personalHermesContext: SessionContext = {
  apiKeyPrefix: 'ak_hermes',
  allowedBundles: [11],
  allowedTools: ['argus_dev_*'],
  deniedTools: null,
  callingUser: { id: 7, entra_groups: [] },
  sessionId: 'personal-hermes:ak_hermes',
  agentName: 'personal-hermes',
};

function bridge(): HermesDevBridge {
  const agentCard = {
    name: 'Argus Dev Coding Orchestrator',
    version: '0.4.0',
    supportedInterfaces: [{ url: 'http://argus-dev:2025', protocolBinding: 'HTTP+JSON', protocolVersion: '1.0' }],
    capabilities: {},
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [{ id: 'ticket-to-pull-request', name: 'Ticket to pull request' }],
  };
  const task = {
    id: 'task-42',
    contextId: 'context-42',
    status: { state: 'TASK_STATE_WORKING' as const },
  };
  const gateway: A2aGateway = {
    getAgentCard: jest.fn(async () => agentCard),
    sendMessage: jest.fn(async () => ({
      rootTraceId: '11111111-1111-4111-8111-111111111111',
      agentCard,
      task,
    })),
    listTasks: jest.fn(async () => ({ tasks: [], nextCursor: null })),
    getTask: jest.fn(async () => task),
    cancelTask: jest.fn(async () => ({ ...task, status: { state: 'TASK_STATE_CANCELED' as const } })),
  };
  const tasks: HermesDevBridgeTaskStore = {
    record: jest.fn(async () => undefined),
    findOwned: jest.fn(async () => null),
  };
  return new HermesDevBridge(gateway, tasks);
}

describe('personal Hermes Argus Dev MCP catalog', () => {
  it('exposes only the narrow bridge tools and no worker/runtime tools', async () => {
    const result = await createMcpServer(noDatabaseConfig, personalHermesContext, {
      hermesDevBridge: {
        bridge: bridge(),
        caller: { userId: 7, apiKeyPrefix: 'ak_hermes', allowedBundleIds: [11] },
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'personal-hermes-test', version: '1.0.0' }, { capabilities: {} });
    await result.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const catalog = await client.listTools();
      expect(catalog.tools.map(tool => tool.name).sort()).toEqual([
        'argus_dev_cancel_run',
        'argus_dev_capabilities',
        'argus_dev_get_result',
        'argus_dev_get_run',
        'argus_dev_get_workspace_evidence',
        'argus_dev_preflight',
        'argus_dev_start_workflow',
      ]);
      expect(catalog.tools.some(tool => tool.name.startsWith('workflow_'))).toBe(false);
      expect(catalog.tools.some(tool => tool.name === 'list_service_bundles')).toBe(false);
    } finally {
      await client.close();
      await result.server.close();
    }
  });

  it('cannot be combined with a child runtime lease catalog', async () => {
    await expect(createMcpServer(noDatabaseConfig, personalHermesContext, {
      runtimeLease: true,
      hermesDevBridge: {
        bridge: bridge(),
        caller: { userId: 7, apiKeyPrefix: 'ak_hermes', allowedBundleIds: [11] },
      },
    })).rejects.toThrow('cannot be combined');
  });
});
