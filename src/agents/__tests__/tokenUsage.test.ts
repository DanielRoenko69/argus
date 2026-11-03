import { describe, it, expect } from '@jest/globals';
import { tokenUsageEvent } from '../tokenUsage.js';

describe('tokenUsageEvent', () => {
  it('formats an SSE token_usage line with cost from pricing', () => {
    const line = tokenUsageEvent(1000, 500, 'gpt-4o', 0.005, 0.015);
    expect(line.startsWith('data: ')).toBe(true);
    expect(line.endsWith('\n\n')).toBe(true);
    const obj = JSON.parse(line.slice(6));
    expect(obj.token_usage).toEqual({
      prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500,
      cost: 0.0125, model: 'gpt-4o',
    });
  });
  it('cost is 0 when pricing is null (self-hosted/Spark)', () => {
    const obj = JSON.parse(tokenUsageEvent(100, 50, 'spark-local', null, null).slice(6));
    expect(obj.token_usage.cost).toBe(0);
    expect(obj.token_usage.total_tokens).toBe(150);
  });
});
