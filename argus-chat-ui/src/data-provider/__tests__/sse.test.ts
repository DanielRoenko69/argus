import { describe, it, expect } from 'vitest';
import { parseSseChunk, type SseEvent } from '../sse';

describe('parseSseChunk', () => {
  it('parses delta / tool_call / tool_result / error / DONE and ignores heartbeats', () => {
    const events: SseEvent[] = [];
    let buf = '';
    const feed = (s: string) => { buf = parseSseChunk(buf + s, (e) => events.push(e)); };
    feed('data: {"delta":"Hel');                 // split mid-JSON across chunks
    feed('lo"}\n\n');
    feed(': heartbeat\n\n');
    feed('data: {"tool_call":{"name":"k8s_get","args":{"x":1}}}\n\n');
    feed('data: {"tool_result":{"name":"k8s_get","preview":"ok"}}\n\n');
    feed('data: {"error":"boom"}\n\n');
    feed('data: [DONE]\n\n');
    expect(events).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'tool_call', name: 'k8s_get', args: { x: 1 } },
      { type: 'tool_result', name: 'k8s_get', preview: 'ok' },
      { type: 'error', message: 'boom' },
      { type: 'done' },
    ]);
    expect(buf).toBe('');
  });

  it('flushes multiple complete blocks arriving in a single chunk', () => {
    const events: SseEvent[] = [];
    let buf = '';
    buf = parseSseChunk(
      buf + 'data: {"delta":"A"}\n\ndata: {"delta":"B"}\n\ndata: [DONE]\n\n',
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { type: 'delta', text: 'A' },
      { type: 'delta', text: 'B' },
      { type: 'done' },
    ]);
    expect(buf).toBe('');
  });

  it('leaves trailing partial block in the buffer without emitting', () => {
    const events: SseEvent[] = [];
    let buf = '';
    buf = parseSseChunk('data: {"delta":"part', (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(buf).toBe('data: {"delta":"part');
    // completing the block in the next chunk flushes it
    buf = parseSseChunk(buf + 'ial"}\n\n', (e) => events.push(e));
    expect(events).toEqual([{ type: 'delta', text: 'partial' }]);
    expect(buf).toBe('');
  });

  it('silently ignores blocks with unrecognised JSON keys', () => {
    const events: SseEvent[] = [];
    let buf = '';
    buf = parseSseChunk('data: {"unknown_key":"value"}\n\n', (e) => events.push(e));
    expect(events).toHaveLength(0);
    expect(buf).toBe('');
  });

  it('parses a token_usage event into a usage SseEvent', () => {
    const events: SseEvent[] = [];
    parseSseChunk('data: {"token_usage":{"prompt_tokens":1000,"completion_tokens":500,"total_tokens":1500,"cost":0.0125,"model":"gpt-4o"}}\n\n', (e) => events.push(e));
    expect(events).toEqual([{ type: 'usage', prompt: 1000, completion: 500, total: 1500, cost: 0.0125, model: 'gpt-4o' }]);
  });

  it('preserves tool execution metadata and structured approval requests', () => {
    const events: SseEvent[] = [];
    parseSseChunk(
      'data: {"tool_call":{"id":"call-1","name":"k8s_apply","args":{"namespace":"prod"}}}\n\n' +
      'data: {"tool_result":{"tool_call_id":"call-1","name":"k8s_apply","preview":"blocked","duration_ms":42,"is_error":true,"trace_id":"trace-1","span_id":"span-1"}}\n\n' +
      'data: {"approval_requested":{"approval_id":"17","action_description":"Requires review","tool_name":"k8s_apply","target_scope":"namespace:prod","parameters":{"namespace":"prod"},"risk_level":"high","risk_score":72,"risk_factors":[],"expected_impacts":[],"ttl_seconds":1800,"created_at":"2026-08-19T10:00:00.000Z"}}\n\n',
      (event) => events.push(event),
    );
    expect(events).toEqual([
      { type: 'tool_call', id: 'call-1', name: 'k8s_apply', args: { namespace: 'prod' } },
      { type: 'tool_result', id: 'call-1', name: 'k8s_apply', preview: 'blocked', durationMs: 42, isError: true, traceId: 'trace-1', spanId: 'span-1' },
      expect.objectContaining({ type: 'approval_requested', approval: expect.objectContaining({ approval_id: '17', risk_level: 'high' }) }),
    ]);
  });
});
