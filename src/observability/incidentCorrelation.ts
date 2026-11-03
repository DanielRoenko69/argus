import type pg from 'pg';

export type IncidentChangeKind = 'agent' | 'workflow' | 'model' | 'capability' | 'connection' | 'access' | 'configuration';
export type IncidentChangeRelevance = 'direct' | 'contextual' | 'temporal';

export interface IncidentChangeCorrelation {
  id: number;
  kind: IncidentChangeKind;
  relevance: IncidentChangeRelevance;
  action: string;
  objectType: string;
  objectId: string;
  objectLabel: string;
  actor: string;
  occurredAt: string;
  minutesFromTrigger: number;
  phase: 'before' | 'during' | 'after';
  changedFields: string[];
  reason: string;
}

export interface IncidentChangeCorrelationResponse {
  incidentId: number;
  generatedAt: string;
  window: { hoursBefore: number; minutesAfter: number };
  changes: IncidentChangeCorrelation[];
  summary: {
    total: number;
    direct: number;
    contextual: number;
    temporal: number;
  };
}

interface IncidentRow {
  id: number;
  metric: string;
  scope_kind: string;
  scope_value: string | null;
  context: Record<string, unknown> | null;
  triggered_at: string | Date;
  recovered_at: string | Date | null;
}

interface AdminChangeRow {
  id: number | string;
  action: string;
  table_name: string;
  object_id: string;
  object_label: string | null;
  changed_by: string | null;
  before_state: unknown;
  after_state: unknown;
  created_at: string | Date;
}

interface Queryable {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(queryText: string, values?: unknown[]): Promise<Pick<pg.QueryResult<T>, 'rows'>>;
}

const SENSITIVE_FIELD = /(secret|password|credential|access.?token|refresh.?token|api.?key|key.?hash|client.?secret)/i;

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function changedFieldNames(beforeState: unknown, afterState: unknown): string[] {
  const before = record(beforeState);
  const after = record(afterState);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !SENSITIVE_FIELD.test(key))
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .sort()
    .slice(0, 8);
}

export function incidentChangeKind(tableName: string): IncidentChangeKind {
  const table = tableName.toLowerCase();
  if (table.includes('agent')) return 'agent';
  if (table.includes('workflow') || table.includes('canvas_flow') || table.includes('composite')) return 'workflow';
  if (table.includes('model')) return 'model';
  if (table.includes('tool') || table.includes('capability') || table.includes('skill') || table.includes('prompt')) return 'capability';
  if (table.includes('backend') || table.includes('connection') || table.includes('remote_mcp')) return 'connection';
  if (table.includes('bundle') || table.includes('policy') || table.includes('user') || table.includes('team') || table.includes('api_key')) return 'access';
  return 'configuration';
}

function evidenceTokens(incident: IncidentRow): string[] {
  const context = record(incident.context);
  const rawExemplars = Array.isArray(context['exemplars']) ? context['exemplars'] : [];
  const tokens = [incident.scope_value ?? ''];
  for (const raw of rawExemplars) {
    const exemplar = record(raw);
    tokens.push(String(exemplar['title'] ?? ''), String(exemplar['dominantSpanLabel'] ?? ''));
  }
  return [...new Set(tokens
    .flatMap(value => value.toLowerCase().split(/[^a-z0-9_.:-]+/))
    .map(value => value.trim())
    .filter(value => value.length >= 3))];
}

