/**
 * PII Redaction Engine (v1 — regex + allowlist).
 *
 * Applied at the boundary BEFORE content reaches the Langfuse SDK:
 *   - src/lib/langfuseTracing.ts wraps every trace/span/generation
 *   - provider/agent observability redacts request/response
 *
 * Detectors are deterministic regex with conservative patterns. The
 * allowlist short-circuits known-safe substrings (ticket IDs, test
 * fixtures, code paths) so they don't get mangled.
 *
 * Runtime settings come from mcp_platform_settings (cached) with env-var
 * fallback. To force-reload after an admin UI toggle, call
 * `invalidateRedactionCache()`.
 *
 * v2 (Phase 7) adds an LLM-based fallback for contextual PII the regex
 * layer can't catch (names, address blocks). Plan:
 * internal design notes (not published)
 */

import type pg from 'pg';
import { logger } from './logger.js';

// ─── Detector catalogue ────────────────────────────────────────────────────

export type DetectorName =
  | 'email'
  | 'phone'
  | 'iban'
  | 'cc'
  | 'k8s_token'
  | 'git_token'
  | 'bearer'
  | 'azure_key'
  | 'aws_key'
  | 'argus_key'
  | 'password'
  | 'empid';

interface Detector {
  name: DetectorName;
  re: RegExp;
  replace: string | ((m: string) => string);
  /** Optional validator (e.g. Luhn for credit cards) — if false, skip this match. */
  validate?: (m: string) => boolean;
}

const luhn = (s: string): boolean => {
  const digits = s.replace(/\D/g, '').split('').map(Number);
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let even = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits[i]!;
    if (even) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    even = !even;
  }
  return sum % 10 === 0;
};

// IMPORTANT: order matters — more-specific patterns first so they win
// over generic catch-alls (e.g. argus_key before bearer).
const DETECTORS: Detector[] = [
  { name: 'email',     re: /[\w.+-]+@[\w-]+\.[\w.-]+/g,                                       replace: '[EMAIL]' },
  { name: 'k8s_token', re: /eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_.-]+/g,                          replace: '[K8S_TOKEN]' },
  { name: 'git_token', re: /\bgh[ps]_[A-Za-z0-9]{30,}\b/g,                                   replace: '[GIT_TOKEN]' },
  { name: 'aws_key',   re: /\b(?:AKIA|ASIA|AROA)[A-Z0-9]{16}\b/g,                            replace: '[AWS_KEY]' },
  { name: 'argus_key', re: /\bak_[a-zA-Z0-9]{16,}\b/g,                                       replace: '[ARGUS_KEY]' },
  { name: 'bearer',    re: /Bearer\s+[A-Za-z0-9._~+/-]{20,}/g,                               replace: 'Bearer [REDACTED]' },
  { name: 'iban',      re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,                              replace: '[IBAN]' },
  {
    name: 'cc',
    // Loose digit pattern; Luhn validates.
    re: /\b(?:\d[ -]?){13,19}\b/g,
    replace: '[CC]',
    validate: luhn,
  },
  { name: 'azure_key', re: /\b[A-Za-z0-9+/]{86}==\b/g,                                       replace: '[AZURE_KEY]' },
  // password=... — case-insensitive, halts at whitespace/quote/comma
  { name: 'password',  re: /(?:^|\b)([Pp]assword|PASSWORD|PASS|pwd)\s*[=:]\s*[^\s'",;)]+/g,  replace: (m) => m.replace(/[=:]\s*[^\s'",;)]+/, (suffix) => suffix.replace(/[^=:\s]+$/, '[REDACTED]')) },
  // Phone — must have at least one separator (space/dash/dot/slash/paren).
  // Pure digit runs are NOT phones (they're IDs/hashes/CCs/PG IDs).
  // Pattern: optional +CC, area code, separator, subscriber number(s).
  {
    name: 'phone',
    re: /(?:\+\d{1,3}[\s./-]?)?\(?\d{2,5}\)?[\s./-]\d{2,12}(?:[\s./-]\d{1,8})*/g,
    replace: '[PHONE]',
    validate: (m) => {
      const d = m.replace(/\D/g, '').length;
      return d >= 8 && d <= 15;
    },
  },
  // Optional employee-id pattern used by enterprise deployments (TEST123, ...)
  { name: 'empid',     re: /\b[A-Z]{4}\d{3}\b/g,                                             replace: '[EMPID]' },
];

const DETECTOR_BY_NAME = new Map<DetectorName, Detector>(DETECTORS.map(d => [d.name, d]));

// ─── Allowlist ─────────────────────────────────────────────────────────────
// Substrings/patterns that should NEVER be redacted, even if a detector
// would match. Applied via "carve-out": we mask allowlisted ranges before
// running detectors, then restore them.

const ALLOWLIST_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, // Operational UUIDs (trace, task and thread IDs)
  /\b(?:CONS|ARGUS|JIRA|PROJ|TICK)-\d+\b/g,                          // Ticket IDs
  /\/workspace\/(?:ARGUS-\d+|argus|argus-[\w-]+|fizzbuzz|leven|calc-app|restricted)\b/g, // Known workspace dirs
  /\btest-api-key-\d+\b/g,                                            // Test fixtures
  /\bclaude-(?:opus|sonnet|haiku)-\d+(?:-\d+)?\b/g,                  // Model IDs (haiku could match empid pattern)
  /\bgpt-\d+(?:\.\d+)?(?:-[a-z]+)?\b/g,
  /\btext-embedding-3-(?:small|large)\b/g,
  /https?:\/\/[\w.-]+(?::\d+)?(?:\/[^\s]*)?/g,                       // URLs (the path could contain user IDs but full URL stays)
  /\b[A-Z]{4}\d{3}_(?:test|fixture|dev)\b/g,                         // Test EMPID variants
];

