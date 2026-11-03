import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  correlateNativeAlertIncident,
  decideAlertCorrelation,
  type AlertCorrelationPolicy,
} from '../alertIncidentCorrelation.js';
import type { NativeAlertRule } from '../nativeAlerts.js';

const policy: AlertCorrelationPolicy = {
  service: 'checkout-api',
  environment: 'production',
  correlationWindowMinutes: 30,
  serviceProfile: { id: 41, revision: 3, sha256: 'a'.repeat(64) },
};

function rule(): NativeAlertRule {
  return {
    id: 7, name: 'Checkout latency', description: '', metric: 'p95_latency_ms', operator: 'gt',
    threshold: 2_000, windowMinutes: 30, minSamples: 5, severity: 'critical', scopeKind: 'all',
    scopeValue: null, cooldownMinutes: 30, notify: false, enabled: true, aiopsAutoInvestigate: true,
    aiopsBundleIds: [], aiopsResourceScope: null, aiopsService: null, aiopsEnvironment: null,
    lastState: 'ok', lastValue: null, lastSampleCount: 0, lastEvaluatedAt: null, lastTriggeredAt: null,
    createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z', openIncidentId: null,
  };
}

describe('native alert incident correlation', () => {
  it('groups the same service and environment inside the configured window with explicit reasons', () => {
    const decision = decideAlertCorrelation(policy, '2026-09-09T10:20:00.000Z', {
      id: 12,
      service: 'Checkout-API',
      environment: 'PRODUCTION',
      lastSignalAt: '2026-09-09T10:00:00.000Z',
    });

    expect(decision.matched).toBe(true);
    expect(decision.reasons.map(reason => reason.code)).toEqual([
      'same_service', 'same_environment', 'within_correlation_window',
    ]);
    expect(decision.reasons[2]?.evidence).toEqual({ deltaSeconds: 1_200, correlationWindowMinutes: 30 });
  });

  it('isolates foreign services and signals outside the time window', () => {
    expect(decideAlertCorrelation(policy, '2026-09-09T10:10:00.000Z', {
      id: 12, service: 'payments-api', environment: 'production', lastSignalAt: '2026-09-09T10:00:00.000Z',
    }).matched).toBe(false);
    expect(decideAlertCorrelation(policy, '2026-09-09T10:31:00.000Z', {
      id: 12, service: 'checkout-api', environment: 'production', lastSignalAt: '2026-09-09T10:00:00.000Z',
    }).matched).toBe(false);
  });

  it('persists a member on the existing group instead of opening a second group', async () => {
    const writes: Array<{ sql: string; params: unknown[] }> = [];
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM mcp_observability_aiops_service_profiles')) return { rows: [{
        id: 41, revision: 3, sha256: 'a'.repeat(64), service: 'checkout-api', environment: 'production',
        correlation_window_minutes: '30',
      }] };
      if (text.includes('FROM mcp_observability_alert_incident_groups')) return { rows: [{
        id: 91, correlation_key: 'b'.repeat(64), service: 'checkout-api', environment: 'production',
        last_signal_at: '2026-09-09T10:00:00.000Z',
      }] };
      writes.push({ sql: text, params: params ?? [] });
      return { rows: [], rowCount: 1 };
    });

    const result = await correlateNativeAlertIncident({ query } as unknown as pg.Pool, {
      incidentId: 82,
      rule: rule(),
      severity: 'warning',
      triggeredAt: '2026-09-09T10:12:00.000Z',
    });

    expect(result).toMatchObject({ groupId: 91, correlationKey: 'b'.repeat(64), role: 'member' });
    expect(writes.some(write => write.sql.includes('INSERT INTO mcp_observability_alert_incident_groups'))).toBe(false);
    const membership = writes.find(write => write.sql.includes('INSERT INTO mcp_observability_alert_incident_group_members'));
    expect(membership?.params.slice(0, 3)).toEqual([91, 82, 'member']);
  });

  it('opens a stable primary group when no matching incident exists', async () => {
    const writes: string[] = [];
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('FROM mcp_observability_aiops_service_profiles')) return { rows: [{
        id: 41, revision: 3, sha256: 'a'.repeat(64), service: 'checkout-api', environment: 'production',
        correlation_window_minutes: '30',
      }] };
      if (text.includes('FROM mcp_observability_alert_incident_groups')) return { rows: [] };
      writes.push(text);
      if (text.includes('INSERT INTO mcp_observability_alert_incident_groups')) return { rows: [{ id: 92 }] };
      return { rows: [], rowCount: 1 };
    });

    const result = await correlateNativeAlertIncident({ query } as unknown as pg.Pool, {
      incidentId: 83,
      rule: rule(),
      severity: 'critical',
      triggeredAt: '2026-09-09T10:45:00.000Z',
    });

    expect(result?.role).toBe('primary');
    expect(result?.groupId).toBe(92);
    expect(result?.correlationKey).toMatch(/^[a-f0-9]{64}$/);
    expect(result?.reasons.map(reason => reason.code)).toEqual(['primary_signal']);
    expect(writes.filter(sql => sql.includes('INSERT INTO mcp_observability_alert_incident_groups'))).toHaveLength(1);
  });
});
