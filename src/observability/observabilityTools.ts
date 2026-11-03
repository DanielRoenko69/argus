import { z } from 'zod';
import type pg from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { redact, redactJson } from '../lib/redaction.js';
import {
  getTelemetrySpan,
  getTelemetryTrace,
  listTelemetryTraceFamily,
  listTelemetryTraces,
  type TelemetrySpanRow,
  type TelemetryTraceRow,
} from './telemetryStore.js';
import { compareTelemetryTraceFamilies } from './traceComparison.js';
import { listTraceFeedback, summarizeTraceFeedback } from './feedbackStore.js';

export const ARGUS_OBSERVABILITY_TOOL_NAMES = [
  'argus_observe_search_traces',
  'argus_observe_get_trace',
  'argus_observe_search_logs',
  'argus_observe_compare_traces',
] as const;
export type ArgusObservabilityToolName = typeof ARGUS_OBSERVABILITY_TOOL_NAMES[number];

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const uuid = z.string().uuid();
const SearchTracesInput = z.object({
  hours: z.number().int().min(1).max(24 * 90).default(24),
  limit: z.number().int().min(1).max(100).default(25),
  status: z.enum(['running', 'waiting', 'completed', 'failed', 'cancelled', 'error'])
    .optional()
    .describe("Trace status. 'error' is accepted as an alias for the persisted 'failed' status."),
  kind: z.enum(['agent', 'workflow', 'compliance', 'evaluation', 'unknown']).optional(),
});
const GetTraceInput = z.object({
  trace_id: uuid.describe('Native Argus trace UUID'),
  include_family: z.boolean().default(true),
  include_previews: z.boolean().default(false),
  span_limit: z.number().int().min(1).max(500).default(100),
});
const SearchLogsInput = z.object({
  trace_id: uuid.optional(),
  root_trace_id: uuid.optional(),
  span_id: uuid.optional(),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).optional(),
  query: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});
const CompareTracesInput = z.object({
  current_trace_id: uuid,
  baseline_trace_id: uuid,
});

function access(allowedBundleIds: number[] | null) {
  return { userId: 0, observeAll: true, allowedBundleIds };
}

function boundedRedacted(value: unknown, maxLength = 4_000): unknown {
  const safe = redactJson(value).value;
  const serialized = JSON.stringify(safe);
  return serialized.length <= maxLength ? safe : `${serialized.slice(0, maxLength)}… [TRUNCATED]`;
}

function safeText(value: unknown, maxLength = 2_000): string | null {
  if (value == null) return null;
  return redact(String(value).slice(0, maxLength)).text;
}

function traceSummary(trace: TelemetryTraceRow) {
  return {
    id: trace.id,
    rootTraceId: trace.root_trace_id,
    parentTraceId: trace.parent_trace_id,
    parentSpanId: trace.parent_span_id,
    name: trace.name,
    kind: trace.kind,
    status: trace.status,
    agentId: trace.agent_id,
    agentName: trace.agent_name ?? null,
    workflowExecutionId: trace.workflow_execution_id,
    model: trace.model,
    provider: trace.provider,
    startedAt: trace.started_at,
    endedAt: trace.ended_at,
    durationMs: Number(trace.duration_ms ?? 0),
    inputTokens: Number(trace.input_tokens ?? 0),
    outputTokens: Number(trace.output_tokens ?? 0),
    totalCostUsd: Number(trace.total_cost_usd ?? 0),
    error: safeText(trace.error_message),
  };
}

function spanSummary(span: TelemetrySpanRow, includePreviews: boolean) {
  return {
    id: span.id,
    traceId: span.trace_id,
    parentSpanId: span.parent_span_id,
    name: span.name,
    kind: span.kind,
    status: span.status,
    toolName: span.tool_name,
    model: span.model,
    provider: span.provider,
    startedAt: span.started_at,
    endedAt: span.ended_at,
    durationMs: Number(span.duration_ms ?? 0),
    inputTokens: Number(span.input_tokens ?? 0),
    outputTokens: Number(span.output_tokens ?? 0),
    totalCostUsd: Number(span.total_cost_usd ?? 0),
    error: safeText(span.error_message),
    ...(includePreviews ? {
      inputPreview: boundedRedacted(span.input_preview),
      outputPreview: boundedRedacted(span.output_preview),
      metadata: boundedRedacted(span.metadata),
    } : {}),
  };
}

