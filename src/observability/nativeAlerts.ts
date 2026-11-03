import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type { ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';
import {
  correlateNativeAlertIncident,
  refreshAlertIncidentCorrelationGroup,
  type AlertGroupingReason,
} from './alertIncidentCorrelation.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type NativeAlertMetric = 'error_rate' | 'success_rate' | 'p95_latency_ms' | 'total_cost_usd' | 'failure_count' | 'latency_regression_percent' | 'cost_regression_percent';
export type NativeAlertOperator = 'gt' | 'gte' | 'lt' | 'lte';
export type NativeAlertSeverity = 'info' | 'warning' | 'critical';
export type NativeAlertScopeKind = 'all' | 'agent' | 'workflow' | 'model' | 'tool';
export type NativeAlertState = 'ok' | 'firing' | 'no_data';

export interface NativeAlertRuleInput {
  name: string;
  description?: string;
  metric: NativeAlertMetric;
  operator: NativeAlertOperator;
  threshold: number;
  windowMinutes: number;
  minSamples: number;
  severity: NativeAlertSeverity;
  scopeKind: NativeAlertScopeKind;
  scopeValue?: string | null;
  cooldownMinutes: number;
  notify: boolean;
  enabled: boolean;
  aiopsAutoInvestigate?: boolean;
  aiopsBundleIds?: number[];
  aiopsResourceScope?: ExecutionResourceScopeRequest | null;
  aiopsService?: string | null;
  aiopsEnvironment?: string | null;
}

export interface NativeAlertTemplate {
  id: string;
  name: string;
  description: string;
  category: 'reliability' | 'latency' | 'cost' | 'operations';
  rules: NativeAlertRuleInput[];
  installedRules: number;
  installed: boolean;
}

export interface NativeAlertRule {
  id: number;
  name: string;
  description: string;
  metric: NativeAlertMetric;
  operator: NativeAlertOperator;
  threshold: number;
  windowMinutes: number;
  minSamples: number;
  severity: NativeAlertSeverity;
  scopeKind: NativeAlertScopeKind;
  scopeValue: string | null;
  cooldownMinutes: number;
  notify: boolean;
  enabled: boolean;
  aiopsAutoInvestigate: boolean;
  aiopsBundleIds: number[];
  aiopsResourceScope: ExecutionResourceScopeRequest | null;
  aiopsService: string | null;
  aiopsEnvironment: string | null;
  lastState: NativeAlertState;
  lastValue: number | null;
  lastSampleCount: number;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  openIncidentId: number | null;
}

export interface NativeAlertIncident {
  id: number;
  ruleId: number;
  ruleName: string;
  state: 'firing' | 'recovered';
  severity: NativeAlertSeverity;
  metricValue: number;
  threshold: number;
  sampleCount: number;
  message: string;
  context: Record<string, unknown>;
  triggeredAt: string;
  recoveredAt: string | null;
  notifiedAt: string | null;
  correlation: {
    groupId: number;
    correlationKey: string;
    role: 'primary' | 'member';
    groupingReasons: AlertGroupingReason[];
    service: string;
    environment: string;
    state: 'firing' | 'recovered';
    severity: NativeAlertSeverity;
    correlationWindowMinutes: number;
    primaryIncidentId: number;
    signalCount: number;
    firstTriggeredAt: string;
    lastSignalAt: string;
    recoveredAt: string | null;
    groupedAt: string;
  } | null;
}

interface RuleRow {
  id: number;
  name: string;
  description: string;
  metric: NativeAlertMetric;
  operator: NativeAlertOperator;
  threshold: number | string;
  window_minutes: number;
  min_samples: number;
  severity: NativeAlertSeverity;
  scope_kind: NativeAlertScopeKind;
  scope_value: string | null;
  cooldown_minutes: number;
  notify: boolean;
  enabled: boolean;
  aiops_auto_investigate: boolean;
  aiops_bundle_ids: number[] | null;
  aiops_resource_scope: ExecutionResourceScopeRequest | null;
  aiops_service: string | null;
  aiops_environment: string | null;
  last_state: NativeAlertState;
  last_value: number | string | null;
  last_sample_count: number;
  last_evaluated_at: string | null;
  last_triggered_at: string | null;
  created_at: string;
  updated_at: string;
  open_incident_id?: number | null;
}

interface IncidentRow {
  id: number;
  rule_id: number;
  rule_name: string;
  state: 'firing' | 'recovered';
  severity: NativeAlertSeverity;
  metric_value: number | string;
  threshold: number | string;
  sample_count: number;
  message: string;
  context: Record<string, unknown>;
  triggered_at: string;
  recovered_at: string | null;
  notified_at: string | null;
  correlation_group_id?: number | string | null;
  correlation_key?: string | null;
  correlation_role?: 'primary' | 'member' | null;
  grouping_reasons?: AlertGroupingReason[] | null;
  correlation_service?: string | null;
  correlation_environment?: string | null;
  correlation_state?: 'firing' | 'recovered' | null;
  correlation_severity?: NativeAlertSeverity | null;
  correlation_window_minutes?: number | string | null;
  primary_incident_id?: number | string | null;
  correlation_signal_count?: number | string | null;
  correlation_first_triggered_at?: string | null;
  correlation_last_signal_at?: string | null;
  correlation_recovered_at?: string | null;
  correlation_grouped_at?: string | null;
}

const NATIVE_ALERT_TEMPLATE_DEFINITIONS: ReadonlyArray<Omit<NativeAlertTemplate, 'installedRules' | 'installed'>> = [
  {
    id: 'reliability-slo',
    name: 'Reliability SLO',
    description: 'Protect a 95% success objective with warning and critical error-rate signals.',
    category: 'reliability',
    rules: [
      {
        name: 'SLO · Reliability budget burn',
        description: 'Warn when the error rate exceeds the 5% reliability budget over one hour.',
        metric: 'error_rate', operator: 'gt', threshold: 5, windowMinutes: 60, minSamples: 20,
        severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 60, notify: true, enabled: true,
      },
      {
        name: 'SLO · Critical reliability regression',
        description: 'Escalate a sustained error rate above 10% in the last 15 minutes.',
        metric: 'error_rate', operator: 'gt', threshold: 10, windowMinutes: 15, minSamples: 10,
        severity: 'critical', scopeKind: 'all', scopeValue: null, cooldownMinutes: 30, notify: true, enabled: true,
      },
    ],
  },
  {
    id: 'latency-slo',
    name: 'Latency SLO',
    description: 'Detect slow agent and workflow experiences using the native P95 signal.',
    category: 'latency',
    rules: [{
      name: 'SLO · P95 latency regression',
      description: 'Warn when the platform P95 execution latency exceeds 30 seconds.',
      metric: 'p95_latency_ms', operator: 'gt', threshold: 30_000, windowMinutes: 30, minSamples: 10,
      severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 60, notify: true, enabled: true,
    }],
  },
  {
    id: 'cost-guardrail',
    name: 'Daily cost guardrail',
    description: 'Keep direct-model spend visible without requiring an external observability product.',
    category: 'cost',
    rules: [{
      name: 'Guardrail · Daily model spend',
      description: 'Warn when trace-attributed model cost exceeds $10 in a rolling 24-hour window.',
      metric: 'total_cost_usd', operator: 'gt', threshold: 10, windowMinutes: 1440, minSamples: 1,
      severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 360, notify: true, enabled: true,
    }],
  },
  {
    id: 'failure-spike',
    name: 'Failure spike',
    description: 'Catch concentrated operational failures before they become a broader outage.',
    category: 'operations',
    rules: [{
      name: 'Operations · Failure spike',
      description: 'Escalate when at least five executions fail inside 15 minutes.',
      metric: 'failure_count', operator: 'gte', threshold: 5, windowMinutes: 15, minSamples: 5,
      severity: 'critical', scopeKind: 'all', scopeValue: null, cooldownMinutes: 30, notify: true, enabled: true,
    }],
  },
  {
    id: 'adaptive-regressions',
    name: 'Adaptive regressions',
    description: 'Compare current latency and cost per execution with a rolling historical baseline.',
    category: 'operations',
    rules: [
      {
        name: 'Adaptive · Execution latency regression',
        description: 'Detects a sustained P95 latency increase against the preceding 7-day baseline, with a 30-day fallback.',
        metric: 'latency_regression_percent', operator: 'gt', threshold: 50, windowMinutes: 30, minSamples: 10,
        severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 60, notify: false, enabled: true,
      },
      {
        name: 'Adaptive · Cost per execution regression',
        description: 'Detects a sustained increase in average trace-attributed cost against the preceding 7-day baseline, with a 30-day fallback.',
        metric: 'cost_regression_percent', operator: 'gt', threshold: 75, windowMinutes: 60, minSamples: 10,
        severity: 'warning', scopeKind: 'all', scopeValue: null, cooldownMinutes: 120, notify: false, enabled: true,
      },
    ],
  },
];

function cloneTemplate(
  template: Omit<NativeAlertTemplate, 'installedRules' | 'installed'>,
  installedNames: ReadonlySet<string>,
): NativeAlertTemplate {
  const rules = template.rules.map(rule => ({ ...rule }));
  const installedRules = rules.filter(rule => installedNames.has(rule.name)).length;
  return { ...template, rules, installedRules, installed: installedRules === rules.length };
}

export async function listNativeAlertTemplates(pool: pg.Pool): Promise<NativeAlertTemplate[]> {
  const names = NATIVE_ALERT_TEMPLATE_DEFINITIONS.flatMap(template => template.rules.map(rule => rule.name));
  const { rows } = await pool.query<{ name: string }>(
    'SELECT name FROM mcp_observability_alert_rules WHERE archived_at IS NULL AND name = ANY($1::text[])',
    [names],
  );
  const installedNames = new Set(rows.map(row => row.name));
  return NATIVE_ALERT_TEMPLATE_DEFINITIONS.map(template => cloneTemplate(template, installedNames));
}

export async function installNativeAlertTemplate(
  pool: pg.Pool,
  templateId: string,
  userId: number,
): Promise<{ template: NativeAlertTemplate; created: number; skipped: number }> {
  const definition = NATIVE_ALERT_TEMPLATE_DEFINITIONS.find(template => template.id === templateId);
  if (!definition) throw new Error('Alert-Preset nicht gefunden');
  const client = await pool.connect();
  let created = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`argus-alert-template:${templateId}`]);
    for (const input of definition.rules) {
      const result = await client.query(
        `INSERT INTO mcp_observability_alert_rules
          (name, description, metric, operator, threshold, window_minutes, min_samples,
           severity, scope_kind, scope_value, cooldown_minutes, notify, enabled, created_by)
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
          WHERE NOT EXISTS (
            SELECT 1 FROM mcp_observability_alert_rules WHERE archived_at IS NULL AND name=$1
          )`,
        [
          input.name, input.description ?? '', input.metric, input.operator, input.threshold,
          input.windowMinutes, input.minSamples, input.severity, input.scopeKind,
          input.scopeValue || null, input.cooldownMinutes, input.notify, input.enabled, userId,
        ],
      );
      created += result.rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const templates = await listNativeAlertTemplates(pool);
  return {
    template: templates.find(template => template.id === templateId)!,
    created,
    skipped: definition.rules.length - created,
  };
}

