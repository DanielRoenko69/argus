import { logger } from '../lib/logger.js';
import pg from 'pg';
import { Agent } from 'undici';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { decrypt } from '../lib/encryption.js';
import { SENSITIVE_HEADER_PATTERN, resolveHeadersForUse } from './headerSecrets.js';
import { loadConfig } from '../config/env.js';
import { resolveBackendAuthentication, removeServiceCredentialHeaders, auditBackendAuthentication, type BackendAuthEvidence } from './backendAuthentication.js';

// ── SSRF Protection ───────────────────────────────────────────
// Block requests to internal/metadata endpoints from custom backends.
// Covers: loopback, RFC-1918, link-local (AWS/GCP/Azure IMDS), K8s DNS,
// IPv4-mapped IPv6, IPv6 unique-local and link-local.
const SSRF_DENYLIST = [
  // IPv4 loopback + unspecified
  /^https?:\/\/localhost(:\d+)?(\/|$)/i,
  /^https?:\/\/127\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/0\.0\.0\.0(:\d+)?(\/|$)/,
  // RFC-1918 private ranges
  /^https?:\/\/10\.\d+\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d+\.\d+(:\d+)?(\/|$)/,
  /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?(\/|$)/,
  // Link-local — covers AWS/GCP/Azure IMDS (169.254.169.254)
  /^https?:\/\/169\.254\.\d+\.\d+(:\d+)?(\/|$)/,
  // CGNAT (100.64.0.0/10) — may expose cloud internal services
  /^https?:\/\/100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+(:\d+)?(\/|$)/,
  // IPv6: loopback, unique-local, link-local, IPv4-mapped variants
  /^https?:\/\/\[::1\](:\d+)?(\/|$)/,
  /^https?:\/\/\[fc00:/i,
  /^https?:\/\/\[fd[0-9a-f]{2}:/i,              // fd00::/8 unique-local
  /^https?:\/\/\[fe80:/i,                        // link-local
  /^https?:\/\/\[::ffff:127\./i,                 // IPv4-mapped loopback
  /^https?:\/\/\[::ffff:169\.254\./i,            // IPv4-mapped IMDS
  // Cloud metadata hostnames (belt-and-suspenders)
  /^https?:\/\/metadata\.google\.internal(:\d+)?(\/|$)/i,
  // Kubernetes internal DNS
  /kubernetes\.default(\.svc(\.cluster\.local)?)?(:\d+)?(\/|$)/i,
];

// Optional allowlist via ENV. Erlaubt cluster-interne Service-DNS-Namen
// (z.B. "argus-develop-langgraph,argus-develop-langfuse-web") obwohl ihre IPs
// in RFC-1918-Ranges fallen. Hostname-Match nur, kein IP-Match — verhindert
// dass SSRF auf andere Pods via IP-Spoofing umgangen wird.
const SSRF_ALLOWLIST = (process.env['SSRF_ALLOWLIST_HOSTS'] ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

function safeUrlOriginForLog(url: string): string {
  try { return new URL(url).origin; }
  catch { return '[invalid-url]'; }
}

/**
 * Decode a numeric IPv4 host (decimal `2130706433` or hex `0x7f000001`) to its
 * dotted-quad form, so the denylist (which only matches dotted-quad) also
 * catches these encodings. Returns null for non-numeric hosts. (audit M6.)
 * NOTE: full DNS-rebinding defence — resolving a hostname and re-checking the
 * resolved IP — needs async DNS and is a separate follow-up.
 */
function decodeNumericIpv4(host: string): string | null {
  let n: number | null = null;
  if (/^\d+$/.test(host)) n = Number(host);
  else if (/^0x[0-9a-f]+$/i.test(host)) n = parseInt(host.slice(2), 16);
  if (n === null || !Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

/**
 * CIDR-based internal address set. Parsed by node:net, so every textual IPv6
 * form (compressed, IPv4-mapped `::ffff:10.0.0.1`, hex-mapped
 * `::ffff:a00:1`, IPv4-compatible) is matched instead of only the spellings a
 * regex anticipates. Ranges that embed or translate to IPv4 (NAT64, 6to4,
 * Teredo) are blocked as a whole because the embedded target is not checked.
 */
const INTERNAL_ADDRESSES = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    // IPv4-mapped (::ffff:a.b.c.d) addresses are matched against the IPv4
    // rules above by BlockList itself; a ::ffff:0:0/96 rule would match all IPv4.
    ['::', 96],            // unspecified, loopback and IPv4-compatible
    ['64:ff9b::', 96],     // NAT64 well-known prefix
    ['64:ff9b:1::', 48],   // local-use NAT64
    ['100::', 64],         // discard-only
    ['2001::', 32],        // Teredo
    ['2002::', 16],        // 6to4
    ['fc00::', 7],         // unique-local
    ['fe80::', 10],        // link-local
    ['fec0::', 10],        // deprecated site-local
    ['ff00::', 8],         // multicast
  ] as const) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/**
 * True if an IP literal is loopback / unspecified / RFC-1918 / link-local
 * (incl. IMDS 169.254.169.254) / CGNAT / reserved / IPv6 internal, including
 * IPv4-mapped and IPv4-embedding IPv6 forms. Non-IP input returns false.
 */
export function isPrivateOrInternalIp(ip: string): boolean {
  const unbracketed = ip.trim().replace(/^\[(.*)\]$/u, '$1');
  const withoutZone = unbracketed.split('%')[0] ?? unbracketed;
  const candidate = decodeNumericIpv4(withoutZone) ?? withoutZone;
  const family = isIP(candidate);
  if (family === 0) return false;
  return INTERNAL_ADDRESSES.check(candidate, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * Positive egress allowlist for outbound HTTP tool calls. Empty list = disabled
 * (allow all). When non-empty, the target host must equal an allowlisted entry
 * or be a subdomain of one. Independent of the SSRF denylist.
 */
export function isEgressAllowed(url: string, allowlist: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    return host === e || host.endsWith(`.${e}`);
  });
}

/** Throws if the URL is not permitted by the configured egress allowlist. */
export function assertEgressAllowed(url: string): void {
  const { egressAllowlist } = loadConfig();
  if (!isEgressAllowed(url, egressAllowlist)) {
    logger.warn({ origin: safeUrlOriginForLog(url) }, 'Egress blocked — host not in ARGUS_EGRESS_ALLOWLIST');
    throw new Error(`URL nicht erlaubt: Host nicht in der Egress-Allowlist`);
  }
}

type SsrfLookupFn = (host: string, opts: { all: true }) => Promise<Array<{ address: string }>>;

/**
 * DNS-rebinding-aware SSRF guard. Runs the synchronous string checks first,
 * then (for hostname targets) resolves the host and rejects if ANY resolved
 * address is private/internal. Honours SSRF_ALLOWLIST_HOSTS (exact host match).
 * The resolver is injectable for testing; production uses node:dns/promises.
 *
 * NOTE: this checks at validation time. Full TOCTOU connection-pinning (forcing
 * the socket to dial the validated IP) remains a tracked follow-up.
 */
export async function assertSsrfSafeResolved(
  url: string,
  lookupFn: SsrfLookupFn = lookup as unknown as SsrfLookupFn,
  options: { failClosedOnDnsError?: boolean } = {},
): Promise<void> {
  assertSsrfSafe(url); // sync denylist + numeric-IP layer (throws on literal private)

  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return; }

  // Already an IP literal → the sync layer fully covered it.
  if (/^[0-9.]+$/.test(host) || host.includes(':') || /^0x[0-9a-f]+$/i.test(host)) return;

  // Allowlisted internal service DNS names are intentionally permitted.
  if (SSRF_ALLOWLIST.length > 0 && SSRF_ALLOWLIST.some((a) => host === a.toLowerCase())) return;

  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookupFn(host, { all: true });
  } catch {
    if (options.failClosedOnDnsError) {
      throw new Error('URL could not be resolved safely');
    }
    // Compatibility mode for existing callers: let the actual fetch surface the network error.
    return;
  }
  for (const a of addrs) {
    if (isPrivateOrInternalIp(a.address)) {
      logger.warn({ origin: safeUrlOriginForLog(url), resolved: a.address }, 'SSRF blocked — hostname resolves to a private/internal IP');
      throw new Error(`URL nicht erlaubt: interne/private Adressen sind gesperrt`);
    }
  }
}

export function assertSsrfSafe(url: string): void {
  if (SSRF_ALLOWLIST.length > 0) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (SSRF_ALLOWLIST.some(allowed => host === allowed.toLowerCase())) {
        return;
      }
    } catch { /* invalid URL — fall through to denylist */ }
  }
  for (const pattern of SSRF_DENYLIST) {
    if (pattern.test(url)) {
      logger.warn({ origin: safeUrlOriginForLog(url) }, 'SSRF attempt blocked — URL matches denylist');
      throw new Error(`URL nicht erlaubt: interne/private Adressen sind gesperrt`);
    }
  }
  // audit M6: the denylist above matches the RAW url string, so encoded-IP
  // hosts (decimal http://2130706433, hex http://0x7f000001) slip through.
  // Node's URL parser already normalises those to dotted-quad in .hostname, so
  // re-run the denylist against the normalised host (plus an explicit numeric
  // decode as a belt-and-suspenders fallback).
  let parsedHost: string | null = null;
  try { parsedHost = new URL(url).hostname.toLowerCase(); } catch { parsedHost = null; }
  if (parsedHost) {
    const candidate = decodeNumericIpv4(parsedHost) ?? parsedHost;
    if (SSRF_DENYLIST.some(p => p.test(`http://${candidate}/`)) || isPrivateOrInternalIp(candidate)) {
      logger.warn({ origin: safeUrlOriginForLog(url), candidate }, 'SSRF attempt blocked — host resolves to a denied address');
      throw new Error(`URL nicht erlaubt: interne/private Adressen sind gesperrt`);
    }
  }
}

const { Pool } = pg;

// ── DB row shape ──────────────────────────────────────────────

export interface CustomBackendRow {
  id: number;
  name: string;
  description: string;
  base_url: string;
  auth_type: 'none' | 'bearer' | 'basic' | 'header';
  auth_value: string | null;
  health_path: string | null;
  default_headers: Record<string, string>;
  timeout_ms: number;
  tls_skip_verify: boolean;
  enabled: boolean;
  backend_type: 'http' | 'mcp' | 'builtin';
  mcp_endpoint: string | null;
  transport_type: 'streamable-http' | 'sse';  // MCP transport protocol
  builtin_key: string | null;  // legacy column, no longer used
  // Upstream Token Exchange (migration 086 + 087)
  auth_mode: 'service-account' | 'permissive' | 'strict';
  oauth_authorize_url: string | null;
  oauth_token_url: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_scopes: string[] | null;
  oauth_revoke_url: string | null;
  config: Record<string, unknown>;  // backend-specific config JSONB
  bundle_id: number | null;   // legacy single FK (deprecated, use bundle_ids)
  bundle_ids: number[];       // n:m via mcp_backend_bundles
  created_at: string;
  updated_at: string;
}

// ── In-memory cache of custom backends ────────────────────────

let cachedBackends: CustomBackendRow[] = [];
let cachedAllBackends: CustomBackendRow[] = [];

export function getCustomBackends(): CustomBackendRow[] {
  return cachedBackends;
}

/** Get all custom backends including disabled ones (for dashboard/status). */
export function getAllCustomBackends(): CustomBackendRow[] {
  return cachedAllBackends;
}

export function setCustomBackends(backends: CustomBackendRow[]): void {
  cachedBackends = backends;
}

export function setAllCustomBackends(backends: CustomBackendRow[]): void {
  cachedAllBackends = backends;
}

// ── Load from DB ──────────────────────────────────────────────

export async function loadCustomBackends(pool: pg.Pool): Promise<CustomBackendRow[]> {
  try {
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables WHERE table_name = 'mcp_backends'
      ) AS exists
    `);
    if (!tableCheck.rows[0].exists) return [];

    const { rows } = await pool.query<CustomBackendRow>(
      `SELECT b.*,
        COALESCE((SELECT array_agg(bb.bundle_id) FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id), '{}') AS bundle_ids
       FROM mcp_backends b WHERE b.enabled = true ORDER BY b.name`
    );
    return rows;
  } catch (err) {
    logger.error({ err }, 'Failed to load custom backends');
    return [];
  }
}

export async function loadAllCustomBackends(pool: pg.Pool): Promise<CustomBackendRow[]> {
  const { rows } = await pool.query<CustomBackendRow>(
    `SELECT b.*,
      COALESCE((SELECT array_agg(bb.bundle_id) FROM mcp_backend_bundles bb WHERE bb.backend_id = b.id), '{}') AS bundle_ids
     FROM mcp_backends b ORDER BY b.name`
  );
  return rows;
}

// ── Build auth headers for a backend ──────────────────────────

/**
 * Backend-bound workflow reference. Legacy raw overrides apply only to explicit
 * service-account calls; they never bypass user OAuth. Never persist raw tokens.
 */
export interface CredOverride {
  token: string | null;
  backendId?: number;
}

function resolveBackendAuthValue(backend: CustomBackendRow, credOverride?: CredOverride): string | null {
  return (credOverride && credOverride.token != null)
    ? credOverride.token
    : (decrypt(backend.auth_value) ?? backend.auth_value);
}

export function buildAuthHeaders(backend: CustomBackendRow, credOverride?: CredOverride): Record<string, string> {
  const headers: Record<string, string> = resolveHeadersForUse(backend.default_headers);
  const authValue = resolveBackendAuthValue(backend, credOverride);

  switch (backend.auth_type) {
    case 'bearer':
      if (authValue) headers['Authorization'] = `Bearer ${authValue}`;
      break;
    case 'basic':
      if (authValue) headers['Authorization'] = `Basic ${Buffer.from(authValue).toString('base64')}`;
      break;
    case 'header':
      if (authValue) {
        const colonIdx = authValue.indexOf(':');
        if (colonIdx > 0) {
          headers[authValue.slice(0, colonIdx).trim()] = authValue.slice(colonIdx + 1).trim();
        }
      }
      break;
  }

  return headers;
}

function backendCredentialRedactions(backend: CustomBackendRow, credOverride?: CredOverride): string[] {
  const value = resolveBackendAuthValue(backend, credOverride);
  if (!value) return [];
  if (backend.auth_type === 'header') {
    const separator = value.indexOf(':');
    return separator > 0 ? [value, value.slice(separator + 1).trim()] : [value];
  }
  if (backend.auth_type === 'basic') {
    const encoded = Buffer.from(value).toString('base64');
    return [value, encoded, `Basic ${encoded}`];
  }
  if (backend.auth_type === 'bearer') return [value, `Bearer ${value}`];
  return [];
}

// ── Per-backend TLS dispatcher ────────────────────────────────

/** Returns a fetch dispatcher that skips TLS verification for this backend. */
function buildDispatcher(backend: CustomBackendRow): { dispatcher: Agent } | Record<string, never> {
  if (!backend.tls_skip_verify) return {};
  // M4: Block tls_skip_verify in production — MITM risk
  if (process.env.NODE_ENV === 'production') {
    logger.error({ backend: backend.name }, 'tls_skip_verify=true is not allowed in production (NODE_ENV=production) — rejecting request');
    throw new Error(`Backend '${backend.name}': TLS verification cannot be disabled in production.`);
  }
  logger.warn({ backend: backend.name }, 'TLS verification disabled for backend (tls_skip_verify=true) — do not use in production');
  return {
    dispatcher: new Agent({ connect: { rejectUnauthorized: false } }),
  };
}

// ── Execute HTTP request against a custom backend ─────────────

export interface CustomBackendResponse {
  status: number;
  statusText: string;
  contentType: string;
  body: string;
  truncated: boolean;
  durationMs: number;
  authentication: BackendAuthEvidence;
}

interface CustomBackendFetchResult {
  response: Response;
  startedAt: number;
  sensitiveValues: string[];
  authentication: BackendAuthEvidence;
}

const ABSOLUTE_MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

export function getCustomBackendResponseLimit(): number {
  const configured = Number(loadConfig().maxResultSizeBytes);
  if (!Number.isFinite(configured)) return 512 * 1_024;
  return Math.max(1_024, Math.min(Math.trunc(configured), ABSOLUTE_MAX_RESPONSE_BYTES));
}

/**
 * Resolve a relative capability target exactly as the runtime executor does.
 * Exported so admin previews cannot drift from the URL that will be executed.
 */
export function resolveCustomBackendTarget(backend: CustomBackendRow, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Custom backend path must start with a single /');
  const base = new URL(backend.base_url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Custom backend base URL is invalid');
  }
  const basePath = base.pathname.replace(/\/$/, '');
  const target = new URL(`${base.origin}${basePath}${path}`);
  if (target.origin !== base.origin) throw new Error('Custom backend path cannot change the configured origin');
  return target.toString();
}

/** Validate the fully resolved runtime target without sending a request. */
export async function assertCustomBackendTargetSafe(backend: CustomBackendRow, path: string): Promise<string> {
  const url = resolveCustomBackendTarget(backend, path);
  await assertSsrfSafeResolved(url, lookup as unknown as SsrfLookupFn, { failClosedOnDnsError: true });
  assertEgressAllowed(url);
  return url;
}

async function fetchCustomBackend(
  backend: CustomBackendRow,
  method: string,
  path: string,
  body?: string,
  requiredAuthModeOverride?: 'service-account' | 'permissive' | 'strict' | null,
  credOverride?: CredOverride,
  requestHeaders: Record<string, string> = {},
): Promise<CustomBackendFetchResult> {
  const url = await assertCustomBackendTargetSafe(backend, path);
  const authentication = await resolveBackendAuthentication(backend, requiredAuthModeOverride, credOverride);
  // Do not decrypt or construct service credentials when using delegated identity.
  const headers = authentication.authorization ? resolveHeadersForUse(backend.default_headers) : buildAuthHeaders(backend, credOverride);
  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalized = name.toLowerCase();
    if (SENSITIVE_HEADER_PATTERN.test(name) || normalized === 'host'
      || normalized === 'content-length' || normalized === 'connection' || normalized === 'transfer-encoding') {
      throw new Error(`Per-request header is not allowed: ${name}`);
    }
    headers[name] = value;
  }

  if (authentication.authorization) {
    removeServiceCredentialHeaders(headers);
    headers['Authorization'] = authentication.authorization;
  }

  // K8s-Impersonation: when enabled in Platform-Config AND backend is K8s-flavored
  // (URL contains /api/v1 oder /apis/), merge Impersonate-User / -Group headers
  // pro current calling user. K8s-RBAC entscheidet dann auf User-Identity statt
  // Argus's Service-Account.
  try {
    const { getK8sImpersonationConfig, buildImpersonationHeaders } = await import('../lib/platformConfig.js');
    const k8sCfg = getK8sImpersonationConfig();
    if (k8sCfg.enabled && (url.includes('/api/v1') || url.includes('/apis/') || backend.builtin_key === 'k8s')) {
      const { getCurrentCallingUser } = await import('../lib/requestContext.js');
      const user = getCurrentCallingUser();
      if (user) {
        const impHeaders = buildImpersonationHeaders({
          username: user.username,
          email: user.email,
          role: user.role,
        });
        Object.assign(headers, impHeaders);
      }
    }
  } catch {
    // Fail-open — impersonation is enhancement, not gating
  }

  const fetchOptions: RequestInit & { dispatcher?: Agent } = {
    method,
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(backend.timeout_ms),
    ...buildDispatcher(backend),
  };

  if (body && method !== 'GET' && method !== 'HEAD') {
    fetchOptions.body = body;
    if (!headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const sensitiveValues = [
    ...(authentication.authorization ? [] : backendCredentialRedactions(backend, credOverride)),
    ...Object.entries(headers)
    .filter(([name, value]) => SENSITIVE_HEADER_PATTERN.test(name) && value.length > 0)
    .flatMap(([, value]) => {
      const withoutScheme = value.replace(/^(?:Bearer|Basic)\s+/i, '');
      return withoutScheme === value ? [value] : [value, withoutScheme];
    }),
  ];
  const startedAt = Date.now();
  auditBackendAuthentication(authentication.evidence);
  const response = await fetch(url, fetchOptions as RequestInit);
  return { response, startedAt, sensitiveValues, authentication: authentication.evidence };
}

function maskSensitiveValues(value: string, sensitiveValues: string[]): string {
  let masked = value;
  for (const secret of [...new Set(sensitiveValues)].sort((left, right) => right.length - left.length)) {
    // Tiny strings create excessive false positives and are not useful credentials.
    if (secret.length >= 4) masked = masked.replaceAll(secret, '[REDACTED]');
  }
  return masked;
}

async function readBodyLimited(response: Response, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  // The fallback mainly supports small mocked/non-standard Response objects;
  // Node's production fetch always exposes a stream, which is capped while reading.
  if (!response.body) {
    const raw = typeof response.text === 'function' ? await response.text() : '';
    const bytes = Buffer.from(raw);
    return {
      body: bytes.subarray(0, maxBytes).toString('utf8'),
      truncated: bytes.byteLength > maxBytes,
    };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const remaining = maxBytes - size;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        size += remaining;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { body: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8'), truncated };
}

/**
 * Execute through the normal custom-backend security/auth path while returning
 * a byte-capped response suitable for the privileged Capability Playground.
 */
export async function executeCustomBackendStructured(
  backend: CustomBackendRow,
  method: string,
  path: string,
  body?: string,
  requiredAuthModeOverride?: 'service-account' | 'permissive' | 'strict' | null,
  credOverride?: CredOverride,
  requestHeaders: Record<string, string> = {},
  options: { maxResponseBytes?: number; redactValues?: string[] } = {},
): Promise<CustomBackendResponse> {
  const maxResponseBytes = Math.max(1_024, Math.min(
    options.maxResponseBytes ?? getCustomBackendResponseLimit(),
    ABSOLUTE_MAX_RESPONSE_BYTES,
  ));
  const result = await fetchCustomBackend(
    backend,
    method,
    path,
    body,
    requiredAuthModeOverride,
    credOverride,
    requestHeaders,
  );
  const limited = await readBodyLimited(result.response, maxResponseBytes);
  const maskedBody = maskSensitiveValues(limited.body, [
    ...result.sensitiveValues,
    ...(options.redactValues ?? []),
  ]);
  const maskedBytes = Buffer.from(maskedBody);
  return {
    status: result.response.status,
    statusText: result.response.statusText,
    contentType: result.response.headers.get('content-type') ?? '',
    body: maskedBytes.subarray(0, maxResponseBytes).toString('utf8'),
    truncated: limited.truncated || maskedBytes.byteLength > maxResponseBytes,
    durationMs: Math.max(0, Date.now() - result.startedAt),
    authentication: result.authentication,
  };
}

export async function executeCustomBackend(
  backend: CustomBackendRow,
  method: string,
  path: string,
  body?: string,
  requiredAuthModeOverride?: 'service-account' | 'permissive' | 'strict' | null,
  credOverride?: CredOverride,
  requestHeaders: Record<string, string> = {},
): Promise<string> {
  const result = await executeCustomBackendStructured(
    backend,
    method,
    path,
    body,
    requiredAuthModeOverride,
    credOverride,
    requestHeaders,
    { maxResponseBytes: getCustomBackendResponseLimit() },
  );
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Upstream service returned HTTP ${result.status} ${result.statusText}`.trim());
  }

  if (backend.config?.['response_contract'] === 'slack-web-api') {
    let payload: unknown;
    try {
      payload = JSON.parse(result.body);
    } catch {
      payload = null;
    }
    if (payload && typeof payload === 'object' && (payload as Record<string, unknown>)['ok'] === false) {
      const rawCode = (payload as Record<string, unknown>)['error'];
      const safeCode = typeof rawCode === 'string' && /^[a-z0-9_-]{1,80}$/i.test(rawCode)
        ? rawCode
        : 'provider_error';
      throw new Error(`Slack API rejected request: ${safeCode}`);
    }
  }
  return `HTTP ${result.status} ${result.statusText}\n\n${result.body}`;
}

// ── Health check for a custom backend ─────────────────────────

export async function checkCustomBackend(backend: CustomBackendRow): Promise<{
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}> {
  if (!backend.health_path) {
    return { reachable: true, latencyMs: null, error: null };
  }

  try {
    const url = `${backend.base_url.replace(/\/$/, '')}${backend.health_path}`;
    assertSsrfSafe(url);
    const headers = buildAuthHeaders(backend);
    const start = Date.now();

    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(Math.min(backend.timeout_ms, 5000)),
      ...buildDispatcher(backend),
    } as RequestInit);

    const latencyMs = Date.now() - start;

    if (!res.ok) {
      return { reachable: false, latencyMs, error: `HTTP ${res.status} ${res.statusText}` };
    }

    return { reachable: true, latencyMs, error: null };
  } catch (err) {
    return {
      reachable: false,
      latencyMs: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Parse "custom:<backend-name>" from tool's backend field ───

export function parseCustomBackendRef(backend: string): string | null {
  if (backend.startsWith('custom:')) {
    return backend.slice(7);
  }
  return null;
}

export function findBackendByName(name: string): CustomBackendRow | undefined {
  return cachedBackends.find(b => b.name === name);
}
