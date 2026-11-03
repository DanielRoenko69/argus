import { createHash } from 'node:crypto';
import type pg from 'pg';
import { Counter } from 'prom-client';
import { z } from 'zod';
import { redact, redactJson } from '../lib/redaction.js';
import { registry } from '../lib/metrics.js';
import {
  correlateNativeAlertIncident,
  refreshAlertIncidentCorrelationGroup,
  type AlertCorrelationPolicy,
} from './alertIncidentCorrelation.js';
import {
  parseAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
} from './aiopsServiceProfileContracts.js';
import type { NativeAlertSeverity } from './nativeAlerts.js';

export const AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION = 1 as const;
export const AIOPS_ALERT_PROVIDERS = [
  'prometheus-alertmanager',
  'grafana',
  'elasticsearch',
  'opensearch',
  'generic',
] as const;

export type AiOpsAlertProvider = (typeof AIOPS_ALERT_PROVIDERS)[number];
export type AiOpsProviderSignalState = 'firing' | 'recovered';

const boundedLabelsSchema = z.record(z.string().trim().max(240)).superRefine((labels, context) => {
  if (Object.keys(labels).length > 64) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'signal labels exceed 64 entries' });
  }
  for (const key of Object.keys(labels)) {
    if (!key.trim() || key.length > 120) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `invalid signal label key '${key}'` });
    }
  }
});

export const aiOpsProviderSignalSchema = z.object({
  schemaVersion: z.literal(AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION).default(AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION),
  eventId: z.string().trim().min(1).max(300),
  monitorRef: z.string().trim().min(1).max(300),
  state: z.enum(['firing', 'recovered']),
  severity: z.enum(['info', 'warning', 'critical']),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(4_000),
  service: z.string().trim().min(1).max(160),
  environment: z.string().trim().min(1).max(120),
  fingerprint: z.string().trim().min(1).max(500).optional(),
  occurredAt: z.string().datetime({ offset: true }),
  evidenceUrl: z.string().trim().max(2_048).optional(),
  labels: boundedLabelsSchema.default({}),
}).strict();

const canonicalEnvelopeSchema = z.object({
  schemaVersion: z.literal(AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION).default(AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION),
  signals: z.array(aiOpsProviderSignalSchema).min(1).max(100),
}).strict();

const alertmanagerAlertSchema = z.object({
  status: z.enum(['firing', 'resolved']).optional(),
  labels: boundedLabelsSchema,
  annotations: boundedLabelsSchema.optional(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  fingerprint: z.string().trim().min(1).max(500),
}).passthrough();

const alertmanagerEnvelopeSchema = z.object({
  status: z.enum(['firing', 'resolved']).optional(),
  receiver: z.string().trim().max(300).optional(),
  groupKey: z.string().trim().max(1_000).optional(),
  alerts: z.array(alertmanagerAlertSchema).min(1).max(100),
}).passthrough();

export type AiOpsProviderSignal = z.infer<typeof aiOpsProviderSignalSchema>;

export interface AiOpsProviderSignalIngestionResult {
  provider: AiOpsAlertProvider;
  eventId: string;
  disposition: 'created' | 'updated' | 'recovered' | 'ignored' | 'replayed';
  signalState: AiOpsProviderSignalState;
  serviceProfile: { id: number; revision: number; sha256: string };
  alertRuleId: number;
  incidentId: number | null;
  correlationGroupId: number | null;
}

export class AiOpsProviderSignalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    readonly code:
      | 'invalid_provider'
      | 'invalid_signal'
      | 'profile_not_found'
      | 'profile_ambiguous'
      | 'profile_revision_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'AiOpsProviderSignalError';
  }
}

interface ActiveProfileRow {
  id: number | string;
  active_revision: number | string;
  profile_sha256: string;
  profile_json: unknown;
}