// ─── Runtime settings (DB-backed + env fallback) ──────────────────────────

interface RedactionSettings {
  enabled: boolean;
  detectors: Set<DetectorName>;
  logLevel: 'silent' | 'count' | 'verbose';
  ts: number;
}

const SETTINGS_TTL_MS = 30_000;
let _cache: RedactionSettings | null = null;
let _pool: pg.Pool | null = null;

const DEFAULT_DETECTORS: DetectorName[] =
  (process.env['PII_REDACTION_DETECTORS'] || 'email,phone,iban,cc,k8s_token,git_token,bearer,azure_key,aws_key,argus_key,password,empid')
    .split(',').map(s => s.trim()).filter(s => s.length) as DetectorName[];

function envDefaults(): RedactionSettings {
  return {
    enabled:   process.env['PII_REDACTION_ENABLED'] !== '0',
    detectors: new Set(DEFAULT_DETECTORS),
    logLevel:  (process.env['PII_REDACTION_LOG_LEVEL'] as RedactionSettings['logLevel']) ?? 'count',
    ts:        Date.now(),
  };
}

export function setRedactionPool(pool: pg.Pool): void { _pool = pool; }

export function invalidateRedactionCache(): void { _cache = null; }

async function loadSettings(): Promise<RedactionSettings> {
  if (_cache && Date.now() - _cache.ts < SETTINGS_TTL_MS) return _cache;
  const fallback = envDefaults();
  if (!_pool) { _cache = fallback; return fallback; }

  try {
    // value column is JSONB — pg driver auto-parses to JS values
    const { rows } = await _pool.query<{ key: string; value: unknown }>(
      `SELECT key, value FROM mcp_platform_settings WHERE category = 'pii_redaction'`,
    );
    const settings: RedactionSettings = { ...fallback };
    for (const r of rows) {
      if (r.key === 'enabled') {
        settings.enabled = r.value === true || r.value === 'true';
      } else if (r.key === 'detectors' && Array.isArray(r.value)) {
        settings.detectors = new Set(r.value as DetectorName[]);
      } else if (r.key === 'log_level' && typeof r.value === 'string') {
        settings.logLevel = r.value as RedactionSettings['logLevel'];
      }
    }
    settings.ts = Date.now();
    _cache = settings;
    return settings;
  } catch (err) {
    logger.warn({ err }, 'redaction: failed to load settings from DB, falling back to env');
    _cache = fallback;
    return fallback;
  }
}

export function isRedactionEnabledSync(): boolean {
  // Best-effort sync read for hot paths; the actual gating decision is
  // re-checked async inside redact() via loadSettings().
  return _cache?.enabled ?? envDefaults().enabled;
}

// ─── Allowlist carve-out ──────────────────────────────────────────────────

interface CarveRange { start: number; end: number; }

function findAllowlistRanges(text: string): CarveRange[] {
  const ranges: CarveRange[] = [];
  for (const pat of ALLOWLIST_PATTERNS) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(text)) !== null) {
      ranges.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) pat.lastIndex++; // avoid infinite loop
    }
  }
  // Sort + merge overlapping ranges
  ranges.sort((a, b) => a.start - b.start);
  const merged: CarveRange[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  return merged;
}