function mapRule(row: RuleRow): NativeAlertRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    metric: row.metric,
    operator: row.operator,
    threshold: Number(row.threshold),
    windowMinutes: row.window_minutes,
    minSamples: row.min_samples,
    severity: row.severity,
    scopeKind: row.scope_kind,
    scopeValue: row.scope_value,
    cooldownMinutes: row.cooldown_minutes,
    notify: row.notify,
    enabled: row.enabled,
    aiopsAutoInvestigate: row.aiops_auto_investigate ?? false,
    aiopsBundleIds: row.aiops_bundle_ids ?? [],
    aiopsResourceScope: row.aiops_resource_scope ?? null,
    aiopsService: row.aiops_service ?? null,
    aiopsEnvironment: row.aiops_environment ?? null,
    lastState: row.last_state,
    lastValue: row.last_value == null ? null : Number(row.last_value),
    lastSampleCount: row.last_sample_count,
    lastEvaluatedAt: row.last_evaluated_at,
    lastTriggeredAt: row.last_triggered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    openIncidentId: row.open_incident_id ?? null,
  };
}

function mapIncident(row: IncidentRow): NativeAlertIncident {
  return {
    id: Number(row.id),
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    state: row.state,
    severity: row.severity,
    metricValue: Number(row.metric_value),
    threshold: Number(row.threshold),
    sampleCount: row.sample_count,
    message: row.message,
    context: row.context ?? {},
    triggeredAt: row.triggered_at,
    recoveredAt: row.recovered_at,
    notifiedAt: row.notified_at,
    correlation: row.correlation_group_id == null ? null : {
      groupId: Number(row.correlation_group_id),
      correlationKey: row.correlation_key!,
      role: row.correlation_role!,
      groupingReasons: row.grouping_reasons ?? [],
      service: row.correlation_service!,
      environment: row.correlation_environment!,
      state: row.correlation_state!,
      severity: row.correlation_severity!,
      correlationWindowMinutes: Number(row.correlation_window_minutes),
      primaryIncidentId: Number(row.primary_incident_id),
      signalCount: Number(row.correlation_signal_count),
      firstTriggeredAt: row.correlation_first_triggered_at!,
      lastSignalAt: row.correlation_last_signal_at!,
      recoveredAt: row.correlation_recovered_at ?? null,
      groupedAt: row.correlation_grouped_at!,
    },
  };
}

