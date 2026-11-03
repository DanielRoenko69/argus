import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert/strict';
import pg from 'pg';
import {
  hashAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
} from '../observability/aiopsServiceProfileContracts.js';
import { ingestAiOpsProviderSignalsWithClient } from '../observability/aiopsProviderSignals.js';

const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();

try {
  await client.query('BEGIN');
  const actor = await client.query<{ id: number; username: string }>(
    `SELECT id, username FROM mcp_users WHERE enabled ORDER BY id LIMIT 1`,
  );
  assert.ok(actor.rows[0], 'certification requires one enabled local user');
  const suffix = Date.now().toString(36);
  const serviceName = `argus-cert-provider-${suffix}`;
  const config: AiOpsServiceProfileConfig = {
    schemaVersion: 1,
    service: {
      displayName: 'Provider ingestion certification',
      serviceName,
      environment: 'certification',
    },
    ownership: { team: 'argus-certification', criticality: 'medium' },
    evidencePolicy: {
      lanes: [{ lane: 'metrics', requirement: 'required', bundleId: 1, queryTemplates: [] }],
      minimumCollectedLanes: 1,
      correlationWindowMinutes: 30,
      maxProviderResultBytes: 65_536,
    },
    selectors: {
      otelServiceNames: [serviceName],
      metricLabels: { service: serviceName, environment: 'certification' },
      logLabels: { service: serviceName, environment: 'certification' },
      traceOperations: [],
    },
    detection: {
      nativeAlertRuleIds: [],
      nativeSloIds: [],
      providerMonitorRefs: ['CertLatencyHigh', 'CertErrorRateHigh'],
      autoInvestigate: true,
      cooldownMinutes: 5,
    },
    context: { knowledgeSourceIds: [], runbookRefs: [], dependencyOverrides: [] },
    remediationPolicy: {
      mode: 'diagnose-only', allowedAdapterKeys: [], maxRiskWithoutApproval: 'none',
      requireApprovalInProduction: true, requireVerification: true, requireRollbackPlan: true,
    },
  };
  const profileHash = hashAiOpsServiceProfileConfig(config);
  const profile = await client.query<{ id: number }>(
    `INSERT INTO mcp_observability_aiops_service_profiles
       (service_name, environment, display_name, status, created_by_user_id)
     VALUES ($1,'certification','Provider ingestion certification','draft',$2)
     RETURNING id`,
    [serviceName, actor.rows[0].id],
  );
  const profileId = Number(profile.rows[0]!.id);
  await client.query(
    `INSERT INTO mcp_observability_aiops_service_profile_revisions
       (profile_id, revision, schema_version, profile_sha256, profile_json,
        created_by_user_id, created_by_actor_id, created_by_username)
     VALUES ($1,1,1,$2,$3::jsonb,$4,$4,$5)`,
    [profileId, profileHash, JSON.stringify(config), actor.rows[0].id, actor.rows[0].username],
  );
  await client.query(
    `UPDATE mcp_observability_aiops_service_profiles
        SET status='active', active_revision=1
      WHERE id=$1`,
    [profileId],
  );

  const firingPayload = {
    status: 'firing',
    groupKey: `{service="${serviceName}",environment="certification"}`,
    alerts: [
      {
        status: 'firing',
        labels: { alertname: 'CertLatencyHigh', service_name: serviceName, environment: 'certification', severity: 'warning' },
        annotations: { summary: 'Certification latency signal.' },
        startsAt: '2026-09-09T12:00:00.000Z',
        fingerprint: `latency-${suffix}`,
      },
      {
        status: 'firing',
        labels: { alertname: 'CertErrorRateHigh', service_name: serviceName, environment: 'certification', severity: 'critical' },
        annotations: { summary: 'Certification error-rate signal.' },
        startsAt: '2026-09-09T12:01:00.000Z',
        fingerprint: `errors-${suffix}`,
      },
    ],
  };
  const firingRaw = Buffer.from(JSON.stringify(firingPayload));
  const fired = await ingestAiOpsProviderSignalsWithClient(
    client, 'prometheus-alertmanager', firingPayload, firingRaw,
  );
  const replay = await ingestAiOpsProviderSignalsWithClient(
    client, 'prometheus-alertmanager', firingPayload, firingRaw,
  );

  const recoveryPayload = {
    status: 'resolved',
    groupKey: firingPayload.groupKey,
    alerts: [{
      ...firingPayload.alerts[0],
      status: 'resolved',
      endsAt: '2026-09-09T12:05:00.000Z',
      annotations: { summary: 'Certification latency signal recovered.' },
    }],
  };
  const recovered = await ingestAiOpsProviderSignalsWithClient(
    client,
    'prometheus-alertmanager',
    recoveryPayload,
    Buffer.from(JSON.stringify(recoveryPayload)),
  );

  assert.deepEqual(fired.results.map(result => result.disposition), ['created', 'created']);
  assert.deepEqual(replay.results.map(result => result.disposition), ['replayed', 'replayed']);
  assert.deepEqual(recovered.results.map(result => result.disposition), ['recovered']);
  assert.equal(new Set(fired.results.map(result => result.correlationGroupId)).size, 1, 'both firing signals must correlate');

  const evidence = await client.query<{
    events: string; rules: string; incidents: string; groups: string;
    firing_incidents: string; group_state: string; group_severity: string;
  }>(
    `SELECT
       (SELECT count(*) FROM mcp_observability_aiops_provider_signals WHERE service_profile_id=$1)::text AS events,
       (SELECT count(*) FROM mcp_observability_alert_rules WHERE provider_service_profile_id=$1)::text AS rules,
       (SELECT count(DISTINCT incident_id) FROM mcp_observability_aiops_provider_signals WHERE service_profile_id=$1 AND incident_id IS NOT NULL)::text AS incidents,
       (SELECT count(DISTINCT membership.group_id)
          FROM mcp_observability_aiops_provider_signals signal
          JOIN mcp_observability_alert_incident_group_members membership ON membership.incident_id=signal.incident_id
         WHERE signal.service_profile_id=$1)::text AS groups,
       (SELECT count(*) FROM mcp_observability_alert_incidents incident
          JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
         WHERE rule.provider_service_profile_id=$1 AND incident.state='firing')::text AS firing_incidents,
       (SELECT alert_group.state
          FROM mcp_observability_alert_incident_groups alert_group
         WHERE alert_group.id=$2) AS group_state,
       (SELECT alert_group.severity
          FROM mcp_observability_alert_incident_groups alert_group
         WHERE alert_group.id=$2) AS group_severity`,
    [profileId, fired.results[0]!.correlationGroupId],
  );
  const row = evidence.rows[0]!;
  assert.equal(Number(row.events), 3, 'replayed deliveries must not create duplicate evidence rows');
  assert.equal(Number(row.rules), 2, 'one hidden provider route per monitor fingerprint is expected');
  assert.equal(Number(row.incidents), 2, 'two provider alerts must preserve two signal incidents');
  assert.equal(Number(row.groups), 1, 'same-service events inside the window must form one group');
  assert.equal(Number(row.firing_incidents), 1, 'recovering one member must leave the other firing');
  assert.equal(row.group_state, 'firing', 'the correlated group must remain firing');
  assert.equal(row.group_severity, 'critical', 'the group must retain its highest firing severity');

  console.log(JSON.stringify({
    ok: true,
    tokenFree: true,
    provider: fired.provider,
    profile: { id: profileId, revision: 1, sha256: profileHash },
    acceptedSignals: fired.results.length + recovered.results.length,
    replayedSignals: replay.results.length,
    persistedEvents: Number(row.events),
    incidents: Number(row.incidents),
    correlationGroups: Number(row.groups),
    firingIncidentsAfterRecovery: Number(row.firing_incidents),
    groupState: row.group_state,
    groupSeverity: row.group_severity,
  }, null, 2));
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