interface ProviderEventRow {
  provider_event_id: string;
  disposition: 'created' | 'updated' | 'recovered' | 'ignored';
  signal_state: AiOpsProviderSignalState;
  service_profile_id: number | string;
  service_profile_revision: number | string;
  service_profile_sha256: string;
  alert_rule_id: number | string;
  incident_id: number | string | null;
  correlation_group_id?: number | string | null;
}

const aiopsProviderSignalsIngestedCounter = new Counter({
  name: 'argus_aiops_provider_signals_ingested_total',
  help: 'Normalized AIOps provider signals accepted by provider, state and disposition.',
  labelNames: ['provider', 'state', 'disposition'] as const,
  registers: [registry],
});

function stableId(...values: string[]): string {
  return createHash('sha256').update(values.join('\0')).digest('hex');
}

function label(labels: Record<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = labels[key]?.trim();
    if (value) return value;
  }
  return null;
}

const SENSITIVE_URL_PARAMETER = /(?:^|[_-])(token|api[_-]?key|authorization|auth|password|passwd|secret|signature|sig|credential)(?:$|[_-])/i;

/**
 * Provider links are rendered in the Console but are never fetched by Core.
 * Retain useful provider filters while removing fragments, credentials and
 * query parameters that commonly carry bearer material.
 */
export function sanitizeAiOpsProviderEvidenceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 2_048) return null;
  try {
    const parsed = new URL(value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_URL_PARAMETER.test(key)) parsed.searchParams.delete(key);
    }
    const normalized = parsed.toString();
    return normalized.length <= 2_048 ? normalized : null;
  } catch {
    return null;
  }
}

function normalizedSeverity(value: string | null): NativeAlertSeverity {
  const severity = value?.toLocaleLowerCase('en-US');
  if (severity === 'critical' || severity === 'fatal' || severity === 'page' || severity === 'error') return 'critical';
  if (severity === 'warning' || severity === 'warn') return 'warning';
  return 'info';
}

function requiredProviderIdentity(
  labels: Record<string, string>,
): { monitorRef: string; service: string; environment: string; title: string } {
  const monitorRef = label(labels, 'monitor_ref', 'alertname', 'alert_rule_uid', 'rule_uid');
  const service = label(labels, 'service.name', 'service_name', 'service', 'app', 'job');
  const environment = label(labels, 'deployment.environment', 'environment', 'env', 'namespace');
  const title = label(labels, 'alertname', 'alert_rule_name', 'rule_name') ?? monitorRef;
  if (!monitorRef || !service || !environment || !title) {
    throw new AiOpsProviderSignalError(
      422,
      'invalid_signal',
      'Provider alert requires monitor, service and environment labels',
    );
  }
  return { monitorRef, service, environment, title };
}

function normalizeAlertmanagerLike(
  provider: 'prometheus-alertmanager' | 'grafana',
  raw: unknown,
): AiOpsProviderSignal[] {
  const parsed = alertmanagerEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiOpsProviderSignalError(400, 'invalid_signal', 'Provider webhook payload is invalid or exceeds limits');
  }
  return parsed.data.alerts.map(alert => {
    const identity = requiredProviderIdentity(alert.labels);
    const annotations = alert.annotations ?? {};
    const state = (alert.status ?? parsed.data.status) === 'resolved' ? 'recovered' : 'firing';
    const occurredAt = state === 'recovered' && alert.endsAt ? alert.endsAt : alert.startsAt;
    const summary = label(annotations, 'summary', 'description', 'message')
      ?? `${identity.title} is ${state} for ${identity.service} in ${identity.environment}.`;
    const eventId = stableId(
      provider,
      parsed.data.groupKey ?? '',
      alert.fingerprint,
      state,
      occurredAt,
    );
    const evidenceUrl = [alert['generatorURL'], alert['dashboardURL'], alert['panelURL'], alert['silenceURL']]
      .map(sanitizeAiOpsProviderEvidenceUrl)
      .find((value): value is string => Boolean(value));
    return aiOpsProviderSignalSchema.parse({
      schemaVersion: AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION,
      eventId,
      monitorRef: identity.monitorRef,
      state,
      severity: normalizedSeverity(label(alert.labels, 'severity', 'priority', 'level')),
      title: identity.title,
      summary,
      service: identity.service,
      environment: identity.environment,
      fingerprint: alert.fingerprint,
      occurredAt,
      ...(evidenceUrl ? { evidenceUrl } : {}),
      labels: alert.labels,
    });
  });
}

