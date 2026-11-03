import { describe, expect, it } from '@jest/globals';
import {
  classifyWorkerError,
  classifyWorkerTermination,
  normalizeToolArguments,
  observeWorkerStreamChunk,
  parseTextToolCall,
  parseTextToolCalls,
  workerToolChoice,
} from '../claudeRunner.js';

describe('worker telemetry', () => {
  it('captures usage-only terminal chunks after the finish reason event', () => {
    const initial = { inputTokens: 0, outputTokens: 0, finishReason: null };
    const finished = observeWorkerStreamChunk(initial, {
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    });
    const withUsage = observeWorkerStreamChunk(finished, {
      choices: [],
      usage: { prompt_tokens: 3210, completion_tokens: 418, total_tokens: 3628 },
    });

    expect(withUsage).toEqual({
      inputTokens: 3210,
      outputTokens: 418,
      finishReason: 'tool_calls',
    });
  });

  it('classifies token truncation, empty output and transport failures separately', () => {
    expect(classifyWorkerTermination({
      finishReason: 'length', hasText: true, toolCallCount: 0,
    })).toBe('token_limit');
    expect(classifyWorkerTermination({
      finishReason: 'stop', hasText: false, toolCallCount: 0,
    })).toBe('empty_response');
    expect(classifyWorkerTermination({
      finishReason: 'tool_calls', hasText: false, toolCallCount: 1,
    })).toBe('tool_calls');
    expect(classifyWorkerError(new TypeError('fetch failed'))).toBe('network_error');
    expect(classifyWorkerError(new DOMException('timed out', 'TimeoutError'))).toBe('timeout');
  });
});

describe('workerToolChoice', () => {
  it('requires the first worker turn to touch a real tool', () => {
    expect(workerToolChoice(0, ['workspace_ls', 'workspace_read'])).toBe('required');
  });

  it('returns to automatic selection after the grounding turn', () => {
    expect(workerToolChoice(1, ['workspace_ls'])).toBe('auto');
    expect(workerToolChoice(7, ['workspace_ls'])).toBe('auto');
  });

  it('does not emit a tool policy when no tools are available', () => {
    expect(workerToolChoice(0, [])).toBeUndefined();
  });

  it('forces a declared coding sequence when the tools are available', () => {
    const tools = ['workspace_ls', 'workspace_read', 'workspace_write'];
    const sequence = ['workspace_ls', 'workspace_read', 'workspace_write'];
    expect(workerToolChoice(0, tools, sequence)).toBe('required');
    expect(workerToolChoice(2, tools, sequence)).toBe('required');
    expect(workerToolChoice(3, tools, sequence)).toBe('auto');
  });
});

describe('normalizeToolArguments', () => {
  it('canonicalizes valid object arguments', () => {
    expect(normalizeToolArguments('{ "path": "/workspace/demo" }')).toBe('{"path":"/workspace/demo"}');
  });

  it('recovers the first object from repeated streaming payloads', () => {
    expect(normalizeToolArguments(
      '{"path":"/workspace/demo"}{"path":"/workspace/demo"}',
    )).toBe('{"path":"/workspace/demo"}');
  });

  it('fails closed for incomplete or non-object arguments', () => {
    expect(normalizeToolArguments('{"path":')).toBe('{}');
    expect(normalizeToolArguments('["/workspace"]')).toBe('{}');
  });
});

describe('parseTextToolCall', () => {
  it('normalizes the strict JSON tool shape emitted by local Ollama coders', () => {
    expect(parseTextToolCall(
      '{"name":"workspace_write","arguments":{"path":"/workspace/demo.txt","content":"hello"}}',
      ['workspace_write'],
    )).toMatchObject({
      type: 'function',
      function: {
        name: 'workspace_write',
        arguments: '{"path":"/workspace/demo.txt","content":"hello"}',
      },
    });
  });

  it('accepts a JSON fence but rejects tools outside the advertised iteration catalog', () => {
    expect(parseTextToolCall(
      '```json\n{"name":"workspace_write","arguments":{"path":"/workspace/demo.txt","content":"hello"}}\n```',
      ['workspace_write'],
    )).not.toBeNull();
    expect(parseTextToolCall(
      '{"name":"workspace_exec","arguments":{"cmd":"whoami"}}',
      ['workspace_write'],
    )).toBeNull();
  });

  it('uses the final corrected call from a tool-only multi-fence response', () => {
    expect(parseTextToolCall(
      '```json\n{"name":"workspace_ls","arguments":{}}\n```' +
      '```json\n{"name":"workspace_ls","arguments":{"path":"/workspace/current"}}\n```',
      ['workspace_ls'],
    )).toMatchObject({
      function: {
        name: 'workspace_ls',
        arguments: '{"path":"/workspace/current"}',
      },
    });
  });

  it('preserves an authorized list-read-write batch emitted in one local-model turn', () => {
    const calls = parseTextToolCalls(
      '```json\n{"name":"workspace_ls","arguments":{"path":"/workspace/current"}}\n```' +
      '```\n{"name":"workspace_read","arguments":{"path":"/workspace/current/src/app.js"}}\n```' +
      '```json\n{"name":"workspace_write","arguments":{"path":"/workspace/current/src/app.js","content":"updated"}}\n```',
      ['workspace_ls', 'workspace_read', 'workspace_write'],
    );
    expect(calls.map(call => call.function.name)).toEqual([
      'workspace_ls',
      'workspace_read',
      'workspace_write',
    ]);
    expect(calls[2]).toMatchObject({
      function: {
        name: 'workspace_write',
        arguments: '{"path":"/workspace/current/src/app.js","content":"updated"}',
      },
    });
  });

  it('recovers a workspace write when a local model leaves literal newlines in content JSON', () => {
    const calls = parseTextToolCalls(
      '{"name":"workspace_read","arguments":{"path":"/workspace/current/src/app.js"}}' +
      '{"name":"workspace_write","arguments":{"path":"/workspace/src/app.js","content":"line one\nline two\n"}}',
      ['workspace_read', 'workspace_write'],
    );
    expect(calls.map(call => call.function.name)).toEqual(['workspace_read', 'workspace_write']);
    expect(JSON.parse(calls[1]!.function.arguments)).toEqual({
      path: '/workspace/current/src/app.js',
      content: 'line one\nline two\n',
    });
  });

  it('accepts a valid call surrounded by explanatory prose', () => {
    expect(parseTextToolCall(
      'I will inspect the workspace first.\n```json\n{"name":"workspace_ls","arguments":{"path":"/workspace/current"}}\n```\nThen I can continue.',
      ['workspace_ls'],
    )).toMatchObject({
      function: {
        name: 'workspace_ls',
        arguments: '{"path":"/workspace/current"}',
      },
    });
    expect(parseTextToolCall(
      'Calling now: {"tool":"workspace_read","args":{"path":"/workspace/current/README.md"}}',
      ['workspace_read'],
    )).toMatchObject({
      function: {
        name: 'workspace_read',
        arguments: '{"path":"/workspace/current/README.md"}',
      },
    });
  });

  it('does not reinterpret ordinary assistant prose or unknown tools as a tool call', () => {
    expect(parseTextToolCall('I would write the file next.', ['workspace_write'])).toBeNull();
    expect(parseTextToolCall(
      'For example: ```json\n{"name":"workspace_exec","arguments":{"cmd":"whoami"}}\n```',
      ['workspace_write'],
    )).toBeNull();
  });
});
