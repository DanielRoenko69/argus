import dotenv from 'dotenv';
dotenv.config();

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { A2aHttpJsonClient, type A2aTask } from '../a2a/client.js';
import { assertAgentExecutionReady } from '../agents/agentReadiness.js';
import { getAgent } from '../agents/agentStore.js';
import { loadConfig } from '../config/env.js';
import {
  getAiOpsServiceProfile,
  getAiOpsServiceProfileRevision,
  listAiOpsServiceProfiles,
  activateAiOpsServiceProfileAudited,
  createAiOpsServiceProfileAudited,
  reviseAiOpsServiceProfileAudited,
  setAiOpsServiceProfileStatusAudited,
  validateAiOpsServiceProfileAudited,
  type AiOpsProfileActorSnapshot,
  type AiOpsProfileAuditContext,
  type AiOpsServiceProfileRecord,
} from '../observability/aiopsServiceProfiles.js';
import {
  hashAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
} from '../observability/aiopsServiceProfileContracts.js';
import { evaluateAiOpsServiceProfileReadiness } from '../observability/aiopsServiceProfileReadiness.js';
import { startAiOpsServiceProfileInvestigation } from '../observability/aiopsServiceProfileInvestigations.js';
import { NativeAlertAiopsDispatcher } from '../observability/nativeAlertAiopsAutomation.js';
import {
  createNativeAlertRule,
  updateNativeAlertRule,
  type NativeAlertRule,
  type NativeAlertRuleInput,
} from '../observability/nativeAlerts.js';
import {
  incidentAiopsSnapshotFromTask,
  PostgresIncidentAiopsTaskStore,
  type IncidentAiopsTaskRecord,
} from '../observability/incidentAiopsTasks.js';
import { PostgresIncidentImpactReader } from '../observability/incidentImpact.js';
import { SolutionPackRegistry } from '../solutionPacks/discovery.js';
import { ExecutionGrantIssuer } from '../solutionPacks/executionGrant.js';

const EXECUTE = process.argv.includes('--execute');
const TIMEOUT_MS = Math.max(60_000, Math.min(20 * 60_000, Number(process.env['AIOPS_PROFILE_CERT_TIMEOUT_MS'] ?? 12 * 60_000)));
const POLL_MS = 2_000;
const BUNDLE_NAME = 'argus-aiops-observe';
const RULE_A_NAME = 'ARGUS-AIOPS-CERT · argus-core latency';
const RULE_B_NAME = 'ARGUS-AIOPS-CERT · checkout-api isolation';
const SERVICE_A = Object.freeze({ displayName: 'Argus Core certification', serviceName: 'argus-core', environment: 'local-demo' });
const SERVICE_B = Object.freeze({ displayName: 'Checkout API certification', serviceName: 'checkout-api', environment: 'argus-demo' });
const OBSERVE_TOOL_NAMES = Object.freeze([
  'aiops_prometheus_query',
  'aiops_prometheus_query_range',
  'aiops_loki_query_range',
  'aiops_jaeger_find_traces',
  'aiops_jaeger_get_trace',
]);
const TERMINAL_STATES = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
  'TASK_STATE_INPUT_REQUIRED',
  'TASK_STATE_AUTH_REQUIRED',
]);

type ServiceIdentity = Readonly<{ displayName: string; serviceName: string; environment: string }>;

type CertificationResult = {
  ok: boolean;
  runId: string;
  mode: 'preflight' | 'execute';
  bundle: { id: number; name: string };
  pack: { state: string; version: string | null };
  agents: Array<{ id: number; name: string; ready: boolean; runtime: string; toolCount: number }>;
  profiles?: Array<{ id: number; revision: number; sha256: string; service: string; environment: string; finalStatus: string }>;
  alerts?: { primaryRuleId: number; isolationRuleId: number; primaryIncidentId: number; isolationIncidentId: number };
  dispatch?: { first: unknown; dedupe: unknown; primaryRows: number; isolationRows: number };
  task?: {
    id: string;
    linkId: number;
    state: string;
    rootTraceId: string | null;
    quality: string | null;
    profile: { id: number; revision: number; sha256: string } | null;
    trigger: { kind: string; ref: string | null } | null;
    bundleIds: number[];
    service: string | null;
    environment: string | null;
  };
};