export async function listNativeAlerts(pool: pg.Pool): Promise<{
  rules: NativeAlertRule[];
  incidents: NativeAlertIncident[];
  summary: { enabledRules: number; firingRules: number; incidents24h: number; recovered24h: number };
}> {
  const [rulesResult, incidentsResult, summaryResult] = await Promise.all([
    pool.query<RuleRow>(
      `SELECT rule.*,
              incident.id AS open_incident_id
         FROM mcp_observability_alert_rules rule
         LEFT JOIN mcp_observability_alert_incidents incident
           ON incident.rule_id=rule.id AND incident.state='firing'
        WHERE rule.archived_at IS NULL AND rule.source_kind='native'
        ORDER BY rule.enabled DESC, rule.updated_at DESC, rule.id DESC`,
    ),
    pool.query<IncidentRow>(
      `SELECT incident.*, rule.name AS rule_name,
              membership.group_id AS correlation_group_id,
              membership.role AS correlation_role,
              membership.grouping_reasons,
              membership.grouped_at AS correlation_grouped_at,
              alert_group.correlation_key,
              alert_group.service AS correlation_service,
              alert_group.environment AS correlation_environment,
              alert_group.state AS correlation_state,
              alert_group.severity AS correlation_severity,
              alert_group.correlation_window_minutes,
              alert_group.primary_incident_id,
              alert_group.signal_count AS correlation_signal_count,
              alert_group.first_triggered_at AS correlation_first_triggered_at,
              alert_group.last_signal_at AS correlation_last_signal_at,
              alert_group.recovered_at AS correlation_recovered_at
         FROM mcp_observability_alert_incidents incident
         JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
         LEFT JOIN mcp_observability_alert_incident_group_members membership
           ON membership.incident_id=incident.id
         LEFT JOIN mcp_observability_alert_incident_groups alert_group
           ON alert_group.id=membership.group_id
        ORDER BY incident.triggered_at DESC
        LIMIT 100`,
    ),
    pool.query<{ enabled_rules: string; firing_rules: string; incidents_24h: string; recovered_24h: string }>(
      `SELECT
         (SELECT count(*) FROM mcp_observability_alert_rules WHERE archived_at IS NULL AND enabled AND source_kind='native') AS enabled_rules,
         (SELECT count(*) FROM mcp_observability_alert_rules WHERE archived_at IS NULL AND enabled AND source_kind='native' AND last_state='firing') AS firing_rules,
         count(*) FILTER (WHERE triggered_at >= now() - interval '24 hours') AS incidents_24h,
         count(*) FILTER (WHERE recovered_at >= now() - interval '24 hours') AS recovered_24h
       FROM mcp_observability_alert_incidents`,
    ),
  ]);
  const summary = summaryResult.rows[0]!;
  return {
    rules: rulesResult.rows.map(mapRule),
    incidents: incidentsResult.rows.map(mapIncident),
    summary: {
      enabledRules: Number(summary.enabled_rules),
      firingRules: Number(summary.firing_rules),
      incidents24h: Number(summary.incidents_24h),
      recovered24h: Number(summary.recovered_24h),
    },
  };
}