function inAllowlist(idx: number, len: number, ranges: CarveRange[]): boolean {
  // Match is in allowlist if it overlaps any safe range
  const matchEnd = idx + len;
  for (const r of ranges) {
    if (r.start <= idx && r.end >= matchEnd) return true; // fully inside
    if (r.start < matchEnd && r.end > idx) return true;   // overlaps
  }
  return false;
}

// ─── Core redaction ───────────────────────────────────────────────────────

export interface RedactionResult {
  text: string;
  found: Partial<Record<DetectorName, number>>;
}

export interface RedactOptions {
  /** Override active detector set; defaults to runtime settings. */
  detectors?: Set<DetectorName>;
  /** Force on/off independent of settings (for tests). */
  forceEnabled?: boolean;
}

/**
 * Synchronous redact. Uses the most-recently-loaded settings (cached).
 * If no settings have been loaded yet, falls back to env defaults.
 */
export function redact(text: string, opts: RedactOptions = {}): RedactionResult {
  if (typeof text !== 'string' || text.length === 0) return { text: text ?? '', found: {} };

  const enabled = opts.forceEnabled ?? _cache?.enabled ?? envDefaults().enabled;
  if (!enabled) return { text, found: {} };

  const activeSet = opts.detectors ?? _cache?.detectors ?? new Set(DEFAULT_DETECTORS);
  const allowRanges = findAllowlistRanges(text);
  const found: Partial<Record<DetectorName, number>> = {};
  let out = text;

  for (const d of DETECTORS) {
    if (!activeSet.has(d.name)) continue;
    d.re.lastIndex = 0;
    // String.prototype.replace callback for a regex WITHOUT capture groups:
    //   (match, offset, fullString) — for regex WITH groups, groups come
    //   between match and offset. None of our detectors use groups, so the
    //   second arg is the offset. (Note: 'password' detector uses lookahead-
    //   style replace internally but no capture-groups in its source regex.)
    out = out.replace(d.re, (match: string, offsetArg: unknown) => {
      const offset = typeof offsetArg === 'number' ? offsetArg : 0;
      if (d.validate && !d.validate(match)) return match;
      if (inAllowlist(offset, match.length, allowRanges)) return match;
      found[d.name] = (found[d.name] ?? 0) + 1;
      return typeof d.replace === 'function' ? d.replace(match) : d.replace;
    });
  }

  return { text: out, found };
}

/**
 * Recursively walk a JSON-like value and redact every string leaf.
 * Keys are NOT redacted (they're operator-controlled).
 * Counters are merged across all leaves.
 */
export function redactJson<T>(value: T, opts: RedactOptions = {}): { value: T; found: Partial<Record<DetectorName, number>> } {
  const merged: Partial<Record<DetectorName, number>> = {};

  const walk = (v: unknown): unknown => {
    if (v === null || v === undefined) return v;
    if (typeof v === 'string') {
      const r = redact(v, opts);
      for (const [k, n] of Object.entries(r.found)) {
        merged[k as DetectorName] = (merged[k as DetectorName] ?? 0) + (n as number);
      }
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };

  return { value: walk(value) as T, found: merged };
}

/**
 * Combine two `found` counters. Useful when redacting multiple fields
 * (input, output) and aggregating for a single trace.
 */
export function mergeFoundCounters(
  a: Partial<Record<DetectorName, number>>,
  b: Partial<Record<DetectorName, number>>,
): Partial<Record<DetectorName, number>> {
  const out: Partial<Record<DetectorName, number>> = { ...a };
  for (const [k, n] of Object.entries(b)) {
    out[k as DetectorName] = (out[k as DetectorName] ?? 0) + (n as number);
  }
  return out;
}

/**
 * Format `found` for trace metadata: hides empty counters.
 * Returns null when nothing matched (don't attach noise to traces).
 */
export function summarizeFound(
  found: Partial<Record<DetectorName, number>>,
): { total: number; byDetector: Partial<Record<DetectorName, number>> } | null {
  let total = 0;
  for (const n of Object.values(found)) total += n as number;
  if (total === 0) return null;
  return { total, byDetector: found };
}

// Eager-load settings if a pool was attached.
export async function ensureSettingsLoaded(): Promise<RedactionSettings> {
  return loadSettings();
}

// Detector list export for the admin UI dropdown.
export function listDetectors(): DetectorName[] {
  return DETECTORS.map(d => d.name);
}

// Hot-reload helper for tests: replace runtime cache directly.
export function _setRedactionCacheForTest(s: Partial<RedactionSettings> & { enabled: boolean }): void {
  _cache = {
    enabled:   s.enabled,
    detectors: s.detectors ?? new Set(DEFAULT_DETECTORS),
    logLevel:  s.logLevel ?? 'count',
    ts:        Date.now(),
  };
}