export function parseAiOpsAlertProvider(raw: string): AiOpsAlertProvider {
  const provider = raw.trim().toLocaleLowerCase('en-US');
  if ((AIOPS_ALERT_PROVIDERS as readonly string[]).includes(provider)) return provider as AiOpsAlertProvider;
  throw new AiOpsProviderSignalError(404, 'invalid_provider', `Unsupported AIOps alert provider '${raw}'`);
}

export function normalizeAiOpsProviderSignals(
  providerValue: string,
  raw: unknown,
): { provider: AiOpsAlertProvider; signals: AiOpsProviderSignal[] } {
  const provider = parseAiOpsAlertProvider(providerValue);
  if (provider === 'prometheus-alertmanager' || provider === 'grafana') {
    return { provider, signals: normalizeAlertmanagerLike(provider, raw) };
  }
  const parsed = canonicalEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiOpsProviderSignalError(
      400,
      'invalid_signal',
      `${provider} connector payload must use the bounded Argus provider-signal envelope`,
    );
  }
  return {
    provider,
    signals: parsed.data.signals.map(signal => {
      const evidenceUrl = sanitizeAiOpsProviderEvidenceUrl(signal.evidenceUrl);
      return { ...signal, ...(evidenceUrl ? { evidenceUrl } : { evidenceUrl: undefined }) };
    }),
  };
}

function activeProfilePolicy(row: ActiveProfileRow): {
  policy: AlertCorrelationPolicy;
  config: AiOpsServiceProfileConfig;
} {
  const id = Number(row.id);
  const revision = Number(row.active_revision);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(revision) || revision <= 0
    || !/^[a-f0-9]{64}$/.test(row.profile_sha256)) {
    throw new AiOpsProviderSignalError(409, 'profile_revision_invalid', 'Active Service Profile revision is invalid');
  }
  const config = parseAiOpsServiceProfileConfig(row.profile_json);
  return {
    config,
    policy: {
      service: config.service.serviceName,
      environment: config.service.environment,
      correlationWindowMinutes: config.evidencePolicy.correlationWindowMinutes,
      serviceProfile: { id, revision, sha256: row.profile_sha256 },
    },
  };
}

async function resolveActiveProfile(
  queryable: Pick<pg.Pool, 'query'>,
  provider: AiOpsAlertProvider,
  signal: AiOpsProviderSignal,
): Promise<{ policy: AlertCorrelationPolicy; config: AiOpsServiceProfileConfig }> {
  const qualifiedMonitorRef = `${provider}:${signal.monitorRef}`;
  const result = await queryable.query<ActiveProfileRow>(
    `SELECT profile.id, profile.active_revision, revision.profile_sha256::text, revision.profile_json
       FROM mcp_observability_aiops_service_profiles profile
       JOIN mcp_observability_aiops_service_profile_revisions revision
         ON revision.profile_id=profile.id AND revision.revision=profile.active_revision
      WHERE profile.workspace_key='default' AND profile.tenant_key='default'
        AND profile.status='active'
        AND lower(profile.service_name)=lower($1)
        AND lower(profile.environment)=lower($2)
        AND EXISTS (
          SELECT 1
            FROM jsonb_array_elements_text(
              COALESCE(revision.profile_json #> '{detection,providerMonitorRefs}', '[]'::jsonb)
            ) configured_ref
           WHERE configured_ref.value=$3 OR configured_ref.value=$4
        )
      ORDER BY profile.id
      LIMIT 2`,
    [signal.service, signal.environment, signal.monitorRef, qualifiedMonitorRef],
  );
  if (result.rows.length === 0) {
    throw new AiOpsProviderSignalError(
      404,
      'profile_not_found',
      `No active Service Profile owns '${signal.monitorRef}' for ${signal.service} / ${signal.environment}`,
    );
  }
  if (result.rows.length > 1) {
    throw new AiOpsProviderSignalError(
      409,
      'profile_ambiguous',
      `Multiple active Service Profiles own '${signal.monitorRef}' for ${signal.service} / ${signal.environment}`,
    );
  }
  return activeProfilePolicy(result.rows[0]!);
}

