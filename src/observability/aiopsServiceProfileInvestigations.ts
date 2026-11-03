import type pg from 'pg';
import type { A2aGateway } from '../a2a/client.js';
import type { ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';
import {
  AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
  aiOpsResolvedServiceContextSchema,
  aiOpsServiceProfileInvestigationSignalSchema,
  aiOpsServiceProfileInvestigationStartedSchema,
  hashAiOpsResolvedServiceContext,
  type AiOpsResolvedServiceContext,
  type AiOpsServiceProfileInvestigationSignal,
  type AiOpsServiceProfileInvestigationStarted,
  type AiOpsServiceProfileReadiness,
} from './aiopsServiceProfileContracts.js';
import type {
  AiOpsProfileScope,
  AiOpsServiceProfileRecord,
  AiOpsServiceProfileRevision,
} from './aiopsServiceProfiles.js';

const LANE_CAPABILITY = Object.freeze({
  metrics: 'metrics',
  logs: 'logs',
  traces: 'traces',
  runtime: 'runtime',
  topology: 'topology',
  changes: 'repository',
  knowledge: 'rag',
  incident: 'incident',
} as const);

export class AiOpsServiceProfileInvestigationError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code: 'profile_not_active' | 'profile_blocked' | 'profile_context_invalid' | 'pack_contract_missing' | 'pack_rejected',
    message: string,
    readonly issueCodes: string[] = [],
  ) {
    super(message);
    this.name = 'AiOpsServiceProfileInvestigationError';
  }
}

export interface AiOpsServiceProfileInvestigationDependencies {
  getProfile(pool: pg.Pool, profileId: number, scope?: AiOpsProfileScope): Promise<AiOpsServiceProfileRecord>;
  getRevision(pool: pg.Pool, profileId: number, revision: number, scope?: AiOpsProfileScope): Promise<AiOpsServiceProfileRevision>;
  evaluateReadiness(pool: pg.Pool, profile: AiOpsServiceProfileRecord): Promise<AiOpsServiceProfileReadiness>;
  a2a: A2aGateway;
  now(): Date;
}

export interface AiOpsInvestigationPrincipal {
  kind: 'user' | 'api_key' | 'service';
  id: string;
  allowedBundleIds: number[] | null;
}

function activeProfileRecord(
  profile: AiOpsServiceProfileRecord,
  revision: AiOpsServiceProfileRevision,
): AiOpsServiceProfileRecord {
  return { ...profile, latestRevision: revision };
}

function resolvedContext(
  profile: AiOpsServiceProfileRecord,
  revision: AiOpsServiceProfileRevision,
  readiness: AiOpsServiceProfileReadiness,
  now: Date,
): AiOpsResolvedServiceContext {
  const config = revision.config;
  const readyLanes = readiness.lanes.filter(lane => lane.requirement !== 'disabled' && lane.state === 'ready');
  return aiOpsResolvedServiceContextSchema.parse({
    schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
    kind: 'aiops-resolved-service-context',
    profile: { id: profile.id, revision: revision.revision, sha256: revision.sha256 },
    service: config.service,
    ownership: config.ownership,
    evidence: {
      minimumCollectedLanes: config.evidencePolicy.minimumCollectedLanes,
      correlationWindowMinutes: config.evidencePolicy.correlationWindowMinutes,
      maxProviderResultBytes: config.evidencePolicy.maxProviderResultBytes,
      lanes: readyLanes.map(lane => {
        const binding = config.evidencePolicy.lanes.find(candidate => candidate.lane === lane.lane)!;
        return {
          lane: lane.lane,
          requirement: binding.requirement,
          bundleId: binding.bundleId,
          toolNames: lane.toolNames,
          queryTemplates: binding.queryTemplates,
        };
      }),
    },
    selectors: config.selectors,
    context: config.context,
    remediationPolicy: config.remediationPolicy,
    resolvedAt: now.toISOString(),
  });
}

function runtimeScope(context: AiOpsResolvedServiceContext): ExecutionResourceScopeRequest | undefined {
  const runtime = context.selectors.runtime;
  return runtime ? {
    kind: runtime.kind,
    backendId: runtime.backendId,
    targetId: runtime.targetId,
    namespace: runtime.namespace,
  } : undefined;
}

