/**
 * Lightweight in-process log sink that writes pino log entries to PostgreSQL.
 * Non-blocking: inserts are fire-and-forget with a small in-memory buffer.
 */
import pg from 'pg';

interface LogEntry {
  ts: Date;
  level: string;
  msg: string;
  data: Record<string, unknown>;
  req_id?: string;
  tool?: string;
  backend?: string;
  api_key_id?: number;
  root_trace_id?: string;
  trace_id?: string;
  span_id?: string;
  agent_id?: number;
  workflow_execution_id?: number;
  tenant_key: string;
  workspace_key: string;
}

const LEVEL_MAP: Record<number, string> = {
  10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal',
};

let pool: pg.Pool | null = null;
let buffer: LogEntry[] = [];
let flushing = false;
let flushTimer: NodeJS.Timeout | null = null;
const BUFFER_LIMIT = 200;
const FLUSH_INTERVAL_MS = 2000;

export function initLogStore(p: pg.Pool) {
  pool = p;
  // Ensure table exists (idempotent)
  p.query(`
    CREATE TABLE IF NOT EXISTS argus_logs (
      id         BIGSERIAL PRIMARY KEY,
      ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
      level      VARCHAR(16) NOT NULL DEFAULT 'info',
      msg        TEXT NOT NULL,
      data       JSONB,
      req_id     VARCHAR(64),
      tool       VARCHAR(128),
      backend    VARCHAR(128),
      api_key_id INTEGER,
      root_trace_id UUID,
      trace_id UUID,
      span_id UUID,
      agent_id INTEGER,
      workflow_execution_id BIGINT
    );
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS root_trace_id UUID;
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS trace_id UUID;
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS span_id UUID;
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS agent_id INTEGER;
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS workflow_execution_id BIGINT;
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS tenant_key VARCHAR(128) NOT NULL DEFAULT 'default';
    ALTER TABLE argus_logs ADD COLUMN IF NOT EXISTS workspace_key VARCHAR(128) NOT NULL DEFAULT 'default';
    CREATE INDEX IF NOT EXISTS idx_argus_logs_ts    ON argus_logs (ts DESC);
    CREATE INDEX IF NOT EXISTS idx_argus_logs_level ON argus_logs (level);
    CREATE INDEX IF NOT EXISTS idx_argus_logs_tool  ON argus_logs (tool);
    CREATE INDEX IF NOT EXISTS idx_argus_logs_root_trace ON argus_logs (root_trace_id, ts DESC) WHERE root_trace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_logs_trace ON argus_logs (trace_id, ts DESC) WHERE trace_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_logs_span ON argus_logs (span_id, ts DESC) WHERE span_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_logs_agent ON argus_logs (agent_id, ts DESC) WHERE agent_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_logs_workflow_execution ON argus_logs (workflow_execution_id, ts DESC) WHERE workflow_execution_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_argus_logs_scope_ts ON argus_logs (tenant_key, workspace_key, ts DESC);
  `).catch(() => {});

  if (!flushTimer) {
    flushTimer = setInterval(flushBuffer, FLUSH_INTERVAL_MS);
    flushTimer.unref();
  }
}

export function writeLog(pinoRecord: Record<string, unknown>) {
  if (!pool) return;
  const levelNum = (pinoRecord.level as number) ?? 30;
  const level = LEVEL_MAP[levelNum] ?? 'info';
  // Skip trace/debug to avoid noise
  if (levelNum < 20) return;

  const { time, level: _l, msg, pid, hostname, ...rest } = pinoRecord;
  const sanitize = (v: unknown) => typeof v === 'string' ? v.replace(/[\r\n\t\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '_') : undefined;
  const uuid = (v: unknown): string | undefined => {
    const value = sanitize(v);
    return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : undefined;
  };
  const scopeKey = (v: unknown): string | undefined => {
    const value = sanitize(v);
    return value && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(value) ? value : undefined;
  };
  const entry: LogEntry = {
    ts: new Date((time as number) ?? Date.now()),
    level,
    msg: (msg as string) ?? '',
    data: rest as Record<string, unknown>,
    req_id: sanitize(rest.reqId) as string | undefined,
    tool: sanitize(rest.tool) as string | undefined,
    backend: sanitize(rest.backend) as string | undefined,
    api_key_id: rest.apiKeyId as number | undefined,
    root_trace_id: uuid(rest.rootTraceId ?? rest.root_trace_id),
    trace_id: uuid(rest.traceId ?? rest.trace_id),
    span_id: uuid(rest.spanId ?? rest.span_id),
    agent_id: Number.isSafeInteger(rest.agentId ?? rest.agent_id) ? Number(rest.agentId ?? rest.agent_id) : undefined,
    workflow_execution_id: Number.isSafeInteger(rest.workflowExecutionId ?? rest.workflow_execution_id)
      ? Number(rest.workflowExecutionId ?? rest.workflow_execution_id)
      : undefined,
    tenant_key: scopeKey(rest.tenantKey ?? rest.tenant_key) ?? 'default',
    workspace_key: scopeKey(rest.workspaceKey ?? rest.workspace_key) ?? 'default',
  };

  buffer.push(entry);
  if (buffer.length >= BUFFER_LIMIT) flushBuffer();
}

export async function flushLogBuffer(): Promise<void> {
  await flushBuffer();
}

async function flushBuffer() {
  if (!pool || flushing || buffer.length === 0) return;
  flushing = true;
  const batch = buffer.splice(0, BUFFER_LIMIT);
  try {
    const values = batch.map((e, i) => {
      const base = i * 15;
      return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10},$${base+11},$${base+12},$${base+13},$${base+14},$${base+15})`;
    }).join(',');
    const params = batch.flatMap(e => [
      e.ts, e.level, e.msg,
      Object.keys(e.data).length > 0 ? JSON.stringify(e.data) : null,
      e.req_id ?? null, e.tool ?? null, e.backend ?? null, e.api_key_id ?? null,
      e.root_trace_id ?? null, e.trace_id ?? null, e.span_id ?? null,
      e.agent_id ?? null, e.workflow_execution_id ?? null,
      e.tenant_key, e.workspace_key,
    ]);
    await pool.query(
      `INSERT INTO argus_logs
        (ts, level, msg, data, req_id, tool, backend, api_key_id,
         root_trace_id, trace_id, span_id, agent_id, workflow_execution_id,
         tenant_key, workspace_key)
       VALUES ${values}`,
      params,
    );
  } catch {
    // swallow — logging must never crash the server
  } finally {
    flushing = false;
  }
}