function profileConfig(identity: ServiceIdentity, alertRuleId: number, bundleId: number): AiOpsServiceProfileConfig {
  return {
    schemaVersion: 1,
    service: {
      ...identity,
      description: 'Reusable local certification profile for deterministic multi-service AIOps routing.',
    },
    ownership: {
      team: 'platform-certification',
      businessService: identity.serviceName,
      criticality: identity.serviceName === SERVICE_A.serviceName ? 'high' : 'medium',
    },
    evidencePolicy: {
      lanes: [
        {
          lane: 'metrics', requirement: 'required', bundleId,
          toolAllowlist: OBSERVE_TOOL_NAMES.slice(0, 2), queryTemplates: [],
        },
        {
          lane: 'logs', requirement: 'required', bundleId,
          toolAllowlist: [OBSERVE_TOOL_NAMES[2]!], queryTemplates: [],
        },
        {
          lane: 'traces', requirement: 'required', bundleId,
          toolAllowlist: OBSERVE_TOOL_NAMES.slice(3), queryTemplates: [],
        },
      ],
      minimumCollectedLanes: 3,
      correlationWindowMinutes: 30,
      maxProviderResultBytes: 65_536,
    },
    selectors: {
      otelServiceNames: [identity.serviceName],
      metricLabels: { service_name: identity.serviceName, environment: identity.environment },
      logLabels: { service_name: identity.serviceName, environment: identity.environment },
      traceOperations: [],
    },
    detection: {
      nativeAlertRuleIds: [alertRuleId],
      nativeSloIds: [],
      providerMonitorRefs: [],
      autoInvestigate: true,
      cooldownMinutes: 1,
    },
    context: { knowledgeSourceIds: [], runbookRefs: [], dependencyOverrides: [] },
    remediationPolicy: {
      mode: 'diagnose-only',
      allowedAdapterKeys: [],
      maxRiskWithoutApproval: 'none',
      requireApprovalInProduction: true,
      requireVerification: true,
      requireRollbackPlan: true,
    },
  };
}

function ruleInput(name: string, description: string): NativeAlertRuleInput {
  return {
    name,
    description,
    metric: 'p95_latency_ms',
    operator: 'gt',
    threshold: 750,
    windowMinutes: 30,
    minSamples: 1_000_000,
    severity: 'warning',
    scopeKind: 'all',
    scopeValue: null,
    cooldownMinutes: 1,
    notify: false,
    enabled: false,
    aiopsAutoInvestigate: false,
    aiopsBundleIds: [],
    aiopsResourceScope: null,
    aiopsService: null,
    aiopsEnvironment: null,
  };
}

function auditContext(runId: string, action: string, actor: AiOpsProfileActorSnapshot): AiOpsProfileAuditContext {
  return {
    producerEventId: randomUUID(),
    environment: 'local-certification',
    requestId: `${runId}:${action}`,
    actor: {
      type: 'human',
      id: String(actor.id),
      authMethod: 'local-certification',
      effectiveRoles: ['platform_admin'],
    },
  };
}

async function assertCoreAgentPreflight(
  pool: pg.Pool,
  bundleId: number,
): Promise<CertificationResult['agents']> {
  const required = ['aiops-researcher', 'aiops-knowledge', 'aiops-reviewer'] as const;
  const rows = await pool.query<{ id: number | string; name: string }>(
    'SELECT id, name FROM mcp_agents WHERE name=ANY($1::text[]) AND enabled=true',
    [required],
  );
  const byName = new Map(rows.rows.map(row => [row.name, Number(row.id)]));
  const missing = required.filter(name => !byName.has(name));
  if (missing.length > 0) throw new Error(`Required AIOps Core Agents are unavailable: ${missing.join(', ')}`);
  const snapshots: CertificationResult['agents'] = [];
  for (const name of required) {
    const id = byName.get(name)!;
    const agent = await getAgent(pool, id, { unmasked: true });
    if (!agent) throw new Error(`Required AIOps Core Agent '${name}' disappeared during preflight`);
    // The current certification profile has no knowledge lane. Knowledge and
    // reviewer are therefore model-only turns; researcher receives only the
    // exact telemetry tools frozen into the execution grant.
    const allowedToolNames = name === 'aiops-researcher' ? [...OBSERVE_TOOL_NAMES] : [];
    const readiness = await assertAgentExecutionReady(pool, agent, {
      bundleIds: [bundleId],
      allowedToolNames,
      probeRuntime: true,
    });
    snapshots.push({
      id,
      name,
      ready: readiness.ready,
      runtime: readiness.runtime.type,
      toolCount: readiness.tools.length,
    });
  }
  return snapshots;
}

