import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import type { BundleCapabilityCheck } from '../../solutionPacks/bundleCapabilities.js';
import type { KubernetesCertificationRecord } from '../../solutionPacks/kubernetesCertificationStore.js';
import {
  aiOpsServiceProfileResourceSchema,
  hashAiOpsServiceProfileConfig,
} from '../aiopsServiceProfileContracts.js';
import { evaluateAiOpsServiceProfileReadiness } from '../aiopsServiceProfileReadiness.js';
import type { AiOpsServiceProfileRecord } from '../aiopsServiceProfiles.js';

const profileFixture = () => aiOpsServiceProfileResourceSchema.parse(JSON.parse(readFileSync(resolve(
  process.cwd(),
  'docs/specs/aiops-service-profiles/service-profile-active.v1.fixture.json',
), 'utf8')));

function record(): AiOpsServiceProfileRecord {
  const fixture = profileFixture();
  return {
    id: fixture.id,
    status: fixture.status,
    activeRevision: fixture.activeRevision,
    latestRevision: fixture.latestRevision,
    createdAt: fixture.createdAt,
    updatedAt: fixture.updatedAt,
  };
}

const tools = new Map<number, string[]>([
  [11, [
    'aiops_prometheus_query',
    'aiops_prometheus_query_range',
    'aiops_jaeger_find_traces',
    'aiops_jaeger_get_trace',
    'aiops_loki_query_range',
  ]],
  [18, ['github_list_commits']],
]);

function check(
  bundleId: number,
  required: string,
  options: { missing?: boolean; blocked?: boolean } = {},
): BundleCapabilityCheck {
  const categories = options.missing ? [] : [required];
  return {
    ok: !options.missing && !options.blocked,
    required: [required],
    provided: categories,
    missing: options.missing ? [required] : [],
    operationalBlockers: options.blocked ? ['connection is not active'] : [],
    operationalIssues: options.blocked ? [{
      bundleId,
      bundleName: `bundle-${bundleId}`,
      backendId: 5,
      backendName: 'provider',
      kind: 'connection_inactive',
      recovery: 'reconnect',
      message: 'connection is not active',
    }] : [],
    bundles: [{
      bundleId,
      bundleName: `bundle-${bundleId}`,
      categories: categories as BundleCapabilityCheck['bundles'][number]['categories'],
      signals: [required],
    }],
  };
}

function dependencies(options: {
  missing?: string;
  blocked?: string;
  relevantBackendIds?: number[];
  runtimeCertification?: KubernetesCertificationRecord | null;
} = {}) {
  return {
    checkBundle: async (_pool: pg.Pool, bundleIds: number[], required: string[], requiredToolNames?: string[]) => check(
      bundleIds[0]!,
      required[0]!,
      {
        missing: options.missing === required[0],
        blocked: options.blocked === required[0]
          && (!requiredToolNames?.length || (options.relevantBackendIds ?? [5]).includes(5)),
      },
    ),
    loadAllowedTools: async (_pool: pg.Pool, bundleIds: number[]) => new Set(tools.get(bundleIds[0]!) ?? []),
    loadRuntimeCertification: async () => options.runtimeCertification ?? null,
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  };
}