async function ensureProviderRule(
  queryable: Pick<pg.Pool, 'query'>,
  provider: AiOpsAlertProvider,
  signal: AiOpsProviderSignal,
  policy: AlertCorrelationPolicy,
): Promise<number> {
  const profile = policy.serviceProfile!;
  const fingerprint = signal.fingerprint ?? signal.monitorRef;
  const ruleName = `Provider · ${signal.title}`.slice(0, 160);
  const result = await queryable.query<{ id: number | string }>(
    `INSERT INTO mcp_observability_alert_rules
       (name, description, metric, operator, threshold, window_minutes, min_samples,
        severity, scope_kind, scope_value, cooldown_minutes, notify, enabled,
        aiops_auto_investigate, aiops_bundle_ids, aiops_resource_scope,
        aiops_service, aiops_environment, source_kind, provider,
        provider_monitor_ref, provider_fingerprint, provider_service_profile_id,
        provider_service_profile_revision, provider_service_profile_sha256)
     VALUES ($1,'Provider-managed signal route','failure_count','gt',0,$2,1,$3,'all',NULL,
             $2,false,true,false,'{}',NULL,NULL,NULL,'provider',$4,$5,$6,$7,$8,$9)
     ON CONFLICT (provider_service_profile_id, provider_service_profile_revision,
                  provider, provider_monitor_ref, provider_fingerprint)
       WHERE source_kind='provider'
     DO UPDATE SET name=EXCLUDED.name, severity=EXCLUDED.severity,
                   window_minutes=EXCLUDED.window_minutes, enabled=true,
                   archived_at=NULL, archived_by=NULL, updated_at=now()
     RETURNING id`,
    [ruleName, policy.correlationWindowMinutes, signal.severity, provider,
      signal.monitorRef, fingerprint, profile.id, profile.revision, profile.sha256],
  );
  return Number(result.rows[0]!.id);
}

async function loadExistingEvent(
  queryable: Pick<pg.Pool, 'query'>,
  provider: AiOpsAlertProvider,
  eventId: string,
): Promise<ProviderEventRow | null> {
  const result = await queryable.query<ProviderEventRow>(
    `SELECT provider_signal.*,
            membership.group_id AS correlation_group_id
       FROM mcp_observability_aiops_provider_signals provider_signal
       LEFT JOIN mcp_observability_alert_incident_group_members membership
         ON membership.incident_id=provider_signal.incident_id
      WHERE provider_signal.workspace_key='default'
        AND provider_signal.tenant_key='default'
        AND provider_signal.provider=$1
        AND provider_signal.provider_event_id=$2
      LIMIT 1`,
    [provider, eventId],
  );
  return result.rows[0] ?? null;
}

function replayResult(provider: AiOpsAlertProvider, row: ProviderEventRow): AiOpsProviderSignalIngestionResult {
  return {
    provider,
    eventId: row.provider_event_id,
    disposition: 'replayed',
    signalState: row.signal_state,
    serviceProfile: {
      id: Number(row.service_profile_id),
      revision: Number(row.service_profile_revision),
      sha256: row.service_profile_sha256,
    },
    alertRuleId: Number(row.alert_rule_id),
    incidentId: row.incident_id == null ? null : Number(row.incident_id),
    correlationGroupId: row.correlation_group_id == null ? null : Number(row.correlation_group_id),
  };
}