function relevanceForChange(
  incident: IncidentRow,
  row: AdminChangeRow,
  kind: IncidentChangeKind,
): { relevance: IncidentChangeRelevance; reason: string } {
  const tokens = evidenceTokens(incident);
  const haystack = [row.table_name, row.object_id, row.object_label ?? '', JSON.stringify(row.before_state), JSON.stringify(row.after_state)]
    .join(' ')
    .toLowerCase();
  if (tokens.some(token => haystack.includes(token))) {
    return { relevance: 'direct', reason: 'Matches the incident scope or correlated run evidence.' };
  }
  const scopeMatch = (incident.scope_kind === 'agent' && kind === 'agent')
    || (incident.scope_kind === 'workflow' && kind === 'workflow')
    || (incident.scope_kind === 'model' && kind === 'model')
    || (incident.scope_kind === 'tool' && kind === 'capability');
  const operationalKind = ['agent', 'workflow', 'model', 'capability', 'connection'].includes(kind);
  if (scopeMatch || (incident.scope_kind === 'all' && operationalKind)) {
    return { relevance: 'contextual', reason: `A ${kind} change can influence this ${incident.metric.replaceAll('_', ' ')} signal.` };
  }
  return { relevance: 'temporal', reason: 'Occurred inside the incident correlation window.' };
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export async function getIncidentChangeCorrelations(
  pool: Queryable,
  incidentId: number,
): Promise<IncidentChangeCorrelationResponse | null> {
  const incidentResult = await pool.query<IncidentRow>(
    `SELECT incident.id, rule.metric, rule.scope_kind, rule.scope_value, incident.context,
            incident.triggered_at, incident.recovered_at
       FROM mcp_observability_alert_incidents incident
       JOIN mcp_observability_alert_rules rule ON rule.id=incident.rule_id
      WHERE incident.id=$1`,
    [incidentId],
  );
  const incident = incidentResult.rows[0];
  if (!incident) return null;
  const changeResult = await pool.query<AdminChangeRow>(
    `SELECT id, action, table_name, object_id, object_label, changed_by,
            before_state, after_state, created_at
       FROM mcp_admin_audit_log
      WHERE created_at >= $1::timestamptz - interval '6 hours'
        AND created_at <= COALESCE($2::timestamptz, now()) + interval '30 minutes'
        AND table_name NOT IN ('mcp_observability_alert_rules', 'mcp_observability_alert_templates')
      ORDER BY abs(extract(epoch FROM (created_at - $1::timestamptz))) ASC, created_at DESC
      LIMIT 40`,
    [iso(incident.triggered_at), incident.recovered_at ? iso(incident.recovered_at) : null],
  );
  const triggerTime = Date.parse(iso(incident.triggered_at));
  const recoveryTime = incident.recovered_at ? Date.parse(iso(incident.recovered_at)) : null;
  const changes = changeResult.rows.map(row => {
    const occurredAt = iso(row.created_at);
    const occurredTime = Date.parse(occurredAt);
    const minutesFromTrigger = Math.round((occurredTime - triggerTime) / 60_000);
    const kind = incidentChangeKind(row.table_name);
    const relevance = relevanceForChange(incident, row, kind);
    return {
      id: Number(row.id),
      kind,
      ...relevance,
      action: row.action,
      objectType: row.table_name,
      objectId: row.object_id,
      objectLabel: row.object_label || `${kind} ${row.object_id}`,
      actor: row.changed_by || 'unknown',
      occurredAt,
      minutesFromTrigger,
      phase: minutesFromTrigger < 0 ? 'before' : recoveryTime == null || occurredTime <= recoveryTime ? 'during' : 'after',
      changedFields: changedFieldNames(row.before_state, row.after_state),
    } satisfies IncidentChangeCorrelation;
  }).sort((left, right) => {
    const rank = { direct: 0, contextual: 1, temporal: 2 } as const;
    return rank[left.relevance] - rank[right.relevance]
      || Math.abs(left.minutesFromTrigger) - Math.abs(right.minutesFromTrigger);
  });
  return {
    incidentId,
    generatedAt: new Date().toISOString(),
    window: { hoursBefore: 6, minutesAfter: 30 },
    changes,
    summary: {
      total: changes.length,
      direct: changes.filter(change => change.relevance === 'direct').length,
      contextual: changes.filter(change => change.relevance === 'contextual').length,
      temporal: changes.filter(change => change.relevance === 'temporal').length,
    },
  };
}
