import type pg from 'pg';
import { checkBundleCapabilities, type BundleCapabilityCheck } from '../solutionPacks/bundleCapabilities.js';
import { listLatestKubernetesCertifications } from '../solutionPacks/kubernetesCertificationStore.js';
import {
  AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
  aiOpsGlobalReadinessSchema,
  type AiOpsGlobalReadiness,
} from './aiopsServiceProfileContracts.js';
import {
  DEFAULT_AIOPS_TENANT_KEY,
  DEFAULT_AIOPS_WORKSPACE_KEY,
} from './aiopsServiceProfiles.js';

const PRIMARY_EVIDENCE_CATEGORIES = new Set(['metrics', 'logs', 'traces', 'runtime', 'incident']);
const CATEGORY_LANE: Readonly<Record<string, AiOpsGlobalReadiness['availableLanes'][number] | undefined>> = Object.freeze({
  metrics: 'metrics',
  logs: 'logs',
  traces: 'traces',
  runtime: 'runtime',
  topology: 'topology',
  repository: 'changes',
  rag: 'knowledge',
  incident: 'incident',
});

export interface AiOpsPackReadinessSnapshot {
  state: 'ready' | 'degraded' | 'offline';
  version: string | null;
}

interface ProfileSummary {
  active: number;
  ready: number;
  degraded: number;
  blocked: number;
}

export interface AiOpsGlobalReadinessDependencies {
  listBundleIds(pool: pg.Pool, allowedBundleIds: number[] | null): Promise<number[]>;
  checkBundles(pool: pg.Pool, bundleIds: number[]): Promise<BundleCapabilityCheck>;
  countCertifiedTargets(pool: pg.Pool, bundleId: number): Promise<number>;
  profileSummary(pool: pg.Pool, workspaceKey: string, tenantKey: string): Promise<ProfileSummary>;
  now(): Date;
}

async function listBundleIds(pool: pg.Pool, allowedBundleIds: number[] | null): Promise<number[]> {
  if (allowedBundleIds?.length === 0) return [];
  const result = await pool.query<{ id: number | string }>(
    `SELECT id
       FROM mcp_service_bundles
      WHERE ($1::int[] IS NULL OR id=ANY($1::int[]))
      ORDER BY id
      LIMIT 200`,
    [allowedBundleIds],
  );
  return result.rows.map(row => Number(row.id)).filter(id => Number.isSafeInteger(id) && id > 0);
}

async function countCertifiedTargets(pool: pg.Pool, bundleId: number): Promise<number> {
  const [backendResult, certifications] = await Promise.all([
    pool.query<{ backend_id: number | string }>(
      `SELECT backend_id FROM mcp_backend_bundles WHERE bundle_id=$1`,
      [bundleId],
    ),
    listLatestKubernetesCertifications(pool),
  ]);
  const backendIds = new Set(backendResult.rows.map(row => Number(row.backend_id)));
  return certifications.filter(certification =>
    backendIds.has(certification.backendId)
      && certification.status === 'passed'
      && certification.freshness !== 'stale').length;
}

async function profileSummary(pool: pg.Pool, workspaceKey: string, tenantKey: string): Promise<ProfileSummary> {
  const result = await pool.query<{
    active: number | string;
    ready: number | string;
    degraded: number | string;
    blocked: number | string;
  }>(
    `WITH active_profiles AS (
       SELECT profile.id, profile.active_revision,
              validation.status AS validation_status
         FROM mcp_observability_aiops_service_profiles profile
         LEFT JOIN LATERAL (
           SELECT status
             FROM mcp_observability_aiops_profile_validations
            WHERE profile_id=profile.id AND revision=profile.active_revision
            ORDER BY validated_at DESC, id DESC
            LIMIT 1
         ) validation ON true
        WHERE profile.status='active'
          AND profile.workspace_key=$1
          AND profile.tenant_key=$2
     )
     SELECT count(*)::int AS active,
            count(*) FILTER (WHERE validation_status='passed')::int AS ready,
            count(*) FILTER (WHERE validation_status='warning')::int AS degraded,
            count(*) FILTER (WHERE validation_status IS NULL OR validation_status='failed')::int AS blocked
       FROM active_profiles`,
    [workspaceKey, tenantKey],
  );
  const row = result.rows[0] ?? { active: 0, ready: 0, degraded: 0, blocked: 0 };
  return {
    active: Number(row.active),
    ready: Number(row.ready),
    degraded: Number(row.degraded),
    blocked: Number(row.blocked),
  };
}

const DEFAULT_DEPENDENCIES: AiOpsGlobalReadinessDependencies = {
  listBundleIds,
  checkBundles: (pool, bundleIds) => checkBundleCapabilities(pool, bundleIds, []),
  countCertifiedTargets,
  profileSummary,
  now: () => new Date(),
};

