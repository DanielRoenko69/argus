import pino from 'pino';
import { writeLog } from './logStore.js';
import { getNativeTelemetryContext } from '../observability/telemetryContext.js';

// DB sink: parses JSON log lines and writes to the argus_logs table
const dbStream = new (class {
  write(chunk: string) {
    try { writeLog(JSON.parse(chunk)); } catch { /* ignore */ }
  }
})();

// In development: pretty-print to stdout + write JSON to DB
// In production:  plain JSON to stdout + write to DB
function buildLogger() {
  // Jest must not create pino-pretty's worker thread: runInBand waits for the
  // test process to exit, while the transport can keep its MessagePort alive.
  const isDev = process.env.NODE_ENV !== 'production'
    && process.env.NODE_ENV !== 'test'
    && process.env.JEST_WORKER_ID == null;
  const level = process.env.LOG_LEVEL ?? 'info';

  if (isDev) {
    // pino-pretty handles stdout; we add a second raw JSON stream for the DB
    const prettyStream = pino.transport({ target: 'pino-pretty', options: { colorize: true } });
    return pino({ level, mixin: telemetryLogMixin }, pino.multistream([
      { level, stream: prettyStream },
      { level: 'info', stream: dbStream as unknown as NodeJS.WritableStream },
    ]) as unknown as NodeJS.WritableStream);
  }

  return pino({ level, mixin: telemetryLogMixin }, pino.multistream([
    { level, stream: process.stdout },
    { level: 'info', stream: dbStream as unknown as NodeJS.WritableStream },
  ]) as unknown as NodeJS.WritableStream);
}

function telemetryLogMixin(): Record<string, unknown> {
  const context = getNativeTelemetryContext();
  if (!context) return {};
  return {
    rootTraceId: context.rootTraceId,
    traceId: context.traceId,
    ...(context.spanId ? { spanId: context.spanId } : {}),
    ...(context.agentId != null ? { agentId: context.agentId } : {}),
    ...(context.workflowId != null ? { workflowId: context.workflowId } : {}),
    ...(context.workflowExecutionId != null ? { workflowExecutionId: context.workflowExecutionId } : {}),
    ...(context.tenantKey ? { tenantKey: context.tenantKey } : {}),
    ...(context.workspaceKey ? { workspaceKey: context.workspaceKey } : {}),
  };
}

export const logger = buildLogger();
export type Logger = typeof logger;
