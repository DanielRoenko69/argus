/**
 * hardenedChat.test.ts — P3-6 TDD
 *
 * Tests:
 *   1. Non-public agent → throws PublicChatRefused before stub is called.
 *   2. Over-length input → throws PublicChatRefused before stub is called.
 *   3. Tools forced to [] — pool proxy blocks tool-query SQL; stub sees no tools.
 *   4. Only public RAG indexes passed as ragIndexIds to runAgentChat.
 *   5. A2AS forced on — pool proxy patches untrusted_tool_output_enforcement=true.
 *   6. System prompt starts with the security envelope.
 *   7. Public agent with no public RAG indexes → ragIndexIds = [-1] (sentinel).
 *
 * The stub runAgentChat captures its arguments.
 * The pool proxy is tested by asserting the patched agent row properties.
 * The real LLM is never called.
 */

import {
  hardenedRunAgentChat,
  PublicChatRefused,
  MAX_PUBLIC_INPUT_CHARS,
  makePublicPool,
} from '../hardenedChat.js';
import type { HardenedChatDeps, HardenedChatArgs, RunAgentChatFn } from '../hardenedChat.js';
import type { Agent } from '../../agents/types.js';
import type { PublicWidget } from '../widgetStore.js';
import type { Config } from '../../config/env.js';
import pg from 'pg';

// ── Fixtures ──────────────────────────────────────────────────

function makeAgent(overrides: Partial<Agent & { rag_indexes?: Array<{ id: number; name: string; label: string; priority: number; visibility?: string }> }> = {}): Agent & { rag_indexes?: Array<{ id: number; name: string; label: string; priority: number; visibility?: string }> } {
  return {
    id: 42,
    name: 'public-bot',
    label: 'Public Bot',
    description: '',
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 2048,
    system_prompt: 'You are a helpful assistant.',
    agent_role: null,
    composite_id: null,
    gitea_project: null,
    enabled: true,
    max_iterations: 5,
    created_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    agent_mode: 'chat',
    task_type: null,
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: null,
    bitbucket_repo: null,
    bundle_ids: null,
    llm_api_key: null,
    thinking_budget: 0,
    untrusted_tool_output_enforcement: false,
    entra_object_id: null,
    entra_app_id: null,
    entra_blueprint_id: null,
    entra_synced_at: null,
    entra_sync_error: null,
    codegraph_enabled: false,
    visibility: 'public',
    min_role: null,
    risk_level: 'low',
    human_oversight_required: false,
    rag_indexes: [],
    ...overrides,
  };
}

function makeWidget(): PublicWidget {
  return {
    id: 1,
    agent_id: 42,
    slug: 'my-widget',
    allowed_origins: ['https://example.com'],
    enabled: true,
    greeting: null,
    accent: null,
    title: null,
    input_placeholder: null,
    launcher_icon_url: null,
    launcher_icon_alt: null,
    launcher_position: 'right',
    rate_limit_per_ip: 20,
    daily_token_cap: 50000,
    created_by: null,
    created_at: new Date(),
  };
}

const STUB_CONFIG = {} as Config;

/**
 * Minimal stub pool for hardenedChat tests.
 * The default query stub returns empty RAG results (simulating no public indexes).
 * Tests that need specific behavior override `queryImpl`.
 */
function makeStubPool(queryImpl?: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const defaultImpl = async (_text: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 });
  const impl = queryImpl ?? defaultImpl;
  return {
    query: jest.fn(impl),
  } as unknown as pg.Pool;
}

/**
 * Consume an AsyncGenerator fully and return all yielded values.
 */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of gen) {
    items.push(item);
  }
  return items;
}

// ── Test: non-public agent ─────────────────────────────────────

describe('hardenedRunAgentChat — visibility assertion', () => {
  test('throws PublicChatRefused when agent.visibility is internal', async () => {
    const agent = makeAgent({ visibility: 'internal' });
    const runAgentChat = jest.fn() as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = {
      runAgentChat,
      pool: makeStubPool(),
      config: STUB_CONFIG,
    };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent,
      sessionId: 'sess-1',
      origin: 'https://example.com',
      ipHash: 'abc123',
      message: 'Hello',
    };

    await expect(collect(hardenedRunAgentChat(deps, args))).rejects.toThrow(PublicChatRefused);
    // Must throw BEFORE calling the runner
    expect(runAgentChat).not.toHaveBeenCalled();
  });
});

// ── Test: input length cap ────────────────────────────────────

