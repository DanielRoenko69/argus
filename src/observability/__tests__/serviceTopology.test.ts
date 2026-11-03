import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import { getServiceTopology } from '../serviceTopology.js';

describe('native service topology', () => {
  it('links discovered infrastructure, service signals, and configured alert state', async () => {
    const query = jest.fn(async (sql: unknown) => {
      const text = String(sql);
      if (text.includes('count(incident.id)')) return { rows: [{
        id: 7, name: 'Checkout latency', severity: 'critical', last_state: 'firing', enabled: true,
        aiops_service: 'checkout-api', aiops_environment: 'demo', open_incidents: 1,
      }] };
      if (text.includes('FROM mcp_observability_service_dependency_evidence')) return { rows: [{
        environment: 'demo', source_service: 'checkout-api', target_kind: 'database', target_name: 'postgresql',
        relation: 'queries', calls: 3, failures: 1, p95_duration_ms: 45000,
        last_seen_at: '2026-08-12T18:04:00.000Z', current: true,
      }] };
      return { rows: [{
        service_name: 'checkout-api', environment: 'demo', source: 'kubernetes', backend_id: 42,
        target_id: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', workload_kind: 'Service',
        workload_name: 'checkout-api', observed_at: '2026-08-12T18:00:00.000Z', current: true,
      }, {
        service_name: 'checkout-api', environment: 'demo', source: 'kubernetes', backend_id: 42,
        target_id: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', workload_kind: 'Deployment',
        workload_name: 'checkout-api', observed_at: '2026-08-12T18:01:00.000Z', current: true,
      }, {
        service_name: 'checkout-api', environment: 'demo', source: 'opentelemetry', backend_id: null,
        target_id: null, cluster: null, namespace: null, workload_kind: null, workload_name: null,
        observed_at: '2026-08-12T18:02:00.000Z', current: true,
      }, {
        service_name: 'checkout-api', environment: 'demo', source: 'logs', backend_id: null,
        target_id: null, cluster: null, namespace: null, workload_kind: null, workload_name: null,
        observed_at: '2026-08-12T18:03:00.000Z', current: true,
      }] };
    });
    const topology = await getServiceTopology({ query } as unknown as pg.Pool);
    const service = topology.nodes.find(node => node.kind === 'service');
    expect(service).toMatchObject({
      name: 'checkout-api', environment: 'demo', state: 'critical', current: true, events: 1,
      signals: ['alerts', 'kubernetes', 'logs', 'traces'],
    });
    expect(topology.nodes.map(node => node.kind)).toEqual(expect.arrayContaining([
      'cluster', 'namespace', 'workload', 'service', 'dependency', 'alert',
    ]));
    expect(topology.edges.map(edge => edge.relation)).toEqual(expect.arrayContaining([
      'contains', 'runs', 'backs', 'exposes', 'monitored_by', 'queries',
    ]));
    expect(topology.summary).toMatchObject({
      clusters: 1, namespaces: 1, workloads: 1, services: 1, alerts: 1,
      firingAlerts: 1, traceServices: 1, logServices: 1,
      runtimeDependencies: 1, calls: 3, failures: 1,
    });
  });
});
