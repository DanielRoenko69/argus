import { describe, expect, it } from '@jest/globals';
import { compareTelemetryTraceFamilies } from '../traceComparison.js';

const trace = (id: string, startedAt: string, durationMs: number) => ({
  id,
  parent_trace_id: null,
  parent_span_id: null,
  name: 'workflow.release',
  kind: 'workflow' as const,
  status: 'completed' as const,
  started_at: startedAt,
  ended_at: new Date(Date.parse(startedAt) + durationMs).toISOString(),
  duration_ms: durationMs,
  total_cost_usd: 0,
});

const span = (
  id: string,
  traceId: string,
  name: string,
  startedAt: string,
  durationMs: number,
  costUsd = 0,
  status: 'completed' | 'failed' = 'completed',
) => ({
  id,
  trace_id: traceId,
  parent_span_id: null,
  name,
  kind: name.startsWith('llm') ? 'llm' as const : 'tool' as const,
  status,
  started_at: startedAt,
  ended_at: new Date(Date.parse(startedAt) + durationMs).toISOString(),
  duration_ms: durationMs,
  total_cost_usd: costUsd,
  tool_name: name.startsWith('tool') ? name : null,
});

describe('native trace comparison', () => {
  it('matches regenerated IDs by structural path and ranks latency and status regressions', () => {
    const baselineStart = '2026-07-30T12:00:00.000Z';
    const currentStart = '2026-07-31T12:00:00.000Z';
    const result = compareTelemetryTraceFamilies({
      traces: [trace('22222222-2222-4222-8222-222222222222', currentStart, 7000)],
      spans: [
        span('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', 'llm.plan', currentStart, 3000, 0.03),
        span('44444444-4444-4444-8444-444444444444', '22222222-2222-4222-8222-222222222222', 'tool.deploy', currentStart, 1000, 0, 'failed'),
      ],
    }, {
      traces: [trace('11111111-1111-4111-8111-111111111111', baselineStart, 5000)],
      spans: [
        span('55555555-5555-4555-8555-555555555555', '11111111-1111-4111-8111-111111111111', 'llm.plan', baselineStart, 2000, 0.02),
        span('66666666-6666-4666-8666-666666666666', '11111111-1111-4111-8111-111111111111', 'tool.deploy', baselineStart, 1000),
      ],
    });

    expect(result?.summary).toMatchObject({
      durationDeltaMs: 2000,
      durationDeltaPercent: 40,
      failedNodeDelta: 1,
      regressionCount: 2,
    });
    expect(result?.summary.costDeltaUsd).toBeCloseTo(0.01);
    expect(result?.summary.costDeltaPercent).toBeCloseTo(50);
    expect(result?.changes.map(change => [change.label, change.change])).toEqual([
      ['tool.deploy', 'status_regression'],
      ['llm.plan', 'regression'],
    ]);
    expect(result?.changes[1]).toMatchObject({ currentDurationMs: 3000, baselineDurationMs: 2000, durationDeltaPercent: 50 });
  });

  it('returns no comparison without two trace families', () => {
    expect(compareTelemetryTraceFamilies({ traces: [], spans: [] }, { traces: [], spans: [] })).toBeNull();
  });
});