export async function createNativeAlertRule(pool: pg.Pool, input: NativeAlertRuleInput, userId: number): Promise<NativeAlertRule> {
  const { rows } = await pool.query<RuleRow>(
    `INSERT INTO mcp_observability_alert_rules
      (name, description, metric, operator, threshold, window_minutes, min_samples,
       severity, scope_kind, scope_value, cooldown_minutes, notify, enabled, created_by,
       aiops_auto_investigate, aiops_bundle_ids, aiops_resource_scope, aiops_service, aiops_environment)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
     RETURNING *`,
    [
      input.name, input.description ?? '', input.metric, input.operator, input.threshold,
      input.windowMinutes, input.minSamples, input.severity, input.scopeKind,
      input.scopeValue || null, input.cooldownMinutes, input.notify, input.enabled, userId,
      input.aiopsAutoInvestigate ?? false, input.aiopsBundleIds ?? [],
      input.aiopsResourceScope ? JSON.stringify(input.aiopsResourceScope) : null,
      input.aiopsService ?? null, input.aiopsEnvironment ?? null,
    ],
  );
  return mapRule(rows[0]!);
}

export async function updateNativeAlertRule(pool: pg.Pool, id: number, input: NativeAlertRuleInput): Promise<NativeAlertRule | null> {
  const { rows } = await pool.query<RuleRow>(
    `UPDATE mcp_observability_alert_rules
        SET name=$2, description=$3, metric=$4, operator=$5, threshold=$6,
            window_minutes=$7, min_samples=$8, severity=$9, scope_kind=$10,
            scope_value=$11, cooldown_minutes=$12, notify=$13, enabled=$14,
            aiops_auto_investigate=$15, aiops_bundle_ids=$16,
            aiops_resource_scope=$17::jsonb, aiops_service=$18, aiops_environment=$19,
            updated_at=now()
      WHERE id=$1 AND archived_at IS NULL
      RETURNING *`,
    [
      id, input.name, input.description ?? '', input.metric, input.operator, input.threshold,
      input.windowMinutes, input.minSamples, input.severity, input.scopeKind,
      input.scopeValue || null, input.cooldownMinutes, input.notify, input.enabled,
      input.aiopsAutoInvestigate ?? false, input.aiopsBundleIds ?? [],
      input.aiopsResourceScope ? JSON.stringify(input.aiopsResourceScope) : null,
      input.aiopsService ?? null, input.aiopsEnvironment ?? null,
    ],
  );
  return rows[0] ? mapRule(rows[0]) : null;
}

