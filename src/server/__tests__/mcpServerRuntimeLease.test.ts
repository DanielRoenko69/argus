import { describe, expect, it } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Config } from '../../config/env.js';
import { createMcpServer, mcpCatalogSections, type SessionContext } from '../mcpServer.js';

const runtimeLeaseContext: SessionContext = {
  apiKeyPrefix: 'runtime_lease_test',
  allowedBundles: [],
  allowedTools: [],
  deniedTools: null,
  sessionId: 'hermes:lease-test',
  agentId: 42,
  agentName: 'coder',
  runtimeLeaseId: '81d84476-b44e-4bb3-9d10-9f44ec04d4f1',
  runtimeWorkspaceRoot: '/workspace/managed-hermes',
  runtimeWorkspaceAccess: 'write',
};

const noDatabaseConfig = {
  postgresEnabled: false,
  postgresConnectionUrl: '',
} as Config;

describe('managed runtime MCP catalog', () => {
  it('keeps Bundle-owned native handlers while excluding generic Core capabilities', () => {
    expect(mcpCatalogSections({ runtimeLease: true })).toEqual({
      genericCore: false,
      bundleOwnedBuiltins: true,
    });
  });

  it('exposes only scoped file tools and no generic Core or shell capabilities', async () => {
    const result = await createMcpServer(noDatabaseConfig, runtimeLeaseContext, { runtimeLease: true });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'runtime-lease-test', version: '1.0.0' }, { capabilities: {} });
    await result.server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'workspace_edit',
        'workspace_ls',
        'workspace_read',
        'workspace_write',
      ]);
      expect(tools.tools.map(tool => tool.name)).not.toContain('workspace_exec');
    } finally {
      await client.close();
      await result.server.close();
    }
  });
});
