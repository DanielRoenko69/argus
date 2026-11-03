import dotenv from 'dotenv';
dotenv.config();

import assert from 'node:assert/strict';
import pg from 'pg';
import { correlateNativeAlertIncident } from '../observability/alertIncidentCorrelation.js';
import { getIncidentChangeCorrelations } from '../observability/incidentCorrelation.js';
import type { NativeAlertRule } from '../observability/nativeAlerts.js';

const connectionString = process.env['POSTGRES_CONNECTION_URL'] ?? process.env['DATABASE_URL'] ?? '';
if (!connectionString) throw new Error('POSTGRES_CONNECTION_URL or DATABASE_URL is required');

const pool = new pg.Pool({ connectionString, max: 1 });
const client = await pool.connect();

function rule(id: number, service: string, environment: string): NativeAlertRule {
  const now = new Date().toISOString();
  return {
    id, name: `Correlation certification ${id}`, description: '', metric: 'failure_count', operator: 'gte',
    threshold: 1, windowMinutes: 30, minSamples: 1, severity: 'warning', scopeKind: 'all', scopeValue: null,
    cooldownMinutes: 30, notify: false, enabled: true, aiopsAutoInvestigate: false, aiopsBundleIds: [],
    aiopsResourceScope: null, aiopsService: service, aiopsEnvironment: environment,
    lastState: 'firing', lastValue: 1, lastSampleCount: 1, lastEvaluatedAt: now, lastTriggeredAt: now,
    createdAt: now, updatedAt: now, openIncidentId: null,
  };
}

