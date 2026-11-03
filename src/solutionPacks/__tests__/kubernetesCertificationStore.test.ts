import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  evaluateKubernetesCertificationFreshness,
  importKubernetesCertification,
  listKubernetesCertificationHistory,
  listLatestKubernetesCertifications,
  loadKubernetesCertificationPolicy,
  normalizeKubernetesCertificationReport,
  resolveKubernetesCertificationBackendId,
} from '../kubernetesCertificationStore.js';

const contractSha256 = 'a'.repeat(64);
const report = {
  apiVersion: 'certification.argus.eu/v1alpha1',
  kind: 'KubernetesConnectorCertificationReport',
  targetId: 'production-openshift',
  platform: 'openshift',
  profile: 'production',
  overall: 'failed',
  checks: [
    { id: 'identity.openshift.restricted-scc', status: 'passed', detail: 'restricted-v2 admitted' },
    { id: 'transport.tls', status: 'failed', detail: 'service certificate is not ready' },
  ],
  generatedAt: '2025-01-01T00:00:00.000Z',
  contractSha256,
};

const backend = {
  id: 17,
  name: 'openshift-kubernetes',
  description: 'OpenShift connector',
  enabled: true,
  bundle_ids: [8],
  config: {
    scope_kind: 'kubernetes',
    platform: 'openshift',
    target_id: 'production-openshift',
    target_label: 'Production OpenShift',
    cluster: 'eu-production-01',
    environment: 'production',
    execution_namespaces: ['payments'],
  },
};

function storedRow() {
  return {
    id: 41,
    backend_id: 17,
    target_id: report.targetId,
    platform: report.platform,
    profile: report.profile,
    status: report.overall,
    contract_sha256: contractSha256,
    report_sha256: 'b'.repeat(64),
    checks: report.checks,
    check_count: 2,
    passed_count: 1,
    failed_count: 1,
    generated_at: report.generatedAt,
    imported_at: '2025-01-01T00:01:00.000Z',
    imported_by: 'alex',
  };
}

describe('Kubernetes connector certification persistence', () => {
  it('derives a bounded freshness policy and deterministic lifecycle states', () => {
    const policy = loadKubernetesCertificationPolicy({
      KUBERNETES_CERTIFICATION_WARNING_AGE_HOURS: '120',
      KUBERNETES_CERTIFICATION_MAX_AGE_HOURS: '168',
      KUBERNETES_CERTIFICATION_ENFORCE_AIOPS: 'true',
    });
    const generatedAt = '2025-01-01T00:00:00.000Z';
    expect(evaluateKubernetesCertificationFreshness(generatedAt, policy, Date.parse('2025-01-05T00:00:00.000Z')))
      .toMatchObject({ freshness: 'fresh', ageHours: 96 });
    expect(evaluateKubernetesCertificationFreshness(generatedAt, policy, Date.parse('2025-01-06T12:00:00.000Z')))
      .toMatchObject({ freshness: 'expiring', ageHours: 132 });
    expect(evaluateKubernetesCertificationFreshness(generatedAt, policy, Date.parse('2025-01-08T00:00:00.000Z')))
      .toMatchObject({ freshness: 'stale', ageHours: 168, expiresAt: '2025-01-08T00:00:00.000Z' });
  });

  it('normalizes bounded evidence and rejects inconsistent status', () => {
    expect(normalizeKubernetesCertificationReport(report)).toMatchObject({
      targetId: 'production-openshift',
      platform: 'openshift',
      overall: 'failed',
      contractSha256,
    });
    expect(() => normalizeKubernetesCertificationReport({ ...report, overall: 'passed' })).toThrow(/does not match/);
    expect(() => normalizeKubernetesCertificationReport({ ...report, contractSha256: 'not-a-hash' })).toThrow(/SHA-256/);
  });

  it('binds a report to the exact governed target and persists only normalized evidence', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [backend] } as never)
      .mockResolvedValueOnce({ rows: [storedRow()] } as never);
    const result = await importKubernetesCertification({ query } as unknown as pg.Pool, {
      backendId: 17,
      report,
      importedBy: 'alex',
    });
    expect(result).toMatchObject({
      backendId: 17,
      targetId: 'production-openshift',
      status: 'failed',
      checkCount: 2,
      failedChecks: [{ id: 'transport.tls', status: 'failed', detail: 'service certificate is not ready' }],
    });
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('INSERT INTO mcp_kubernetes_connector_certifications'), expect.arrayContaining([
      17, 'production-openshift', 'openshift', 'production', 'failed', contractSha256,
    ]));
  });

  it('resolves an automation import to one enabled governed target', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [backend] } as never);
    await expect(resolveKubernetesCertificationBackendId(
      { query } as unknown as pg.Pool,
      'production-openshift',
    )).resolves.toBe(17);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE backend.enabled=true'));
  });

  it('fails closed when an automation target is ambiguous', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [backend, { ...backend, id: 18 }] } as never);
    await expect(resolveKubernetesCertificationBackendId(
      { query } as unknown as pg.Pool,
      'production-openshift',
    )).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a report whose platform differs from the governed target', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [backend] } as never);
    await expect(importKubernetesCertification({ query } as unknown as pg.Pool, {
      backendId: 17,
      report: { ...report, platform: 'gke' },
    })).rejects.toThrow(/does not match/);
  });

  it('projects the latest report without retaining successful check details in the UI record', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [storedRow()] } as never);
    await expect(listLatestKubernetesCertifications({ query } as unknown as pg.Pool)).resolves.toEqual([
      expect.objectContaining({
        id: 41,
        failedCount: 1,
        failedChecks: [{ id: 'transport.tls', status: 'failed', detail: 'service certificate is not ready' }],
      }),
    ]);
  });

  it('returns a bounded target history with lifecycle metadata', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [storedRow()] } as never);
    const history = await listKubernetesCertificationHistory(
      { query } as unknown as pg.Pool,
      { backendId: 17, targetId: 'production-openshift', limit: 7 },
      { warningAgeHours: 120, maxAgeHours: 168, enforceAIOps: true },
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('WHERE backend_id=$1 AND target_id=$2'), [17, 'production-openshift', 7]);
    expect(history[0]).toEqual(expect.objectContaining({
      backendId: 17,
      targetId: 'production-openshift',
      freshness: 'stale',
      expiresAt: '2025-01-08T00:00:00.000Z',
    }));
  });
});