function success(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function searchTraces(pool: pg.Pool, args: z.infer<typeof SearchTracesInput>, allowedBundleIds: number[] | null) {
  const traces = await listTelemetryTraces(pool, {
    ...access(allowedBundleIds),
    hours: args.hours,
    limit: args.limit,
    status: args.status === 'error' ? 'failed' : args.status,
    kind: args.kind,
  });
  return success({ count: traces.length, traces: traces.map(traceSummary) });
}

async function getTrace(pool: pg.Pool, args: z.infer<typeof GetTraceInput>, allowedBundleIds: number[] | null) {
  const traceAccess = access(allowedBundleIds);
  const selected = await getTelemetryTrace(pool, args.trace_id, traceAccess);
  if (!selected) return failure('Trace not found or outside the assigned bundle scope.');
  const family = args.include_family
    ? await listTelemetryTraceFamily(pool, selected.trace.root_trace_id, traceAccess)
    : { traces: [selected.trace], spans: selected.spans, truncated: false, spansTruncated: false };
  const feedback = await listTraceFeedback(pool, selected.trace.id);
  const spans = family.spans.slice(0, args.span_limit);
  return success({
    rootTraceId: selected.trace.root_trace_id,
    currentTraceId: selected.trace.id,
    traces: family.traces.map(trace => ({
      ...traceSummary(trace),
      ...(args.include_previews ? {
        inputPreview: boundedRedacted(trace.input_preview),
        outputPreview: boundedRedacted(trace.output_preview),
        metadata: boundedRedacted(trace.metadata),
      } : {}),
    })),
    spans: spans.map(span => spanSummary(span, args.include_previews)),
    feedback: {
      summary: summarizeTraceFeedback(feedback),
      ...(args.include_previews ? {
        entries: feedback.slice(0, 100).map(entry => ({
          id: Number(entry.id),
          spanId: entry.span_id,
          source: entry.source,
          label: entry.label,
          score: entry.score == null ? null : Number(entry.score),
          sentiment: entry.sentiment,
          comment: safeText(entry.comment),
          tags: entry.tags,
          createdAt: entry.created_at,
        })),
      } : {}),
    },
    truncated: family.truncated || family.spansTruncated || family.spans.length > spans.length,
  });
}

async function searchLogs(pool: pg.Pool, args: z.infer<typeof SearchLogsInput>, allowedBundleIds: number[] | null) {
  if (!args.trace_id && !args.root_trace_id && !args.span_id) {
    return failure('A trace_id, root_trace_id or span_id is required for scoped log search.');
  }
  const traceAccess = access(allowedBundleIds);
  if (args.trace_id && !await getTelemetryTrace(pool, args.trace_id, traceAccess)) {
    return failure('Trace not found or outside the assigned bundle scope.');
  }
  if (args.root_trace_id && !await getTelemetryTrace(pool, args.root_trace_id, traceAccess)) {
    return failure('Trace family not found or outside the assigned bundle scope.');
  }
  if (args.span_id && !await getTelemetrySpan(pool, args.span_id, traceAccess)) {
    return failure('Span not found or outside the assigned bundle scope.');
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const add = (field: string, cast: string, value: unknown) => {
    params.push(value);
    conditions.push(`${field}=$${params.length}${cast}`);
  };
  if (args.trace_id) add('trace_id', '::uuid', args.trace_id);
  if (args.root_trace_id) add('root_trace_id', '::uuid', args.root_trace_id);
  if (args.span_id) add('span_id', '::uuid', args.span_id);
  if (args.level) add('level', '', args.level);
  if (args.query) {
    params.push(`%${args.query}%`);
    conditions.push(`(msg ILIKE $${params.length} OR data::text ILIKE $${params.length})`);
  }
  params.push(args.limit);
  const result = await pool.query<{
    id: number; ts: string; level: string; msg: string; tool: string | null;
    backend: string | null; req_id: string | null; root_trace_id: string | null;
    trace_id: string | null; span_id: string | null; data: unknown;
  }>(
    `SELECT id, ts, level, msg, tool, backend, req_id, root_trace_id, trace_id, span_id, data
       FROM argus_logs WHERE ${conditions.join(' AND ')}
      ORDER BY ts DESC LIMIT $${params.length}`,
    params,
  );
  return success({
    count: result.rows.length,
    logs: result.rows.map(row => ({
      id: row.id,
      timestamp: row.ts,
      level: row.level,
      message: safeText(row.msg),
      tool: row.tool,
      backend: row.backend,
      requestId: row.req_id,
      rootTraceId: row.root_trace_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      data: boundedRedacted(row.data),
    })),
  });
}

async function compareTraces(pool: pg.Pool, args: z.infer<typeof CompareTracesInput>, allowedBundleIds: number[] | null) {
  const traceAccess = access(allowedBundleIds);
  const [current, baseline] = await Promise.all([
    getTelemetryTrace(pool, args.current_trace_id, traceAccess),
    getTelemetryTrace(pool, args.baseline_trace_id, traceAccess),
  ]);
  if (!current || !baseline) return failure('One or both traces were not found in the assigned bundle scope.');
  const [currentFamily, baselineFamily] = await Promise.all([
    listTelemetryTraceFamily(pool, current.trace.root_trace_id, traceAccess),
    listTelemetryTraceFamily(pool, baseline.trace.root_trace_id, traceAccess),
  ]);
  const comparison = compareTelemetryTraceFamilies(currentFamily, baselineFamily);
  if (!comparison) return failure('The selected trace families cannot be compared.');
  return success({
    ...comparison,
    changes: comparison.changes.slice(0, 100),
    truncated: comparison.changes.length > 100 || currentFamily.truncated || baselineFamily.truncated,
  });
}

export function isArgusObservabilityTool(name: string): name is ArgusObservabilityToolName {
  return (ARGUS_OBSERVABILITY_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeArgusObservabilityTool(
  pool: pg.Pool,
  name: ArgusObservabilityToolName,
  rawArgs: Record<string, unknown>,
  allowedBundleIds: number[] | null = null,
): Promise<ToolResult> {
  try {
    if (name === 'argus_observe_search_traces') return searchTraces(pool, SearchTracesInput.parse(rawArgs), allowedBundleIds);
    if (name === 'argus_observe_get_trace') return getTrace(pool, GetTraceInput.parse(rawArgs), allowedBundleIds);
    if (name === 'argus_observe_search_logs') return searchLogs(pool, SearchLogsInput.parse(rawArgs), allowedBundleIds);
    return compareTraces(pool, CompareTracesInput.parse(rawArgs), allowedBundleIds);
  } catch (error) {
    const message = error instanceof z.ZodError
      ? `Invalid arguments: ${error.issues.map(issue => issue.message).join('; ')}`
      : 'Observability query failed. Inspect Argus server logs for details.';
    return failure(message);
  }
}

export async function registerArgusObservabilityTools(
  server: McpServer,
  pool: pg.Pool,
  allowedToolNames: Set<string> | null,
  allowedBundleIds: number[] | null,
): Promise<void> {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM mcp_tools
      WHERE enabled=true AND tool_type='builtin' AND backend='argus-observability'
        AND name=ANY($1::text[])`,
    [[...ARGUS_OBSERVABILITY_TOOL_NAMES]],
  );
  const enabled = new Set(result.rows.map(row => row.name));
  const available = (name: ArgusObservabilityToolName) =>
    enabled.has(name) && (allowedToolNames == null || allowedToolNames.has(name));

  if (available('argus_observe_search_traces')) server.tool(
    'argus_observe_search_traces',
    'Search recent Argus agent and workflow traces by status and kind. Read-only; returns bounded summaries without prompt previews.',
    SearchTracesInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusObservabilityTool(pool, 'argus_observe_search_traces', args, allowedBundleIds),
  );
  if (available('argus_observe_get_trace')) server.tool(
    'argus_observe_get_trace',
    'Inspect one Argus trace or distributed trace family, including spans, duration, tokens, cost and optional redacted previews.',
    GetTraceInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusObservabilityTool(pool, 'argus_observe_get_trace', args, allowedBundleIds),
  );
  if (available('argus_observe_search_logs')) server.tool(
    'argus_observe_search_logs',
    'Search structured Argus logs correlated to an accessible trace, trace family or span. Read-only; unscoped global search is rejected.',
    SearchLogsInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusObservabilityTool(pool, 'argus_observe_search_logs', args, allowedBundleIds),
  );
  if (available('argus_observe_compare_traces')) server.tool(
    'argus_observe_compare_traces',
    'Compare two accessible Argus trace families for latency, cost, failures and node-level regressions. Read-only.',
    CompareTracesInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusObservabilityTool(pool, 'argus_observe_compare_traces', args, allowedBundleIds),
  );
}
