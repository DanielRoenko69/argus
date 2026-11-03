import { describe, expect, it } from '@jest/globals';
import { assessHistoricalTraceBaseline, type HistoricalTraceWindow } from '../traceBaseline.js';

const window = (days: 7 | 30, sampleCount: number, overrides: Partial<HistoricalTraceWindow> = {}): HistoricalTraceWindow => ({
  days,
  sampleCount,
  terminalCount: sampleCount,
  medianDurationMs: 1000,
  p95DurationMs: 1800,
  medianCostUsd: 0.02,
  p95CostUsd: 0.04,
  successRate: 98,
  ...overrides,
});

describe('historical trace baseline', () => {
  it('prefers a sufficiently sampled seven-day window and flags a strong regression', () => {
    const result = assessHistoricalTraceBaseline(
      { durationMs: 2500, costUsd: 0.06 },
      [window(7, 35), window(30, 100)],
    );
    expect(result).toMatchObject({
      selectedWindowDays: 7,
      confidence: 'high',
      sampleCount: 35,
      durationDeltaPercent: 150,
      durationState: 'critical',
      costState: 'critical',
    });
    expect(result.costDeltaPercent).toBeCloseTo(200);
  });

  it('falls back to thirty days and exposes low-confidence sparse history', () => {
    expect(assessHistoricalTraceBaseline(
      { durationMs: 1100, costUsd: 0.021 },
      [window(7, 3), window(30, 18)],
    )).toMatchObject({ selectedWindowDays: 30, confidence: 'medium', durationState: 'normal' });
    expect(assessHistoricalTraceBaseline(
      { durationMs: 1100, costUsd: 0.021 },
      [window(7, 2), window(30, 5)],
    )).toMatchObject({ selectedWindowDays: 30, confidence: 'low' });
  });

  it('returns no-data states without historical evidence', () => {
    expect(assessHistoricalTraceBaseline({ durationMs: 1000, costUsd: 0 }, [])).toMatchObject({
      selectedWindowDays: null, confidence: 'none', durationState: 'no_data', costState: 'no_data',
    });
  });
});