async function existingRuleId(pool: pg.Pool, name: string): Promise<number | null> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM mcp_observability_alert_rules
      WHERE name=$1 AND archived_at IS NULL
      ORDER BY id DESC LIMIT 1`,
    [name],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

async function ensureRule(
  pool: pg.Pool,
  name: string,
  description: string,
  actorId: number,
): Promise<NativeAlertRule> {
  const found = await existingRuleId(pool, name);
  if (found) {
    const updated = await updateNativeAlertRule(pool, found, ruleInput(name, description));
    if (!updated) throw new Error(`Certification alert rule ${found} disappeared during preparation`);
    return updated;
  }
  return createNativeAlertRule(pool, ruleInput(name, description), actorId);
}

async function ensureProfile(
  pool: pg.Pool,
  config: AiOpsServiceProfileConfig,
  actor: AiOpsProfileActorSnapshot,
  runId: string,
): Promise<AiOpsServiceProfileRecord> {
  let profile = (await listAiOpsServiceProfiles(pool, {}, { includeArchived: true })).find(candidate => {
    const service = candidate.latestRevision.config.service;
    return service.serviceName === config.service.serviceName && service.environment === config.service.environment;
  });
  if (profile?.status === 'archived') {
    throw new Error(`Certification profile ${config.service.serviceName}/${config.service.environment} is archived; clone or restore it explicitly`);
  }
  if (!profile) {
    profile = (await createAiOpsServiceProfileAudited(
      pool, config, actor, auditContext(runId, `create:${config.service.serviceName}`, actor),
    )).value;
  } else if (profile.latestRevision.sha256 !== hashAiOpsServiceProfileConfig(config)) {
    profile = (await reviseAiOpsServiceProfileAudited(
      pool,
      profile.id,
      profile.latestRevision.revision,
      config,
      actor,
      auditContext(runId, `revise:${config.service.serviceName}`, actor),
    )).value;
  }
  const readiness = await evaluateAiOpsServiceProfileReadiness(pool, profile);
  if (readiness.state === 'blocked') {
    const blockers = readiness.issues.filter(issue => issue.severity === 'blocking').map(issue => issue.code);
    throw new Error(`Profile ${config.service.serviceName} is blocked: ${blockers.join(', ')}`);
  }
  await validateAiOpsServiceProfileAudited(
    pool, readiness, actor, auditContext(runId, `validate:${config.service.serviceName}`, actor),
  );
  profile = await getAiOpsServiceProfile(pool, profile.id);
  if (profile.status !== 'active'
    || profile.activeRevision?.revision !== profile.latestRevision.revision
    || profile.activeRevision.sha256 !== profile.latestRevision.sha256) {
    profile = (await activateAiOpsServiceProfileAudited(
      pool,
      profile.id,
      profile.latestRevision.revision,
      profile.latestRevision.revision,
      auditContext(runId, `activate:${config.service.serviceName}`, actor),
    )).value;
  }
  return profile;
}

async function pauseProfile(
  pool: pg.Pool,
  profileId: number,
  actor: AiOpsProfileActorSnapshot,
  runId: string,
): Promise<AiOpsServiceProfileRecord> {
  const current = await getAiOpsServiceProfile(pool, profileId);
  if (current.status !== 'active') return current;
  return (await setAiOpsServiceProfileStatusAudited(
    pool,
    profileId,
    'paused',
    current.latestRevision.revision,
    auditContext(runId, `pause:${current.latestRevision.config.service.serviceName}`, actor),
  )).value;
}

async function insertCertificationIncidents(
  pool: pg.Pool,
  ruleA: NativeAlertRule,
  ruleB: NativeAlertRule,
  runId: string,
): Promise<{ primaryIncidentId: number; isolationIncidentId: number }> {
  await pool.query(
    `UPDATE mcp_observability_alert_incidents
        SET state='recovered', recovered_at=COALESCE(recovered_at, now()), updated_at=now()
      WHERE rule_id=ANY($1::bigint[]) AND state='firing'`,
    [[ruleA.id, ruleB.id]],
  );
  await pool.query(
    `UPDATE mcp_observability_incident_aiops_dispatches dispatch
        SET status='skipped', last_error='Superseded by a later certification run', updated_at=now()
       FROM mcp_observability_alert_incidents incident
      WHERE dispatch.incident_id=incident.id
        AND incident.rule_id=ANY($1::bigint[])
        AND dispatch.status IN ('pending','dispatching','failed')`,
    [[ruleA.id, ruleB.id]],
  );
  const primary = await pool.query<{ id: number }>(
    `INSERT INTO mcp_observability_alert_incidents
       (rule_id, state, severity, metric_value, threshold, sample_count, message, context)
     VALUES ($1,'firing','warning',1850,750,24,$2,$3::jsonb)
     RETURNING id`,
    [
      ruleA.id,
      'Certification signal: Argus Core P95 latency is 1850 ms. Correlate metrics, logs and traces; diagnose only.',
      JSON.stringify({ certification: true, runId, expectedService: SERVICE_A.serviceName }),
    ],
  );
  const isolation = await pool.query<{ id: number }>(
    `INSERT INTO mcp_observability_alert_incidents
       (rule_id, state, severity, metric_value, threshold, sample_count, message, context, recovered_at)
     VALUES ($1,'recovered','warning',410,750,24,$2,$3::jsonb,now())
     RETURNING id`,
    [
      ruleB.id,
      'Certification control: checkout-api is healthy and must not dispatch an investigation.',
      JSON.stringify({ certification: true, runId, expectedService: SERVICE_B.serviceName, isolationControl: true }),
    ],
  );
  await pool.query(
    `UPDATE mcp_observability_alert_rules
        SET enabled=true,
            last_state=CASE WHEN id=$1 THEN 'firing' ELSE 'ok' END,
            updated_at=now()
      WHERE id=ANY($2::bigint[])`,
    [ruleA.id, [ruleA.id, ruleB.id]],
  );
  return { primaryIncidentId: Number(primary.rows[0]!.id), isolationIncidentId: Number(isolation.rows[0]!.id) };
}

async function waitForTaskLink(
  tasks: PostgresIncidentAiopsTaskStore,
  incidentId: number,
  timeoutMs = 30_000,
): Promise<IncidentAiopsTaskRecord> {
  const deadline = Date.now() + timeoutMs;
  do {
    const records = await tasks.list(incidentId, 5);
    if (records[0]) return records[0];
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error('The profile-backed dispatcher did not persist an incident task link');
}

async function waitForTask(
  a2a: A2aHttpJsonClient,
  tasks: PostgresIncidentAiopsTaskStore,
  record: IncidentAiopsTaskRecord,
  issuer: ExecutionGrantIssuer,
): Promise<IncidentAiopsTaskRecord> {
  let current = record;
  let task: A2aTask | null = null;
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    task = await a2a.getTask(current.packId, current.agentId, current.taskId);
    current = await tasks.update(current.id, incidentAiopsSnapshotFromTask(task, current.rootTraceId));
    process.stderr.write(`[aiops-profile-cert] task=${task.id} state=${task.status.state}\n`);
    if (TERMINAL_STATES.has(task.status.state)) break;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
  if (!task || !TERMINAL_STATES.has(task.status.state)) throw new Error(`AIOps task exceeded the ${TIMEOUT_MS} ms certification deadline`);
  const traceStatus = task.status.state === 'TASK_STATE_COMPLETED'
    ? 'completed'
    : task.status.state === 'TASK_STATE_CANCELED' ? 'cancelled' : 'failed';
  if (current.rootTraceId) {
    await issuer.finalizeRootTrace(current.rootTraceId, traceStatus, { taskId: task.id, state: task.status.state });
  }
  if (task.status.state !== 'TASK_STATE_COMPLETED') throw new Error(`AIOps task ended in ${task.status.state}`);
  return current;
}

async function main(): Promise<void> {
  const runId = randomUUID();
  const config = loadConfig();
  if (!config.postgresEnabled || !config.postgresConnectionUrl) throw new Error('Postgres is required');
  if (!config.solutionPackExecutionGrantSecret) throw new Error('AIOps execution grants are not configured');
  const pool = new pg.Pool({ connectionString: config.postgresConnectionUrl, max: 4 });
  const actor: AiOpsProfileActorSnapshot = { id: 1, username: 'Alex' };
  const profiles: AiOpsServiceProfileRecord[] = [];
  const rules: NativeAlertRule[] = [];
  let incidents: { primaryIncidentId: number; isolationIncidentId: number } | null = null;
  let result: CertificationResult | null = null;
  try {
    const user = await pool.query<{ id: number; username: string }>(
      'SELECT id, username FROM mcp_users WHERE id=$1 AND enabled=true', [actor.id],
    );
    if (!user.rows[0]) throw new Error('Local certification actor #1 is unavailable');
    actor.username = user.rows[0].username;
    const bundle = await pool.query<{ id: number; name: string }>(
      'SELECT id, name FROM mcp_service_bundles WHERE name=$1', [BUNDLE_NAME],
    );
    if (!bundle.rows[0]) throw new Error(`${BUNDLE_NAME} is not installed`);
    const registry = new SolutionPackRegistry(config.solutionPackEndpoints, {
      coreVersion: config.solutionPackCoreVersion,
      timeoutMs: config.solutionPackDiscoveryTimeoutMs,
    });
    await registry.refresh();
    const discovered = registry.get('argus.aiops');
    if (!discovered || discovered.state !== 'ready') {
      throw new Error(`Argus AIOps Pack is ${discovered?.state ?? 'not configured'}`);
    }
    const agents = await assertCoreAgentPreflight(pool, Number(bundle.rows[0].id));
    result = {
      ok: true,
      runId,
      mode: EXECUTE ? 'execute' : 'preflight',
      bundle: { id: Number(bundle.rows[0].id), name: bundle.rows[0].name },
      pack: { state: discovered.state, version: discovered.manifest?.metadata.version ?? null },
      agents,
    };
    if (!EXECUTE) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    const ruleA = await ensureRule(pool, RULE_A_NAME, 'Primary firing signal for profile-routing certification.', actor.id);
    const ruleB = await ensureRule(pool, RULE_B_NAME, 'Recovered control signal that must remain isolated.', actor.id);
    rules.push(ruleA, ruleB);
    const profileA = await ensureProfile(pool, profileConfig(SERVICE_A, ruleA.id, Number(bundle.rows[0].id)), actor, runId);
    const profileB = await ensureProfile(pool, profileConfig(SERVICE_B, ruleB.id, Number(bundle.rows[0].id)), actor, runId);
    profiles.push(profileA, profileB);
    incidents = await insertCertificationIncidents(pool, ruleA, ruleB, runId);

    const issuer = new ExecutionGrantIssuer(
      pool,
      config.solutionPackExecutionGrantSecret,
      undefined,
      undefined,
      config.managedRuntimeReadOnlyBundleIds,
    );
    const a2a = new A2aHttpJsonClient(registry, {
      timeoutMs: config.solutionPackDiscoveryTimeoutMs,
      executionGrantIssuer: issuer,
    });
    const tasks = new PostgresIncidentAiopsTaskStore(pool);
    const dispatcher = new NativeAlertAiopsDispatcher(
      pool,
      a2a,
      tasks,
      1,
      new PostgresIncidentImpactReader(pool),
      (profileId, signal, principal, expectedActiveProfile) => startAiOpsServiceProfileInvestigation(
        pool,
        profileId,
        signal,
        principal,
        {
          getProfile: getAiOpsServiceProfile,
          getRevision: getAiOpsServiceProfileRevision,
          evaluateReadiness: evaluateAiOpsServiceProfileReadiness,
          a2a,
          now: () => new Date(),
        },
        expectedActiveProfile,
      ),
    );
    const firstDispatch = await dispatcher.dispatchOnce();
    const link = await waitForTaskLink(tasks, incidents.primaryIncidentId);
    const dedupeDispatch = await dispatcher.dispatchOnce();
    const finished = await waitForTask(a2a, tasks, link, issuer);

    const counts = await pool.query<{ primary_rows: string; isolation_rows: string; primary_tasks: string }>(
      `SELECT
         count(*) FILTER (WHERE dispatch.incident_id=$1) AS primary_rows,
         count(*) FILTER (WHERE dispatch.incident_id=$2) AS isolation_rows,
         (SELECT count(*) FROM mcp_observability_incident_aiops_tasks task WHERE task.incident_id=$1) AS primary_tasks
       FROM mcp_observability_incident_aiops_dispatches dispatch
      WHERE dispatch.incident_id=ANY($3::bigint[])`,
      [incidents.primaryIncidentId, incidents.isolationIncidentId, [incidents.primaryIncidentId, incidents.isolationIncidentId]],
    );
    const primaryRows = Number(counts.rows[0]?.primary_rows ?? 0);
    const isolationRows = Number(counts.rows[0]?.isolation_rows ?? 0);
    const primaryTasks = Number(counts.rows[0]?.primary_tasks ?? 0);
    const expectedProfile = finished.executionContext.serviceProfile;
    const activeProfileA = profileA.activeRevision;
    if (!activeProfileA) throw new Error('Primary certification profile lost its active revision');
    const routingOk = primaryRows === 1
      && isolationRows === 0
      && primaryTasks === 1
      && expectedProfile?.id === profileA.id
      && expectedProfile.revision === activeProfileA.revision
      && expectedProfile.sha256 === activeProfileA.sha256
      && finished.executionContext.bundleIds.length === 1
      && finished.executionContext.bundleIds[0] === Number(bundle.rows[0].id)
      && finished.executionContext.service === SERVICE_A.serviceName
      && finished.executionContext.environment === SERVICE_A.environment
      && finished.executionContext.trigger?.kind === 'native-alert'
      && finished.executionContext.trigger.ref === String(incidents.primaryIncidentId);
    if (!routingOk) throw new Error('Persisted profile/task/trigger isolation evidence did not match the certification contract');
    result = {
      ...result,
      ok: true,
      profiles: profiles.map(profile => ({
        id: profile.id,
        revision: profile.latestRevision.revision,
        sha256: profile.latestRevision.sha256,
        service: profile.latestRevision.config.service.serviceName,
        environment: profile.latestRevision.config.service.environment,
        finalStatus: 'paused',
      })),
      alerts: {
        primaryRuleId: ruleA.id,
        isolationRuleId: ruleB.id,
        ...incidents,
      },
      dispatch: { first: firstDispatch, dedupe: dedupeDispatch, primaryRows, isolationRows },
      task: {
        id: finished.taskId,
        linkId: finished.id,
        state: finished.state,
        rootTraceId: finished.rootTraceId,
        quality: finished.quality,
        profile: finished.executionContext.serviceProfile,
        trigger: finished.executionContext.trigger,
        bundleIds: finished.executionContext.bundleIds,
        service: finished.executionContext.service,
        environment: finished.executionContext.environment,
      },
    };
  } finally {
    if (rules.length > 0) {
      await pool.query(
        `UPDATE mcp_observability_alert_rules SET enabled=false, last_state='ok', updated_at=now()
          WHERE id=ANY($1::bigint[])`,
        [rules.map(rule => rule.id)],
      ).catch(() => undefined);
    }
    if (incidents) {
      await pool.query(
        `UPDATE mcp_observability_alert_incidents
            SET state='recovered', recovered_at=COALESCE(recovered_at, now()), updated_at=now()
          WHERE id=ANY($1::bigint[]) AND state='firing'`,
        [[incidents.primaryIncidentId, incidents.isolationIncidentId]],
      ).catch(() => undefined);
    }
    for (const profile of profiles.reverse()) {
      await pauseProfile(pool, profile.id, actor, runId).catch(error => {
        process.stderr.write(`[aiops-profile-cert] failed to pause profile ${profile.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }
    await pool.end();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`[aiops-profile-cert] failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