try {
  await client.query('BEGIN');
  const rules = await client.query<{ id: number }>(
    `INSERT INTO mcp_observability_alert_rules
      (name, description, metric, operator, threshold, window_minutes, min_samples, severity,
       scope_kind, cooldown_minutes, notify, enabled, aiops_auto_investigate, aiops_bundle_ids,
       aiops_service, aiops_environment)
     VALUES
      ('ARGUS-CERT correlation latency', '', 'failure_count', 'gte', 1, 30, 1, 'warning', 'all', 30, false, true, false, ARRAY[]::integer[], 'checkout-api', 'production'),
      ('ARGUS-CERT correlation errors', '', 'failure_count', 'gte', 1, 30, 1, 'critical', 'all', 30, false, true, false, ARRAY[]::integer[], 'checkout-api', 'production'),
      ('ARGUS-CERT foreign service', '', 'failure_count', 'gte', 1, 30, 1, 'warning', 'all', 30, false, true, false, ARRAY[]::integer[], 'payments-api', 'production'),
      ('ARGUS-CERT foreign environment', '', 'failure_count', 'gte', 1, 30, 1, 'warning', 'all', 30, false, true, false, ARRAY[]::integer[], 'checkout-api', 'staging'),
      ('ARGUS-CERT expired window', '', 'failure_count', 'gte', 1, 30, 1, 'warning', 'all', 30, false, true, false, ARRAY[]::integer[], 'checkout-api', 'production')
     RETURNING id`,
  );
  const signalTime = new Date();
  const incidents: number[] = [];
  for (const [index, row] of rules.rows.entries()) {
    const service = index === 2 ? 'payments-api' : 'checkout-api';
    const environment = index === 3 ? 'staging' : 'production';
    const offsetMinutes = index === 4 ? 32 : index;
    const incidentContext = index === 0
      ? { exemplars: [{ title: 'checkout-api deployment', dominantSpanLabel: 'checkout-api' }] }
      : {};
    const inserted = await client.query<{ id: number; triggered_at: string }>(
      `INSERT INTO mcp_observability_alert_incidents
        (rule_id, state, severity, metric_value, threshold, sample_count, message, context, triggered_at)
       VALUES ($1,'firing',$2,2,1,2,$3,$4::jsonb,$5::timestamptz)
       RETURNING id, triggered_at`,
      [row.id, index === 1 ? 'critical' : 'warning', `Certification signal ${index + 1}`,
        JSON.stringify(incidentContext), new Date(signalTime.getTime() + offsetMinutes * 60_000).toISOString()],
    );
    const incident = inserted.rows[0]!;
    incidents.push(Number(incident.id));
    await correlateNativeAlertIncident(client, {
      incidentId: Number(incident.id),
      rule: rule(Number(row.id), service, environment),
      severity: index === 1 ? 'critical' : 'warning',
      triggeredAt: incident.triggered_at,
    });
  }

  const groups = await client.query<{
    id: number; service: string; environment: string; signal_count: number; severity: string;
    primary_incident_id: number; reasons: Array<Array<{ code: string }>>;
  }>(
    `SELECT alert_group.id, alert_group.service, alert_group.environment,
            alert_group.signal_count, alert_group.severity, alert_group.primary_incident_id,
            COALESCE(jsonb_agg(member.grouping_reasons ORDER BY member.grouped_at), '[]'::jsonb) AS reasons
       FROM mcp_observability_alert_incident_groups alert_group
       JOIN mcp_observability_alert_incident_group_members member ON member.group_id=alert_group.id
      WHERE member.incident_id=ANY($1::bigint[])
      GROUP BY alert_group.id
      ORDER BY alert_group.service`,
    [incidents],
  );
  const checkoutGroups = groups.rows.filter(group => group.service === 'checkout-api' && group.environment === 'production');
  const checkout = checkoutGroups.find(group => Number(group.signal_count) === 2);
  const checkoutExpired = checkoutGroups.find(group => Number(group.signal_count) === 1);
  const payments = groups.rows.find(group => group.service === 'payments-api');
  const staging = groups.rows.find(group => group.environment === 'staging');
  assert.equal(groups.rows.length, 4, 'foreign service, environment and expired windows must produce separate groups');
  assert.equal(Number(checkout?.signal_count), 2, 'same-service signals must share one group');
  assert.equal(checkout?.severity, 'critical', 'group severity must promote to the highest member severity');
  assert.equal(Number(payments?.signal_count), 1, 'foreign service must remain isolated');
  assert.equal(Number(staging?.signal_count), 1, 'foreign environment must remain isolated');
  assert.equal(Number(checkoutExpired?.signal_count), 1, 'signal outside the rolling correlation window must remain isolated');
  assert.deepEqual(
    checkout?.reasons.flatMap(reason => reason).map(reason => reason.code).sort(),
    ['primary_signal', 'same_environment', 'same_service', 'within_correlation_window'].sort(),
    'persisted membership must explain why signals were grouped',
  );

  const dispatchable = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM mcp_observability_alert_incidents incident
       LEFT JOIN mcp_observability_alert_incident_group_members member ON member.incident_id=incident.id
      WHERE incident.id=ANY($1::bigint[])
        AND (member.incident_id IS NULL OR member.role='primary')`,
    [incidents],
  );
  assert.equal(Number(dispatchable.rows[0]?.count), 4, 'only one primary signal per correlation group may dispatch');

  await client.query(
    `INSERT INTO mcp_admin_audit_log
       (action, table_name, object_id, object_label, changed_by, before_state, after_state, created_at)
     VALUES
       ('updated','mcp_backends','cert-runtime','checkout-api production runtime','argus-cert',
        '{"revision":"old"}'::jsonb,'{"revision":"new"}'::jsonb,$1::timestamptz - interval '10 minutes'),
       ('updated','mcp_models','cert-model','unrelated model','argus-cert',
        '{"enabled":false}'::jsonb,'{"enabled":true}'::jsonb,$1::timestamptz - interval '2 hours'),
       ('updated','mcp_tools','cert-old','checkout-api old deployment','argus-cert',
        '{"enabled":false}'::jsonb,'{"enabled":true}'::jsonb,$1::timestamptz - interval '7 hours')`,
    [signalTime.toISOString()],
  );
  const changeWindow = await getIncidentChangeCorrelations(client, incidents[0]!);
  assert.ok(changeWindow, 'incident change-window projection must exist');
  const directChange = changeWindow.changes.find(change => change.objectId === 'cert-runtime');
  const contextualChange = changeWindow.changes.find(change => change.objectId === 'cert-model');
  assert.equal(directChange?.relevance, 'direct', 'service-matching deployment change must be ranked direct');
  assert.equal(directChange?.minutesFromTrigger, -10, 'direct change must retain its signed temporal distance');
  assert.equal(contextualChange?.relevance, 'contextual', 'operational change inside the window must remain contextual');
  assert.ok(changeWindow.changes.every(change => change.objectId !== 'cert-old'), 'expired changes must never enter incident evidence');

  console.log(JSON.stringify({
    ok: true,
    tokenFree: true,
    signals: incidents.length,
    groups: groups.rows.length,
    dispatchablePrimaries: Number(dispatchable.rows[0]?.count),
    checkout: { signals: Number(checkout?.signal_count), severity: checkout?.severity },
    payments: { signals: Number(payments?.signal_count), severity: payments?.severity },
    staging: { signals: Number(staging?.signal_count), severity: staging?.severity },
    expiredWindow: { signals: Number(checkoutExpired?.signal_count), severity: checkoutExpired?.severity },
    changeWindow: {
      certifiedChanges: [directChange?.objectId, contextualChange?.objectId],
      excludedChanges: ['cert-old'],
      bounds: changeWindow.window,
    },
  }, null, 2));
  await client.query('ROLLBACK');
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  throw error;
} finally {
  client.release();
  await pool.end();
}
