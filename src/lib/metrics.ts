import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const toolCallCounter = new Counter({
  name: 'mcp_tool_calls_total',
  help: 'Total MCP tool invocations',
  labelNames: ['tool', 'status'] as const,
  registers: [registry],
});

export const toolDurationHistogram = new Histogram({
  name: 'mcp_tool_duration_seconds',
  help: 'Duration of MCP tool execution in seconds',
  labelNames: ['tool'] as const,
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

export const activeSessionsGauge = new Gauge({
  name: 'mcp_active_sessions',
  help: 'Number of active MCP sessions',
  registers: [registry],
});

export const httpRequestCounter = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const rateLimitCounter = new Counter({
  name: 'mcp_rate_limit_hits_total',
  help: 'Number of rate-limited requests',
  labelNames: ['api_key_prefix'] as const,
  registers: [registry],
});

export const auditLogCounter = new Counter({
  name: 'mcp_audit_log_total',
  help: 'Total audit log entries written',
  registers: [registry],
});

export const canonicalAuditIntegrityGauge = new Gauge({
  name: 'argus_canonical_audit_integrity_state',
  help: 'Latest canonical audit integrity state (1 for the current state label).',
  labelNames: ['environment', 'state'] as const,
  registers: [registry],
});

export const canonicalAuditCheckpointSequenceGauge = new Gauge({
  name: 'argus_canonical_audit_checkpoint_sequence',
  help: 'Most recent signed canonical audit sequence by environment.',
  labelNames: ['environment'] as const,
  registers: [registry],
});

export const canonicalAuditOutboxPendingGauge = new Gauge({
  name: 'argus_canonical_audit_outbox_pending',
  help: 'Number of undelivered canonical audit outbox records.',
  registers: [registry],
});

export const canonicalAuditOutboxOldestAgeGauge = new Gauge({
  name: 'argus_canonical_audit_outbox_oldest_age_seconds',
  help: 'Age in seconds of the oldest undelivered canonical audit outbox record.',
  registers: [registry],
});


export const gatewayRateLimitCounter = new Counter({
  name: 'gateway_rate_limit_hits_total',
  help: 'Number of rate-limited gateway requests',
  labelNames: ['dimension', 'type'] as const,
  registers: [registry],
});
