import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  archiveNativeAlertRule,
  evaluateNativeAlertMetric,
  installNativeAlertTemplate,
  listNativeAlerts,
  listNativeAlertTemplates,
  nativeAlertBreached,
  runNativeAlertEvaluation,
  type NativeAlertRule,
} from '../nativeAlerts.js';

function rule(overrides: Partial<NativeAlertRule> = {}): NativeAlertRule {
  return {
    id: 7,
    name: 'High error rate',
    description: '',
    metric: 'error_rate',
    operator: 'gt',
    threshold: 10,
    windowMinutes: 15,
    minSamples: 5,
    severity: 'critical',
    scopeKind: 'all',
    scopeValue: null,
    cooldownMinutes: 60,
    notify: false,
    enabled: true,
    aiopsAutoInvestigate: false,
    aiopsBundleIds: [],
    aiopsResourceScope: null,
    aiopsService: null,
    aiopsEnvironment: null,
    lastState: 'ok',
    lastValue: 0,
    lastSampleCount: 10,
    lastEvaluatedAt: null,
    lastTriggeredAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    openIncidentId: null,
    ...overrides,
  };
}

describe('native observability alerts', () => {
  it('supports high and low threshold comparisons', () => {
    expect(nativeAlertBreached(12, 'gt', 10)).toBe(true);
    expect(nativeAlertBreached(10, 'gt', 10)).toBe(false);
    expect(nativeAlertBreached(10, 'gte', 10)).toBe(true);
    expect(nativeAlertBreached(89, 'lt', 90)).toBe(true);
    expect(nativeAlertBreached(90, 'lte', 90)).toBe(true);
  });

  it('derives a rate and evidence count from terminal traces', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: [{
      total_count: '12', terminal_count: '10', completed_count: '8', failed_count: '2',
      duration_count: '10', p95_duration_ms: '1800', total_cost_usd: '0.42',
    }] } as never);
    const result = await evaluateNativeAlertMetric({ query } as unknown as pg.Pool, rule());
    expect(result).toEqual({ value: 20, sampleCount: 10 });
    expect(String(query.mock.calls[0]?.[0])).toContain('mcp_observability_traces observation');
  });

  it('compares current P95 latency with a sufficiently sampled seven-day baseline', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValueOnce({ rows: [{
      current_count: '12', current_duration_count: '12', current_p95_duration_ms: '3000', current_avg_cost_usd: '0.03',
      baseline_7d_count: '24', baseline_7d_duration_count: '20', baseline_7d_p95_duration_ms: '2000', baseline_7d_avg_cost_usd: '0.02',
      baseline_30d_count: '80', baseline_30d_duration_count: '75', baseline_30d_p95_duration_ms: '1800', baseline_30d_avg_cost_usd: '0.018',
    }] } as never).mockResolvedValueOnce({ rows: [{
      root_trace_id: '11111111-1111-4111-8111-111111111111',
      trace_id: '11111111-1111-4111-8111-111111111111',
      span_id: '33333333-3333-4333-8333-333333333333', run_kind: 'workflow', title: 'workflow.release',
      workflow_execution_id: 42, started_at: '2026-08-01T12:00:00.000Z', duration_ms: '7000',
      cost_usd: '0.03', dominant_span_label: 'llm.plan',
    }] } as never);
    const result = await evaluateNativeAlertMetric(
      { query } as unknown as pg.Pool,
      rule({ metric: 'latency_regression_percent', threshold: 50, minSamples: 10 }),
    );

    expect(result).toEqual({
      value: 50,
      sampleCount: 12,
      baseline: { value: 2000, currentValue: 3000, sampleCount: 20, windowDays: 7 },
      exemplars: [{
        rootTraceId: '11111111-1111-4111-8111-111111111111',
        traceId: '11111111-1111-4111-8111-111111111111',
        spanId: '33333333-3333-4333-8333-333333333333', runKind: 'workflow', title: 'workflow.release',
        startedAt: '2026-08-01T12:00:00.000Z', durationMs: 7000, costUsd: 0.03,
        dominantSpanLabel: 'llm.plan', href: '/runs/workflow/42?span=33333333-3333-4333-8333-333333333333',
      }],
    });
    expect(String(query.mock.calls[0]?.[0])).toContain("interval '30 days'");
    expect(String(query.mock.calls[0]?.[0])).toContain('observation.id=observation.root_trace_id');
  });

  it('falls back to thirty days for a sparse adaptive cost baseline', async () => {
    const query = jest.fn<pg.Pool['query']>().mockResolvedValueOnce({ rows: [{
      current_count: '14', current_duration_count: '14', current_p95_duration_ms: '1000', current_avg_cost_usd: '0.03',
      baseline_7d_count: '3', baseline_7d_duration_count: '3', baseline_7d_p95_duration_ms: '900', baseline_7d_avg_cost_usd: '0.025',
      baseline_30d_count: '45', baseline_30d_duration_count: '40', baseline_30d_p95_duration_ms: '950', baseline_30d_avg_cost_usd: '0.02',
    }] } as never).mockResolvedValueOnce({ rows: [] } as never);
    const result = await evaluateNativeAlertMetric(
      { query } as unknown as pg.Pool,
      rule({ metric: 'cost_regression_percent', threshold: 40, minSamples: 10 }),
    );

    expect(result.sampleCount).toBe(14);
    expect(result.value).toBeCloseTo(50);
    expect(result.baseline).toEqual({ value: 0.02, currentValue: 0.03, sampleCount: 45, windowDays: 30 });
    expect(result.exemplars).toEqual([]);
  });

  it('creates one persistent incident when a rule breaches', async () => {
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      if (text.includes('FROM mcp_observability_alert_rules rule')) return { rows: [{
        id: 7, name: 'High error rate', description: '', metric: 'error_rate', operator: 'gt',
        threshold: '10', window_minutes: 15, min_samples: 5, severity: 'critical', scope_kind: 'all',
        scope_value: null, cooldown_minutes: 60, notify: false, enabled: true, last_state: 'ok',
        last_value: '0', last_sample_count: 10, last_evaluated_at: null, last_triggered_at: null,
        created_at: '2026-08-01T00:00:00.000Z', updated_at: '2026-08-01T00:00:00.000Z', open_incident_id: null,
      }] };
      if (text.includes('percentile_cont(0.95)')) return { rows: [{
        total_count: '12', terminal_count: '10', completed_count: '8', failed_count: '2',
        duration_count: '10', p95_duration_ms: '1800', total_cost_usd: '0.42',
      }] };
      if (text.includes('INSERT INTO mcp_observability_alert_incidents')) return { rows: [{ id: 81 }] };
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: jest.fn() } as unknown as pg.PoolClient;
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    const result = await runNativeAlertEvaluation(pool);

    expect(result).toEqual({ evaluated: 1, fired: 1, recovered: 0, skipped: false });
    expect(query.mock.calls.some(call => String(call[0]).includes('INSERT INTO mcp_observability_alert_incidents'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('reports installed preset rules and installs a preset transactionally', async () => {
    const installedNames = ['SLO · Reliability budget burn', 'SLO · Critical reliability regression'];
    const poolQuery = jest.fn<pg.Pool['query']>().mockResolvedValue({ rows: installedNames.map(name => ({ name })) } as never);
    const clientQuery = jest.fn(async (sql: unknown) => ({ rows: [], rowCount: String(sql).includes('INSERT INTO') ? 1 : null }));
    const client = { query: clientQuery, release: jest.fn() } as unknown as pg.PoolClient;
    const pool = { query: poolQuery, connect: jest.fn(async () => client) } as unknown as pg.Pool;

    const listed = await listNativeAlertTemplates(pool);
    expect(listed.find(template => template.id === 'reliability-slo')?.installed).toBe(true);

    const result = await installNativeAlertTemplate(pool, 'reliability-slo', 1);
    expect(result.created).toBe(2);
    expect(result.template.installed).toBe(true);
    expect(clientQuery.mock.calls.some(call => String(call[0]).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(clientQuery.mock.calls.some(call => call[0] === 'COMMIT')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });

  it('projects durable correlation evidence with each incident', async () => {
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('AS enabled_rules')) return { rows: [{
        enabled_rules: '0', firing_rules: '0', incidents_24h: '1', recovered_24h: '0',
      }] };
      if (text.includes('membership.group_id AS correlation_group_id')) return { rows: [{
        id: 81, rule_id: 7, rule_name: 'Checkout latency', state: 'firing', severity: 'critical',
        metric_value: '2200', threshold: '2000', sample_count: 12, message: 'Latency breached', context: {},
        triggered_at: '2026-09-09T10:00:00.000Z', recovered_at: null, notified_at: null,
        correlation_group_id: '31', correlation_key: 'a'.repeat(64), correlation_role: 'member',
        grouping_reasons: [{ code: 'same_service', summary: 'Signals target the same service.', evidence: { service: 'checkout-api' } }],
        correlation_service: 'checkout-api', correlation_environment: 'production', correlation_state: 'firing',
        correlation_severity: 'critical', correlation_window_minutes: '30', primary_incident_id: '80',
        correlation_signal_count: '2', correlation_first_triggered_at: '2026-09-09T09:58:00.000Z',
        correlation_last_signal_at: '2026-09-09T10:00:00.000Z', correlation_recovered_at: null,
        correlation_grouped_at: '2026-09-09T10:00:00.100Z',
      }] };
      return { rows: [] };
    });

    const result = await listNativeAlerts({ query } as unknown as pg.Pool);

    expect(result.incidents[0]?.correlation).toMatchObject({
      groupId: 31, role: 'member', service: 'checkout-api', environment: 'production',
      primaryIncidentId: 80, signalCount: 2, correlationWindowMinutes: 30,
    });
    expect(result.incidents[0]?.correlation?.groupingReasons[0]?.code).toBe('same_service');
  });

  it('archives a rule and recovers its open incident without deleting audit evidence', async () => {
    const query = jest.fn(async (text: string) => {
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('UPDATE mcp_observability_alert_rules')) return { rows: [{ id: 7 }], rowCount: 1 };
      if (text.includes('UPDATE mcp_observability_alert_incidents')) return { rows: [], rowCount: 1 };
      if (text.includes('UPDATE mcp_observability_alert_incident_groups')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${text}`);
    });
    const client = { query, release: jest.fn() };
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;

    await expect(archiveNativeAlertRule(pool, 7, 1)).resolves.toBe(true);

    expect(query.mock.calls.some(call => String(call[0]).startsWith('DELETE'))).toBe(false);
    expect(query.mock.calls.some(call => String(call[0]).includes("state='recovered'"))).toBe(true);
    expect(query.mock.calls.some(call => call[0] === 'COMMIT')).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
