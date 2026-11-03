import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { nextAuditReportRun } from './reportSchedule.js';
import type {
  AuditReportDefinition, AuditReportFilters, AuditReportReview, AuditReportRun,
  CreateAuditReportDefinitionInput,
} from './reportTypes.js';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => new Date(value as string | number | Date).toISOString();
const isoNull = (value: unknown): string | null => value == null ? null : iso(value);

function mapDefinition(row: Row): AuditReportDefinition {
  return {
    id: String(row['id']), workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']),
    environment: String(row['environment']), name: String(row['name']), reportType: row['report_type'] as AuditReportDefinition['reportType'],
    cadence: row['cadence'] as AuditReportDefinition['cadence'], timezone: String(row['timezone']),
    scheduleHour: Number(row['schedule_hour']), scheduleWeekday: row['schedule_weekday'] == null ? null : Number(row['schedule_weekday']),
    scheduleMonthday: row['schedule_monthday'] == null ? null : Number(row['schedule_monthday']), windowDays: Number(row['window_days']),
    filters: (row['filters'] ?? {}) as AuditReportFilters, formats: row['formats'] as AuditReportDefinition['formats'], enabled: Boolean(row['enabled']),
    createdBy: String(row['created_by']), createdAt: iso(row['created_at']), updatedAt: iso(row['updated_at']),
    nextRunAt: isoNull(row['next_run_at']), lastRunAt: isoNull(row['last_run_at']), disabledAt: isoNull(row['disabled_at']),
  };
}

function mapReview(row: Row): AuditReportReview {
  return { id: String(row['id']), decision: row['decision'] as AuditReportReview['decision'], actorId: String(row['actor_id']),
    actorAuthMethod: String(row['actor_auth_method']), occurredAt: iso(row['occurred_at']), auditEventId: String(row['audit_event_id']) };
}

function mapRun(row: Row, includePack = false): AuditReportRun {
  return {
    id: String(row['id']), definitionId: row['definition_id'] == null ? null : String(row['definition_id']),
    workspaceKey: String(row['workspace_key']), tenantKey: String(row['tenant_key']), environment: String(row['environment']),
    reportType: row['report_type'] as AuditReportRun['reportType'], name: String(row['name_snapshot']),
    triggerType: row['trigger_type'] as AuditReportRun['triggerType'], requestedBy: String(row['requested_by']), status: row['status'] as AuditReportRun['status'],
    periodFrom: iso(row['period_from']), periodTo: iso(row['period_to']), filters: (row['filters'] ?? {}) as AuditReportFilters,
    checkpointId: row['checkpoint_id'] == null ? null : String(row['checkpoint_id']), packId: row['pack_id'] == null ? null : String(row['pack_id']),
    packDigest: row['pack_digest'] == null ? null : String(row['pack_digest']), verificationState: row['verification_state'] as AuditReportRun['verificationState'],
    eventCount: Number(row['event_count']), chainEntryCount: Number(row['chain_entry_count']), gapCodes: (row['gap_codes'] ?? []) as string[],
    summary: row['summary'] as AuditReportRun['summary'], ...(includePack ? { evidencePack: row['evidence_pack'] as AuditReportRun['evidencePack'] } : {}),
    errorCode: row['error_code'] == null ? null : String(row['error_code']), errorMessage: row['error_message'] == null ? null : String(row['error_message']),
    startedAt: isoNull(row['started_at']), completedAt: isoNull(row['completed_at']), createdAt: iso(row['created_at']), reviews: [],
  };
}

async function attachReviews(pool: pg.Pool, runs: AuditReportRun[]): Promise<AuditReportRun[]> {
  if (runs.length === 0) return runs;
  const result = await pool.query(`SELECT * FROM mcp_audit_report_reviews WHERE report_run_id=ANY($1::uuid[]) ORDER BY occurred_at DESC`, [runs.map(run => run.id)]);
  const byRun = new Map<string, AuditReportReview[]>();
  for (const row of result.rows as Row[]) {
    const id = String(row['report_run_id']);
    byRun.set(id, [...(byRun.get(id) ?? []), mapReview(row)]);
  }
  return runs.map(run => ({ ...run, reviews: byRun.get(run.id) ?? [] }));
}

