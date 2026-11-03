import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { listNativeSlos } from '../nativeSlos.js';

describe('native SLO evaluation', () => {
  it('evaluates reliability budgets and latency objectives with sample floors', async () => {
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.startsWith('SELECT * FROM mcp_observability_slos')) return { rows: [
        { id: 1, name: 'Agent reliability', description: '', metric: 'success_rate', target: '95', window_minutes: 60, min_samples: 20, scope_kind: 'agent', scope_value: '7', enabled: true, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' },
        { id: 2, name: 'Tool latency', description: '', metric: 'p95_latency_ms', target: '1000', window_minutes: 120, min_samples: 50, scope_kind: 'tool', scope_value: 'search', enabled: true, created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z' },
      ] };
      if (params?.[0] === 60) return { rows: [{ total_count: '100', terminal_count: '100', completed_count: '96', failed_count: '4', duration_count: '100', p95_duration_ms: '800', total_cost_usd: '1' }] };
      return { rows: [{ total_count: '10', terminal_count: '10', completed_count: '10', failed_count: '0', duration_count: '10', p95_duration_ms: '1500', total_cost_usd: '0' }] };
    });
    const result = await listNativeSlos({ query } as unknown as pg.Pool);
    const reliability = result.find(slo => slo.id === 1)!;
    const latency = result.find(slo => slo.id === 2)!;
    expect(reliability.evaluation.state).toBe('met');
    expect(reliability.evaluation.errorBudgetRemainingPercent).toBeCloseTo(20);
    expect(reliability.evaluation.burnRate).toBeCloseTo(0.8);
    expect(latency.evaluation.state).toBe('no_data');
    expect(latency.evaluation.actual).toBe(1500);
  });
});
