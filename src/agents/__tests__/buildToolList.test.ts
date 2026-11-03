/**
 * buildToolList.test.ts — fail-closed allowedTools filter
 *
 * Strategy: mock every heavy import that agentRunner.ts pulls in so we can
 * call the exported buildToolList() directly without a DB or LLM.
 *
 * Key assertions:
 *   - allowedTools=[]   → returned list is EMPTY regardless of source
 *     (remote MCP, workspace, DB dynamic tools are ALL filtered out)
 *   - allowedTools=undefined → ALL tools present (no regression)
 *   - allowedTools=['db_tool'] → only that tool survives
 *   - Filter runs AFTER every source (remote + workspace + DB all contribute
 *     before the allowedTools gate runs)
 */

// ── Stable module mocks (must run before any import of agentRunner) ──

// Provide a fake remote MCP tool so we can assert it's filtered
const FAKE_REMOTE_TOOL = {
  prefixedName: 'kubernetes_get_secret',
  description: 'Get a K8s secret',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      detail: { type: 'string', enum: ['none', 'stats', 'full_patch'] },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

jest.mock('../../backends/remoteMcpClients.js', () => ({
  getAllRemoteTools: () => [FAKE_REMOTE_TOOL],
}));

// Provide a fake dynamic DB tool
const FAKE_DB_TOOL = {
  name: 'db_custom_tool',
  description: 'A DB-configured tool',
  enabled: true,
  parameters: JSON.stringify([{ name: 'query', type: 'string', required: true }]),
};

jest.mock('../../tools/dynamic/index.js', () => ({
  loadDynamicTools: jest.fn(async () => [FAKE_DB_TOOL]),
}));

// Workspace tools — provide a fake one and ensure the secret is set so it's included
const FAKE_WORKSPACE_TOOL = {
  type: 'function' as const,
  function: {
    name: 'workspace_exec',
    description: 'Execute a shell command',
    parameters: { type: 'object' as const, properties: { cmd: { type: 'string' } } },
  },
};

jest.mock('../../tools/workspace.js', () => ({
  WORKSPACE_TOOLS: [FAKE_WORKSPACE_TOOL],
  validateWorkspacePathAccess: jest.fn(() => null),
}));

// RAG tools — no additional agentic RAG for these tests (keep it simple)
jest.mock('../../tools/ragTools.js', () => ({
  getAgentRagTools: jest.fn(async () => []),
}));

const FAKE_SUBAGENT_TOOL = {
  type: 'function' as const,
  function: {
    name: '__call_agent__',
    description: 'Call a sub-agent',
    parameters: { type: 'object' as const, properties: {} },
  },
};

// Subagent tools are a first-class catalog source. Keeping one in the test
// fixture prevents composite filters from accidentally being bypassed again.
jest.mock('../../agents/subagents.js', () => ({
  subagentToolDefs: jest.fn(() => [FAKE_SUBAGENT_TOOL]),
  getSubagentDepth: jest.fn(() => 0),
  MAX_SUBAGENT_DEPTH: 5,
  SUBAGENT_TOOL_SINGLE: '__call_agent__',
  SUBAGENT_TOOL_PARALLEL: '__call_agents_parallel__',
  callSubagentSingle: jest.fn(),
  callSubagentsParallel: jest.fn(),
  formatParallelResults: jest.fn(),
}));

// Config env — expose WORKSPACE_SECRET so workspace tools are included
jest.mock('../../config/env.js', () => ({
  WORKSPACE_SECRET: 'test-secret',  // non-falsy → workspace tools are included
  USE_SDK_RUNNER: false,
  loadConfig: () => ({}),
}));

// Stubs for remaining heavy deps
jest.mock('../../lib/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../lib/encryption.js', () => ({
  encrypt: (v: unknown) => v,
  decrypt: (v: unknown) => v,
}));

jest.mock('../../agents/agentStore.js', () => ({
  getAgent: jest.fn(),
  getSession: jest.fn(),
  appendMessages: jest.fn(),
  createSession: jest.fn(),
}));

jest.mock('../../agents/skillStore.js', () => ({
  getAgentSkillContents: jest.fn(async () => []),
  readPinnedAgentSkills: jest.fn(async () => []),
}));

jest.mock('../../agents/memory.js', () => ({
  retrieveMemories: jest.fn(async () => []),
  formatMemoryContext: jest.fn(() => ''),
  extractAndStoreMemories: jest.fn(async () => {}),
}));

jest.mock('../../agents/ragClient.js', () => ({
  formatRagContext: jest.fn(() => ''),
}));

jest.mock('../../agents/ragSearch.js', () => ({
  searchRagIndex: jest.fn(async () => []),
}));

jest.mock('../../agents/activeSessions.js', () => ({
  registerSessionStart: jest.fn(),
  recordIterationStart: jest.fn(),
  recordToolCallStart: jest.fn(),
  recordToolCallEnd: jest.fn(),
  recordTokenUsage: jest.fn(),
  recordStreaming: jest.fn(),
  unregisterSession: jest.fn(),
}));

jest.mock('../../agents/claudeRunner.js', () => ({
  runClaudeWorkerAgent: jest.fn(),
}));

jest.mock('../../agents/sdkRunner.js', () => ({
  runCompactingWorkerAgent: jest.fn(),
}));

jest.mock('../../agents/continuousEval.js', () => ({
  scoreAgentTurn: jest.fn(async () => {}),
}));

jest.mock('../../agents/toolSearch.js', () => ({
  filterToolsForTask: jest.fn((tools: unknown[]) => tools),
}));

jest.mock('../../agents/promptBuilder.js', () => ({
  buildStableSystemPrompt: jest.fn(() => 'system'),
  buildWorkerStandards: jest.fn(() => ''),
}));

jest.mock('../../agents/toolOutputTagging.js', () => ({
  wrapToolOutput: jest.fn((n: string, id: string, out: string) => out),
}));

jest.mock('../../agents/workspace/codegraphPrejob.js', () => ({
  ensureCodegraphReady: jest.fn(async () => {}),
}));

jest.mock('../../lib/audit.js', () => ({
  writeAuditEntry: jest.fn(async () => {}),
}));

jest.mock('../../audit/immutableAudit.js', () => ({
  writeImmutableAudit: jest.fn(),
}));

jest.mock('../../lib/langfuseTracing.js', () => ({
  openTrace: jest.fn(() => ({
    trace: { enabled: false, id: 'trace-0', span: jest.fn((_meta: unknown, fn: () => unknown) => fn()) },
    setOutput: jest.fn(),
  })),
  enterTraceContext: jest.fn(),
  traceHeaders: jest.fn(() => ({})),
  withTraceContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
}));

jest.mock('../../tools/toolRunner.js', () => ({
  executeTool: jest.fn(),
}));

jest.mock('../../auth/userPolicyStore.js', () => ({
  fetchUserAgentPolicyData: jest.fn(async () => ({ allow: [], deny: [] })),
}));

jest.mock('../../agents/hooks/index.js', () => ({
  runPreToolHooks: jest.fn(async () => ({ decision: 'allow', modified_args: undefined })),
  runPostToolHooks: jest.fn(async () => {}),
  bootstrapBuiltinHooks: jest.fn(async () => {}),
}));

// ── Now import the function under test ────────────────────────

import pg from 'pg';
import { buildToolList, validateAdvertisedToolCall } from '../agentRunner.js';

// ── Pool stub — returns empty rows for all queries ────────────

function makePool(): pg.Pool {
  return {
    query: jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 })),
  } as unknown as pg.Pool;
}