describe('AIOps profile readiness evaluation', () => {
  const pool = {} as pg.Pool;

  it('accepts provider-only evidence without a Kubernetes target', async () => {
    const readiness = await evaluateAiOpsServiceProfileReadiness(pool, record(), dependencies());

    expect(readiness).toMatchObject({
      state: 'ready',
      runtime: { required: false, state: 'not_required', scope: null, certification: null },
      summary: { requiredLanes: 2, readyRequiredLanes: 2, optionalGaps: 0, blockingIssues: 0 },
    });
  });

  it('keeps an optional evidence gap degraded but activatable', async () => {
    const readiness = await evaluateAiOpsServiceProfileReadiness(
      pool,
      record(),
      dependencies({ missing: 'repository' }),
    );

    expect(readiness).toMatchObject({
      state: 'degraded',
      summary: { optionalGaps: 1, blockingIssues: 0 },
    });
    expect(readiness.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_lane_capability_missing',
      severity: 'warning',
      lane: 'changes',
    }));
  });

  it('blocks a required lane when its bundle no longer provides the capability', async () => {
    const readiness = await evaluateAiOpsServiceProfileReadiness(
      pool,
      record(),
      dependencies({ missing: 'metrics' }),
    );

    expect(readiness).toMatchObject({
      state: 'blocked',
      summary: { requiredLanes: 2, readyRequiredLanes: 1, blockingIssues: 1 },
    });
    expect(readiness.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_lane_capability_missing',
      severity: 'blocking',
      lane: 'metrics',
    }));
  });

  it('blocks a required lane when its trusted connection is inactive', async () => {
    const readiness = await evaluateAiOpsServiceProfileReadiness(
      pool,
      record(),
      dependencies({ blocked: 'metrics' }),
    );

    expect(readiness.state).toBe('blocked');
    expect(readiness.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_bundle_operationally_blocked',
      severity: 'blocking',
      lane: 'metrics',
    }));
    expect(readiness.recoveryActions).toContainEqual(expect.objectContaining({
      kind: 'manage_connection',
    }));
  });

  it('ignores an unrelated blocked backend when a lane has an explicit tool allowlist', async () => {
    const readiness = await evaluateAiOpsServiceProfileReadiness(
      pool,
      record(),
      dependencies({ blocked: 'metrics', relevantBackendIds: [24] }),
    );

    expect(readiness.state).toBe('ready');
    expect(readiness.issues).not.toContainEqual(expect.objectContaining({
      code: 'aiops_bundle_operationally_blocked',
      lane: 'metrics',
    }));
  });

  it('requires fresh certification only for a configured runtime boundary', async () => {
    const runtimeProfile = record();
    const config = structuredClone(runtimeProfile.latestRevision.config);
    config.evidencePolicy.lanes.push({
      lane: 'runtime',
      requirement: 'required',
      bundleId: 11,
      toolAllowlist: [],
      queryTemplates: [],
    });
    config.selectors.runtime = {
      kind: 'kubernetes',
      backendId: 5,
      targetId: 'prod-cluster',
      cluster: 'production',
      namespace: 'checkout',
      workloads: [{ kind: 'Deployment', name: 'checkout-api' }],
    };
    runtimeProfile.latestRevision = {
      ...runtimeProfile.latestRevision,
      config,
      sha256: hashAiOpsServiceProfileConfig(config),
    };

    const readiness = await evaluateAiOpsServiceProfileReadiness(pool, runtimeProfile, dependencies());
    expect(readiness).toMatchObject({
      state: 'blocked',
      runtime: { required: true, state: 'missing' },
    });
    expect(readiness.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_runtime_certification_missing',
      severity: 'blocking',
    }));
  });

  it('blocks a required runtime when the latest certification is stale', async () => {
    const runtimeProfile = record();
    const config = structuredClone(runtimeProfile.latestRevision.config);
    config.evidencePolicy.lanes.push({
      lane: 'runtime',
      requirement: 'required',
      bundleId: 11,
      toolAllowlist: [],
      queryTemplates: [],
    });
    config.selectors.runtime = {
      kind: 'kubernetes',
      backendId: 5,
      targetId: 'prod-cluster',
      cluster: 'production',
      namespace: 'checkout',
      workloads: [{ kind: 'Deployment', name: 'checkout-api' }],
    };
    runtimeProfile.latestRevision = {
      ...runtimeProfile.latestRevision,
      config,
      sha256: hashAiOpsServiceProfileConfig(config),
    };
    const certification: KubernetesCertificationRecord = {
      id: 91,
      backendId: 5,
      targetId: 'prod-cluster',
      platform: 'kubernetes',
      profile: 'production',
      status: 'passed',
      contractSha256: 'c'.repeat(64),
      reportSha256: 'd'.repeat(64),
      checkCount: 1,
      passedCount: 1,
      failedCount: 0,
      failedChecks: [],
      generatedAt: '2026-08-31T12:00:00.000Z',
      importedAt: '2026-08-31T12:01:00.000Z',
      importedBy: 'certifier',
      freshness: 'stale',
      ageHours: 192,
      expiresAt: '2026-09-07T12:00:00.000Z',
    };

    const readiness = await evaluateAiOpsServiceProfileReadiness(
      pool,
      runtimeProfile,
      dependencies({ runtimeCertification: certification }),
    );

    expect(readiness).toMatchObject({
      state: 'blocked',
      runtime: { required: true, state: 'blocked', certification: { status: 'passed', freshness: 'stale' } },
    });
    expect(readiness.issues).toContainEqual(expect.objectContaining({
      code: 'aiops_runtime_certification_stale',
      severity: 'blocking',
    }));
    expect(readiness.recoveryActions).toContainEqual(expect.objectContaining({
      kind: 'renew_certification',
    }));
  });
});