describe('hardenedRunAgentChat — input cap', () => {
  test('throws PublicChatRefused when message exceeds MAX_PUBLIC_INPUT_CHARS', async () => {
    const agent = makeAgent();
    const runAgentChat = jest.fn() as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = {
      runAgentChat,
      pool: makeStubPool(),
      config: STUB_CONFIG,
    };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent,
      sessionId: 'sess-1',
      origin: 'https://example.com',
      ipHash: 'abc123',
      message: 'x'.repeat(MAX_PUBLIC_INPUT_CHARS + 1),
    };

    await expect(collect(hardenedRunAgentChat(deps, args))).rejects.toThrow(PublicChatRefused);
    // Must throw BEFORE calling the runner
    expect(runAgentChat).not.toHaveBeenCalled();
  });

  test('exactly MAX_PUBLIC_INPUT_CHARS is accepted', async () => {
    const agent = makeAgent();

    // Stub runner that yields [DONE]
    async function* stubRunner(_id: number, _sess: string, _msg: string, _pool: pg.Pool, _cfg: Config, _mo?: string, _cu?: { id: number; entra_groups: string[] }, _ri?: number[]): AsyncGenerator<string> { yield 'data: [DONE]\n\n'; }
    const runAgentChat = jest.fn(stubRunner) as unknown as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = {
      runAgentChat,
      pool: makeStubPool(),
      config: STUB_CONFIG,
    };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent,
      sessionId: 'sess-1',
      origin: 'https://example.com',
      ipHash: 'abc123',
      message: 'x'.repeat(MAX_PUBLIC_INPUT_CHARS),
    };

    await expect(collect(hardenedRunAgentChat(deps, args))).resolves.toBeDefined();
  });
});

// ── Test: public RAG indexes only ────────────────────────────