async function correlationGroupForIncident(
  queryable: Pick<pg.Pool, 'query'>,
  incidentId: number | null,
): Promise<number | null> {
  if (incidentId == null) return null;
  const result = await queryable.query<{ group_id: number | string }>(
    `SELECT group_id
       FROM mcp_observability_alert_incident_group_members
      WHERE incident_id=$1`,
    [incidentId],
  );
  return result.rows[0] ? Number(result.rows[0].group_id) : null;
}

async function ingestOne(
  client: pg.PoolClient,
  provider: AiOpsAlertProvider,
  signal: AiOpsProviderSignal,
  rawPayloadSha256: string,
): Promise<AiOpsProviderSignalIngestionResult> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('argus-aiops-provider-signal'), hashtext($1))`,
    [JSON.stringify([provider, signal.eventId])],
  );
  const existing = await loadExistingEvent(client, provider, signal.eventId);
  if (existing) return replayResult(provider, existing);

  const { policy } = await resolveActiveProfile(client, provider, signal);
  const profile = policy.serviceProfile!;
  const alertRuleId = await ensureProviderRule(client, provider, signal, policy);
  const open = await client.query<{ id: number | string }>(
    `SELECT id FROM mcp_observability_alert_incidents
      WHERE rule_id=$1 AND state='firing'
      LIMIT 1 FOR UPDATE`,
    [alertRuleId],
  );
  let incidentId = open.rows[0] ? Number(open.rows[0].id) : null;
  let disposition: 'created' | 'updated' | 'recovered' | 'ignored';
  const safeTitle = redact(signal.title, { forceEnabled: true }).text.slice(0, 160);
  const safeSummary = redact(signal.summary, { forceEnabled: true }).text.slice(0, 4_000);
  const safeSignal = redactJson({ ...signal, title: safeTitle, summary: safeSummary }, { forceEnabled: true }).value;
  const context = {
    source: 'provider',
    providerSignal: {
      schemaVersion: AIOPS_PROVIDER_SIGNAL_SCHEMA_VERSION,
      provider,
      providerEventId: signal.eventId,
      monitorRef: signal.monitorRef,
      fingerprint: signal.fingerprint ?? signal.monitorRef,
      serviceProfile: profile,
      ...(signal.evidenceUrl ? { evidenceUrl: signal.evidenceUrl } : {}),
      labels: (safeSignal as Record<string, unknown>)['labels'] ?? {},
    },
  };

  if (signal.state === 'firing' && incidentId == null) {
    const inserted = await client.query<{ id: number | string }>(
      `INSERT INTO mcp_observability_alert_incidents
         (rule_id, state, severity, metric_value, threshold, sample_count,
          message, context, triggered_at)
       VALUES ($1,'firing',$2,1,0,1,$3,$4::jsonb,$5::timestamptz)
       RETURNING id`,
      [alertRuleId, signal.severity, safeSummary, JSON.stringify(context), signal.occurredAt],
    );
    incidentId = Number(inserted.rows[0]!.id);
    await correlateNativeAlertIncident(client, {
      incidentId,
      severity: signal.severity,
      triggeredAt: signal.occurredAt,
      policy,
    });
    disposition = 'created';
  } else if (signal.state === 'firing') {
    await client.query(
      `UPDATE mcp_observability_alert_incidents
          SET severity=CASE
                WHEN $2='critical' OR ($2='warning' AND severity='info') THEN $2
                ELSE severity
              END,
              message=$3, sample_count=sample_count+1, context=$4::jsonb, updated_at=now()
        WHERE id=$1`,
      [incidentId, signal.severity, safeSummary, JSON.stringify(context)],
    );
    await client.query(
      `UPDATE mcp_observability_alert_incident_groups alert_group
          SET severity=CASE
                WHEN $2='critical' OR ($2='warning' AND severity='info') THEN $2
                ELSE severity
              END,
              last_signal_at=GREATEST(last_signal_at,$3::timestamptz), updated_at=now()
        WHERE EXISTS (
          SELECT 1 FROM mcp_observability_alert_incident_group_members membership
           WHERE membership.group_id=alert_group.id AND membership.incident_id=$1
        )`,
      [incidentId, signal.severity, signal.occurredAt],
    );
    disposition = 'updated';
  } else if (incidentId != null) {
    await client.query(
      `UPDATE mcp_observability_alert_incidents
          SET state='recovered', recovered_at=$2::timestamptz,
              message=$3, context=$4::jsonb, updated_at=now()
        WHERE id=$1`,
      [incidentId, signal.occurredAt, safeSummary, JSON.stringify(context)],
    );
    await refreshAlertIncidentCorrelationGroup(client, incidentId);
    disposition = 'recovered';
  } else {
    disposition = 'ignored';
  }

  await client.query(
    `INSERT INTO mcp_observability_aiops_provider_signals
       (provider, provider_event_id, monitor_ref, fingerprint, signal_state,
        severity, service, environment, title, summary, occurred_at,
        raw_payload_sha256, normalized_signal, disposition,
        service_profile_id, service_profile_revision, service_profile_sha256,
        alert_rule_id, incident_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,$12,$13::jsonb,$14,$15,$16,$17,$18,$19)`,
    [provider, signal.eventId, signal.monitorRef, signal.fingerprint ?? signal.monitorRef,
      signal.state, signal.severity, policy.service, policy.environment, safeTitle,
      safeSummary, signal.occurredAt, rawPayloadSha256, JSON.stringify(safeSignal),
      disposition, profile.id, profile.revision, profile.sha256, alertRuleId, incidentId],
  );
  const correlationGroupId = await correlationGroupForIncident(client, incidentId);
  return {
    provider,
    eventId: signal.eventId,
    disposition,
    signalState: signal.state,
    serviceProfile: profile,
    alertRuleId,
    incidentId,
    correlationGroupId,
  };
}

export async function ingestAiOpsProviderSignalsWithClient(
  client: pg.PoolClient,
  providerValue: string,
  raw: unknown,
  rawPayload: Buffer,
): Promise<{ provider: AiOpsAlertProvider; results: AiOpsProviderSignalIngestionResult[]; dispatchRequested: boolean }> {
  const { provider, signals } = normalizeAiOpsProviderSignals(providerValue, raw);
  if (rawPayload.byteLength === 0 || rawPayload.byteLength > 1_048_576) {
    throw new AiOpsProviderSignalError(400, 'invalid_signal', 'Provider payload must be between 1 byte and 1 MiB');
  }
  const rawPayloadSha256 = createHash('sha256').update(rawPayload).digest('hex');
  const results: AiOpsProviderSignalIngestionResult[] = [];
  for (const signal of signals) {
    results.push(await ingestOne(client, provider, signal, rawPayloadSha256));
  }
  return {
    provider,
    results,
    dispatchRequested: results.some(result => result.signalState === 'firing' && result.disposition === 'created'),
  };
}

export async function ingestAiOpsProviderSignals(
  pool: pg.Pool,
  providerValue: string,
  raw: unknown,
  rawPayload: Buffer,
): Promise<{ provider: AiOpsAlertProvider; results: AiOpsProviderSignalIngestionResult[]; dispatchRequested: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const accepted = await ingestAiOpsProviderSignalsWithClient(client, providerValue, raw, rawPayload);
    await client.query('COMMIT');
    for (const result of accepted.results) {
      aiopsProviderSignalsIngestedCounter.inc({
        provider: accepted.provider,
        state: result.signalState,
        disposition: result.disposition,
      });
    }
    return accepted;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
