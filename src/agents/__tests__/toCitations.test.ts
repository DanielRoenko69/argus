import { describe, it, expect } from '@jest/globals';
import { toCitations, attachCitationsToLastAssistant } from '../ragClient.js';
import type { RagResult } from '../ragClient.js';
import type { ChatMessage, Citation } from '../types.js';

describe('toCitations', () => {
  it('maps RagResult[] → Citation[] (index label, truncated snippet, source fallback)', () => {
    const results = [
      { id: 'd1', score: 0.91, content: 'x'.repeat(500), source: 'runbook.md' },
      { id: 'd2', score: 0.4, content: 'short' },
    ] as RagResult[];
    const cites = toCitations(results, 'Ops-KB');
    expect(cites).toHaveLength(2);
    expect(cites[0]).toEqual({ source: 'runbook.md', snippet: 'x'.repeat(300), score: 0.91, index: 'Ops-KB' });
    expect(cites[1].source).toBe('');
    expect(cites[1].snippet).toBe('short');
    expect(cites[1].index).toBe('Ops-KB');
  });
});

describe('attachCitationsToLastAssistant', () => {
  const cites: Citation[] = [{ source: 'r.md', snippet: 's', score: 0.5, index: 'KB' }];

  it('attaches to the LAST assistant (final answer), not a tool-calling intermediate', () => {
    const msgs: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', content: 'res', tool_call_id: 't1' },
      { role: 'assistant', content: 'the answer' },
    ];
    attachCitationsToLastAssistant(msgs, cites);
    expect(msgs[0]!.citations).toBeUndefined();
    expect(msgs[2]!.citations).toEqual(cites);
  });

  it('single assistant turn → attaches to it', () => {
    const msgs: ChatMessage[] = [{ role: 'assistant', content: 'answer' }];
    attachCitationsToLastAssistant(msgs, cites);
    expect(msgs[0]!.citations).toEqual(cites);
  });

  it('no-op for empty citations or when there is no assistant message', () => {
    const a: ChatMessage[] = [{ role: 'assistant', content: 'x' }];
    attachCitationsToLastAssistant(a, []);
    expect(a[0]!.citations).toBeUndefined();
    const t: ChatMessage[] = [{ role: 'tool', content: 'x', tool_call_id: 't' }];
    attachCitationsToLastAssistant(t, cites);
    expect(t[0]!.citations).toBeUndefined();
  });
});
