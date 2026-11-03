import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Config } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { parseCustomBackendRef, findBackendByName, executeCustomBackend, assertSsrfSafeResolved, assertEgressAllowed } from '../../backends/customBackends.js';
import pg from 'pg';

const { Pool } = pg;

// Names of enabled write-action tools (is_write=true). Refreshed on every loadDynamicTools call,
// which buildToolList runs at turn start before any hook — so the human-approval-gate reads a warm set
// with no per-call query.
const writeToolNames = new Set<string>();
export function isKnownWriteTool(name: string): boolean { return writeToolNames.has(name); }

// ── Shared Pool Singleton ─────────────────────────────────────
let _pool: pg.Pool | null = null;
function getPool(connectionUrl: string): pg.Pool {
  if (!_pool) _pool = new Pool({ connectionString: connectionUrl });
  return _pool;
}

// ── DB row shape ──────────────────────────────────────────────
export interface DynamicToolRow {
  id: number;
  name: string;
  description: string;
  backend: string; // 'postgresql' | 'opensearch' | 'http' | 'custom:<name>'
  query_template: string | null;
  parameters: ToolParameter[];
  enabled: boolean;
  category: string | null;
  bundle_id: number | null;   // legacy single FK (deprecated, use bundle_ids)
  bundle_ids: number[];       // n:m via mcp_tool_bundles
  tool_type: 'builtin' | 'dynamic';
  created_at: string;
  updated_at: string;
  /** Per-tool minimum authentication requirement. NULL = honor backend default.
   *  Use "strict" for sensitive tools (e.g., delete-PR, force-push) so they
   *  require a user OAuth token even on permissive backends. */
  required_auth_mode?: 'service-account' | 'permissive' | 'strict' | null;
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string;
}

// ── Prompt Injection Prevention ───────────────────────────────

const MAX_TOOL_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_PARAM_DESCRIPTION_LENGTH = 200;

// Patterns that indicate likely prompt injection attempts in DB-sourced strings
const SUSPICIOUS_PATTERNS = [
  /ignore\s+(previous|all|above|prior)\s+instructions?/i,
  /\bsystem\s*:/i,
  /\[INST\]/i,
  /<\s*system\s*>/i,
  /###\s*(instruction|system|prompt)/i,
];

export function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_TOOL_NAME_LENGTH);
}

export function sanitizeDescription(raw: string, maxLen = MAX_DESCRIPTION_LENGTH): string {
  return raw.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function warnIfSuspicious(toolName: string, description: string): void {
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(description)) {
      logger.warn({ toolName, pattern: pattern.toString() }, 'Suspicious pattern in tool description — possible prompt injection in DB');
      break;
    }
  }
}

// ── SQL Row Limit ──────────────────────────────────────────────

/**
 * Reject PostgreSQL extended-query input containing more than one statement.
 *
 * A plain `sql.split(';')` is not sufficient: semicolons are legal inside
 * strings, quoted identifiers, comments and dollar-quoted function bodies.
 * This small lexer follows those PostgreSQL constructs and permits at most one
 * top-level semicolon, which may only be followed by whitespace or comments.
 */
