import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { NativeAlertRule, NativeAlertSeverity } from './nativeAlerts.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type AlertGroupingReasonCode =
  | 'primary_signal'
  | 'same_service'
  | 'same_environment'
  | 'within_correlation_window';

export interface AlertGroupingReason {
  code: AlertGroupingReasonCode;
  summary: string;
  evidence: Record<string, string | number>;
}

export interface AlertCorrelationPolicy {
  service: string;
  environment: string;
  correlationWindowMinutes: number;
  serviceProfile: { id: number; revision: number; sha256: string } | null;
}

export interface AlertCorrelationCandidate {
  id: number;
  service: string;
  environment: string;
  lastSignalAt: string | Date;
}

export interface AlertIncidentCorrelationResult {
  groupId: number;
  correlationKey: string;
  role: 'primary' | 'member';
  reasons: AlertGroupingReason[];
}

interface ProfilePolicyRow {
  id: number | string;
  revision: number | string;
  sha256: string;
  service: string;
  environment: string;
  correlation_window_minutes: number | string;
}

interface GroupRow {
  id: number | string;
  correlation_key: string;
  service: string;
  environment: string;
  last_signal_at: string | Date;
}

const severityRank: Record<NativeAlertSeverity, number> = { info: 1, warning: 2, critical: 3 };