export async function createAuditReportDefinition(pool: pg.Pool, input: CreateAuditReportDefinitionInput): Promise<AuditReportDefinition> {
  const now = input.now ?? new Date();
  const next = nextAuditReportRun(input, now);
  const result = await pool.query(
    `INSERT INTO mcp_audit_report_definitions
      (id,workspace_key,tenant_key,environment,name,report_type,cadence,timezone,schedule_hour,schedule_weekday,schedule_monthday,window_days,filters,formats,created_by,created_at,updated_at,next_run_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::text[],$15,$16,$16,$17) RETURNING *`,
    [randomUUID(), input.workspaceKey, input.tenantKey, input.environment, input.name, input.reportType, input.cadence,
      input.timezone, input.scheduleHour, input.scheduleWeekday, input.scheduleMonthday, input.windowDays,
      JSON.stringify(input.filters), input.formats, input.createdBy, now.toISOString(), next?.toISOString() ?? null],
  );
  return mapDefinition(result.rows[0] as Row);
}

export async function listAuditReportDefinitions(pool: pg.Pool, workspaceKey: string, tenantKey: string): Promise<AuditReportDefinition[]> {
  const result = await pool.query(`SELECT * FROM mcp_audit_report_definitions WHERE workspace_key=$1 AND tenant_key=$2 ORDER BY enabled DESC, created_at DESC`, [workspaceKey, tenantKey]);
  return (result.rows as Row[]).map(mapDefinition);
}

export async function disableAuditReportDefinition(pool: pg.Pool, id: string, workspaceKey: string, tenantKey: string, now = new Date()): Promise<AuditReportDefinition | null> {
  const result = await pool.query(`UPDATE mcp_audit_report_definitions SET enabled=FALSE, disabled_at=$4, next_run_at=NULL WHERE id=$1 AND workspace_key=$2 AND tenant_key=$3 AND enabled=TRUE RETURNING *`, [id, workspaceKey, tenantKey, now.toISOString()]);
  return result.rows[0] ? mapDefinition(result.rows[0] as Row) : null;
}

export async function getAuditReportDefinition(pool: pg.Pool, id: string, workspaceKey: string, tenantKey: string): Promise<AuditReportDefinition | null> {
  const result = await pool.query(`SELECT * FROM mcp_audit_report_definitions WHERE id=$1 AND workspace_key=$2 AND tenant_key=$3`, [id, workspaceKey, tenantKey]);
  return result.rows[0] ? mapDefinition(result.rows[0] as Row) : null;
}

export async function createAuditReportRun(pool: pg.Pool, input: {
  definitionId?: string | null; workspaceKey: string; tenantKey: string; environment: string; reportType: AuditReportRun['reportType'];
  name: string; triggerType: AuditReportRun['triggerType']; requestedBy: string; periodFrom: Date; periodTo: Date; filters: AuditReportFilters;
}): Promise<AuditReportRun> {
  const result = await pool.query(
    `INSERT INTO mcp_audit_report_runs (id,definition_id,workspace_key,tenant_key,environment,report_type,name_snapshot,trigger_type,requested_by,status,period_from,period_to,filters)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',$10,$11,$12::jsonb) RETURNING *`,
    [randomUUID(), input.definitionId ?? null, input.workspaceKey, input.tenantKey, input.environment, input.reportType, input.name,
      input.triggerType, input.requestedBy, input.periodFrom.toISOString(), input.periodTo.toISOString(), JSON.stringify(input.filters)],
  );
  return mapRun(result.rows[0] as Row);
}

export async function markAuditReportRunning(pool: pg.Pool, id: string, now = new Date()): Promise<boolean> {
  const result = await pool.query(`UPDATE mcp_audit_report_runs SET status='running', started_at=$2 WHERE id=$1 AND status='queued' RETURNING id`, [id, now.toISOString()]);
  return result.rowCount === 1;
}