export async function evaluateAiOpsGlobalReadiness(
  pool: pg.Pool,
  input: {
    allowedBundleIds: number[] | null;
    pack: AiOpsPackReadinessSnapshot;
    workspaceKey?: string;
    tenantKey?: string;
  },
  dependencies: Partial<AiOpsGlobalReadinessDependencies> = {},
): Promise<AiOpsGlobalReadiness> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const bundleIds = await deps.listBundleIds(pool, input.allowedBundleIds);
  const [assessment, profiles] = await Promise.all([
    deps.checkBundles(pool, bundleIds),
    deps.profileSummary(
      pool,
      input.workspaceKey?.trim() || DEFAULT_AIOPS_WORKSPACE_KEY,
      input.tenantKey?.trim() || DEFAULT_AIOPS_TENANT_KEY,
    ),
  ]);
  const operationalIssues = assessment.operationalIssues ?? [];
  const blockedBundleIds = new Set(operationalIssues.map(issue => issue.bundleId));
  const eligible = assessment.bundles
    .filter(bundle => bundle.categories.some(category => PRIMARY_EVIDENCE_CATEGORIES.has(category)))
    .sort((left, right) => {
      const leftBlocked = blockedBundleIds.has(left.bundleId);
      const rightBlocked = blockedBundleIds.has(right.bundleId);
      if (leftBlocked !== rightBlocked) return leftBlocked ? 1 : -1;
      if (left.bundleName === 'argus-aiops-observe') return -1;
      if (right.bundleName === 'argus-aiops-observe') return 1;
      const leftScore = left.categories.filter(category => PRIMARY_EVIDENCE_CATEGORIES.has(category)).length;
      const rightScore = right.categories.filter(category => PRIMARY_EVIDENCE_CATEGORIES.has(category)).length;
      return rightScore - leftScore || left.bundleId - right.bundleId;
    });
  const availableLanes = [...new Set(eligible.flatMap(bundle => bundle.categories
    .map(category => CATEGORY_LANE[category])
    .filter((lane): lane is AiOpsGlobalReadiness['availableLanes'][number] => Boolean(lane))))];
  const primary = eligible[0] ?? null;
  const primaryOperationalIssues = primary
    ? operationalIssues.filter(issue => issue.bundleId === primary.bundleId)
    : [];
  const certifiedTargetCount = primary ? await deps.countCertifiedTargets(pool, primary.bundleId) : 0;
  const issues: AiOpsGlobalReadiness['issues'] = [];
  if (!primary) {
    issues.push({
      code: 'aiops_evidence_connection_required',
      severity: 'blocking',
      message: 'Connect at least one trusted and reachable MCP bundle with an AIOps evidence capability',
    });
  }
  for (const issue of primaryOperationalIssues) {
    issues.push({
      code: `aiops_evidence_${issue.kind}`,
      severity: 'blocking',
      message: issue.message,
      bundleId: issue.bundleId,
      ...(issue.backendId == null ? {} : { backendId: issue.backendId }),
    });
  }
  if (input.pack.state !== 'ready') {
    issues.push({
      code: 'aiops_pack_not_ready',
      severity: input.pack.state === 'offline' ? 'blocking' : 'warning',
      message: input.pack.state === 'offline'
        ? 'The Argus AIOps runtime is offline'
        : 'The Argus AIOps runtime is degraded',
    });
  }
  if (profiles.blocked > 0) {
    issues.push({
      code: 'aiops_profiles_blocked',
      severity: 'warning',
      message: `${profiles.blocked} active service profile(s) need attention`,
    });
  }
  if (profiles.degraded > 0) {
    issues.push({
      code: 'aiops_profiles_degraded',
      severity: 'warning',
      message: `${profiles.degraded} active service profile(s) have optional evidence gaps`,
    });
  }
  const presentation = primary ? 'connected_summary' : 'connector_setup';
  const state = !primary
    ? 'setup_required'
    : primaryOperationalIssues.length > 0 || input.pack.state === 'offline'
      ? 'blocked'
      : issues.length > 0
        ? 'degraded'
        : 'ready';
  return aiOpsGlobalReadinessSchema.parse({
    schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
    kind: 'aiops-readiness',
    state,
    presentation,
    generatedAt: deps.now().toISOString(),
    pack: input.pack,
    eligibleBundleCount: eligible.length,
    availableLanes,
    primaryConnection: primary ? {
      bundleId: primary.bundleId,
      bundleName: primary.bundleName,
      lanes: primary.categories
        .map(category => CATEGORY_LANE[category])
        .filter((lane): lane is AiOpsGlobalReadiness['availableLanes'][number] => Boolean(lane)),
      certifiedTargetCount,
      checkedAt: deps.now().toISOString(),
    } : null,
    profiles,
    issues,
    recoveryActions: primary ? [
      {
        id: 'manage-aiops-evidence',
        label: primaryOperationalIssues.some(issue => issue.recovery === 'review_catalog')
          ? 'Review evidence catalog'
          : 'Manage evidence',
        kind: primaryOperationalIssues.some(issue => issue.recovery === 'review_catalog')
          ? 'review_catalog'
          : 'manage_connection',
        href: '/mcp-fabric',
      },
      {
        id: 'add-aiops-environment',
        label: 'Add environment',
        kind: 'add_environment',
        href: '/solutions/argus.aiops?setup=connectors',
      },
    ] : [{
      id: 'connect-aiops-evidence',
      label: 'Connect evidence',
      kind: 'manage_connection',
      href: '/mcp-fabric',
    }],
  });
}
