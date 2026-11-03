import type pg from 'pg';
import type { Config } from '../config/env.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { redact, redactJson } from '../lib/redaction.js';
import { executeTool, type ToolResult } from '../tools/toolRunner.js';
import {
  AIOPS_QUERY_PLACEHOLDERS,
  AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
  aiOpsEvidenceQueryPreflightInputSchema,
  aiOpsEvidenceQueryPreflightResultSchema,
  type AiOpsEvidenceQueryPreflightInput,
  type AiOpsEvidenceQueryPreflightResult,
} from './aiopsServiceProfileContracts.js';
import { AiOpsServiceProfileError } from './aiopsServiceProfiles.js';

const MAX_ARGUMENT_BYTES = 64 * 1_024;
const MAX_ARGUMENT_DEPTH = 12;
const MAX_ARGUMENT_NODES = 2_000;
const MAX_PREVIEW_CHARS = 16_384;
const STRICT_REMOTE_READ_NAME = /(?:^|_)(?:search|query|find|get|list|read|count|inspect|describe)(?:_|$)/i;
const WRITE_NAME = /(?:^|_)(?:write|create|update|delete|index|insert|put|post|patch|push|commit|deploy|restart|scale|apply|drop|truncate|kill|destroy)(?:_|$)/i;

interface ToolSafety {
  enabled: boolean;
  isWrite: boolean;
  source: 'managed' | 'remote';
}

export interface AiOpsEvidenceQueryPreflightDependencies {
  loadAllowedTools(pool: pg.Pool, bundleIds: number[]): Promise<Set<string>>;
  loadToolSafety(pool: pg.Pool, toolName: string): Promise<ToolSafety | null>;
  execute(
    toolName: string,
    args: Record<string, unknown>,
    context: { pool: pg.Pool; config: Config; allowedBundles: number[] },
  ): Promise<ToolResult>;
  now(): Date;
}

async function loadToolSafety(pool: pg.Pool, toolName: string): Promise<ToolSafety | null> {
  const managed = await pool.query<{ enabled: boolean; is_write: boolean }>(
    `SELECT enabled, COALESCE(is_write, false) AS is_write
       FROM mcp_tools
      WHERE name=$1
      LIMIT 1`,
    [toolName],
  );
  if (managed.rows[0]) {
    return { enabled: managed.rows[0].enabled, isWrite: managed.rows[0].is_write, source: 'managed' };
  }
  const remote = await pool.query<{ enabled: boolean }>(
    `SELECT backend.enabled
       FROM mcp_remote_tools tool
       JOIN mcp_backends backend ON backend.id=tool.backend_id
      WHERE tool.prefixed_name=$1
      LIMIT 1`,
    [toolName],
  );
  if (!remote.rows[0]) return null;
  const nameIsReadOnly = STRICT_REMOTE_READ_NAME.test(toolName) && !WRITE_NAME.test(toolName);
  return { enabled: remote.rows[0].enabled, isWrite: !nameIsReadOnly, source: 'remote' };
}

const DEFAULT_DEPENDENCIES: AiOpsEvidenceQueryPreflightDependencies = {
  loadAllowedTools: (pool, bundleIds) => loadAllowedToolNames(pool, bundleIds, { includeUnscoped: false }),
  loadToolSafety,
  execute: executeTool,
  now: () => new Date(),
};

function assertBoundedArguments(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query template must render to a JSON object');
  }
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): void => {
    nodes++;
    if (nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) {
      throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query arguments exceed the governed complexity limit');
    }
    if (Array.isArray(candidate)) {
      for (const child of candidate) visit(child, depth + 1);
    } else if (candidate && typeof candidate === 'object') {
      for (const child of Object.values(candidate as Record<string, unknown>)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function renderArguments(input: AiOpsEvidenceQueryPreflightInput): Record<string, unknown> {
  const values: Record<(typeof AIOPS_QUERY_PLACEHOLDERS)[number], string | undefined> = {
    'service.name': input.context.serviceName,
    environment: input.context.environment,
    'window.start': input.context.windowStart,
    'window.end': input.context.windowEnd,
    'window.start_micros': String(BigInt(Date.parse(input.context.windowStart)) * 1_000n),
    'window.end_micros': String(BigInt(Date.parse(input.context.windowEnd)) * 1_000n),
    'runtime.cluster': input.context.runtime?.cluster,
    'runtime.namespace': input.context.runtime?.namespace,
    'signal.keyword': input.context.signal?.keyword ?? input.query.defaults?.signalKeyword,
    'signal.fingerprint': input.context.signal?.fingerprint ?? input.query.defaults?.signalFingerprint,
    'trace.id': input.context.traceId,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.query.template);
  } catch {
    throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query template must contain valid JSON arguments');
  }
  assertBoundedArguments(parsed);

  function renderString(candidate: string): string {
    const trimmed = candidate.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const nested = JSON.parse(candidate) as unknown;
        if (nested && typeof nested === 'object') return JSON.stringify(renderValue(nested));
      } catch {
        // Provider-native query strings may begin with braces (for example LogQL).
      }
    }
    let rendered = candidate;
    for (const placeholder of AIOPS_QUERY_PLACEHOLDERS) {
      const token = `\${${placeholder}}`;
      if (!rendered.includes(token)) continue;
      const value = values[placeholder];
      if (!value) {
        throw new AiOpsServiceProfileError(400, 'invalid_profile', `Evidence query context is missing ${placeholder}`);
      }
      rendered = rendered.replaceAll(token, value);
    }
    if (/\$\{[^}]+\}/.test(rendered)) {
      throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query contains an unresolved placeholder');
    }
    return rendered;
  }
  function renderValue(candidate: unknown): unknown {
    if (typeof candidate === 'string') return renderString(candidate);
    if (Array.isArray(candidate)) return candidate.map(renderValue);
    if (candidate && typeof candidate === 'object') {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .map(([key, value]) => [key, renderValue(value)]));
    }
    return candidate;
  }
  const rendered = renderValue(parsed);
  assertBoundedArguments(rendered);
  if (/\$\{[^}]+\}/.test(JSON.stringify(rendered))) {
    throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query contains an unresolved placeholder');
  }
  if (Buffer.byteLength(JSON.stringify(rendered), 'utf8') > MAX_ARGUMENT_BYTES) {
    throw new AiOpsServiceProfileError(400, 'invalid_profile', 'Evidence query arguments exceed 64 KiB');
  }
  return rendered;
}

