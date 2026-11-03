import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import pg from 'pg';
import type { A2aGateway } from '../a2a/client.js';
import {
  loadBundleCapabilities,
  type BundleCapabilityCategory,
} from '../solutionPacks/bundleCapabilities.js';
import {
  aiOpsServiceProfileConfigSchema,
  hashAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
  type AiOpsServiceProfileReadiness,
} from '../observability/aiopsServiceProfileContracts.js';
import {
  AiOpsServiceProfileInvestigationError,
  startAiOpsServiceProfileInvestigation,
} from '../observability/aiopsServiceProfileInvestigations.js';
import { evaluateAiOpsServiceProfileReadiness } from '../observability/aiopsServiceProfileReadiness.js';
import type { AiOpsServiceProfileRecord } from '../observability/aiopsServiceProfiles.js';

const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();
const now = new Date();
const metricToolName = 'aiops_prometheus_query_range';

type BundleRow = { id: number | string };
type BackendRow = { id: number | string };
type RuntimeToolRow = { backend_id: number | string; prefixed_name: string };
type AiOpsEvidenceLane = AiOpsServiceProfileConfig['evidencePolicy']['lanes'][number]['lane'];

const missingLaneCandidates: Array<{
  lane: AiOpsEvidenceLane;
  capability: BundleCapabilityCategory;
}> = [
  { lane: 'knowledge', capability: 'rag' },
  { lane: 'changes', capability: 'repository' },
  { lane: 'topology', capability: 'topology' },
  { lane: 'incident', capability: 'incident' },
];

