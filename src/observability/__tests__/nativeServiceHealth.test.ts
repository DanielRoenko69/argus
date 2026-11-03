import { describe, expect, it } from '@jest/globals';
import type { NativeAlertIncident, NativeAlertRule } from '../nativeAlerts.js';
import { buildNativeServiceHealth } from '../nativeServiceHealth.js';
import type { TelemetryAnalytics } from '../telemetryStore.js';

function analytics(overrides: Partial<TelemetryAnalytics['summary']> = {}): TelemetryAnalytics {
  return {
    summary: {
      totalTraces: 100, completedTraces: 96, failedTraces: 4, activeTraces: 0, waitingTraces: 0,
      successRate: 96, errorRate: 4, avgDurationMs: 1200, p50DurationMs: 800, p95DurationMs: 4000,
      totalInputTokens: 1000, totalOutputTokens: 500, totalCostUsd: 2.5, llmCalls: 80, toolCalls: 120,
      ...overrides,
    },
    timeline: [],
    agents: [{ id: 1, name: 'Operator', executions: 60, failures: 2, successRate: 96.7, tokens: 1500, costUsd: 2.5, p95DurationMs: 3800 }],
    workflows: [{ id: 2, name: 'Release guard', executions: 40, failures: 2, successRate: 95, p95DurationMs: 4200 }],
    models: [{ provider: 'openai', model: 'gpt-5', calls: 80, failures: 1, inputTokens: 1000, outputTokens: 500, costUsd: 2.5, avgDurationMs: 700, p95DurationMs: 1800 }],
    tools: [{ tool: 'kubernetes_get_pods', calls: 120, failures: 1, avgDurationMs: 200, p95DurationMs: 500 }],
  };
}

describe('native service health', () => {
  it('builds a healthy score and remaining reliability budget from native analytics', () => {
    const result = buildNativeServiceHealth(analytics(), { rules: [], incidents: [] });
    expect(result.state).toBe('healthy');
    expect(result.score).toBeGreaterThanOrEqual(95);
    expect(result.errorBudget.remainingPercent).toBeCloseTo(20);
    expect(result.slos.map(slo => slo.state)).toEqual(['met', 'met', 'met']);
    expect(result.components).toHaveLength(4);
  });

  it('lets an open critical incident override otherwise healthy telemetry', () => {
    const incident = {
      id: 8, ruleId: 4, ruleName: 'Failure spike', state: 'firing', severity: 'critical', metricValue: 5,
      threshold: 5, sampleCount: 20, message: 'Failure count breached', context: {},
      triggeredAt: '2026-08-01T00:00:00.000Z', recoveredAt: null, notifiedAt: null, correlation: null,
    } satisfies NativeAlertIncident;
    const result = buildNativeServiceHealth(analytics(), { rules: [] as NativeAlertRule[], incidents: [incident] });
    expect(result.state).toBe('critical');
    expect(result.summary.criticalIncidents).toBe(1);
    expect(result.slos.find(slo => slo.id === 'incidents')?.state).toBe('breached');
    expect(result.recommendations[0]?.severity).toBe('critical');
  });
});