export function assertSingleSqlStatement(sql: string): void {
  let state: 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote' = 'normal';
  let blockCommentDepth = 0;
  let dollarQuoteDelimiter = '';
  let escapeString = false;
  let terminated = false;

  const reject = (): never => {
    throw new Error('Dynamic PostgreSQL tools accept exactly one SQL statement; remove additional statements.');
  };

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];

    if (state === 'line-comment') {
      if (char === '\n' || char === '\r') state = 'normal';
      continue;
    }

    if (state === 'block-comment') {
      // PostgreSQL supports nested block comments.
      if (char === '/' && next === '*') {
        blockCommentDepth += 1;
        i += 1;
      } else if (char === '*' && next === '/') {
        blockCommentDepth -= 1;
        i += 1;
        if (blockCommentDepth === 0) state = 'normal';
      }
      continue;
    }

    if (state === 'single-quote') {
      // Backslash escaping is syntax only for PostgreSQL E'...' strings. Treating
      // it as universal would let a normal string hide a real statement boundary
      // when standard_conforming_strings is enabled.
      if (escapeString && char === '\\') {
        i += 1;
      } else if (char === "'" && next === "'") {
        i += 1;
      } else if (char === "'") {
        state = 'normal';
        escapeString = false;
      }
      continue;
    }

    if (state === 'double-quote') {
      if (char === '"' && next === '"') {
        i += 1;
      } else if (char === '"') {
        state = 'normal';
      }
      continue;
    }

    if (state === 'dollar-quote') {
      if (sql.startsWith(dollarQuoteDelimiter, i)) {
        i += dollarQuoteDelimiter.length - 1;
        state = 'normal';
        dollarQuoteDelimiter = '';
      }
      continue;
    }

    // In normal SQL, comments do not count as content after a trailing
    // statement terminator.
    if (char === '-' && next === '-') {
      state = 'line-comment';
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      state = 'block-comment';
      blockCommentDepth = 1;
      i += 1;
      continue;
    }
    if (/\s/.test(char)) continue;

    if (char === ';') {
      if (terminated) reject();
      terminated = true;
      continue;
    }

    // Any SQL token after the one allowed terminator starts another statement.
    if (terminated) reject();

    if (char === "'") {
      state = 'single-quote';
      const previous = sql[i - 1];
      const beforePrevious = sql[i - 2];
      escapeString = (previous === 'E' || previous === 'e')
        && (i < 2 || !/[a-zA-Z0-9_$]/.test(beforePrevious));
      continue;
    }
    if (char === '"') {
      state = 'double-quote';
      continue;
    }
    if (char === '$') {
      // A dollar quote adjoining an identifier is part of that identifier in
      // PostgreSQL (for example foo$tag$bar), not the start of a quoted body.
      // Misclassifying it could hide a real top-level semicolon.
      const previousIsIdentifier = i > 0 && /[\p{L}\p{N}_$]/u.test(sql[i - 1]);
      const delimiter = previousIsIdentifier
        ? undefined
        : sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/)?.[0];
      if (delimiter) {
        state = 'dollar-quote';
        dollarQuoteDelimiter = delimiter;
        i += delimiter.length - 1;
      }
    }
  }
}

function injectRowLimit(sql: string, maxRows: number): string {
  // Strip ALL existing LIMIT clauses (global replace prevents the first-match-only bypass
  // where a multi-statement query's second LIMIT is left unrestricted).
  const withoutLimit = sql.replace(/\bLIMIT\s+\d+\b/gi, '').trim();
  // Normalise: strip trailing semicolon so we can append cleanly
  const normalized = withoutLimit.replace(/;$/, '').trim();
  // Append a single, authoritative LIMIT that caps output at maxRows
  return `${normalized} LIMIT ${maxRows}`;
}

// ── Template rendering ────────────────────────────────────────

/**
 * Render a template for HTTP/non-SQL backends (string interpolation).
 * Values in URL path/query positions are URL-encoded; values inside JSON bodies
 * are JSON-string-escaped so they remain valid JSON.
 * Line 1 is the request line (METHOD URL) — values there are URL-encoded.
 * Header values retain their HTTP semantics (ETags, spaces, slashes, etc.) while
 * control characters are percent-escaped to prevent request splitting. A
 * placeholder used in a header name is still URL-encoded and rejected later if invalid.
 * The body (lines after blank line or first line starting with { or [) — values
 * are JSON-string-escaped (encodeURIComponent would break JSON syntax).
 */