function configFor(
  bundleId: number,
  lanes: AiOpsServiceProfileConfig['evidencePolicy']['lanes'],
  runtime?: { backendId: number; targetId: string },
): AiOpsServiceProfileConfig {
  return aiOpsServiceProfileConfigSchema.parse({
    schemaVersion: 1,
    service: {
      displayName: 'Readiness certification service',
      serviceName: 'argus-readiness-cert',
      environment: 'certification',
      description: 'Transactional fail-closed readiness certification.',
    },
    ownership: { team: 'argus', criticality: 'high' },
    evidencePolicy: {
      lanes,
      minimumCollectedLanes: lanes.filter(lane => lane.requirement !== 'disabled').length,
      correlationWindowMinutes: 30,
      maxProviderResultBytes: 65_536,
    },
    selectors: {
      otelServiceNames: ['argus-readiness-cert'],
      metricLabels: {},
      logLabels: {},
      traceOperations: [],
      ...(runtime ? {
        runtime: {
          kind: 'kubernetes',
          backendId: runtime.backendId,
          targetId: runtime.targetId,
          cluster: 'certification',
          namespace: 'argus-cert',
          workloads: [{ kind: 'Deployment', name: 'argus-readiness-cert' }],
        },
      } : {}),
    },
    detection: {
      nativeAlertRuleIds: [],
      nativeSloIds: [],
      providerMonitorRefs: [],
      autoInvestigate: false,
      cooldownMinutes: 15,
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
  });
}

function profile(config: AiOpsServiceProfileConfig): AiOpsServiceProfileRecord {
  const sha256 = hashAiOpsServiceProfileConfig(config);
  const timestamp = now.toISOString();
  return {
    id: 9_999_991,
    status: 'active',
    activeRevision: { revision: 1, sha256 },
    latestRevision: {
      revision: 1,
      sha256,
      config,
      createdAt: timestamp,
      createdBy: { id: 1, username: 'readiness-certifier' },
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

let packCalls = 0;
const noPackWork = {
  async getAgentCard() {
    packCalls += 1;
    throw new Error('blocked readiness must prevent Agent Card discovery');
  },
  async sendMessage() {
    packCalls += 1;
    throw new Error('blocked readiness must prevent Pack or model work');
  },
} as unknown as A2aGateway;

async function assertDispatchBlocked(
  db: pg.Pool,
  record: AiOpsServiceProfileRecord,
  readiness: AiOpsServiceProfileReadiness,
  expectedIssue: string,
): Promise<void> {
  let rejected: unknown;
  try {
    await startAiOpsServiceProfileInvestigation(db, record.id, {
      title: 'Certification incident',
      summary: 'This request must stop at the Core readiness boundary.',
    }, { kind: 'service', id: 'aiops-readiness-certifier', allowedBundleIds: [
      ...new Set(record.latestRevision.config.evidencePolicy.lanes.map(lane => lane.bundleId)),
    ] }, {
      getProfile: async () => record,
      getRevision: async () => record.latestRevision,
      evaluateReadiness: async () => readiness,
      a2a: noPackWork,
      now: () => now,
    });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected instanceof AiOpsServiceProfileInvestigationError);
  assert.equal(rejected.code, 'profile_blocked');
  assert.ok(rejected.issueCodes.includes(expectedIssue));
}

try {
  await client.query('BEGIN');
  const db = client as unknown as pg.Pool;
  const bundleResult = await client.query<BundleRow>(
    `SELECT id FROM mcp_service_bundles WHERE name='argus-aiops-observe' LIMIT 1`,
  );
  const bundleId = Number(bundleResult.rows[0]?.id);
  if (!Number.isSafeInteger(bundleId) || bundleId <= 0) {
    throw new Error("Bundle 'argus-aiops-observe' is required; start the AIOps demo overlay first");
  }
  const metricBackendResult = await client.query<BackendRow>(
    `SELECT backend.id
       FROM mcp_tools tool
       JOIN mcp_tool_bundles tool_bundle ON tool_bundle.tool_id=tool.id AND tool_bundle.bundle_id=$1
       JOIN mcp_backends backend ON tool.backend=backend.name OR tool.backend=('custom:' || backend.name)
       JOIN mcp_backend_bundles backend_bundle
         ON backend_bundle.backend_id=backend.id AND backend_bundle.bundle_id=tool_bundle.bundle_id
      WHERE tool.name=$2
      ORDER BY backend.id
      LIMIT 1`,
    [bundleId, metricToolName],
  );
  const metricBackendId = Number(metricBackendResult.rows[0]?.id);
  const runtimeToolResult = await client.query<RuntimeToolRow>(
    `SELECT remote.backend_id, remote.prefixed_name
       FROM mcp_remote_tools remote
       JOIN mcp_backend_bundles membership ON membership.backend_id=remote.backend_id
      WHERE membership.bundle_id=$1
        AND remote.tool_name='k8s_describe_resource'
      ORDER BY remote.backend_id
      LIMIT 1`,
    [bundleId],
  );
  const runtimeBackendId = Number(runtimeToolResult.rows[0]?.backend_id);
  const runtimeToolName = runtimeToolResult.rows[0]?.prefixed_name;
  if (!Number.isSafeInteger(metricBackendId) || metricBackendId <= 0 || !runtimeToolName
    || !Number.isSafeInteger(runtimeBackendId) || runtimeBackendId <= 0) {
    throw new Error('AIOps metrics and Kubernetes evidence tools must be installed before certification');
  }

  // A separate certification process has no live remote-client registry. For
  // this transaction only, neutralize unrelated MCP connection state so each
  // scenario proves exactly one intended failure. ROLLBACK restores the rows.
  await client.query(
    `UPDATE mcp_backends
        SET backend_type='http'
      WHERE backend_type='mcp'
        AND id IN (SELECT backend_id FROM mcp_backend_bundles WHERE bundle_id=$1)`,
    [bundleId],
  );

  const metricConfig = configFor(bundleId, [{
    lane: 'metrics', requirement: 'required', bundleId,
    toolAllowlist: [metricToolName], queryTemplates: [],
  }]);
  const metricProfile = profile(metricConfig);
  const baseline = await evaluateAiOpsServiceProfileReadiness(db, metricProfile);
  assert.equal(baseline.state, 'ready', 'baseline metrics evidence must be ready before fault injection');

  await client.query('UPDATE mcp_backends SET enabled=false WHERE id=$1', [metricBackendId]);
  const connectorLoss = await evaluateAiOpsServiceProfileReadiness(db, metricProfile);
  assert.equal(connectorLoss.state, 'blocked');
  assert.ok(connectorLoss.issues.some(issue => issue.code === 'aiops_bundle_operationally_blocked'
    && issue.severity === 'blocking'));
  assert.ok(connectorLoss.recoveryActions.some(action => action.kind === 'manage_connection'));
  await assertDispatchBlocked(db, metricProfile, connectorLoss, 'aiops_bundle_operationally_blocked');
  await client.query('UPDATE mcp_backends SET enabled=true WHERE id=$1', [metricBackendId]);

  const capabilities = await loadBundleCapabilities(db, [bundleId]);
  const provided = new Set(capabilities[0]?.categories ?? []);
  const missing = missingLaneCandidates.find(candidate => !provided.has(candidate.capability));
  if (!missing) throw new Error('AIOps observe bundle unexpectedly provides every negative-test capability');
  const missingConfig = configFor(bundleId, [{
    lane: missing.lane, requirement: 'required', bundleId, queryTemplates: [],
  }]);
  const missingProfile = profile(missingConfig);
  const missingLane = await evaluateAiOpsServiceProfileReadiness(db, missingProfile);
  assert.equal(missingLane.state, 'blocked');
  assert.ok(missingLane.issues.some(issue => issue.code === 'aiops_lane_capability_missing'
    && issue.lane === missing.lane && issue.severity === 'blocking'));
  await assertDispatchBlocked(db, missingProfile, missingLane, 'aiops_lane_capability_missing');

  const staleTargetId = `argus-cert-stale-${now.getTime()}`;
  const generatedAt = new Date(now.getTime() - 8 * 24 * 60 * 60_000);
  await client.query(
    `INSERT INTO mcp_kubernetes_connector_certifications
       (backend_id, target_id, platform, profile, status, contract_sha256, report_sha256,
        checks, check_count, passed_count, failed_count, generated_at, imported_by)
     VALUES ($1,$2,'kubernetes','production','passed',$3,$4,$5::jsonb,1,1,0,$6,'aiops-readiness-certifier')`,
    [
      runtimeBackendId,
      staleTargetId,
      createHash('sha256').update(`contract:${staleTargetId}`).digest('hex'),
      createHash('sha256').update(`report:${staleTargetId}`).digest('hex'),
      JSON.stringify([{ id: 'read-only', status: 'passed', detail: 'Transactional stale certification fixture' }]),
      generatedAt.toISOString(),
    ],
  );
  const staleConfig = configFor(bundleId, [
    {
      lane: 'metrics', requirement: 'required', bundleId,
      toolAllowlist: [metricToolName], queryTemplates: [],
    },
    {
      lane: 'runtime', requirement: 'required', bundleId,
      toolAllowlist: [runtimeToolName], queryTemplates: [],
    },
  ], { backendId: runtimeBackendId, targetId: staleTargetId });
  const staleProfile = profile(staleConfig);
  const staleCertification = await evaluateAiOpsServiceProfileReadiness(db, staleProfile);
  assert.equal(staleCertification.state, 'blocked');
  assert.equal(staleCertification.runtime.state, 'blocked');
  assert.equal(staleCertification.runtime.certification?.freshness, 'stale');
  assert.ok(staleCertification.issues.some(issue => issue.code === 'aiops_runtime_certification_stale'
    && issue.severity === 'blocking'));
  assert.ok(staleCertification.recoveryActions.some(action => action.kind === 'renew_certification'));
  await assertDispatchBlocked(db, staleProfile, staleCertification, 'aiops_runtime_certification_stale');

  assert.equal(packCalls, 0, 'fail-closed scenarios must not contact the Pack or spend model work');
  await client.query('ROLLBACK');
  console.log(JSON.stringify({
    ok: true,
    tokenFree: true,
    mutationFree: true,
    packCalls,
    bundleId,
    scenarios: {
      connectorLoss: {
        state: connectorLoss.state,
        issue: 'aiops_bundle_operationally_blocked',
        backendId: metricBackendId,
      },
      missingRequiredLane: {
        state: missingLane.state,
        lane: missing.lane,
        capability: missing.capability,
        issue: 'aiops_lane_capability_missing',
      },
      staleCertification: {
        state: staleCertification.state,
        runtimeState: staleCertification.runtime.state,
        freshness: staleCertification.runtime.certification?.freshness,
        issue: 'aiops_runtime_certification_stale',
      },
    },
  }, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