function boundedWindow(value: number): number {
  return Math.max(5, Math.min(360, Math.round(value)));
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

export function decideAlertCorrelation(
  policy: AlertCorrelationPolicy,
  triggeredAt: string | Date,
  candidate: AlertCorrelationCandidate,
): { matched: boolean; reasons: AlertGroupingReason[] } {
  const serviceMatches = normalized(candidate.service) === normalized(policy.service);
  const environmentMatches = normalized(candidate.environment) === normalized(policy.environment);
  const deltaMs = new Date(triggeredAt).getTime() - new Date(candidate.lastSignalAt).getTime();
  const windowMs = boundedWindow(policy.correlationWindowMinutes) * 60_000;
  const withinWindow = deltaMs >= 0 && deltaMs <= windowMs;
  const reasons: AlertGroupingReason[] = [];
  if (serviceMatches) reasons.push({
    code: 'same_service',
    summary: 'Signals target the same service.',
    evidence: { service: policy.service },
  });
  if (environmentMatches) reasons.push({
    code: 'same_environment',
    summary: 'Signals target the same environment.',
    evidence: { environment: policy.environment },
  });
  if (withinWindow) reasons.push({
    code: 'within_correlation_window',
    summary: 'Signal arrived inside the configured correlation window.',
    evidence: {
      deltaSeconds: Math.round(deltaMs / 1_000),
      correlationWindowMinutes: boundedWindow(policy.correlationWindowMinutes),
    },
  });
  return { matched: serviceMatches && environmentMatches && withinWindow, reasons };
}

export async function resolveAlertCorrelationPolicy(
  queryable: Queryable,
  rule: NativeAlertRule,
): Promise<AlertCorrelationPolicy | null> {
  const profileMatches = await queryable.query<ProfilePolicyRow>(
    `SELECT profile.id, revision.revision, revision.profile_sha256::text AS sha256,
            profile.service_name AS service, profile.environment,
            revision.profile_json #>> '{evidencePolicy,correlationWindowMinutes}' AS correlation_window_minutes
       FROM mcp_observability_aiops_service_profiles profile
       JOIN mcp_observability_aiops_service_profile_revisions revision
         ON revision.profile_id=profile.id AND revision.revision=profile.active_revision
      WHERE profile.workspace_key='default' AND profile.tenant_key='default'
        AND profile.status='active'
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(
              COALESCE(revision.profile_json #> '{detection,nativeAlertRuleIds}', '[]'::jsonb)
            ) alert_rule_id
           WHERE alert_rule_id::bigint=$1
        )
      ORDER BY profile.id
      LIMIT 2`,
    [rule.id],
  );
  if (profileMatches.rows.length === 1) {
    const profile = profileMatches.rows[0]!;
    return {
      service: profile.service,
      environment: profile.environment,
      correlationWindowMinutes: boundedWindow(Number(profile.correlation_window_minutes)),
      serviceProfile: { id: Number(profile.id), revision: Number(profile.revision), sha256: profile.sha256 },
    };
  }
  if (profileMatches.rows.length > 1 || !rule.aiopsService?.trim() || !rule.aiopsEnvironment?.trim()) return null;
  return {
    service: rule.aiopsService.trim(),
    environment: rule.aiopsEnvironment.trim(),
    correlationWindowMinutes: boundedWindow(rule.windowMinutes),
    serviceProfile: null,
  };
}

function groupKey(policy: AlertCorrelationPolicy, primaryIncidentId: number, triggeredAt: string | Date): string {
  return createHash('sha256').update([
    normalized(policy.service), normalized(policy.environment),
    String(primaryIncidentId), new Date(triggeredAt).toISOString(),
  ].join('\0')).digest('hex');
}

export async function correlateNativeAlertIncident(
  queryable: Queryable,
  input: {
    incidentId: number;
    rule?: NativeAlertRule;
    policy?: AlertCorrelationPolicy;
    severity: NativeAlertSeverity;
    triggeredAt: string | Date;
  },
): Promise<AlertIncidentCorrelationResult | null> {
  const policy = input.policy
    ?? (input.rule ? await resolveAlertCorrelationPolicy(queryable, input.rule) : null);
  if (!policy) return null;

  const candidates = await queryable.query<GroupRow>(
    `SELECT id, correlation_key, service, environment, last_signal_at
       FROM mcp_observability_alert_incident_groups
      WHERE workspace_key='default' AND tenant_key='default'
        AND lower(service)=lower($1) AND lower(environment)=lower($2)
        AND last_signal_at <= $3::timestamptz
        AND last_signal_at >= $3::timestamptz - make_interval(mins => $4::int)
      ORDER BY last_signal_at DESC, id DESC
      LIMIT 1`,
    [policy.service, policy.environment, input.triggeredAt, policy.correlationWindowMinutes],
  );
  const candidate = candidates.rows[0];
  const decision = candidate
    ? decideAlertCorrelation(policy, input.triggeredAt, {
      id: Number(candidate.id), service: candidate.service,
      environment: candidate.environment, lastSignalAt: candidate.last_signal_at,
    })
    : null;

  let groupId: number;
  let correlationKey: string;
  let role: 'primary' | 'member';
  let reasons: AlertGroupingReason[];
  if (candidate && decision?.matched) {
    groupId = Number(candidate.id);
    correlationKey = candidate.correlation_key;
    role = 'member';
    reasons = decision.reasons;
  } else {
    correlationKey = groupKey(policy, input.incidentId, input.triggeredAt);
    const inserted = await queryable.query<{ id: number | string }>(
      `INSERT INTO mcp_observability_alert_incident_groups
        (correlation_key, service, environment, state, severity, correlation_window_minutes,
         primary_incident_id, primary_service_profile_id, primary_service_profile_revision,
         primary_service_profile_sha256, first_triggered_at, last_signal_at)
       VALUES ($1,$2,$3,'firing',$4,$5,$6,$7,$8,$9,$10::timestamptz,$10::timestamptz)
       RETURNING id`,
      [correlationKey, policy.service, policy.environment, input.severity,
        policy.correlationWindowMinutes, input.incidentId, policy.serviceProfile?.id ?? null,
        policy.serviceProfile?.revision ?? null, policy.serviceProfile?.sha256 ?? null, input.triggeredAt],
    );
    groupId = Number(inserted.rows[0]!.id);
    role = 'primary';
    reasons = [{
      code: 'primary_signal',
      summary: 'Signal opened the correlated incident group.',
      evidence: { service: policy.service, environment: policy.environment },
    }];
  }

  await queryable.query(
    `INSERT INTO mcp_observability_alert_incident_group_members
      (group_id, incident_id, role, grouping_reasons,
       service_profile_id, service_profile_revision, service_profile_sha256)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     ON CONFLICT (incident_id) DO NOTHING`,
    [groupId, input.incidentId, role, JSON.stringify(reasons), policy.serviceProfile?.id ?? null,
      policy.serviceProfile?.revision ?? null, policy.serviceProfile?.sha256 ?? null],
  );
  await queryable.query(
    `UPDATE mcp_observability_alert_incident_groups
        SET state='firing', recovered_at=NULL,
            severity=CASE WHEN $2::int > CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 ELSE 1 END
                          THEN $3 ELSE severity END,
            signal_count=(SELECT count(*) FROM mcp_observability_alert_incident_group_members WHERE group_id=$1),
            last_signal_at=GREATEST(last_signal_at, $4::timestamptz), updated_at=now()
      WHERE id=$1`,
    [groupId, severityRank[input.severity], input.severity, input.triggeredAt],
  );
  return { groupId, correlationKey, role, reasons };
}

export async function refreshAlertIncidentCorrelationGroup(
  queryable: Queryable,
  incidentId: number,
): Promise<void> {
  await queryable.query(
    `UPDATE mcp_observability_alert_incident_groups alert_group
        SET state=CASE WHEN EXISTS (
              SELECT 1
                FROM mcp_observability_alert_incident_group_members active_member
                JOIN mcp_observability_alert_incidents active_incident ON active_incident.id=active_member.incident_id
               WHERE active_member.group_id=alert_group.id AND active_incident.state='firing'
            ) THEN 'firing' ELSE 'recovered' END,
            recovered_at=CASE WHEN EXISTS (
              SELECT 1
                FROM mcp_observability_alert_incident_group_members active_member
                JOIN mcp_observability_alert_incidents active_incident ON active_incident.id=active_member.incident_id
               WHERE active_member.group_id=alert_group.id AND active_incident.state='firing'
            ) THEN NULL ELSE now() END,
            updated_at=now()
      WHERE alert_group.id=(
        SELECT membership.group_id
          FROM mcp_observability_alert_incident_group_members membership
         WHERE membership.incident_id=$1
      )`,
    [incidentId],
  );
}
