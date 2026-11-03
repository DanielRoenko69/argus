import type pg from 'pg';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import {
  checkBundleCapabilities,
  type BundleCapabilityCheck,
  type BundleCapabilityCategory,
} from '../solutionPacks/bundleCapabilities.js';
import {
  getLatestKubernetesCertification,
  type KubernetesCertificationRecord,
} from '../solutionPacks/kubernetesCertificationStore.js';
import {
  AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
  aiOpsServiceProfileReadinessSchema,
  type AiOpsServiceProfileReadiness,
} from './aiopsServiceProfileContracts.js';
import type { AiOpsServiceProfileRecord } from './aiopsServiceProfiles.js';

type EvidenceLane = AiOpsServiceProfileReadiness['lanes'][number]['lane'];
type ReadinessIssue = AiOpsServiceProfileReadiness['issues'][number];
type RecoveryAction = AiOpsServiceProfileReadiness['recoveryActions'][number];

const LANE_CAPABILITY: Readonly<Record<EvidenceLane, BundleCapabilityCategory>> = Object.freeze({
  metrics: 'metrics',
  logs: 'logs',
  traces: 'traces',
  runtime: 'runtime',
  topology: 'topology',
  changes: 'repository',
  knowledge: 'rag',
  incident: 'incident',
});

const PROFILE_CAPABILITIES = new Set([
  'metrics', 'logs', 'traces', 'runtime', 'topology', 'incident', 'repository', 'rag',
]);

export interface AiOpsProfileReadinessDependencies {
  checkBundle(
    pool: pg.Pool,
    bundleIds: number[],
    required: string[],
    requiredToolNames?: string[],
  ): Promise<BundleCapabilityCheck>;
  loadAllowedTools(pool: pg.Pool, bundleIds: number[]): Promise<Set<string>>;
  loadRuntimeCertification(
    pool: pg.Pool,
    input: { backendId: number; targetId: string },
  ): Promise<KubernetesCertificationRecord | null>;
  now(): Date;
}

const DEFAULT_DEPENDENCIES: AiOpsProfileReadinessDependencies = {
  checkBundle: (pool, bundleIds, required, requiredToolNames) => checkBundleCapabilities(
    pool, bundleIds, required, { requiredToolNames },
  ),
  loadAllowedTools: (pool, bundleIds) => loadAllowedToolNames(pool, bundleIds, { includeUnscoped: false }),
  loadRuntimeCertification: getLatestKubernetesCertification,
  now: () => new Date(),
};

function recoveryForBundle(
  bundleId: number,
  check: BundleCapabilityCheck,
): RecoveryAction[] {
  const actions: RecoveryAction[] = [];
  const operational = check.operationalIssues ?? [];
  if (operational.some(issue => issue.recovery === 'review_catalog')) {
    actions.push({
      id: `review-catalog-${bundleId}`,
      label: 'Review MCP catalog',
      kind: 'review_catalog',
      href: '/mcp-fabric#connections',
    });
  }
  if (operational.some(issue => issue.recovery === 'enable_connection' || issue.recovery === 'reconnect')) {
    actions.push({
      id: `manage-connection-${bundleId}`,
      label: 'Manage evidence connection',
      kind: 'manage_connection',
      href: '/mcp-fabric#connections',
    });
  }
  if (check.bundles.length === 0 || check.missing.length > 0) {
    actions.push({
      id: `manage-bundle-${bundleId}`,
      label: 'Review MCP bundle capabilities',
      kind: 'manage_connection',
      href: `/mcp-fabric/bundles/${bundleId}`,
    });
  }
  return actions;
}

function dedupeActions(actions: RecoveryAction[]): RecoveryAction[] {
  return [...new Map(actions.map(action => [action.id, action])).values()];
}

function issueSeverity(requirement: 'required' | 'optional' | 'disabled'): 'blocking' | 'warning' {
  return requirement === 'required' ? 'blocking' : 'warning';
}