export function renderTemplate(template: string, params: Record<string, unknown>, paramDefs: ToolParameter[]): string {
  const lines = template.split('\n');
  // Determine where the body starts (same logic as executeHttp)
  let bodyStartIdx = lines.length; // default: no body
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '') { bodyStartIdx = i + 1; break; }
    if (/^\s*[{[]/.test(lines[i])) { bodyStartIdx = i; break; }
  }

  const rawBodyMatch = bodyStartIdx < lines.length
    ? lines.slice(bodyStartIdx).join('\n').trim().match(/^\{\{([A-Za-z][A-Za-z0-9_]*)\}\}$/)
    : null;
  const rawBodyParameter = rawBodyMatch?.[1] ?? null;
  const rendered = lines.map((line, idx) => {
    let result = line;
    for (const def of paramDefs) {
      const raw = String(params[def.name] ?? def.default ?? '');
      const placeholder = `{{${def.name}}}`;
      if (result.includes(placeholder)) {
        const headerSeparator = idx > 0 && idx < bodyStartIdx ? line.indexOf(': ') : -1;
        const placeholderIndex = line.indexOf(placeholder);
        const isHeaderValue = headerSeparator >= 1 && placeholderIndex > headerSeparator;
        // Body: JSON-escape. URL/header-name: URL-encode. Header values must not
        // be URL-encoded wholesale because that changes upstream API semantics.
        const value = idx >= bodyStartIdx
          ? rawBodyParameter === def.name
            ? raw
            : JSON.stringify(raw).slice(1, -1)   // strip surrounding quotes
          : isHeaderValue
            ? raw.replace(/[\u0000-\u001f\u007f]/g, character =>
              `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
            : encodeURIComponent(raw);
        result = result.replaceAll(placeholder, value);
      }
    }
    return result;
  });

  const output = rendered.join('\n');

  // F2: Post-render JSON validation — detect if parameter values broke JSON structure
  if (bodyStartIdx < lines.length) {
    const bodyStr = rendered.slice(bodyStartIdx).join('\n').trim();
    if (bodyStr && (bodyStr.startsWith('{') || bodyStr.startsWith('[') || rawBodyParameter != null)) {
      try {
        JSON.parse(bodyStr);
      } catch {
        throw new Error(
          `Template rendering produced invalid JSON body — parameter values may contain unescaped JSON syntax. ` +
          `Check that placeholders inside JSON bodies are surrounded by double quotes in the template (e.g. "{{value}}" not {{value}}).`
        );
      }
    }
  }

  return output;
}

const DISALLOWED_REQUEST_HEADERS = new Set([
  'authorization', 'connection', 'content-length', 'cookie', 'host', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export interface ParsedHttpRequestSpec {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  target: string;
  headers: Record<string, string>;
  body?: string;
}

/** Parse the shared dynamic HTTP mini-format: request line, optional headers, blank line, body. */
export function parseHttpRequestSpec(spec: string): ParsedHttpRequestSpec {
  const lines = spec.split('\n');
  const firstLine = lines[0]?.trim() ?? '';
  const match = firstLine.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/);
  if (!match) throw new Error(`Invalid HTTP spec: ${firstLine}`);
  const headers: Record<string, string> = {};
  const bodyLines: string[] = [];
  let inBody = false;
  for (const line of lines.slice(1)) {
    if (inBody) {
      bodyLines.push(line);
      continue;
    }
    if (line.trim() === '') {
      inBody = true;
      continue;
    }
    if (/^\s*[{[]/.test(line)) {
      inBody = true;
      bodyLines.push(line);
      continue;
    }
    const separator = line.indexOf(': ');
    if (separator < 1) throw new Error(`Invalid HTTP header line: ${line}`);
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 2).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name) || DISALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) {
      throw new Error(`HTTP header is reserved or invalid: ${name}`);
    }
    headers[name] = value;
  }
  const body = bodyLines.join('\n').trim();
  return {
    method: match[1] as ParsedHttpRequestSpec['method'],
    target: match[2]!,
    headers,
    ...(body ? { body } : {}),
  };
}

/**
 * Render a SQL template as a parameterized query.
 * {{param}} placeholders are replaced with $1, $2, ... and values returned separately.
 * This prevents SQL injection entirely — user values never touch the SQL string.
 */
export function renderSqlTemplate(
  template: string,
  params: Record<string, unknown>,
  paramDefs: ToolParameter[],
): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  let sql = template;
  for (const def of paramDefs) {
    const placeholder = `{{${def.name}}}`;
    if (sql.includes(placeholder)) {
      values.push(params[def.name] ?? def.default ?? null);
      sql = sql.replaceAll(placeholder, `$${values.length}`);
    }
  }
  return { sql, values };
}

// ── Build Zod schema from parameter defs ──────────────────────
export function buildInputSchema(paramDefs: ToolParameter[]): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of paramDefs) {
    let schema: z.ZodTypeAny;
    switch (p.type) {
      case 'number':
        schema = z.number().describe(p.description);
        break;
      case 'boolean':
        schema = z.boolean().describe(p.description);
        break;
      default:
        schema = z.string().describe(p.description);
    }
    if (!p.required) {
      schema = schema.optional();
    }
    shape[p.name] = schema;
  }
  return shape;
}

// ── Backend executors ─────────────────────────────────────────
export async function executePg(
  pool: pg.Pool,
  sql: string,
  values: unknown[] = [],
  options?: { statementTimeoutMs?: number; maxRows?: number },
): Promise<string> {
  // Defense in depth: the pg extended query protocol must never receive a
  // second statement from a dynamic tool, even when the transaction is read-only.
  assertSingleSqlStatement(sql);

  // C1: Cast to integer and clamp — prevents SQL injection via string interpolation
  const timeoutMs = Math.max(100, Math.min(Math.trunc(Number(options?.statementTimeoutMs ?? 10_000)), 300_000));
  const maxRows = options?.maxRows ?? 1000;
  const limitedSql = injectRowLimit(sql, maxRows);

  const client = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);
    const result = await client.query(limitedSql, values);
    await client.query('COMMIT');
    return JSON.stringify({ rowCount: result.rowCount, rows: result.rows }, null, 2);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function executeHttp(spec: string): Promise<string> {
  const { method, target: url, headers, body } = parseHttpRequestSpec(spec);

  // SSRF protection: block internal/private addresses + DNS-rebinding (resolve-and-check)
  await assertSsrfSafeResolved(url);
  // Egress allowlist (opt-in via ARGUS_EGRESS_ALLOWLIST; empty = allow all)
  assertEgressAllowed(url);

  const res = await fetch(url, {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });

  const contentType = res.headers.get('content-type') ?? '';
  const responseBody = contentType.includes('json')
    ? JSON.stringify(await res.json(), null, 2)
    : await res.text();

  return `HTTP ${res.status} ${res.statusText}\n\n${responseBody}`;
}

// ── Bundle filtering ──────────────────────────────────────────
function filterByBundles(tools: DynamicToolRow[], allowed: number[] | null | undefined): DynamicToolRow[] {
  if (allowed == null) return tools; // null/undefined = no filter
  const set = new Set(allowed);
  return tools.filter(t =>
    t.bundle_ids.length === 0 || t.bundle_ids.some(id => set.has(id))
  );
}

// ── Load from DB and register ─────────────────────────────────
export async function loadDynamicTools(pool: pg.Pool): Promise<DynamicToolRow[]> {
  const { rows } = await pool.query<DynamicToolRow>(
    `SELECT t.*,
      COALESCE((SELECT array_agg(tb.bundle_id) FROM mcp_tool_bundles tb WHERE tb.tool_id = t.id), '{}') AS bundle_ids
     FROM mcp_tools t WHERE t.enabled = true ORDER BY t.category, t.name`
  );
  // Refresh the warm write-action set so the human-approval-gate can gate is_write tools
  // with no per-call query (buildToolList calls this at turn start, before any hook fires).
  writeToolNames.clear();
  for (const r of rows) {
    if ((r as DynamicToolRow & { is_write?: boolean }).is_write) writeToolNames.add(r.name);
  }
  return rows;
}

export function registerDynamicTool(
  server: McpServer,
  tool: DynamicToolRow,
  pool: pg.Pool,
  config: Config,
): void {
  const rawParams: ToolParameter[] =
    typeof tool.parameters === 'string' ? JSON.parse(tool.parameters) : tool.parameters;

  // F1: Sanitize DB-sourced strings before they reach the LLM (prompt injection prevention)
  const safeName = sanitizeToolName(tool.name);
  const safeDescription = sanitizeDescription(tool.description);
  warnIfSuspicious(safeName, safeDescription);

  const paramDefs: ToolParameter[] = rawParams.map(p => ({
    ...p,
    name: sanitizeToolName(p.name),
    description: sanitizeDescription(p.description, MAX_PARAM_DESCRIPTION_LENGTH),
  }));

  const inputSchema = buildInputSchema(paramDefs);

  server.tool(
    safeName,
    safeDescription,
    inputSchema,
    async (args) => {
      try {
        if (!tool.query_template) {
          return {
            content: [{ type: 'text' as const, text: `Error: Tool '${safeName}' has no query template` }],
            isError: true,
          };
        }
        let result: string;
        const callArgs = args as Record<string, unknown>;

        const customRef = parseCustomBackendRef(tool.backend);
        if (customRef) {
          const backend = findBackendByName(customRef);
          if (!backend) {
            return {
              content: [{ type: 'text' as const, text: `Custom backend '${customRef}' not found or disabled` }],
              isError: true,
            };
          }
          // HTTP backends: string interpolation (values go into URL/body, not SQL)
          const rendered = renderTemplate(tool.query_template, callArgs, paramDefs);
          const request = parseHttpRequestSpec(rendered);
          result = await executeCustomBackend(
            backend,
            request.method,
            request.target,
            request.body,
            tool.required_auth_mode ?? null,
            undefined,
            request.headers,
          );
        } else {
          if (tool.required_auth_mode && tool.required_auth_mode !== 'service-account') {
            throw new Error('User OAuth requires a configured custom backend; no service fallback was used');
          }
          switch (tool.backend) {
            case 'postgresql': {
              // Parameterized query — never interpolates user values into SQL string
              const { sql, values } = renderSqlTemplate(tool.query_template, callArgs, paramDefs);
              // F3: enforce row limit + statement timeout
              result = await executePg(pool, sql, values, {
                statementTimeoutMs: 10_000,
                maxRows: config.maxResultRows,
              });
              break;
            }
            case 'http': {
              const rendered = renderTemplate(tool.query_template, callArgs, paramDefs);
              result = await executeHttp(rendered);
              break;
            }
            default:
              return {
                content: [{ type: 'text' as const, text: `Unknown backend: ${tool.backend}` }],
                isError: true,
              };
          }
        }

        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err: unknown) {
        // Log full details server-side; return a generic message to the caller
        // to avoid leaking DB connection strings, SQL snippets, or internal paths.
        const internalMessage = err instanceof Error ? err.message : String(err);
        logger.error({ toolName: tool.name, err: internalMessage }, 'Dynamic tool execution error');
        const safeMessage = internalMessage.length < 120 && !/password|secret|key|host|connect/i.test(internalMessage)
          ? internalMessage
          : `Tool execution failed — check server logs for details`;
        return {
          content: [{ type: 'text' as const, text: `Error executing tool '${tool.name}': ${safeMessage}` }],
          isError: true,
        };
      }
    }
  );
}

export async function registerDynamicTools(
  server: McpServer,
  config: Config,
  allowedBundles?: number[] | null,
  allowedToolNames?: Set<string> | null,
): Promise<DynamicToolRow[]> {
  if (!config.postgresEnabled) {
    logger.info('Dynamic tools skipped - PostgreSQL not enabled');
    return [];
  }

  const pool = getPool(config.postgresConnectionUrl);

  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'mcp_tools'
      ) AS exists
    `);

    if (!tableCheck.rows[0].exists) {
      logger.info('Table mcp_tools does not exist - skipping. Run db/init.sql to enable.');
      return [];
    }

    const allTools = await loadDynamicTools(pool);
    // Built-ins are catalogued in the same table for Fabric/bundle policy,
    // but their handlers are registered by their owning module.
    const dynamicTools = allTools.filter(tool => tool.tool_type !== 'builtin');
    const tools = allowedToolNames
      ? dynamicTools.filter(tool => allowedToolNames.has(tool.name))
      : filterByBundles(dynamicTools, allowedBundles);
    logger.info({ total: dynamicTools.length, filtered: tools.length }, 'Dynamic tools loaded from database');

    for (const tool of tools) {
      registerDynamicTool(server, tool, pool, config);
      logger.info({ tool: tool.name, backend: tool.backend, category: tool.category }, 'Registered dynamic tool');
    }

    return tools;
  } catch (err) {
    logger.error({ err }, 'Failed to load dynamic tools');
    return [];
  }
}