export async function archiveNativeAlertRule(pool: pg.Pool, id: number, userId: number): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE mcp_observability_alert_rules
          SET archived_at=now(), archived_by=$2, enabled=false,
              aiops_auto_investigate=false, last_state='ok', updated_at=now()
        WHERE id=$1 AND archived_at IS NULL
        RETURNING id`,
      [id, userId],
    );
    if ((result.rowCount ?? 0) === 0) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `UPDATE mcp_observability_alert_incidents
          SET state='recovered', recovered_at=COALESCE(recovered_at, now()),
              message=CASE WHEN state='firing' THEN message || ' Rule archived by an operator.' ELSE message END,
              updated_at=now()
        WHERE rule_id=$1 AND state='firing'`,
      [id],
    );
    await client.query(
      `UPDATE mcp_observability_alert_incident_groups alert_group
          SET state='recovered', recovered_at=COALESCE(recovered_at, now()), updated_at=now()
        WHERE EXISTS (
          SELECT 1
            FROM mcp_observability_alert_incident_group_members affected_member
            JOIN mcp_observability_alert_incidents affected_incident ON affected_incident.id=affected_member.incident_id
           WHERE affected_member.group_id=alert_group.id AND affected_incident.rule_id=$1
        )
          AND NOT EXISTS (
            SELECT 1
              FROM mcp_observability_alert_incident_group_members active_member
              JOIN mcp_observability_alert_incidents active_incident ON active_incident.id=active_member.incident_id
             WHERE active_member.group_id=alert_group.id AND active_incident.state='firing'
          )`,
      [id],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

interface MetricAggregateRow {
  total_count: string;
  terminal_count: string;
  completed_count: string;
  failed_count: string;
  duration_count: string;
  p95_duration_ms: number | string | null;
  total_cost_usd: number | string | null;
}

export interface NativeAlertMetricResult {
  value: number;
  sampleCount: number;
  baseline?: {
    value: number;
    currentValue: number;
    sampleCount: number;
    windowDays: 7 | 30;
  };
  exemplars?: NativeAlertExemplar[];
}

export interface NativeAlertExemplar {
  rootTraceId: string;
  traceId: string;
  spanId: string | null;
  runKind: 'agent' | 'workflow';
  title: string;
  startedAt: string;
  durationMs: number;
  costUsd: number;
  dominantSpanLabel: string | null;
  href: string;
}

export type NativeAlertMetricQuery = Pick<NativeAlertRule, 'metric' | 'windowMinutes' | 'scopeKind' | 'scopeValue'>
  & Partial<Pick<NativeAlertRule, 'minSamples'>>;

interface RegressionAggregateRow {
  current_count: string;
  current_duration_count: string;
  current_p95_duration_ms: number | string | null;
  current_avg_cost_usd: number | string | null;
  baseline_7d_count: string;
  baseline_7d_duration_count: string;
  baseline_7d_p95_duration_ms: number | string | null;
  baseline_7d_avg_cost_usd: number | string | null;
  baseline_30d_count: string;
  baseline_30d_duration_count: string;
  baseline_30d_p95_duration_ms: number | string | null;
  baseline_30d_avg_cost_usd: number | string | null;
}

interface RegressionExemplarRow {
  root_trace_id: string;
  trace_id: string;
  span_id: string | null;
  run_kind: string;
  title: string;
  workflow_execution_id: number | string | null;
  started_at: string;
  duration_ms: number | string | null;
  cost_usd: number | string | null;
  dominant_span_label: string | null;
}

async function evaluateNativeRegressionMetric(
  pool: Queryable,
  rule: NativeAlertMetricQuery,
): Promise<NativeAlertMetricResult> {
  const params: unknown[] = [rule.windowMinutes];
  let fromSql: string;
  let costExpression = 'observation.total_cost_usd';
  const conditions: string[] = [];
  if (rule.scopeKind === 'model' || rule.scopeKind === 'tool') {
    fromSql = `mcp_observability_spans observation
      JOIN mcp_observability_traces trace ON trace.id=observation.trace_id`;
    conditions.push(rule.scopeKind === 'model' ? `observation.kind='llm'` : `observation.kind='tool'`);
    conditions.push(`observation.status IN ('completed','failed')`);
    conditions.push(`trace.kind IN ('agent','workflow')`);
    if (rule.scopeValue) {
      params.push(rule.scopeValue);
      conditions.push(rule.scopeKind === 'model'
        ? `observation.model=$${params.length}`
        : `observation.tool_name=$${params.length}`);
    }
  } else {
    fromSql = `mcp_observability_traces observation
      LEFT JOIN mcp_workflow_executions workflow_execution
        ON workflow_execution.id=observation.workflow_execution_id`;
    conditions.push(`observation.id=observation.root_trace_id`);
    conditions.push(`observation.kind IN ('agent','workflow')`);
    conditions.push(`observation.status IN ('completed','failed')`);
    costExpression = `COALESCE(
      NULLIF((
        SELECT sum(family_span.total_cost_usd)
          FROM mcp_observability_traces family_trace
          JOIN mcp_observability_spans family_span ON family_span.trace_id=family_trace.id
         WHERE family_trace.root_trace_id=observation.id
      ), 0),
      NULLIF((
        SELECT sum(family_trace.total_cost_usd)
          FROM mcp_observability_traces family_trace
         WHERE family_trace.root_trace_id=observation.id AND family_trace.id<>observation.id
      ), 0),
      observation.total_cost_usd
    )`;
    if (rule.scopeKind === 'agent') {
      conditions.push(`observation.kind='agent'`);
      if (rule.scopeValue) {
        params.push(Number(rule.scopeValue));
        conditions.push(`observation.agent_id=$${params.length}`);
      }
    } else if (rule.scopeKind === 'workflow') {
      conditions.push(`observation.kind='workflow'`);
      if (rule.scopeValue) {
        params.push(Number(rule.scopeValue));
        conditions.push(`workflow_execution.workflow_id=$${params.length}`);
      }
    }
  }
  const current = `observation.started_at >= now() - interval '1 minute' * $1`;
  const beforeCurrent = `observation.started_at < now() - interval '1 minute' * $1`;
  const baseline7 = `${beforeCurrent} AND observation.started_at >= now() - interval '1 minute' * $1 - interval '7 days'`;
  const baseline30 = `${beforeCurrent} AND observation.started_at >= now() - interval '1 minute' * $1 - interval '30 days'`;
  const { rows } = await pool.query<RegressionAggregateRow>(
    `SELECT
       count(*) FILTER (WHERE ${current})::text AS current_count,
       count(observation.duration_ms) FILTER (WHERE ${current})::text AS current_duration_count,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY observation.duration_ms)
         FILTER (WHERE ${current} AND observation.duration_ms IS NOT NULL) AS current_p95_duration_ms,
       avg(${costExpression}) FILTER (WHERE ${current}) AS current_avg_cost_usd,
       count(*) FILTER (WHERE ${baseline7})::text AS baseline_7d_count,
       count(observation.duration_ms) FILTER (WHERE ${baseline7})::text AS baseline_7d_duration_count,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY observation.duration_ms)
         FILTER (WHERE ${baseline7} AND observation.duration_ms IS NOT NULL) AS baseline_7d_p95_duration_ms,
       avg(${costExpression}) FILTER (WHERE ${baseline7}) AS baseline_7d_avg_cost_usd,
       count(*) FILTER (WHERE ${baseline30})::text AS baseline_30d_count,
       count(observation.duration_ms) FILTER (WHERE ${baseline30})::text AS baseline_30d_duration_count,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY observation.duration_ms)
         FILTER (WHERE ${baseline30} AND observation.duration_ms IS NOT NULL) AS baseline_30d_p95_duration_ms,
       avg(${costExpression}) FILTER (WHERE ${baseline30}) AS baseline_30d_avg_cost_usd
      FROM ${fromSql}
     WHERE ${conditions.join(' AND ')}`,
    params,
  );
  const row = rows[0]!;
  const minimumSamples = Math.max(1, rule.minSamples ?? 1);
  const latency = rule.metric === 'latency_regression_percent';
  const currentValue = Number(latency ? row.current_p95_duration_ms ?? 0 : row.current_avg_cost_usd ?? 0);
  const currentSamples = Number(latency ? row.current_duration_count : row.current_count);
  const samples7 = Number(latency ? row.baseline_7d_duration_count : row.baseline_7d_count);
  const samples30 = Number(latency ? row.baseline_30d_duration_count : row.baseline_30d_count);
  const windowDays: 7 | 30 = samples7 >= minimumSamples ? 7 : 30;
  const baselineValue = Number(windowDays === 7
    ? latency ? row.baseline_7d_p95_duration_ms ?? 0 : row.baseline_7d_avg_cost_usd ?? 0
    : latency ? row.baseline_30d_p95_duration_ms ?? 0 : row.baseline_30d_avg_cost_usd ?? 0);
  const baselineSamples = windowDays === 7 ? samples7 : samples30;
  const value = baselineValue > 0 ? 100 * (currentValue - baselineValue) / baselineValue : 0;
  const exemplarResult = rule.scopeKind === 'model' || rule.scopeKind === 'tool'
    ? await pool.query<RegressionExemplarRow>(
      `SELECT trace.root_trace_id, trace.id AS trace_id, observation.id AS span_id,
              trace.kind AS run_kind, trace.name AS title, trace.workflow_execution_id,
              observation.started_at, observation.duration_ms,
              observation.total_cost_usd AS cost_usd,
              COALESCE(observation.tool_name, observation.name) AS dominant_span_label
         FROM ${fromSql}
        WHERE ${conditions.join(' AND ')} AND ${current}
        ORDER BY ${latency ? 'observation.duration_ms' : 'observation.total_cost_usd'} DESC NULLS LAST,
                 observation.started_at DESC
        LIMIT 5`,
      params,
    )
    : await pool.query<RegressionExemplarRow>(
      `SELECT observation.id AS root_trace_id, observation.id AS trace_id,
              dominant.span_id, observation.kind AS run_kind, observation.name AS title,
              observation.workflow_execution_id, observation.started_at,
              observation.duration_ms, ${costExpression} AS cost_usd,
              dominant.label AS dominant_span_label
         FROM ${fromSql}
         LEFT JOIN LATERAL (
           SELECT family_span.id AS span_id,
                  COALESCE(family_span.tool_name, family_span.name) AS label
             FROM mcp_observability_traces family_trace
             JOIN mcp_observability_spans family_span ON family_span.trace_id=family_trace.id
            WHERE family_trace.root_trace_id=observation.id
            ORDER BY ${latency ? 'family_span.duration_ms' : 'family_span.total_cost_usd'} DESC NULLS LAST,
                     family_span.started_at
            LIMIT 1
         ) dominant ON true
        WHERE ${conditions.join(' AND ')} AND ${current}
        ORDER BY ${latency ? 'observation.duration_ms' : costExpression} DESC NULLS LAST,
                 observation.started_at DESC
        LIMIT 5`,
      params,
    );
  const exemplars = exemplarResult.rows.flatMap(row => {
    if (row.run_kind !== 'agent' && row.run_kind !== 'workflow') return [];
    const traceId = String(row.trace_id);
    const spanId = row.span_id ? String(row.span_id) : null;
    const href = row.run_kind === 'workflow' && row.workflow_execution_id != null
      ? `/runs/workflow/${row.workflow_execution_id}`
      : row.run_kind === 'agent'
        ? `/runs/agent/${encodeURIComponent(traceId)}`
        : null;
    if (!href) return [];
    return [{
      rootTraceId: String(row.root_trace_id),
      traceId,
      spanId,
      runKind: row.run_kind,
      title: String(row.title),
      startedAt: row.started_at,
      durationMs: Number(row.duration_ms ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      dominantSpanLabel: row.dominant_span_label,
      href: spanId ? `${href}?span=${encodeURIComponent(spanId)}` : href,
    } satisfies NativeAlertExemplar];
  });
  return {
    value,
    sampleCount: currentSamples,
    baseline: { value: baselineValue, currentValue, sampleCount: baselineSamples, windowDays },
    exemplars,
  };
}

export async function evaluateNativeAlertMetric(pool: Queryable, rule: NativeAlertMetricQuery): Promise<NativeAlertMetricResult> {
  if (rule.metric === 'latency_regression_percent' || rule.metric === 'cost_regression_percent') {
    return evaluateNativeRegressionMetric(pool, rule);
  }
  const params: unknown[] = [rule.windowMinutes];
  let fromSql: string;
  const conditions: string[] = [];
  if (rule.scopeKind === 'model' || rule.scopeKind === 'tool') {
    fromSql = `mcp_observability_spans observation
      JOIN mcp_observability_traces trace ON trace.id=observation.trace_id`;
    conditions.push(`observation.started_at >= now() - interval '1 minute' * $1`);
    conditions.push(rule.scopeKind === 'model' ? `observation.kind='llm'` : `observation.kind='tool'`);
    if (rule.scopeValue) {
      params.push(rule.scopeValue);
      conditions.push(rule.scopeKind === 'model'
        ? `observation.model=$${params.length}`
        : `observation.tool_name=$${params.length}`);
    }
  } else {
    fromSql = `mcp_observability_traces observation
      LEFT JOIN mcp_workflow_executions workflow_execution
        ON workflow_execution.id=observation.workflow_execution_id`;
    conditions.push(`observation.started_at >= now() - interval '1 minute' * $1`);
    if (rule.scopeKind === 'agent') {
      conditions.push(`observation.kind='agent'`);
      if (rule.scopeValue) {
        params.push(Number(rule.scopeValue));
        conditions.push(`observation.agent_id=$${params.length}`);
      }
    } else if (rule.scopeKind === 'workflow') {
      conditions.push(`observation.kind='workflow'`);
      if (rule.scopeValue) {
        params.push(Number(rule.scopeValue));
        conditions.push(`workflow_execution.workflow_id=$${params.length}`);
      }
    }
  }

  const { rows } = await pool.query<MetricAggregateRow>(
    `SELECT count(*)::text AS total_count,
            count(*) FILTER (WHERE observation.status IN ('completed','failed'))::text AS terminal_count,
            count(*) FILTER (WHERE observation.status='completed')::text AS completed_count,
            count(*) FILTER (WHERE observation.status='failed')::text AS failed_count,
            count(observation.duration_ms)::text AS duration_count,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY observation.duration_ms)
              FILTER (WHERE observation.duration_ms IS NOT NULL) AS p95_duration_ms,
            COALESCE(sum(observation.total_cost_usd), 0) AS total_cost_usd
       FROM ${fromSql}
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  const row = rows[0]!;
  const total = Number(row.total_count);
  const terminal = Number(row.terminal_count);
  const completed = Number(row.completed_count);
  const failed = Number(row.failed_count);
  if (rule.metric === 'error_rate') return { value: terminal > 0 ? failed / terminal * 100 : 0, sampleCount: terminal };
  if (rule.metric === 'success_rate') return { value: terminal > 0 ? completed / terminal * 100 : 0, sampleCount: terminal };
  if (rule.metric === 'p95_latency_ms') return { value: Number(row.p95_duration_ms ?? 0), sampleCount: Number(row.duration_count) };
  if (rule.metric === 'total_cost_usd') return { value: Number(row.total_cost_usd ?? 0), sampleCount: total };
  return { value: failed, sampleCount: total };
}

