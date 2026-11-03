import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { getAiopsOutcomes } from '../aiopsOutcomes.js';

describe('getAiopsOutcomes', () => {
  it('compresses correlated signals and calculates investigation and remediation outcomes', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({ rows: [{
        actionable_key: 'group:31', service: 'checkout-api', environment: 'production', state: 'recovered', severity: 'critical',
        signal_count: '3', native_signal_count: '2', provider_signal_count: '1', correlation_group_id: '31',
        incident_ids: ['40', '41', '42'],
        first_triggered_at: '2026-09-09T10:00:00.000Z', recovered_at: '2026-09-09T10:10:00.000Z',
      }, {
        actionable_key: 'incident:42', service: 'catalog-api', environment: 'production', state: 'firing', severity: 'warning',
        signal_count: '1', native_signal_count: '1', provider_signal_count: '0', correlation_group_id: null,
        incident_ids: ['43'],
        first_triggered_at: '2026-09-09T11:00:00.000Z', recovered_at: null,
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        actionable_key: 'group:31', state: 'TASK_STATE_COMPLETED', quality: 'reviewed', conclusion: 'confirmed',
        first_triggered_at: '2026-09-09T10:00:00.000Z', created_at: '2026-09-09T10:01:00.000Z', updated_at: '2026-09-09T10:05:00.000Z',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{ actionable_key: 'group:31', status: 'started' }, { actionable_key: 'incident:42', status: 'blocked' }] } as never)
      .mockResolvedValueOnce({ rows: [{
        actionable_key: 'group:31', remediation_id: '9', remediation_status: 'verified', plan_id: '12', plan_status: 'verified', monitor_status: 'healthy',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{ total: '4' }] } as never)
      .mockResolvedValueOnce({ rows: [{
        environment: 'production', source_service: 'checkout-api', target_kind: 'database', target_name: 'postgresql',
        relation: 'queries', calls: '10', failures: '8', p95_duration_ms: '1200', last_seen_at: '2026-09-09T10:04:00.000Z',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        incident_id: '42', provider: 'grafana', monitor_ref: 'CheckoutLatencyHigh', service: 'checkout-api', environment: 'production',
        evidence_url: 'https://grafana.example.test/alerting/list?search=checkout', occurred_at: '2026-09-09T10:00:00.000Z',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        task_id: '81', service_profile_id: '7', service_profile_revision: '3', service_profile_sha256: 'a'.repeat(64),
        service: 'checkout-api', environment: 'production', display_name: 'Checkout API',
        state: 'TASK_STATE_COMPLETED', quality: 'reviewed',
        result_json: {
          schemaVersion: 1,
          evidence: [
            { lane: 'metrics', claim: 'Latency breached the service objective.', sourceRefs: ['prometheus'] },
            { lane: 'logs', claim: 'Timeouts match the incident window.', sourceRefs: ['loki'] },
          ],
        },
        profile_json: {
          evidencePolicy: {
            minimumCollectedLanes: 2,
            lanes: [
              { lane: 'incident', requirement: 'required' },
              { lane: 'metrics', requirement: 'required' },
              { lane: 'logs', requirement: 'optional' },
            ],
          },
        },
        telemetry_trace_count: '3', input_tokens: '1200', output_tokens: '300', recorded_cost_usd: '0.042',
        feedback_reviews: '2', feedback_helpful: '1', feedback_partial: '1', feedback_incorrect: '0',
      }] } as never);

    const result = await getAiopsOutcomes({ query } as unknown as pg.Pool, 30);

    expect(result).toMatchObject({
      schemaVersion: 1,
      window: { days: 30 },
      signals: { total: 4, native: 3, provider: 1, providerDeliveries: 4 },
      incidents: {
        actionable: 2, firing: 1, recovered: 1, correlated: 1, standalone: 1,
        suppressedSignals: 2, compressionRatio: 2, medianRecoveryMs: 600_000,
      },
      investigations: {
        started: 1, completed: 1, partial: 0, failed: 0, blocked: 1, active: 0,
        coveragePercent: 50, completionRatePercent: 100, medianTimeToStartMs: 60_000, medianTimeToCompleteMs: 240_000,
      },
      rootCause: { confirmed: 1, suspected: 0, refuted: 0, inconclusive: 0 },
      remediations: {
        proposed: 1, approved: 1, awaitingApproval: 0, executed: 1, verified: 1,
        failed: 0, rolledBack: 0, successRatePercent: 100, postChangeHealthy: 1, postChangeRegressed: 0,
      },
    });
    expect(result.topServices[0]).toMatchObject({ service: 'checkout-api', incidents: 1, signals: 3 });
    expect(result.graph).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({ kind: 'service', label: 'checkout-api', incidentIds: [40, 41, 42] }),
        expect.objectContaining({ kind: 'database', label: 'postgresql' }),
      ]),
      edges: [expect.objectContaining({ relation: 'queries', evidence: 'causal_candidate', confidence: 'high', failureRate: 0.8 })],
      truncated: { nodes: false, edges: false },
    });
    expect(result.graph.nodes.find(node => node.label === 'checkout-api')?.providerLinks[0]).toMatchObject({
      provider: 'grafana', monitorRef: 'CheckoutLatencyHigh', incidentHref: '/observe/alerts?incident=42',
      externalHref: 'https://grafana.example.test/alerting/list?search=checkout',
    });
    expect(result.profileAttribution).toMatchObject({
      profileBoundInvestigations: 1,
      telemetryLinkedInvestigations: 1,
      totalTokens: 1500,
      recordedCostUsd: 0.042,
      reviewedInvestigations: 1,
      reviews: 2,
      helpful: 1,
      partial: 1,
      incorrect: 0,
      helpfulPercent: 50,
      truncated: false,
      profiles: [{
        profile: { id: 7, revision: 3, service: 'checkout-api', environment: 'production' },
        investigations: 1,
        completedInvestigations: 1,
        evidence: {
          assessedInvestigations: 1,
          investigationsMeetingPolicy: 1,
          policyCoveragePercent: 100,
          configuredLanes: 3,
          requiredLanes: 2,
          optionalLanes: 1,
          lanes: expect.arrayContaining([
            expect.objectContaining({ lane: 'incident', coveragePercent: 100, claims: 1 }),
            expect.objectContaining({ lane: 'metrics', coveragePercent: 100, claims: 1 }),
            expect.objectContaining({ lane: 'logs', coveragePercent: 100, claims: 1 }),
          ]),
        },
        usage: {
          telemetryLinkedInvestigations: 1,
          tokenAttributedInvestigations: 1,
          costAttributedInvestigations: 1,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
          recordedCostUsd: 0.042,
          averageTokensPerInvestigation: 1500,
          averageRecordedCostUsdPerInvestigation: 0.042,
        },
        feedback: {
          reviewedInvestigations: 1, reviews: 2, helpful: 1, partial: 1, incorrect: 0, helpfulPercent: 50,
        },
      }],
    });
    expect(query).toHaveBeenCalledTimes(8);
    expect(String(query.mock.calls[0]?.[0])).toContain("rule.source_kind");
  });

  it('returns stable zero outcomes and clamps the requested window', async () => {
    const query = jest.fn<pg.Pool['query']>()
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [{ total: '0' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [] } as never);

    const result = await getAiopsOutcomes({ query } as unknown as pg.Pool, 999);

    expect(result.window.days).toBe(90);
    expect(result.incidents.compressionRatio).toBe(0);
    expect(result.incidents.medianRecoveryMs).toBeNull();
    expect(result.investigations.coveragePercent).toBe(0);
    expect(result.remediations.successRatePercent).toBe(0);
    expect(result.profileAttribution).toEqual({
      profileBoundInvestigations: 0,
      telemetryLinkedInvestigations: 0,
      totalTokens: 0,
      recordedCostUsd: 0,
      reviewedInvestigations: 0,
      reviews: 0,
      helpful: 0,
      partial: 0,
      incorrect: 0,
      helpfulPercent: 0,
      truncated: false,
      profiles: [],
    });
    expect(result.graph).toEqual({ nodes: [], edges: [], truncated: { nodes: false, edges: false } });
    expect(query.mock.calls.every(call => call[1]?.[0] === 90)).toBe(true);
  });
});
