import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { chatCompletion, createEmbedding, parseCodexRuntimeToolCalls, streamChatCompletion } from '../client.js';
import { buildCodexRuntimePrompt } from '../codexContextBudget.js';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('direct LLM client', () => {
  it('supports a single-attempt evaluation call without raw provider error text', async () => {
    const fetchMock=jest.spyOn(globalThis,'fetch').mockResolvedValue(new Response('sensitive-provider-body',{ status:503 }));
    await expect(chatCompletion({ model:'fixture',messages:[] },{
      targetOverride:{ provider:'openai-compatible',model:'fixture',baseUrl:'http://fixture.invalid',apiKey:'',authType:'none',timeoutMs:1000 },
      maxRetries:0,safeErrors:true,
    })).rejects.toThrow('API error 503');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('preserves Anthropic partial usage separately from compatibility defaults', async () => {
    jest.spyOn(globalThis,'fetch').mockResolvedValue(jsonResponse({ id:'fixture',model:'fixture',content:[{ type:'text',text:'ok' }],stop_reason:'end_turn',usage:{ input_tokens:3 } }));
    const result=await chatCompletion({ model:'fixture',messages:[] },{
      targetOverride:{ provider:'anthropic',model:'fixture',baseUrl:'http://fixture.invalid',apiKey:'fixture',authType:'api-key',timeoutMs:1000 },
    });
    expect(result.usage_observed).toEqual({ prompt_tokens:3 });
    expect(result.usage?.completion_tokens).toBe(0); // Older callers remain compatible.
  });
  it('calls OpenAI chat completions directly', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      id: 'chat-1',
      model: 'gpt-4o-mini',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hallo' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }));

    const result = await chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 42,
    });

    expect(result.choices[0]?.message.content).toBe('Hallo');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/chat/completions');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer openai-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 42,
      stream: false,
    });
  });

  it('uses a registered target override and rewrites the upstream model name', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      id: 'chat-compatible',
      model: 'openai/gpt-5.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    }));

    await chatCompletion({
      model: 'argus-coder',
      messages: [{ role: 'user', content: 'Hi' }],
    }, {
      targetOverride: {
        provider: 'openai-compatible',
        baseUrl: 'http://litellm:4000/v1',
        apiKey: 'proxy-key',
        authType: 'bearer',
        model: 'openai/gpt-5.1',
        timeoutMs: 10_000,
        supportsReasoning: false,
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://litellm:4000/v1/chat/completions');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer proxy-key');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'openai/gpt-5.1',
      reasoning_effort: 'none',
    });
  });

  it('translates Anthropic messages, tools and responses', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      id: 'msg-1',
      model: 'claude-sonnet-4-5',
      stop_reason: 'tool_use',
      content: [
        { type: 'text', text: 'Ich prüfe das.' },
        { type: 'tool_use', id: 'toolu_1', name: 'workspace_ls', input: { path: '.' } },
      ],
      usage: { input_tokens: 12, output_tokens: 7 },
    }));

    const result = await chatCompletion({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: 'Du bist ein Coding Agent.' },
        { role: 'user', content: 'Liste Dateien.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'workspace_ls',
          description: 'List files',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'workspace_ls' } },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/v1/messages');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('anthropic-test');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: 'Du bist ein Coding Agent.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Liste Dateien.' }] }],
      tools: [{ name: 'workspace_ls', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'workspace_ls' },
      stream: false,
    });
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
    expect(result.choices[0]?.message.tool_calls?.[0]).toMatchObject({
      id: 'toolu_1',
      function: { name: 'workspace_ls', arguments: '{"path":"."}' },
    });
    expect(result.usage?.total_tokens).toBe(19);
  });

  it('uses the OpenAI embeddings endpoint', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      data: [{ index: 0, embedding: [0.1, 0.2] }],
    }));

    const result = await createEmbedding('text-embedding-3-large', 'Argus');

    expect(result.data[0]?.embedding).toEqual([0.1, 0.2]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.openai.com/v1/embeddings');
  });

  it('delegates subscription reasoning to the Codex bridge and returns a Core tool call', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      response: '{"name":"workspace_read","arguments":{"path":"src/index.ts"}}',
      runId: 'run-1',
      threadId: 'thread-1',
      model: 'gpt-5.6-terra',
      usage: { input_tokens: 20, output_tokens: 8, cached_input_tokens: 3 },
    }));

    const result = await chatCompletion({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: 'Read the entry point.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'workspace_read',
          description: 'Read a workspace file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
    }, {
      targetOverride: {
        provider: 'openai-compatible',
        baseUrl: 'http://agent-workspace:3001',
        apiKey: 'workspace-secret',
        authType: 'none',
        model: 'gpt-5.6-terra',
        timeoutMs: 610_000,
        runtimeType: 'codex-subscription',
        runtimeReasoningEffort: 'xhigh',
        runtimeAgentId: 12,
        runtimeRootTraceId: 'root-trace',
        runtimeWorkingDirectory: '/runtime',
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://agent-workspace:3001/codex/run');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init as RequestInit & { dispatcher?: unknown }).dispatcher).toBeDefined();
    expect((init.headers as Record<string, string>)['x-workspace-secret']).toBe('workspace-secret');
    expect(JSON.parse(String(init.body))).toMatchObject({
      cwd: '/runtime',
      executionMode: 'core-agent',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'xhigh',
      timeoutSec: 600,
      rootTraceId: 'root-trace',
      agentId: 12,
      taskType: 'agent_turn',
      telemetryManaged: true,
    });
    expect(result.choices[0]?.finish_reason).toBe('tool_calls');
    expect(result.choices[0]?.message.tool_calls?.[0]?.function).toEqual({
      name: 'workspace_read',
      arguments: '{"path":"src/index.ts"}',
    });
    expect(result.usage).toMatchObject({ prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 });
  });

  it('delegates Claude Code profiles to the protected workspace bridge', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      response: '{"name":"workspace_read","arguments":{"path":"src/index.ts"}}',
      runId: 'claude-run-1',
      threadId: 'claude-thread-1',
      model: 'claude-sonnet-4-5',
      usage: null,
    }));

    const result = await chatCompletion({
      model: 'claude-subscription',
      messages: [{ role: 'user', content: 'Read the entry point.' }],
      tools: [{
        type: 'function',
        function: {
          name: 'workspace_read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      }],
    }, {
      targetOverride: {
        provider: 'anthropic',
        baseUrl: 'http://agent-workspace:3001',
        apiKey: 'workspace-secret',
        authType: 'none',
        model: 'claude-subscription',
        timeoutMs: 910_000,
        runtimeType: 'claude-code-subscription',
        runtimeAgentId: 14,
        runtimeRootTraceId: 'root-trace',
        runtimeWorkingDirectory: '/runtime',
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://agent-workspace:3001/claude/run');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      cwd: '/runtime',
      timeoutSec: 900,
      rootTraceId: 'root-trace',
      agentId: 14,
      taskType: 'agent_turn',
      telemetryManaged: true,
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('model');
    expect(result.choices[0]?.message.tool_calls?.[0]?.function.name).toBe('workspace_read');
  });

  it('compacts oversized MCP catalogs before calling the Codex bridge', async () => {
    process.env['CODEX_CONTEXT_TARGET_CHARS'] = '40000';
    const tools = Array.from({ length: 24 }, (_, index) => ({
      type: 'function' as const,
      function: {
        name: `github_tool_${index}`,
        description: `GitHub operation ${index} ${'verbose '.repeat(700)}`,
        parameters: {
          type: 'object',
          properties: {
            owner: { type: 'string', description: 'Repository owner '.repeat(100) },
            repo: { type: 'string', description: 'Repository name '.repeat(100) },
            query: { type: 'string', description: 'Search expression '.repeat(100) },
          },
          required: ['owner', 'repo'],
          examples: Array.from({ length: 20 }, () => ({ owner: 'example', repo: 'large' })),
        },
      },
    }));
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      response: 'The repository is scoped correctly.',
      model: 'gpt-5.6-terra',
      usage: { input_tokens: 1000, output_tokens: 10 },
    }));

    await chatCompletion({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: 'Keep repository access governed.' },
        { role: 'user', content: 'Inspect argus-project/argus_core and preserve this exact instruction.' },
      ],
      tools,
    }, {
      targetOverride: {
        provider: 'openai-compatible',
        baseUrl: 'http://agent-workspace:3001',
        apiKey: 'workspace-secret',
        authType: 'none',
        model: 'gpt-5.6-terra',
        timeoutMs: 610_000,
        runtimeType: 'codex-subscription',
      },
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as { prompt: string };
    expect(body.prompt.length).toBeLessThanOrEqual(40_000);
    expect(body.prompt).toContain('Inspect argus-project/argus_core and preserve this exact instruction.');
    expect(body.prompt).toContain('github_tool_0');
    expect(body.prompt).toContain('github_tool_23');
    expect(body.prompt).not.toContain('examples');
  });

  it('prioritizes the latest human instruction over accumulated machine output', () => {
    process.env['CODEX_CONTEXT_TARGET_CHARS'] = '32000';
    const result = buildCodexRuntimePrompt({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: `Governed agent policy\n${'policy '.repeat(8_000)}` },
        { role: 'user', content: 'Initial repository request.' },
        { role: 'assistant', content: 'analysis '.repeat(8_000) },
        { role: 'tool', name: 'github_search', tool_call_id: 'tool-1', content: 'result '.repeat(12_000) },
        { role: 'assistant', content: 'analysis '.repeat(8_000) },
        { role: 'tool', name: 'github_file', tool_call_id: 'tool-2', content: 'source '.repeat(12_000) },
        { role: 'assistant', content: 'I reviewed the earlier evidence.' },
        { role: 'user', content: 'FINAL HUMAN CORRECTION: only inspect argus-project/argus_core.' },
      ],
    });

    expect(result.report.compacted).toBe(true);
    expect(result.prompt.length).toBeLessThanOrEqual(32_000);
    expect(result.prompt).toContain('FINAL HUMAN CORRECTION: only inspect argus-project/argus_core.');
    expect(result.report.originalChars).toBeGreaterThan(result.report.finalChars);
    expect(result.report.strategies).toContain('strict_message_bounds');
  });

  it('fails safely when the current human instruction alone exceeds the hard boundary', () => {
    process.env['CODEX_CONTEXT_TARGET_CHARS'] = '145000';
    expect(() => buildCodexRuntimePrompt({
      model: 'gpt-5.6-terra',
      messages: [{ role: 'user', content: `Do not truncate this instruction. ${'x'.repeat(160_000)}` }],
    })).toThrow(/cannot be compacted safely/);
  });

  it('rejects text-encoded Codex tool requests outside the advertised Core catalog', () => {
    const calls = parseCodexRuntimeToolCalls(
      '{"name":"workspace_exec","arguments":{"cmd":"whoami"}}',
      [{ type: 'function', function: { name: 'rag_search', parameters: { type: 'object' } } }],
    );
    expect(calls).toEqual([]);
  });

  it('retries a transient 429 and honors a bounded retry delay', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    process.env['LLM_MAX_RETRIES'] = '1';
    process.env['LLM_RETRY_BASE_MS'] = '1';
    process.env['LLM_RETRY_MAX_MS'] = '2';
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{"error":"rate_limit"}', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(jsonResponse({
        id: 'chat-retry',
        model: 'gpt-4o-mini',
        choices: [{ index: 0, message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }],
      }));

    const result = await chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'retry' }],
    });

    expect(result.choices[0]?.message.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry authentication failures', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    process.env['LLM_MAX_RETRIES'] = '3';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));

    await expect(chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'no retry' }],
    })).rejects.toThrow(/API error 401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps transport timeouts as hard failures instead of retrying blindly', async () => {
    process.env['OPENAI_API_KEY'] = 'openai-test';
    process.env['LLM_MAX_RETRIES'] = '3';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('timed out', 'TimeoutError'));

    await expect(chatCompletion({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'timeout' }],
    })).rejects.toThrow('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes Anthropic streaming text, tools and usage', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'anthropic-test';
    const events = [
      { type: 'message_start', message: { id: 'msg-1', model: 'claude-sonnet-4-5', usage: { input_tokens: 5 } } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hallo' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'workspace_ls' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"."}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
    ];
    const sse = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(sse, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    }));

    const chunks = [];
    for await (const chunk of streamChatCompletion({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi' }],
    })) {
      chunks.push(chunk);
    }

    expect(chunks.some(chunk => chunk.choices[0]?.delta.content === 'Hallo')).toBe(true);
    expect(chunks.some(chunk => chunk.choices[0]?.delta.tool_calls?.[0]?.function?.name === 'workspace_ls')).toBe(true);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(chunks.at(-1)?.usage?.total_tokens).toBe(9);
  });
});