export function nativeAlertBreached(value: number, operator: NativeAlertOperator, threshold: number): boolean {
  if (operator === 'gt') return value > threshold;
  if (operator === 'gte') return value >= threshold;
  if (operator === 'lt') return value < threshold;
  return value <= threshold;
}

function metricLabel(metric: NativeAlertMetric): string {
  return {
    error_rate: 'Error rate',
    success_rate: 'Success rate',
    p95_latency_ms: 'P95 latency',
    total_cost_usd: 'Total cost',
    failure_count: 'Failure count',
    latency_regression_percent: 'Latency regression',
    cost_regression_percent: 'Cost regression',
  }[metric];
}

function scopeLabel(rule: NativeAlertRule): string {
  return rule.scopeKind === 'all' ? 'all executions' : `${rule.scopeKind}${rule.scopeValue ? ` ${rule.scopeValue}` : ''}`;
}

function incidentMessage(rule: NativeAlertRule, result: NativeAlertMetricResult): string {
  if (result.baseline) {
    const exemplar = result.exemplars?.[0];
    return `${metricLabel(rule.metric)} is ${result.value.toFixed(1)}% (${rule.operator} ${rule.threshold}%) across ${scopeLabel(rule)}. Current ${result.baseline.currentValue.toFixed(4)} vs ${result.baseline.windowDays}-day baseline ${result.baseline.value.toFixed(4)} from ${result.baseline.sampleCount} samples.${exemplar ? ` Top evidence: ${exemplar.title}${exemplar.dominantSpanLabel ? ` · ${exemplar.dominantSpanLabel}` : ''}.` : ''}`;
  }
  return `${metricLabel(rule.metric)} is ${result.value.toFixed(3)} (${rule.operator} ${rule.threshold}) across ${scopeLabel(rule)} in the last ${rule.windowMinutes} minutes.`;
}