export async function startAiOpsServiceProfileInvestigation(
  pool: pg.Pool,
  profileId: number,
  signalValue: unknown,
  principal: AiOpsInvestigationPrincipal,
  dependencies: AiOpsServiceProfileInvestigationDependencies,
  expectedActiveProfile?: { revision: number; sha256: string },
): Promise<AiOpsServiceProfileInvestigationStarted> {
  const signal: AiOpsServiceProfileInvestigationSignal = aiOpsServiceProfileInvestigationSignalSchema.parse(signalValue);
  const profile = await dependencies.getProfile(pool, profileId);
  if (profile.status !== 'active' || !profile.activeRevision) {
    throw new AiOpsServiceProfileInvestigationError(409, 'profile_not_active', 'Activate a validated service profile before starting an investigation');
  }
  if (expectedActiveProfile && (
    profile.activeRevision.revision !== expectedActiveProfile.revision
    || profile.activeRevision.sha256 !== expectedActiveProfile.sha256
  )) {
    throw new AiOpsServiceProfileInvestigationError(
      409,
      'profile_context_invalid',
      'The active service profile changed after this investigation was queued',
    );
  }
  const revision = await dependencies.getRevision(pool, profile.id, profile.activeRevision.revision);
  if (revision.sha256 !== profile.activeRevision.sha256) {
    throw new AiOpsServiceProfileInvestigationError(409, 'profile_context_invalid', 'The active profile revision hash does not match stored evidence');
  }
  const readiness = await dependencies.evaluateReadiness(pool, activeProfileRecord(profile, revision));
  if (readiness.state === 'blocked') {
    throw new AiOpsServiceProfileInvestigationError(
      409,
      'profile_blocked',
      'The active service profile is not ready for a new investigation',
      readiness.issues.filter(issue => issue.severity === 'blocking').map(issue => issue.code),
    );
  }

  const context = resolvedContext(profile, revision, readiness, dependencies.now());
  const contextSha256 = hashAiOpsResolvedServiceContext(context);
  const bundleIds = [...new Set(context.evidence.lanes.map(lane => lane.bundleId))].sort((a, b) => a - b);
  const toolNames = [...new Set(context.evidence.lanes.flatMap(lane => lane.toolNames))].sort();
  const requiredBundleCategories = [...new Set(context.evidence.lanes
    .filter(lane => lane.requirement === 'required')
    .map(lane => LANE_CAPABILITY[lane.lane]))];

  const card = await dependencies.a2a.getAgentCard('argus.aiops', 'incident-orchestrator');
  if (card.capabilities?.['aiopsServiceContextVersion'] !== AIOPS_SERVICE_PROFILE_SCHEMA_VERSION) {
    throw new AiOpsServiceProfileInvestigationError(
      503,
      'pack_contract_missing',
      'Connected Argus AIOps does not support profile-backed investigation context v1',
    );
  }

  try {
    const result = await dependencies.a2a.sendMessage('argus.aiops', 'incident-orchestrator', {
      data: {
        operation: 'workflow.start',
        workflowId: 'incident-investigation',
        input: {
          title: signal.title,
          summary: signal.summary,
          severity: signal.severity,
          service: context.service.serviceName,
          environment: context.service.environment,
          correlation_window_minutes: context.evidence.correlationWindowMinutes,
          ...(signal.startedAt ? { started_at: signal.startedAt } : {}),
          ...(signal.alertSource ? { alert_source: signal.alertSource } : {}),
          ...(signal.alertUrl ? { alert_url: signal.alertUrl } : {}),
          ...(signal.keyword ? { signal_keyword: signal.keyword } : {}),
          ...(signal.fingerprint ? { signal_fingerprint: signal.fingerprint } : {}),
          ...(signal.labels || signal.sourceIncidentId ? { labels: {
            ...(signal.labels ?? {}),
            ...(signal.sourceIncidentId ? { argus_source_incident_id: String(signal.sourceIncidentId) } : {}),
          } } : {}),
        },
        resolvedServiceContext: context,
      },
    }, {
      principalKind: principal.kind,
      principalId: principal.id,
      principalAllowedBundleIds: principal.allowedBundleIds,
      requestedBundleIds: bundleIds,
      requestedToolNames: toolNames,
      requiredBundleCategories,
      aiopsServiceContext: {
        profileId: profile.id,
        revision: revision.revision,
        profileSha256: revision.sha256,
        resolvedContextSha256: contextSha256,
      },
      ...(runtimeScope(context) ? { requestedResourceScope: runtimeScope(context) } : {}),
    });
    return aiOpsServiceProfileInvestigationStartedSchema.parse({
      schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
      kind: 'aiops-service-profile-investigation-started',
      profile: context.profile,
      resolvedContextSha256: contextSha256,
      execution: {
        bundleIds,
        toolNames,
        resourceScope: runtimeScope(context) ?? null,
        service: context.service.serviceName,
        environment: context.service.environment,
      },
      rootTraceId: result.rootTraceId,
      task: result.task,
    });
  } catch (cause) {
    if (cause instanceof AiOpsServiceProfileInvestigationError) throw cause;
    throw new AiOpsServiceProfileInvestigationError(
      502,
      'pack_rejected',
      cause instanceof Error ? cause.message : 'Argus AIOps rejected the profile-backed investigation',
    );
  }
}