function parsedPayload(text: string): unknown {
  const trimmed = text.trim();
  for (const offset of [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(value => value >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(trimmed.slice(offset)); } catch { /* continue */ }
  }
  return null;
}

function matchedDocuments(text: string): number | null {
  const payload = parsedPayload(text);
  if (Array.isArray(payload)) return payload.length;
  if (!payload || typeof payload !== 'object') return null;
  const object = payload as Record<string, unknown>;
  if (typeof object['count'] === 'number' && Number.isSafeInteger(object['count']) && object['count'] >= 0) return object['count'];
  const hits = object['hits'];
  if (!hits || typeof hits !== 'object' || Array.isArray(hits)) return null;
  const total = (hits as Record<string, unknown>)['total'];
  if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0) return total;
  if (total && typeof total === 'object' && !Array.isArray(total)) {
    const value = (total as Record<string, unknown>)['value'];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  const rows = (hits as Record<string, unknown>)['hits'];
  return Array.isArray(rows) ? rows.length : null;
}

export async function runAiOpsEvidenceQueryPreflight(
  pool: pg.Pool,
  config: Config,
  rawInput: unknown,
  dependencies: Partial<AiOpsEvidenceQueryPreflightDependencies> = {},
): Promise<AiOpsEvidenceQueryPreflightResult> {
  const input = aiOpsEvidenceQueryPreflightInputSchema.parse(rawInput);
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const allowedTools = await deps.loadAllowedTools(pool, [input.bundleId]);
  if (!allowedTools.has(input.query.toolName)) {
    throw new AiOpsServiceProfileError(403, 'forbidden', 'Evidence query tool is not authorized by the selected bundle');
  }
  const safety = await deps.loadToolSafety(pool, input.query.toolName);
  if (!safety || !safety.enabled) {
    throw new AiOpsServiceProfileError(409, 'validation_required', 'Evidence query tool is unavailable');
  }
  if (safety.isWrite) {
    throw new AiOpsServiceProfileError(403, 'forbidden', 'Evidence query preflight only permits verified read-only tools');
  }

  const args = renderArguments(input);
  const safeArguments = redactJson(args, { forceEnabled: true }).value;
  const base = {
    schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
    kind: 'aiops-evidence-query-preflight' as const,
    lane: input.lane,
    bundleId: input.bundleId,
    queryId: input.query.id,
    toolName: input.query.toolName,
    generatedAt: deps.now().toISOString(),
    request: { arguments: safeArguments },
  };
  if (!input.execute) {
    return aiOpsEvidenceQueryPreflightResultSchema.parse({
      ...base,
      state: 'preview',
      executed: false,
      response: null,
    });
  }

  const startedAt = Date.now();
  try {
    const result = await deps.execute(input.query.toolName, args, {
      pool,
      config,
      allowedBundles: [input.bundleId],
    });
    const durationMs = Math.max(0, Date.now() - startedAt);
    const raw = result.content.map(part => part.text).join('\n');
    const resultBytes = Buffer.byteLength(raw, 'utf8');
    const failed = result.isError === true;
    const preview = failed
      ? 'Evidence source rejected or could not execute the read-only query.'
      : redact(raw, { forceEnabled: true }).text.slice(0, MAX_PREVIEW_CHARS);
    return aiOpsEvidenceQueryPreflightResultSchema.parse({
      ...base,
      state: failed ? 'failed' : 'succeeded',
      executed: true,
      response: {
        preview,
        matchedDocuments: failed ? null : matchedDocuments(raw),
        durationMs,
        resultBytes,
        truncated: resultBytes > Buffer.byteLength(preview, 'utf8'),
      },
    });
  } catch {
    const durationMs = Math.max(0, Date.now() - startedAt);
    return aiOpsEvidenceQueryPreflightResultSchema.parse({
      ...base,
      state: 'failed',
      executed: true,
      response: {
        preview: 'Evidence source rejected or could not execute the read-only query.',
        matchedDocuments: null,
        durationMs,
        resultBytes: 0,
        truncated: false,
      },
    });
  }
}