// ── Tests ─────────────────────────────────────────────────────

describe('buildToolList — allowedTools fail-closed filter', () => {

  beforeEach(() => jest.clearAllMocks());

  test('allowedTools undefined → all tool sources contribute (no regression)', async () => {
    const tools = await buildToolList(makePool(), null, 1, undefined);
    const names = tools.map(t => t.function.name);

    // Remote MCP tool present
    expect(names).toContain('kubernetes_get_secret');
    // DB dynamic tool present
    expect(names).toContain('db_custom_tool');
    // Workspace tool present (WORKSPACE_SECRET is set in mock)
    expect(names).toContain('workspace_exec');
    // Synthetic agent delegation is present without an enclosing policy.
    expect(names).toContain('__call_agent__');
    expect(tools.find(tool => tool.function.name === 'kubernetes_get_secret')?.function.parameters)
      .toEqual(FAKE_REMOTE_TOOL.inputSchema);
  });

  test('allowedTools=[] → EMPTY list — remote MCP, workspace, and DB tools ALL blocked', async () => {
    const tools = await buildToolList(makePool(), null, 1, []);

    expect(tools).toHaveLength(0);

    // Verify each dangerous source individually
    const names = tools.map(t => t.function.name);
    expect(names).not.toContain('kubernetes_get_secret'); // remote MCP tool blocked
    expect(names).not.toContain('workspace_exec');         // workspace RCE tool blocked
    expect(names).not.toContain('db_custom_tool');         // DB dynamic tool blocked
  });

  test('allowedTools=[name] → only the named tool survives', async () => {
    const tools = await buildToolList(makePool(), null, 1, ['db_custom_tool']);
    const names = tools.map(t => t.function.name);

    expect(names).toEqual(['db_custom_tool']);
    expect(names).not.toContain('kubernetes_get_secret');
    expect(names).not.toContain('workspace_exec');
  });

  test('allowedTools=[] with compositeId null still returns empty (no composite bypass)', async () => {
    const tools = await buildToolList(makePool(), null, 1, []);
    expect(tools).toHaveLength(0);
  });

  test('explicit Agent bundles fail closed for backend tools while keeping local workspace tools', async () => {
    const pool = makePool();
    const tools = await buildToolList(pool, null, 1, undefined, [99]);
    const names = tools.map(tool => tool.function.name);
    expect(names).toEqual(['workspace_exec', '__call_agent__']);
    expect(names).not.toContain('kubernetes_get_secret');
    expect(names).not.toContain('db_custom_tool');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('$2::boolean'),
      [[99], false],
    );
  });

  test('an Agent composite resolves included bundles without the unscoped fallback', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT included_bundle_ids')) {
        return {
          rows: [{
            included_bundle_ids: [77],
            tool_allow_patterns: [],
            tool_deny_patterns: [],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as pg.Pool;
    const tools = await buildToolList(pool, 5, 1);
    expect(tools.map(tool => tool.function.name)).toEqual(['workspace_exec', '__call_agent__']);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('$2::boolean'),
      [[77], false],
    );
  });

  test('composite allow patterns also constrain synthetic sub-agent tools', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT included_bundle_ids')) {
        return {
          rows: [{
            included_bundle_ids: [],
            tool_allow_patterns: ['workspace_*'],
            tool_deny_patterns: [],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as pg.Pool;

    const tools = await buildToolList(pool, 5, 1);

    expect(tools.map(tool => tool.function.name)).toEqual(['workspace_exec']);
    expect(tools.map(tool => tool.function.name)).not.toContain('__call_agent__');
  });

  test('a no-match composite is truly tool-less including delegation', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT included_bundle_ids')) {
        return {
          rows: [{
            included_bundle_ids: [],
            tool_allow_patterns: ['__argus_dev_no_tools__'],
            tool_deny_patterns: [],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const pool = { query } as unknown as pg.Pool;

    await expect(buildToolList(pool, 5, 1)).resolves.toEqual([]);
  });
});

describe('validateAdvertisedToolCall — runtime dispatch boundary', () => {
  test('allows a tool from the exact catalog advertised for the turn', () => {
    expect(validateAdvertisedToolCall('prometheus_query', new Set(['prometheus_query']))).toBeNull();
  });

  test('blocks a valid but unadvertised tool name before execution', () => {
    expect(validateAdvertisedToolCall('fabric_status', new Set(['prometheus_query'])))
      .toBe("Tool 'fabric_status' is not available to this agent.");
  });
});