export async function completeAuditReportRun(pool: pg.Pool, id: string, result: {
  checkpointId: string; packId: string; packDigest: string; eventCount: number; chainEntryCount: number; gapCodes: string[];
  summary: unknown; evidencePack: unknown; completedAt: Date;
}): Promise<void> {
  await pool.query(`UPDATE mcp_audit_report_runs SET status='completed',checkpoint_id=$2,pack_id=$3,pack_digest=$4,verification_state='valid',event_count=$5,chain_entry_count=$6,gap_codes=$7,summary=$8::jsonb,evidence_pack=$9::jsonb,completed_at=$10 WHERE id=$1 AND status='running'`,
    [id, result.checkpointId, result.packId, result.packDigest, result.eventCount, result.chainEntryCount, result.gapCodes,
      JSON.stringify(result.summary), JSON.stringify(result.evidencePack), result.completedAt.toISOString()]);
}

export async function failAuditReportRun(pool: pg.Pool, id: string, code: string, message: string, now = new Date()): Promise<void> {
  await pool.query(`UPDATE mcp_audit_report_runs SET status='failed',error_code=$2,error_message=$3,completed_at=$4 WHERE id=$1 AND status IN ('queued','running')`, [id, code, message.slice(0, 4000), now.toISOString()]);
}

export async function getAuditReportRun(pool: pg.Pool, id: string, workspaceKey: string, tenantKey: string, includePack = false): Promise<AuditReportRun | null> {
  const result = await pool.query(`SELECT * FROM mcp_audit_report_runs WHERE id=$1 AND workspace_key=$2 AND tenant_key=$3`, [id, workspaceKey, tenantKey]);
  if (!result.rows[0]) return null;
  return (await attachReviews(pool, [mapRun(result.rows[0] as Row, includePack)]))[0] ?? null;
}

export async function listAuditReportRuns(pool: pg.Pool, workspaceKey: string, tenantKey: string, limit = 50): Promise<AuditReportRun[]> {
  const result = await pool.query(`SELECT * FROM mcp_audit_report_runs WHERE workspace_key=$1 AND tenant_key=$2 ORDER BY created_at DESC LIMIT $3`, [workspaceKey, tenantKey, limit]);
  return attachReviews(pool, (result.rows as Row[]).map(row => mapRun(row)));
}

export async function addAuditReportReviewRow(client: pg.PoolClient, input: { id: string; reportRunId: string; decision: AuditReportReview['decision']; actorId: string; actorAuthMethod: string; commentDigest: string; occurredAt: Date; auditEventId: string }): Promise<AuditReportReview> {
  const result = await client.query(`INSERT INTO mcp_audit_report_reviews (id,report_run_id,decision,actor_id,actor_auth_method,comment_digest,occurred_at,audit_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [input.id, input.reportRunId, input.decision, input.actorId, input.actorAuthMethod, input.commentDigest, input.occurredAt.toISOString(), input.auditEventId]);
  return mapReview(result.rows[0] as Row);
}

export async function listDueAuditReportDefinitions(pool: pg.Pool, now = new Date(), limit = 10): Promise<AuditReportDefinition[]> {
  const result = await pool.query(`SELECT * FROM mcp_audit_report_definitions WHERE enabled=TRUE AND cadence<>'manual' AND next_run_at<=$1 ORDER BY next_run_at LIMIT $2`, [now.toISOString(), limit]);
  return (result.rows as Row[]).map(mapDefinition);
}

export async function listQueuedAuditReportRuns(pool: pg.Pool, limit = 10): Promise<string[]> {
  const result = await pool.query<{ id: string }>(`SELECT id FROM mcp_audit_report_runs WHERE status='queued' AND created_at<=now()-interval '10 seconds' ORDER BY created_at LIMIT $1`, [limit]);
  return result.rows.map(row => row.id);
}

export async function requeueStaleAuditReportRuns(pool: pg.Pool, now = new Date(), staleMinutes = 30): Promise<number> {
  const staleBefore = new Date(now.getTime() - staleMinutes * 60_000);
  const result = await pool.query(`UPDATE mcp_audit_report_runs SET status='queued',started_at=NULL WHERE status='running' AND started_at<$1`, [staleBefore.toISOString()]);
  return result.rowCount ?? 0;
}

export async function advanceAuditReportDefinition(pool: pg.Pool, definition: AuditReportDefinition, now = new Date()): Promise<void> {
  const next = nextAuditReportRun(definition, now);
  await pool.query(`UPDATE mcp_audit_report_definitions SET last_run_at=$2,next_run_at=$3 WHERE id=$1`, [definition.id, now.toISOString(), next?.toISOString() ?? null]);
}
