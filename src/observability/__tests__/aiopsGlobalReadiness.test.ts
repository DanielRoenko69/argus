import { jest } from '@jest/globals';
import type pg from 'pg';
import type { BundleCapabilityCheck } from '../../solutionPacks/bundleCapabilities.js';
import {
  evaluateAiOpsGlobalReadiness,
  type AiOpsGlobalReadinessDependencies,
} from '../aiopsGlobalReadiness.js';

function assessment(options: { eligible?: boolean; blocked?: boolean } = {}): BundleCapabilityCheck {
  const eligible = options.eligible ?? true;
  return {
    ok: eligible && !options.blocked,
    required: [],
    provided: eligible ? ['logs', 'traces', 'topology'] : [],
    missing: [],
    operationalBlockers: options.blocked ? ['catalog blocked'] : [],
    operationalIssues: options.blocked ? [{
      bundleId: 11,
      bundleName: 'observe-prod',
      backendId: 8,
      backendName: 'observability',
      kind: 'catalog_changed',
      recovery: 'review_catalog',
      message: 'catalog blocked',
    }] : [],
    bundles: eligible ? [{
      bundleId: 11,
      bundleName: 'observe-prod',
      categories: ['logs', 'traces', 'topology'],
      signals: ['loki', 'jaeger'],
    }] : [],
  };
}

function dependencies(check = assessment()): AiOpsGlobalReadinessDependencies {
  return {
    listBundleIds: jest.fn(async (_pool: pg.Pool, allowed: number[] | null) => allowed?.length === 0 ? [] : [11]),
    checkBundles: jest.fn(async (_pool: pg.Pool, ids: number[]) => ids.length > 0 ? check : assessment({ eligible: false })),
    countCertifiedTargets: jest.fn(async () => 0),
    profileSummary: jest.fn(async (_pool: pg.Pool, _workspaceKey: string, _tenantKey: string) => ({ active: 1, ready: 1, degraded: 0, blocked: 0 })),
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  };
}

describe('global AIOps readiness', () => {
  const pool = {} as pg.Pool;

  it('treats one trusted provider-only evidence bundle as connected', async () => {
    const deps = dependencies();
    const result = await evaluateAiOpsGlobalReadiness(pool, {
      allowedBundleIds: null,
      pack: { state: 'ready', version: '0.3.0' },
    }, deps);

    expect(result).toMatchObject({
      state: 'ready',
      presentation: 'connected_summary',
      eligibleBundleCount: 1,
      availableLanes: ['logs', 'traces', 'topology'],
      primaryConnection: {
        bundleId: 11,
        lanes: ['logs', 'traces', 'topology'],
        certifiedTargetCount: 0,
      },
    });
    expect(deps.profileSummary).toHaveBeenCalledWith(pool, 'default', 'default');
  });

  it('shows connector setup when the user has no authorized evidence bundle', async () => {
    const deps = dependencies();
    const result = await evaluateAiOpsGlobalReadiness(pool, {
      allowedBundleIds: [],
      pack: { state: 'ready', version: '0.3.0' },
    }, deps);

    expect(result).toMatchObject({
      state: 'setup_required',
      presentation: 'connector_setup',
      eligibleBundleCount: 0,
      primaryConnection: null,
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_evidence_connection_required',
      severity: 'blocking',
    }));
    expect(deps.countCertifiedTargets).not.toHaveBeenCalled();
  });

  it('keeps a configured bundle visible but blocks launches when its MCP connection is blocked', async () => {
    const result = await evaluateAiOpsGlobalReadiness(pool, {
      allowedBundleIds: [11],
      pack: { state: 'ready', version: '0.3.0' },
    }, dependencies(assessment({ blocked: true })));

    expect(result).toMatchObject({
      state: 'blocked',
      presentation: 'connected_summary',
      eligibleBundleCount: 1,
      primaryConnection: { bundleId: 11 },
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_evidence_catalog_changed',
      severity: 'blocking',
      bundleId: 11,
      backendId: 8,
    }));
    expect(result.recoveryActions).toContainEqual(expect.objectContaining({
      id: 'manage-aiops-evidence',
      kind: 'review_catalog',
    }));
  });

  it('keeps the connected summary but blocks launches when the Pack is offline', async () => {
    const result = await evaluateAiOpsGlobalReadiness(pool, {
      allowedBundleIds: null,
      pack: { state: 'offline', version: null },
    }, dependencies());

    expect(result).toMatchObject({ state: 'blocked', presentation: 'connected_summary' });
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_pack_not_ready',
      severity: 'blocking',
    }));
  });
});