export async function evaluateAiOpsServiceProfileReadiness(
  pool: pg.Pool,
  profile: AiOpsServiceProfileRecord,
  dependencies: Partial<AiOpsProfileReadinessDependencies> = {},
): Promise<AiOpsServiceProfileReadiness> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const config = profile.latestRevision.config;
  const issues: ReadinessIssue[] = [];
  const recoveryActions: RecoveryAction[] = [];

  const lanes = await Promise.all(config.evidencePolicy.lanes.map(async binding => {
    if (binding.requirement === 'disabled') {
      return {
        lane: binding.lane,
        requirement: binding.requirement,
        state: 'disabled' as const,
        bundleId: binding.bundleId,
        bundleName: null,
        providedCategories: [],
        toolNames: [],
        issueCodes: [],
      };
    }
    const capability = LANE_CAPABILITY[binding.lane];
    const [check, allowedTools] = await Promise.all([
      deps.checkBundle(pool, [binding.bundleId], [capability], binding.toolAllowlist),
      deps.loadAllowedTools(pool, [binding.bundleId]),
    ]);
    const laneIssueCodes: string[] = [];
    if (check.bundles.length === 0) {
      const code = 'aiops_bundle_not_found';
      laneIssueCodes.push(code);
      issues.push({
        code,
        severity: issueSeverity(binding.requirement),
        message: `Evidence bundle ${binding.bundleId} does not exist`,
        lane: binding.lane,
        bundleId: binding.bundleId,
      });
    } else if (check.missing.includes(capability)) {
      const code = 'aiops_lane_capability_missing';
      laneIssueCodes.push(code);
      issues.push({
        code,
        severity: issueSeverity(binding.requirement),
        message: `Bundle ${binding.bundleId} does not provide the ${binding.lane} evidence lane`,
        lane: binding.lane,
        bundleId: binding.bundleId,
      });
    }
    if ((check.operationalBlockers ?? []).length > 0) {
      const code = 'aiops_bundle_operationally_blocked';
      laneIssueCodes.push(code);
      issues.push({
        code,
        severity: issueSeverity(binding.requirement),
        message: `Bundle ${binding.bundleId} is not currently trusted and reachable`,
        lane: binding.lane,
        bundleId: binding.bundleId,
      });
    }
    const missingTools = (binding.toolAllowlist ?? []).filter(tool => !allowedTools.has(tool));
    if (missingTools.length > 0) {
      const code = 'aiops_lane_tool_missing';
      laneIssueCodes.push(code);
      issues.push({
        code,
        severity: issueSeverity(binding.requirement),
        message: `${missingTools.length} allowlisted tool(s) are unavailable in bundle ${binding.bundleId}`,
        lane: binding.lane,
        bundleId: binding.bundleId,
      });
    }
    recoveryActions.push(...recoveryForBundle(binding.bundleId, check));
    const hasOperationalBlocker = (check.operationalBlockers ?? []).length > 0;
    const state = laneIssueCodes.length === 0
      ? 'ready' as const
      : hasOperationalBlocker
        ? 'blocked' as const
        : 'missing' as const;
    const bundle = check.bundles[0];
    return {
      lane: binding.lane,
      requirement: binding.requirement,
      state,
      bundleId: binding.bundleId,
      bundleName: bundle?.bundleName ?? null,
      providedCategories: (bundle?.categories ?? []).filter(category => PROFILE_CAPABILITIES.has(category)) as Array<
        'metrics' | 'logs' | 'traces' | 'runtime' | 'topology' | 'incident' | 'repository' | 'rag'
      >,
      toolNames: [...allowedTools]
        .filter(tool => !binding.toolAllowlist || binding.toolAllowlist.includes(tool))
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 32),
      issueCodes: laneIssueCodes,
    };
  }));

  const runtimeRequired = config.evidencePolicy.lanes.some(
    lane => lane.lane === 'runtime' && lane.requirement === 'required',
  ) || config.remediationPolicy.mode === 'governed-execute';
  const runtimeScope = config.selectors.runtime ?? null;
  let certification: KubernetesCertificationRecord | null = null;
  let runtimeState: AiOpsServiceProfileReadiness['runtime']['state'] = runtimeRequired ? 'missing' : 'not_required';
  if (runtimeScope) {
    certification = await deps.loadRuntimeCertification(pool, {
      backendId: runtimeScope.backendId,
      targetId: runtimeScope.targetId,
    });
    if (certification?.status === 'passed' && certification.freshness !== 'stale') {
      runtimeState = 'ready';
      if (certification.freshness === 'expiring') {
        issues.push({
          code: 'aiops_runtime_certification_expiring',
          severity: 'warning',
          message: 'Kubernetes connector certification is expiring',
          backendId: runtimeScope.backendId,
        });
      }
    } else {
      runtimeState = certification ? 'blocked' : 'missing';
      issues.push({
        code: certification?.status === 'failed'
          ? 'aiops_runtime_certification_failed'
          : certification?.freshness === 'stale'
            ? 'aiops_runtime_certification_stale'
            : 'aiops_runtime_certification_missing',
        severity: runtimeRequired ? 'blocking' : 'warning',
        message: certification
          ? 'Kubernetes connector certification is not valid for a new AIOps run'
          : 'Kubernetes connector certification is missing',
        backendId: runtimeScope.backendId,
      });
      recoveryActions.push({
        id: `renew-certification-${runtimeScope.backendId}-${runtimeScope.targetId}`,
        label: 'Renew Kubernetes certification',
        kind: 'renew_certification',
        href: '/solutions/argus.aiops',
      });
    }
  } else if (runtimeRequired) {
    issues.push({
      code: 'aiops_runtime_scope_missing',
      severity: 'blocking',
      message: 'This profile requires an explicit runtime scope',
      lane: 'runtime',
    });
    recoveryActions.push({
      id: `edit-profile-${profile.id}`,
      label: 'Edit service profile',
      kind: 'edit_profile',
      href: `/solutions/argus.aiops/service-profiles/${profile.id}`,
    });
  }

  const readyEnabledLanes = lanes.filter(lane => lane.requirement !== 'disabled' && lane.state === 'ready').length;
  if (readyEnabledLanes < config.evidencePolicy.minimumCollectedLanes) {
    issues.push({
      code: 'aiops_minimum_evidence_not_met',
      severity: 'blocking',
      message: `Only ${readyEnabledLanes} evidence lane(s) are ready; ${config.evidencePolicy.minimumCollectedLanes} are required`,
    });
  }
  const requiredLanes = lanes.filter(lane => lane.requirement === 'required');
  const readyRequiredLanes = requiredLanes.filter(lane => lane.state === 'ready').length;
  const optionalGaps = lanes.filter(lane => lane.requirement === 'optional' && lane.state !== 'ready').length;
  const blockingIssues = issues.filter(issue => issue.severity === 'blocking').length;
  const state = blockingIssues > 0 ? 'blocked' : issues.length > 0 ? 'degraded' : 'ready';

  return aiOpsServiceProfileReadinessSchema.parse({
    schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
    kind: 'aiops-service-profile-readiness',
    profileId: profile.id,
    revision: profile.latestRevision.revision,
    profileSha256: profile.latestRevision.sha256,
    state,
    generatedAt: deps.now().toISOString(),
    lanes,
    runtime: {
      required: runtimeRequired,
      state: runtimeState,
      scope: runtimeScope,
      certification: certification ? {
        status: certification.status,
        freshness: certification.freshness,
        generatedAt: certification.generatedAt,
        expiresAt: certification.expiresAt,
      } : null,
    },
    summary: { requiredLanes: requiredLanes.length, readyRequiredLanes, optionalGaps, blockingIssues },
    issues,
    recoveryActions: dedupeActions(recoveryActions),
  });
}