export async function runNativeAlertEvaluation(pool: pg.Pool): Promise<{
  evaluated: number;
  fired: number;
  recovered: number;
  skipped: boolean;
}> {
  const client = await pool.connect();
  let evaluated = 0;
  let fired = 0;
  let recovered = 0;
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext('argus-native-observability-alerts')) AS acquired`,
    );
    if (!lock.rows[0]?.acquired) return { evaluated: 0, fired: 0, recovered: 0, skipped: true };
    const { rows } = await client.query<RuleRow>(
      `SELECT rule.*, incident.id AS open_incident_id
         FROM mcp_observability_alert_rules rule
         LEFT JOIN mcp_observability_alert_incidents incident
           ON incident.rule_id=rule.id AND incident.state='firing'
        WHERE rule.enabled AND rule.archived_at IS NULL AND rule.source_kind='native'
        ORDER BY rule.id`,
    );
    for (const row of rows) {
      const rule = mapRule(row);
      try {
        const result = await evaluateNativeAlertMetric(client, rule);
        evaluated++;
        const enoughData = result.sampleCount >= rule.minSamples
          && (result.baseline == null || result.baseline.sampleCount >= rule.minSamples);
        const breached = enoughData && nativeAlertBreached(result.value, rule.operator, rule.threshold);
        const nextState: NativeAlertState = enoughData ? breached ? 'firing' : 'ok' : 'no_data';
        let notification: { title: string; message: string; severity: NativeAlertSeverity; incidentId: number } | null = null;
        if (breached && rule.openIncidentId == null) {
          const cooldownReady = !rule.lastTriggeredAt
            || Date.now() - Date.parse(rule.lastTriggeredAt) >= rule.cooldownMinutes * 60_000;
          if (cooldownReady) {
            const message = incidentMessage(rule, result);
            const inserted = await client.query<{ id: number; triggered_at: string }>(
              `INSERT INTO mcp_observability_alert_incidents
                (rule_id, state, severity, metric_value, threshold, sample_count, message, context)
               VALUES ($1,'firing',$2,$3,$4,$5,$6,$7::jsonb)
               ON CONFLICT (rule_id) WHERE state='firing' DO NOTHING
               RETURNING id, triggered_at`,
              [
                rule.id, rule.severity, result.value, rule.threshold, result.sampleCount, message,
                JSON.stringify({ metric: rule.metric, operator: rule.operator, windowMinutes: rule.windowMinutes, scopeKind: rule.scopeKind, scopeValue: rule.scopeValue, baseline: result.baseline ?? null, exemplars: result.exemplars ?? [] }),
              ],
            );
            const incidentId = inserted.rows[0]?.id;
            if (incidentId != null) {
              fired++;
              try {
                await correlateNativeAlertIncident(client, {
                  incidentId,
                  rule,
                  severity: rule.severity,
                  triggeredAt: inserted.rows[0]!.triggered_at,
                });
              } catch (error) {
                // Alert evidence must survive a temporary correlation failure.
                // The correlation schema is additive and can be backfilled.
                logger.warn({ err: error, alertRuleId: rule.id, incidentId }, 'Native alert incident correlation failed');
              }
              await client.query('UPDATE mcp_observability_alert_rules SET last_triggered_at=now() WHERE id=$1', [rule.id]);
              if (rule.notify) notification = { title: `Argus alert: ${rule.name}`, message, severity: rule.severity, incidentId };
            }
          }
        } else if (breached && rule.openIncidentId != null) {
          await client.query(
            `UPDATE mcp_observability_alert_incidents
                SET metric_value=$2, sample_count=$3, message=$4, context=$5::jsonb, updated_at=now()
              WHERE id=$1`,
            [
              rule.openIncidentId, result.value, result.sampleCount, incidentMessage(rule, result),
              JSON.stringify({ metric: rule.metric, operator: rule.operator, windowMinutes: rule.windowMinutes, scopeKind: rule.scopeKind, scopeValue: rule.scopeValue, baseline: result.baseline ?? null, exemplars: result.exemplars ?? [] }),
            ],
          );
        } else if (!breached && enoughData && rule.openIncidentId != null) {
          const message = `${rule.name} recovered. ${metricLabel(rule.metric)} is ${result.value.toFixed(3)}.`;
          await client.query(
            `UPDATE mcp_observability_alert_incidents
                SET state='recovered', recovered_at=now(), metric_value=$2,
                    sample_count=$3, message=$4, updated_at=now()
              WHERE id=$1`,
            [rule.openIncidentId, result.value, result.sampleCount, message],
          );
          await refreshAlertIncidentCorrelationGroup(client, rule.openIncidentId).catch(error => {
            logger.warn({ err: error, alertRuleId: rule.id, incidentId: rule.openIncidentId }, 'Native alert correlation recovery refresh failed');
          });
          recovered++;
          if (rule.notify) notification = { title: `Argus recovery: ${rule.name}`, message, severity: 'info', incidentId: rule.openIncidentId };
        }
        await client.query(
          `UPDATE mcp_observability_alert_rules
              SET last_state=$2, last_value=$3, last_sample_count=$4,
                  last_evaluated_at=now(), updated_at=now()
            WHERE id=$1`,
          [rule.id, nextState, result.value, result.sampleCount],
        );
        if (notification) {
          const { sendNotification } = await import('../lib/notifications.js');
          await sendNotification(notification.title, notification.message, notification.severity);
          await client.query(
            'UPDATE mcp_observability_alert_incidents SET notified_at=now(), updated_at=now() WHERE id=$1',
            [notification.incidentId],
          );
        }
      } catch (error) {
        logger.warn({ err: error, alertRuleId: rule.id }, 'Native alert rule evaluation failed');
      }
    }
    return { evaluated, fired, recovered, skipped: false };
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext('argus-native-observability-alerts'))`).catch(() => undefined);
    client.release();
  }
}

export function startNativeAlertWorker(
  pool: pg.Pool,
  automation?: { dispatchOnce(): Promise<unknown> },
): NodeJS.Timeout | null {
  if (process.env['NATIVE_ALERTS_ENABLED'] === 'false') {
    logger.info('Native observability alert worker disabled');
    return null;
  }
  const intervalMs = Math.max(15_000, Number(process.env['NATIVE_ALERTS_INTERVAL_MS'] ?? 60_000));
  const run = () => {
    runNativeAlertEvaluation(pool)
      .then(async result => {
        if (result.fired || result.recovered) logger.info(result, 'Native observability alerts evaluated');
        if (automation) await automation.dispatchOnce();
      })
      .catch(error => logger.warn({ err: error }, 'Native observability alert worker failed'));
  };
  const timer = setInterval(run, intervalMs);
  timer.unref();
  setTimeout(run, 5_000).unref();
  logger.info({ intervalMs }, 'Native observability alert worker started');
  return timer;
}
