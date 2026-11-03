import { getIncidentImpact, incidentImpactLabels, mergeIncidentImpactLabels } from '../incidentImpact.js';

describe('incident dependency impact', () => {
  it('builds a bounded upstream/downstream blast radius and ranks failed downstream evidence', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 81, triggered_at: '2026-08-12T20:00:00.000Z', recovered_at: null,
        aiops_service: 'checkout-api', aiops_environment: 'demo',
      }] })
      .mockResolvedValueOnce({ rows: [{
        source_service: 'frontend', target_kind: 'service', target_name: 'checkout-api', relation: 'calls',
        calls: 20, failures: 1, p95_duration_ms: 80, last_seen_at: '2026-08-12T20:05:00.000Z',
      }, {
        source_service: 'checkout-api', target_kind: 'database', target_name: 'redis', relation: 'queries',
        calls: 4, failures: 4, p95_duration_ms: 900, last_seen_at: '2026-08-12T20:06:00.000Z',
      }, {
        source_service: 'checkout-api', target_kind: 'service', target_name: 'payments-api', relation: 'calls',
        calls: 5, failures: 1, p95_duration_ms: 450, last_seen_at: '2026-08-12T20:06:00.000Z',
      }, {
        source_service: 'payments-api', target_kind: 'database', target_name: 'postgresql', relation: 'queries',
        calls: 5, failures: 5, p95_duration_ms: 1200, last_seen_at: '2026-08-12T20:07:00.000Z',
      }] });

    const result = await getIncidentImpact({ query } as never, 81);

    expect(result).toMatchObject({
      available: true,
      service: 'checkout-api',
      environment: 'demo',
      summary: {
        upstreamServices: 1,
        downstreamServices: 1,
        externalDependencies: 2,
        failingDependencies: 3,
        observedCalls: 14,
        observedFailures: 10,
      },
    });
    expect(result?.impactedServices).toEqual(expect.arrayContaining([
      expect.objectContaining({ service: 'frontend', direction: 'upstream', depth: 1 }),
      expect.objectContaining({ service: 'payments-api', direction: 'downstream', depth: 1 }),
    ]));
    expect(result?.rootCauseCandidates[0]).toMatchObject({
      targetName: 'redis', confidence: 'high', direction: 'downstream', depth: 1, failureRate: 1,
    });
    expect(result?.rootCauseCandidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetName: 'postgresql', depth: 2 }),
    ]));
    expect(String(query.mock.calls[1]?.[0])).toContain("interval '60 minutes'");
  });

  it('fails closed without an explicit alert service boundary', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{
      id: 82, triggered_at: '2026-08-12T20:00:00.000Z', recovered_at: null,
      aiops_service: null, aiops_environment: null,
    }] });
    const result = await getIncidentImpact({ query } as never, 82);
    expect(result).toMatchObject({ available: false, service: null, environment: null });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('returns null for an unknown incident', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [] });
    await expect(getIncidentImpact({ query } as never, 404)).resolves.toBeNull();
  });

  it('projects only bounded aggregate evidence into the strict AIOps label contract', () => {
    const labels = incidentImpactLabels({
      incidentId: 81, generatedAt: '2026-08-12T20:00:00.000Z', available: true, reason: null,
      service: 'checkout-api', environment: 'demo', window: { minutesBefore: 60, minutesAfter: 30 },
      summary: { upstreamServices: 1, downstreamServices: 1, externalDependencies: 1, failingDependencies: 1, observedCalls: 4, observedFailures: 4 },
      impactedServices: [{ service: 'frontend', direction: 'upstream', depth: 1, path: ['frontend', 'checkout-api'] }],
      dependencies: [{
        sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
        direction: 'downstream', depth: 1, path: ['checkout-api', 'postgresql'], calls: 4, failures: 4,
        failureRate: 1, p95DurationMs: 1200, lastSeenAt: '2026-08-12T20:00:00.000Z',
      }],
      rootCauseCandidates: [{
        sourceService: 'checkout-api', targetKind: 'database', targetName: 'postgresql', relation: 'queries',
        direction: 'downstream', depth: 1, path: ['checkout-api', 'postgresql'], calls: 4, failures: 4,
        failureRate: 1, p95DurationMs: 1200, lastSeenAt: '2026-08-12T20:00:00.000Z', confidence: 'high',
        reason: 'Aggregate evidence only.',
      }],
    });
    expect(labels).toMatchObject({
      'argus.core.impact.status': 'observed',
      'argus.core.impact.source': 'argus.core',
    });
    expect(labels['argus.core.impact.candidate.1']).toContain('target=database:postgresql');
    expect(labels['argus.core.impact.service_path.1']).toContain('frontend -> checkout-api');
    expect(Object.keys(labels).length).toBeLessThanOrEqual(29);
    expect(Object.values(labels).every(value => value.length <= 500 && !/[\r\n\t]/.test(value))).toBe(true);
    expect(JSON.stringify(labels)).not.toContain('raw');
  });

  it('preserves ordinary labels but replaces spoofed Core impact context', () => {
    const labels = mergeIncidentImpactLabels({
      team: 'payments',
      'argus.core.impact.status': 'observed',
      'argus.core.impact.candidate.1': 'fake root cause',
      invalid: 42,
    }, null);
    expect(labels).toEqual({
      team: 'payments',
      'argus.core.impact.schema': '1',
      'argus.core.impact.status': 'unavailable',
    });
  });
});
