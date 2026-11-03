import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  AiOpsProviderSignalError,
  ingestAiOpsProviderSignals,
  normalizeAiOpsProviderSignals,
} from '../aiopsProviderSignals.js';

function activeConfig(): Record<string, unknown> {
  const resource = JSON.parse(readFileSync(resolve(
    process.cwd(),
    'docs/specs/aiops-service-profiles/service-profile-active.v1.fixture.json',
  ), 'utf8')) as { latestRevision: { config: Record<string, unknown> } };
  const config = structuredClone(resource.latestRevision.config);
  (config['detection'] as Record<string, unknown>)['providerMonitorRefs'] = ['CheckoutLatencyHigh'];
  return config;
}

describe('AIOps provider signal ingestion', () => {
  it('normalizes an Alertmanager payload into the bounded Argus signal contract', () => {
    const normalized = normalizeAiOpsProviderSignals('prometheus-alertmanager', {
      status: 'firing',
      receiver: 'argus',
      groupKey: '{}:{alertname="CheckoutLatencyHigh"}',
      alerts: [{
        status: 'firing',
        labels: {
          alertname: 'CheckoutLatencyHigh',
          service_name: 'checkout-api',
          environment: 'production',
          severity: 'critical',
        },
        annotations: { summary: 'Checkout P95 latency exceeded 2s.' },
        generatorURL: 'https://grafana.example.test/alerting/list?search=checkout&token=do-not-store#secret',
        startsAt: '2026-09-09T12:00:00.000Z',
        fingerprint: 'alert-fingerprint-1',
      }],
    });

    expect(normalized.provider).toBe('prometheus-alertmanager');
    expect(normalized.signals).toHaveLength(1);
    expect(normalized.signals[0]).toMatchObject({
      monitorRef: 'CheckoutLatencyHigh', service: 'checkout-api', environment: 'production',
      severity: 'critical', state: 'firing', fingerprint: 'alert-fingerprint-1',
      evidenceUrl: 'https://grafana.example.test/alerting/list?search=checkout',
    });
    expect(normalized.signals[0]?.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('drops unsafe provider evidence URLs without rejecting the incident signal', () => {
    const normalized = normalizeAiOpsProviderSignals('generic', {
      schemaVersion: 1,
      signals: [{
        schemaVersion: 1, eventId: 'event-unsafe-link', monitorRef: 'checkout-errors', state: 'firing', severity: 'warning',
        title: 'Checkout errors', summary: 'Errors observed.', service: 'checkout-api', environment: 'production',
        occurredAt: '2026-09-09T12:00:00.000Z', evidenceUrl: 'javascript:alert(1)', labels: {},
      }],
    });

    expect(normalized.signals[0]?.evidenceUrl).toBeUndefined();
  });

  it('accepts the canonical connector envelope used by Elasticsearch and OpenSearch', () => {
    const normalized = normalizeAiOpsProviderSignals('elasticsearch', {
      schemaVersion: 1,
      signals: [{
        schemaVersion: 1,
        eventId: 'elastic-event-42', monitorRef: 'checkout-errors', state: 'firing', severity: 'warning',
        title: 'Checkout error burst', summary: 'Error keyword exceeded its threshold.',
        service: 'checkout-api', environment: 'production', fingerprint: 'checkout-errors:500',
        occurredAt: '2026-09-09T12:00:00.000Z', labels: { index: 'logs-checkout-prod' },
      }],
    });

    expect(normalized.signals[0]).toMatchObject({ eventId: 'elastic-event-42', monitorRef: 'checkout-errors' });
  });

  it('fails closed when provider identity labels are missing', () => {
    expect(() => normalizeAiOpsProviderSignals('grafana', {
      alerts: [{
        labels: { alertname: 'NoService' }, annotations: {},
        startsAt: '2026-09-09T12:00:00.000Z', fingerprint: 'x',
      }],
    })).toThrow(AiOpsProviderSignalError);
  });

  it('persists a firing provider signal through the existing incident and correlation pipeline', async () => {
    const config = activeConfig();
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [] };
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{ pg_advisory_xact_lock: null }] };
      if (text.includes('FROM mcp_observability_aiops_provider_signals')) return { rows: [] };
      if (text.includes('FROM mcp_observability_aiops_service_profiles profile')) return { rows: [{
        id: 41, active_revision: 3, profile_sha256: 'a'.repeat(64), profile_json: config,
      }] };
      if (text.includes('INSERT INTO mcp_observability_alert_rules')) return { rows: [{ id: 501 }] };
      if (text.includes("SELECT id FROM mcp_observability_alert_incidents")) return { rows: [] };
      if (text.includes('INSERT INTO mcp_observability_alert_incidents')) return { rows: [{ id: 801 }] };
      if (text.includes('FROM mcp_observability_alert_incident_groups') && text.includes('last_signal_at')) return { rows: [] };
      if (text.includes('INSERT INTO mcp_observability_alert_incident_groups')) return { rows: [{ id: 901 }] };
      if (text.includes('SELECT group_id') && text.includes('mcp_observability_alert_incident_group_members')) {
        return { rows: [{ group_id: 901 }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: jest.fn() } as unknown as pg.PoolClient;
    const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;
    const body = {
      schemaVersion: 1,
      signals: [{
        schemaVersion: 1,
        eventId: 'event-1', monitorRef: 'CheckoutLatencyHigh', state: 'firing', severity: 'critical',
        title: 'Checkout latency', summary: 'P95 exceeded 2 seconds.', service: 'checkout-api',
        environment: 'production', fingerprint: 'checkout-latency',
        occurredAt: '2026-09-09T12:00:00.000Z', labels: {},
      }],
    };

    const result = await ingestAiOpsProviderSignals(
      pool,
      'generic',
      body,
      Buffer.from(JSON.stringify(body)),
    );

    expect(result).toMatchObject({
      provider: 'generic', dispatchRequested: true,
      results: [{ disposition: 'created', incidentId: 801, correlationGroupId: 901, alertRuleId: 501 }],
    });
    expect(query.mock.calls.some(call => String(call[0]).includes('mcp_observability_aiops_provider_signals'))).toBe(true);
    expect(query.mock.calls.some(call => String(call[0]).includes('mcp_observability_alert_incident_group_members'))).toBe(true);
    expect(client.release).toHaveBeenCalled();
  });
});