describe('hardenedRunAgentChat — RAG restriction', () => {
  test('passes only public RAG index IDs to runAgentChat', async () => {
    const agent = makeAgent();

    // Pool returns two public RAG indexes for this agent
    const pool = makeStubPool(async (text: string) => {
      if (text.includes("r.visibility = 'public'")) {
        return { rows: [{ id: 7 }, { id: 12 }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    const capturedArgs: unknown[] = [];
    async function* stubRunner(...a: unknown[]): AsyncGenerator<string> {
      capturedArgs.push(...a);
      yield 'data: [DONE]\n\n';
    }
    const runAgentChat = jest.fn((...a) => stubRunner(...a)) as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = { runAgentChat, pool, config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent,
      sessionId: 'sess-rag',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Tell me about X',
    };

    await collect(hardenedRunAgentChat(deps, args));

    // The 8th argument (index 7) is ragIndexIds
    const callArgs = runAgentChat.mock.calls[0];
    const ragIndexIds = callArgs?.[7];
    expect(Array.isArray(ragIndexIds)).toBe(true);
    expect(ragIndexIds).toEqual(expect.arrayContaining([7, 12]));
    expect((ragIndexIds as number[]).length).toBe(2);
    // Must NOT contain any non-public index IDs
    expect(ragIndexIds).not.toContain(99);
  });

  test('no public RAG indexes → ragIndexIds = [-1] sentinel (never all-indexes fallback)', async () => {
    const agent = makeAgent();

    // Pool returns no public RAG indexes
    const pool = makeStubPool(async () => ({ rows: [], rowCount: 0 }));

    const capturedRagIds: (number[] | undefined)[] = [];
    async function* stubRunner(_id: number, _sess: string, _msg: string, _pool: pg.Pool, _cfg: Config, _model?: string, _user?: { id: number; entra_groups: string[] }, ragIndexIds?: number[]): AsyncGenerator<string> {
      capturedRagIds.push(ragIndexIds);
      yield 'data: [DONE]\n\n';
    }
    const runAgentChat = jest.fn(stubRunner) as unknown as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = { runAgentChat, pool, config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent,
      sessionId: 'sess-norag',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Hello',
    };

    await collect(hardenedRunAgentChat(deps, args));

    // When no public indexes, we pass [-1] so buildRagContext uses the filterIds
    // path (which matches nothing) instead of the no-filter path (all indexes).
    expect(capturedRagIds[0]).toEqual([-1]);
  });
});

// ── Test: tool blocking via pool proxy ───────────────────────

describe('makePublicPool — tool query blocking', () => {
  const TOOL_QUERIES = [
    'SELECT t.* FROM mcp_tools t WHERE t.enabled = true ORDER BY t.category, t.name',
    'SELECT r.* FROM mcp_rag_indexes r\n     JOIN mcp_agent_rag_indexes ar ON ar.rag_index_id = r.id\n     WHERE ar.agent_id = $1 AND r.enabled = true\n     ORDER BY ar.priority, r.label',
    'SELECT included_bundle_ids, tool_allow_patterns, tool_deny_patterns FROM mcp_composites WHERE id=$1',
    'SELECT id, name, label, agent_mode FROM mcp_agents WHERE enabled = true AND id != $1 ORDER BY id',
  ];

  for (const sql of TOOL_QUERIES) {
    test(`blocks tool-loading query: "${sql.slice(0, 60)}..."`, async () => {
      const realPool = {
        query: jest.fn(async () => ({ rows: [{ id: 1, name: 'dangerous-tool' }], rowCount: 1 })),
      } as unknown as pg.Pool;

      const proxy = makePublicPool(realPool, 'envelope\n');
      const result = await (proxy as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> }).query(sql, []);

      // Tool queries must return empty
      expect(result.rows).toHaveLength(0);
      // Real pool should NOT have been called for this query
      expect((realPool.query as jest.Mock)).not.toHaveBeenCalled();
    });
  }

  test('non-tool queries pass through to the real pool', async () => {
    const realPool = {
      query: jest.fn(async () => ({ rows: [{ id: 99 }], rowCount: 1 })),
    } as unknown as pg.Pool;

    const proxy = makePublicPool(realPool, 'envelope\n');
    const result = await (proxy as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[] }> }).query(
      'SELECT * FROM mcp_agent_sessions WHERE id=$1',
      ['sess-123'],
    );

    expect(result.rows).toHaveLength(1);
    expect((realPool.query as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});

// ── Test: A2AS forced on via pool proxy ──────────────────────

describe('makePublicPool — agent row patching', () => {
  const GET_AGENT_SQL = `SELECT a.*, c.name AS composite_name FROM mcp_agents a LEFT JOIN mcp_composites c ON c.id = a.composite_id WHERE a.id = $1 GROUP BY a.id, c.name`;

  test('forces untrusted_tool_output_enforcement=true in patched agent row', async () => {
    const agentRow = {
      id: 42,
      system_prompt: 'original prompt',
      untrusted_tool_output_enforcement: false,
      composite_id: 5,
    };
    const realPool = {
      query: jest.fn(async () => ({ rows: [agentRow], rowCount: 1 })),
    } as unknown as pg.Pool;

    const proxy = makePublicPool(realPool, 'ENVELOPE\n\n---\n');
    const result = await (proxy as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query(GET_AGENT_SQL, [42]);

    const row = result.rows[0];
    expect(row?.['untrusted_tool_output_enforcement']).toBe(true);
  });

  test('prepends security envelope to agent system_prompt', async () => {
    const agentRow = {
      id: 42,
      system_prompt: 'You are a bot.',
      untrusted_tool_output_enforcement: false,
      composite_id: null,
    };
    const realPool = {
      query: jest.fn(async () => ({ rows: [agentRow], rowCount: 1 })),
    } as unknown as pg.Pool;

    const envelope = 'SECURITY ENVELOPE\n---\n';
    const proxy = makePublicPool(realPool, envelope);
    const result = await (proxy as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query(GET_AGENT_SQL, [42]);

    const row = result.rows[0];
    expect(typeof row?.['system_prompt']).toBe('string');
    expect((row?.['system_prompt'] as string).startsWith(envelope)).toBe(true);
    expect(row?.['system_prompt'] as string).toContain('You are a bot.');
  });

  test('sets composite_id to null in patched agent row', async () => {
    const agentRow = {
      id: 42,
      system_prompt: 'prompt',
      untrusted_tool_output_enforcement: true,
      composite_id: 99,  // has a composite that could grant tools
    };
    const realPool = {
      query: jest.fn(async () => ({ rows: [agentRow], rowCount: 1 })),
    } as unknown as pg.Pool;

    const proxy = makePublicPool(realPool, 'env\n');
    const result = await (proxy as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query(GET_AGENT_SQL, [42]);

    const row = result.rows[0];
    expect(row?.['composite_id']).toBeNull();
  });
});

// ── Test: system prompt envelope in end-to-end flow ──────────

describe('hardenedRunAgentChat — system prompt envelope', () => {
  test('security envelope is prepended to the agent system_prompt', async () => {
    // We test this via makePublicPool directly (above) and via the integration
    // that the hardenedPool passed to runAgentChat patches the agent row.
    // Here we verify the overall structure: makePublicPool receives the envelope.

    // Snapshot: the public security envelope must contain key security directives.
    // Import the module to get the real envelope (it's not exported — test via proxy).
    const agentRow = {
      id: 42,
      system_prompt: 'Agent base prompt.',
      untrusted_tool_output_enforcement: false,
      composite_id: null,
    };
    const realPool = {
      query: jest.fn(async (text: string) => {
        if (text.includes('FROM mcp_agents a') && text.includes('WHERE a.id = $1')) {
          return { rows: [{ ...agentRow }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as pg.Pool;

    // Capture the pool passed to runAgentChat
    let capturedPool: pg.Pool | undefined;
    async function* stubRunner(_id: number, _sess: string, _msg: string, pool: pg.Pool, _cfg: Config, _mo?: string, _cu?: { id: number; entra_groups: string[] }, _ri?: number[]): AsyncGenerator<string> {
      capturedPool = pool;
      yield 'data: [DONE]\n\n';
    }
    const runAgentChat = jest.fn(stubRunner) as unknown as jest.MockedFunction<RunAgentChatFn>;

    const deps: HardenedChatDeps = { runAgentChat, pool: realPool, config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent: makeAgent({ id: 42, system_prompt: 'Agent base prompt.' }),
      sessionId: 'sess-prompt',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Hello',
    };

    await collect(hardenedRunAgentChat(deps, args));

    // The pool passed to runAgentChat is the hardened proxy
    expect(capturedPool).toBeDefined();

    // Query the proxy with the getAgent SQL to verify the envelope is prepended
    const proxyResult = await (capturedPool as unknown as { query: (t: string, v?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }).query(
      'SELECT a.*, c.name AS composite_name FROM mcp_agents a LEFT JOIN mcp_composites c ON c.id = a.composite_id WHERE a.id = $1 GROUP BY a.id, c.name',
      [42],
    );

    const prompt = proxyResult.rows[0]?.['system_prompt'] as string;
    // The envelope must mention key security instructions
    expect(prompt).toContain('public-facing assistant');
    expect(prompt).toContain('NEVER reveal');
    expect(prompt).toContain('jailbreak');
    // The original prompt must still be present (appended after the envelope)
    expect(prompt).toContain('Agent base prompt.');
  });
});

// ── Test: fail-closed allowedTools=[] + disableMemory=true ───

describe('hardenedRunAgentChat — fail-closed tool lockdown + memory off', () => {
  /**
   * Helper: capture all arguments that runAgentChat is called with.
   */
  function captureStubRunner(): {
    runAgentChat: jest.MockedFunction<RunAgentChatFn>;
    getCallArgs: () => Parameters<RunAgentChatFn>;
  } {
    let capturedArgs: unknown[] = [];
    async function* stub(...args: unknown[]): AsyncGenerator<string> {
      capturedArgs = args;
      yield 'data: [DONE]\n\n';
    }
    const runAgentChat = jest.fn((...args: unknown[]) => stub(...args)) as unknown as jest.MockedFunction<RunAgentChatFn>;
    return {
      runAgentChat,
      getCallArgs: () => capturedArgs as Parameters<RunAgentChatFn>,
    };
  }

  test('passes allowedTools=[] (index 8) to runAgentChat', async () => {
    const { runAgentChat, getCallArgs } = captureStubRunner();
    const deps: HardenedChatDeps = { runAgentChat, pool: makeStubPool(), config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent: makeAgent(),
      sessionId: 'sess-allowed',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Hello',
    };

    await collect(hardenedRunAgentChat(deps, args));

    const callArgs = getCallArgs();
    // Arg index 8 = allowedTools
    expect(callArgs[8]).toEqual([]);
  });

  test('passes disableMemory=true (index 9) to runAgentChat', async () => {
    const { runAgentChat, getCallArgs } = captureStubRunner();
    const deps: HardenedChatDeps = { runAgentChat, pool: makeStubPool(), config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent: makeAgent(),
      sessionId: 'sess-mem',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Hello',
    };

    await collect(hardenedRunAgentChat(deps, args));

    const callArgs = getCallArgs();
    // Arg index 9 = disableMemory
    expect(callArgs[9]).toBe(true);
  });

  test('passes both allowedTools=[] and disableMemory=true in the same call', async () => {
    const { runAgentChat, getCallArgs } = captureStubRunner();
    const deps: HardenedChatDeps = { runAgentChat, pool: makeStubPool(), config: STUB_CONFIG };
    const args: HardenedChatArgs = {
      widget: makeWidget(),
      agent: makeAgent(),
      sessionId: 'sess-both',
      origin: 'https://example.com',
      ipHash: 'abc',
      message: 'Hello',
    };

    await collect(hardenedRunAgentChat(deps, args));

    expect(runAgentChat).toHaveBeenCalledTimes(1);
    const callArgs = getCallArgs();
    expect(callArgs[8]).toEqual([]);      // allowedTools
    expect(callArgs[9]).toBe(true);       // disableMemory
  });
});
