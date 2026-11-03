import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  listServiceCatalog,
  serviceEvidenceFromKubernetesResult,
  serviceEvidenceFromLokiResult,
  serviceEvidenceFromOtelResult,
  upsertServiceCatalogEvidence,
} from '../serviceCatalog.js';

const scope = {
  kind: 'kubernetes' as const,
  backendId: 42,
  targetId: 'demo-kind',
  cluster: 'argus-kind',
  namespace: 'argus-demo',
  environment: 'demo',
};

describe('observability service catalog', () => {
  it('normalizes Kubernetes services and workloads without persisting raw payloads', () => {
    const evidence = serviceEvidenceFromKubernetesResult({ content: [{ type: 'text', text: JSON.stringify({
      apiVersion: 'v1',
      items: [
        { kind: 'Service', metadata: { name: 'checkout', labels: { 'app.kubernetes.io/name': 'checkout-api', secret: 'not-a-credential-field' } } },
        { kind: 'Deployment', metadata: { name: 'checkout-v2', labels: { app: 'checkout-api' } } },
        { kind: 'Secret', metadata: { name: 'checkout-token' } },
      ],
    }) }] }, { bundleId: 28, scope, sourceRef: 'aiops_kubernetes_k8s_get_resources' });
    expect(evidence).toHaveLength(2);
    expect(evidence.map(item => [item.serviceName, item.workloadKind, item.workloadName])).toEqual([
      ['checkout-api', 'Service', 'checkout'],
      ['checkout-api', 'Deployment', 'checkout-v2'],
    ]);
    expect(evidence.every(item => item.namespace === 'argus-demo' && item.backendId === 42)).toBe(true);
    expect(evidence[0]?.attributes).not.toHaveProperty('secret');
  });

  it('extracts only bounded service identities from Jaeger/OpenTelemetry catalogs', () => {
    const evidence = serviceEvidenceFromOtelResult({ content: [{ type: 'text', text: 'HTTP 200 OK\n\n{"data":["checkout-api","catalog-api","bad service name"]}' }] }, {
      bundleId: 28, environment: 'demo', sourceRef: 'aiops_jaeger_services',
    });
    expect(evidence.map(item => item.serviceName)).toEqual(['checkout-api', 'catalog-api']);
  });

  it('stores only bounded service identity evidence from Loki label discovery', () => {
    const evidence = serviceEvidenceFromLokiResult({ content: [{ type: 'text', text: JSON.stringify({
      status: 'success', data: ['checkout-api', 'checkout-api', 'bad service name'],
    }) }] }, { bundleId: 28, environment: 'demo', sourceRef: 'aiops_loki_label_values' });
    expect(evidence).toEqual([expect.objectContaining({
      serviceName: 'checkout-api', environment: 'demo', source: 'logs', bundleId: 28,
    })]);
  });

  it('upserts bounded evidence and merges sources into service entries', async () => {
    const writes: unknown[][] = [];
    const query = jest.fn(async (sql: unknown, params?: unknown[]) => {
      if (String(sql).startsWith('INSERT INTO')) { writes.push(params ?? []); return { rows: [], rowCount: 1 }; }
      return { rows: [{
        service_name: 'checkout-api', environment: 'demo', source: 'kubernetes', backend_id: 42,
        target_id: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo', workload_kind: 'Deployment',
        workload_name: 'checkout-api', observed_at: '2026-08-12T18:00:00.000Z', current: true,
      }, {
        service_name: 'checkout-api', environment: 'demo', source: 'opentelemetry', backend_id: null,
        target_id: null, cluster: null, namespace: null, workload_kind: null, workload_name: null,
        observed_at: '2026-08-12T18:05:00.000Z', current: true,
      }] };
    });
    const pool = { query } as unknown as pg.Pool;
    expect(await upsertServiceCatalogEvidence(pool, [{
      serviceName: 'checkout-api', environment: 'demo', source: 'kubernetes', sourceRef: 'k8s', bundleId: 28,
      backendId: 42, targetId: 'demo-kind', cluster: 'argus-kind', namespace: 'argus-demo',
      workloadKind: 'Deployment', workloadName: 'checkout-api',
    }])).toBe(1);
    expect(writes).toHaveLength(1);
    const catalog = await listServiceCatalog(pool);
    expect(catalog.entries).toHaveLength(1);
    expect(catalog.entries[0]).toMatchObject({
      serviceName: 'checkout-api', environment: 'demo', current: true, evidenceCount: 2,
      sources: ['kubernetes', 'opentelemetry'],
      targets: [{ backendId: 42, targetId: 'demo-kind', namespace: 'argus-demo', current: true }],
    });
  });
});
