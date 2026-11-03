import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  attachSolutionPackTokenFiles,
  parseSolutionPackEndpoints,
  type SolutionPackEndpoint,
} from '../solutionPacks/discovery.js';

export interface Config {
  auditLogRetentionDays: number;
  auditEvidenceV1Enabled: boolean;
  auditCheckpointIntervalSec: number;
  auditOutboxLagAlertSec: number;
  auditReportWorkerIntervalSec: number;
  mcpFabricProfileDriftIntervalSec: number;
  repositoryGraphEnabled: boolean;
  port: number;
  apiKeys: string[];

  // PostgreSQL (internal DB for tools, backends, audit, etc.)
  postgresEnabled: boolean;
  postgresConnectionUrl: string;

  // Rate limiting
  rateLimitPerMinute: number;

  // Query result limits
  maxResultRows: number;
  maxResultSizeBytes: number;

  // Dynamic tools
  dynamicToolsPollIntervalSec: number;

  // Session / Auth
  sessionSecret: string;
  sessionMaxAgeHours: number;

  // OAuth 2.0 (optional �?? API-level Bearer token validation)
  oauth2Enabled: boolean;
  oauth2Issuer: string;
  oauth2Audience: string;
  oauth2JwksUri: string;

  // Entra ID SSO (optional �?? browser-based login via Microsoft)
  entraSsoEnabled: boolean;
  entraTenantId: string;
  entraClientId: string;
  entraClientSecret: string;
  entraRedirectUri: string;
  entraDefaultRole: string;          // ArgusRole, default 'viewer'
  entraGroupMap: Record<string, string>; // AD group ObjectID �?? ArgusRole
  entraEmergencyLocalAdmin: boolean; // local admins still work even when SSO is active
  entraDisableLocalLogin: boolean;   // set true to go SSO-only (keep emergency admin!)

  // Provider-neutral interactive OIDC. The Entra preset populates these values
  // from the ENTRA_* settings; OIDC_SSO_ENABLED selects explicit generic values.
  oidcSsoEnabled: boolean;
  oidcProvider: 'entra' | 'generic_oidc';
  oidcProviderName: string;
  /** User-facing IdP page for enrolling or changing MFA factors. */
  oidcAccountManagementUrl: string;
  /** Optional administrator-facing IdP policy console. */
  oidcAdminConsoleUrl: string;
  oidcAuthorizationUrl: string;
  oidcTokenUrl: string;
  oidcIssuer: string;
  oidcJwksUri: string;
  oidcClientId: string;
  oidcClientSecret: string;
  oidcRedirectUri: string;
  oidcScopes: string;
  oidcSubjectClaim: string;
  oidcEmailClaim: string;
  oidcDisplayNameClaim: string;
  oidcGroupsClaim: string;
  oidcDefaultRole: string;
  oidcGroupMap: Record<string, string>;
  /** Signed ID-token amr values accepted as MFA evidence. */
  oidcMfaAmrValues: string[];
  /** Signed ID-token acr values accepted as MFA evidence and requested during step-up. */
  oidcMfaAcrValues: string[];
  /** Maximum age of auth_time for a sensitive-operation step-up. */
  oidcMfaMaxAgeSeconds: number;

  // Premium workforce federation for human-facing backend consoles. This is
  // intentionally independent from machine credentials used by workflows.
  backendSsoEnabled: boolean;
  backendSsoAllowedOrigins: string[];

  // Entra ID Agent Identity (mig 081) — per-agent Service Principal provisioning
  entraAgentRegistration: boolean;     // master flag; false in dev/local
  entraSidecarUrl: string;             // typically http://localhost:5000 (in-pod sidecar)
  entraEnvSlug: string;                // 'test' | 'prod' — used in SP displayName
  entraBlueprintMap: Record<string, string>; // agent_role -> blueprint_id, parsed from JSON env

  // Local password-based login (can be disabled when SSO-only)
  localAuthEnabled: boolean;

  // Redis Cache (optional)
  redisEnabled: boolean;
  redisUrl: string;
  redisCacheTtlSec: number;
  redisCacheNamespace: string;

  // LangSmith observability (optional)
  langsmithApiKey: string;
  langsmithBaseUrl: string;

  // Qdrant Knowledge Store (optional)
  qdrantUrl: string;
  qdrantApiKey: string;

  // Sec-Härtung Phase 1 (2026-05-27)
  prodApprovalEnforce: boolean;
  rbacEnforce: boolean;
  maxAgentSessionSeconds: number;
  egressAllowlist: string[];
  piiMlEnabled: boolean;
  piiMlUrl: string;
  piiMlThreshold: number;
  piiMlEntities: string[];
  piiMlLanguage: string;

  // Public Widget (Phase 3 — default off)
  publicWidgetEnabled: boolean;
  shareLinksEnabled: boolean;
  widgetTokenSecret: string;    // derived from SESSION_SECRET when unset
  widgetTokenTtlSec: number;
  turnstileEnabled: boolean;
  turnstileSecret: string;
  trustProxyHops: number;

  // Chat SPA (argus-chat-ui — default off)
  chatSpaEnabled: boolean;

  // AI interaction transparency — default on for interactive agent surfaces
  aiTransparencyNoticeEnabled: boolean;
  aiTransparencyNoticeText: string;

  // Out-of-process Solution Packs discovered from operator-controlled endpoints.
  solutionPackEndpoints: SolutionPackEndpoint[];
  solutionPackCoreVersion: string;
  solutionPackDiscoveryTimeoutMs: number;
  solutionPackRefreshSec: number;
  solutionPackExecutionGrantSecret: string;
  /** Operator-controlled internal origin used only by per-run MCP proxies. Empty disables managed runtimes. */
  runtimeMcpOrigin: string;
  /** Explicit V1 allow-list; remote MCP tools do not yet have universal write metadata. */
  managedRuntimeReadOnlyBundleIds: number[];

  // Delayed verification of successful AIOps provider changes.
  aiopsPostChangeMonitorDelaySec: number;
  aiopsPostChangeMonitorPollSec: number;
  // Age after which an in-progress provider operation is reconciled read-only.
  aiopsRemediationReconcileStaleSec: number;
}

/** Parse ENTRA_GROUP_MAP="objectId1:platform_admin,objectId2:operations_admin" */
function parseEntraGroupMap(raw: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep < 1) continue;
    const id   = trimmed.slice(0, sep).trim();
    const role = trimmed.slice(sep + 1).trim();
    if (id && role) map[id] = role;
  }
  return map;
}

function parseOidcAssuranceValues(raw: string, name: string): string[] {
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (values.length > 32 || values.some(value => value.length > 128 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new Error(`${name} must contain at most 32 comma-separated values of at most 128 characters`);
  }
  return [...new Set(values)];
}

function parseOidcMfaMaxAgeSeconds(raw: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('OIDC_MFA_MAX_AGE_SECONDS must be an integer between 60 and 3600');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 60 || value > 3_600) {
    throw new Error('OIDC_MFA_MAX_AGE_SECONDS must be an integer between 60 and 3600');
  }
  return value;
}

function parseHttpOrigins(raw: string, name: string): string[] {
  const origins = raw.split(',').map(value => value.trim()).filter(Boolean).map(value => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} must contain comma-separated HTTP(S) origins`);
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`${name} must contain credential-free HTTP(S) origins without paths`);
    }
    return url.origin;
  });
  if (origins.length > 64) throw new Error(`${name} supports at most 64 origins`);
  return [...new Set(origins)];
}

function loadExecutionGrantSecret(sessionSecret: string): string {
  const inline = process.env['ARGUS_EXECUTION_GRANT_SECRET'] ?? '';
  const filename = process.env['ARGUS_EXECUTION_GRANT_SECRET_FILE'] ?? '';
  if (inline && filename) {
    throw new Error('Configure ARGUS_EXECUTION_GRANT_SECRET or ARGUS_EXECUTION_GRANT_SECRET_FILE, not both');
  }
  if (!filename) {
    if (inline) return inline;
    // Keep a fresh self-hosted Core usable without introducing a second local
    // secret. HMAC domain separation produces a distinct signing key; serious
    // deployments should still inject and rotate an explicit secret file.
    return createHmac('sha256', sessionSecret).update('argus-execution-grant-v1').digest('hex');
  }
  const raw = readFileSync(filename, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 8 * 1024) {
    throw new Error('execution grant signing secret exceeds 8 KiB');
  }
  const secret = raw.trim();
  if (/\r|\n/.test(secret)) throw new Error('execution grant signing secret file is malformed');
  return secret;
}

function parseRuntimeMcpOrigin(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('ARGUS_RUNTIME_MCP_ORIGIN must be a valid HTTP(S) origin');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('ARGUS_RUNTIME_MCP_ORIGIN must be a credential-free HTTP(S) origin without a path');
  }
  return url.origin;
}

function parseManagedRuntimeReadOnlyBundleIds(raw: string): number[] {
  const values = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (values.length > 64) throw new Error('ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS supports at most 64 bundle IDs');
  const parsed = values.map(value => {
    if (!/^\d+$/.test(value)) throw new Error('ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS must be comma-separated positive integer IDs');
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error('ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS must contain positive integer IDs');
    }
    return id;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error('ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS must not contain duplicate IDs');
  }
  return parsed;
}

export function loadConfig(): Config {
  const apiKeysRaw = process.env.MCP_API_KEYS ?? '';
  const apiKeys = apiKeysRaw.split(',').map(k => k.trim()).filter(Boolean);

  if (apiKeys.length === 0) {
    throw new Error('MCP_API_KEYS must be set with at least one API key (comma-separated)');
  }

  const sessionSecret = process.env.SESSION_SECRET ?? '';
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be set and at least 32 characters long (generate with: openssl rand -hex 32)');
  }

  if (!process.env['DB_ENCRYPTION_KEY']) {
    if (process.env['NODE_ENV'] === 'production') {
      throw new Error('DB_ENCRYPTION_KEY must be set in production (generate with: openssl rand -hex 32)');
    }
    console.warn('[security] DB_ENCRYPTION_KEY not set — sensitive DB fields stored unencrypted (OK for local dev)');
  }

  const postgresEnabled = process.env.DATABASE_URL != null || process.env.POSTGRES_CONNECTION_URL != null;
  const entraSsoEnabled = process.env.ENTRA_SSO_ENABLED === 'true';
  const genericOidcEnabled = process.env.OIDC_SSO_ENABLED === 'true';
  if (entraSsoEnabled && genericOidcEnabled) {
    throw new Error('Configure either ENTRA_SSO_ENABLED or OIDC_SSO_ENABLED, not both');
  }

  const oidcProvider = genericOidcEnabled ? 'generic_oidc' as const : 'entra' as const;
  const entraTenantId = process.env.ENTRA_TENANT_ID ?? '';
  const entraClientId = process.env.ENTRA_CLIENT_ID ?? '';
  const entraClientSecret = process.env.ENTRA_CLIENT_SECRET ?? '';
  const entraRedirectUri = process.env.ENTRA_REDIRECT_URI
    ?? `http://localhost:${process.env.PORT ?? '3000'}/auth/entra/callback`;
  const oidcSsoEnabled = genericOidcEnabled || entraSsoEnabled;
  const oidcAuthorizationUrl = genericOidcEnabled
    ? process.env.OIDC_AUTHORIZATION_URL ?? ''
    : `https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/authorize`;
  const oidcTokenUrl = genericOidcEnabled
    ? process.env.OIDC_TOKEN_URL ?? ''
    : `https://login.microsoftonline.com/${entraTenantId}/oauth2/v2.0/token`;
  const oidcIssuer = genericOidcEnabled
    ? process.env.OIDC_ISSUER ?? ''
    : `https://login.microsoftonline.com/${entraTenantId}/v2.0`;
  const oidcJwksUri = genericOidcEnabled
    ? process.env.OIDC_JWKS_URI ?? ''
    : `https://login.microsoftonline.com/${entraTenantId}/discovery/v2.0/keys`;
  const oidcClientId = genericOidcEnabled ? process.env.OIDC_CLIENT_ID ?? '' : entraClientId;
  const oidcClientSecret = genericOidcEnabled ? process.env.OIDC_CLIENT_SECRET ?? '' : entraClientSecret;
  const oidcRedirectUri = genericOidcEnabled
    ? process.env.OIDC_REDIRECT_URI ?? `http://localhost:${process.env.PORT ?? '3000'}/auth/oidc/callback`
    : entraRedirectUri;

  if (oidcSsoEnabled) {
    const required = {
      authorizationUrl: oidcAuthorizationUrl,
      tokenUrl: oidcTokenUrl,
      issuer: oidcIssuer,
      jwksUri: oidcJwksUri,
      clientId: oidcClientId,
      redirectUri: oidcRedirectUri,
    };
    const missing = Object.entries(required).filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`Interactive OIDC is enabled but required settings are missing: ${missing.join(', ')}`);
    }
  }

  return {
    auditEvidenceV1Enabled: process.env['ARGUS_AUDIT_EVIDENCE_V1_ENABLED'] === 'true',
    auditCheckpointIntervalSec: Math.max(60, Math.min(86_400, parseInt(process.env['ARGUS_AUDIT_CHECKPOINT_INTERVAL_SEC'] ?? '300', 10))),
    auditOutboxLagAlertSec: Math.max(30, Math.min(86_400, parseInt(process.env['ARGUS_AUDIT_OUTBOX_LAG_ALERT_SEC'] ?? '300', 10))),
    auditReportWorkerIntervalSec: Math.max(15, Math.min(3_600, parseInt(process.env['ARGUS_AUDIT_REPORT_WORKER_INTERVAL_SEC'] ?? '60', 10))),
    mcpFabricProfileDriftIntervalSec: Math.max(30, Math.min(86_400, parseInt(process.env['ARGUS_MCP_FABRIC_DRIFT_INTERVAL_SEC'] ?? '300', 10))),
    repositoryGraphEnabled: process.env['ARGUS_REPOSITORY_GRAPH_ENABLED'] === 'true',
    port: parseInt(process.env.PORT ?? '3000', 10),
    apiKeys,

    postgresEnabled,
    postgresConnectionUrl: process.env.DATABASE_URL ?? process.env.POSTGRES_CONNECTION_URL ?? '',

    rateLimitPerMinute: parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? '120', 10),
    maxResultRows: parseInt(process.env.MAX_RESULT_ROWS ?? '500', 10),
    maxResultSizeBytes: parseInt(process.env.MAX_RESULT_SIZE_BYTES ?? '524288', 10), // 512KB
    dynamicToolsPollIntervalSec: parseInt(process.env.DYNAMIC_TOOLS_POLL_INTERVAL_SEC ?? '60', 10),
    aiopsPostChangeMonitorDelaySec: Math.max(30, Math.min(86_400, parseInt(process.env.AIOPS_POST_CHANGE_MONITOR_DELAY_SEC ?? '300', 10))),
    aiopsPostChangeMonitorPollSec: Math.max(10, Math.min(3_600, parseInt(process.env.AIOPS_POST_CHANGE_MONITOR_POLL_SEC ?? '30', 10))),
    aiopsRemediationReconcileStaleSec: Math.max(30, Math.min(86_400, parseInt(process.env.AIOPS_REMEDIATION_RECONCILE_STALE_SEC ?? '120', 10))),

    auditLogRetentionDays: parseInt(process.env.AUDIT_LOG_RETENTION_DAYS ?? '90', 10),

    sessionSecret,
    sessionMaxAgeHours: parseInt(process.env.SESSION_MAX_AGE_HOURS ?? '8', 10),

    oauth2Enabled: process.env.OAUTH2_ENABLED === 'true',
    oauth2Issuer: process.env.OAUTH2_ISSUER ?? '',
    oauth2Audience: process.env.OAUTH2_AUDIENCE ?? '',
    oauth2JwksUri: process.env.OAUTH2_JWKS_URI ?? '',

    entraSsoEnabled,
    entraTenantId,
    entraClientId,
    entraClientSecret,
    entraRedirectUri,
    entraDefaultRole: process.env.ENTRA_DEFAULT_ROLE ?? 'viewer',
    entraGroupMap: parseEntraGroupMap(process.env.ENTRA_GROUP_MAP ?? ''),
    entraEmergencyLocalAdmin: genericOidcEnabled
      ? process.env.OIDC_EMERGENCY_LOCAL_ADMIN !== 'false'
      : process.env.ENTRA_EMERGENCY_LOCAL_ADMIN !== 'false', // default true
    entraDisableLocalLogin: genericOidcEnabled
      ? process.env.OIDC_DISABLE_LOCAL_LOGIN === 'true'
      : process.env.ENTRA_DISABLE_LOCAL_LOGIN === 'true',

    oidcSsoEnabled,
    oidcProvider,
    oidcProviderName: genericOidcEnabled ? process.env.OIDC_PROVIDER_NAME ?? 'Single Sign-On' : 'Microsoft',
    oidcAccountManagementUrl: genericOidcEnabled
      ? process.env.OIDC_ACCOUNT_MANAGEMENT_URL ?? ''
      : process.env.ENTRA_ACCOUNT_MANAGEMENT_URL ?? 'https://mysignins.microsoft.com/security-info',
    oidcAdminConsoleUrl: genericOidcEnabled
      ? process.env.OIDC_ADMIN_CONSOLE_URL ?? ''
      : process.env.ENTRA_ADMIN_CONSOLE_URL ?? 'https://entra.microsoft.com/#view/Microsoft_AAD_ConditionalAccess/ConditionalAccessBlade/~/Policies',
    oidcAuthorizationUrl,
    oidcTokenUrl,
    oidcIssuer,
    oidcJwksUri,
    oidcClientId,
    oidcClientSecret,
    oidcRedirectUri,
    oidcScopes: genericOidcEnabled ? process.env.OIDC_SCOPES ?? 'openid profile email' : 'openid profile email',
    oidcSubjectClaim: genericOidcEnabled ? process.env.OIDC_SUBJECT_CLAIM ?? 'sub' : 'oid',
    oidcEmailClaim: genericOidcEnabled ? process.env.OIDC_EMAIL_CLAIM ?? 'email' : 'preferred_username',
    oidcDisplayNameClaim: genericOidcEnabled ? process.env.OIDC_DISPLAY_NAME_CLAIM ?? 'name' : 'name',
    oidcGroupsClaim: genericOidcEnabled ? process.env.OIDC_GROUPS_CLAIM ?? 'groups' : 'groups',
    oidcDefaultRole: genericOidcEnabled ? process.env.OIDC_DEFAULT_ROLE ?? 'viewer' : process.env.ENTRA_DEFAULT_ROLE ?? 'viewer',
    oidcGroupMap: genericOidcEnabled
      ? parseEntraGroupMap(process.env.OIDC_GROUP_MAP ?? '')
      : parseEntraGroupMap(process.env.ENTRA_GROUP_MAP ?? ''),
    oidcMfaAmrValues: parseOidcAssuranceValues(
      process.env.OIDC_MFA_AMR_VALUES ?? 'mfa,otp,hwk,webauthn,fido',
      'OIDC_MFA_AMR_VALUES',
    ),
    oidcMfaAcrValues: parseOidcAssuranceValues(
      process.env.OIDC_MFA_ACR_VALUES ?? '',
      'OIDC_MFA_ACR_VALUES',
    ),
    oidcMfaMaxAgeSeconds: parseOidcMfaMaxAgeSeconds(
      process.env.OIDC_MFA_MAX_AGE_SECONDS ?? '600',
    ),
    backendSsoEnabled: process.env['ARGUS_BACKEND_SSO_ENABLED'] === 'true',
    backendSsoAllowedOrigins: parseHttpOrigins(
      process.env['ARGUS_BACKEND_SSO_ALLOWED_ORIGINS'] ?? '',
      'ARGUS_BACKEND_SSO_ALLOWED_ORIGINS',
    ),

    // Entra ID Agent Identity (mig 081)
    entraAgentRegistration: process.env['ENTRA_AGENT_REGISTRATION'] === 'true',
    entraSidecarUrl: process.env['ENTRA_SIDECAR_URL'] ?? 'http://localhost:5000',
    entraEnvSlug: process.env['ENTRA_ENV_SLUG'] ?? 'dev',
    entraBlueprintMap: (() => {
      const raw = process.env['ENTRA_BLUEPRINTS_JSON'] ?? '{}';
      try { return JSON.parse(raw) as Record<string, string>; }
      catch { return {}; }
    })(),

    localAuthEnabled: process.env.LOCAL_AUTH_ENABLED !== 'false',  // default: true

    // Redis Cache
    redisEnabled: process.env.REDIS_ENABLED === 'true',
    redisUrl: process.env.REDIS_URL ??
      (process.env.REDIS_PASSWORD
        ? `redis://:${encodeURIComponent(process.env.REDIS_PASSWORD)}@redis:6379`
        : 'redis://redis:6379'),
    redisCacheTtlSec: parseInt(process.env.REDIS_CACHE_TTL_SEC ?? '300', 10),
    redisCacheNamespace: process.env.REDIS_CACHE_NAMESPACE ?? 'argus',

    // LangSmith
    langsmithApiKey: process.env.LANGSMITH_API_KEY ?? '',
    langsmithBaseUrl: process.env.LANGSMITH_BASE_URL ?? 'https://api.smith.langchain.com',

    // Qdrant
    qdrantUrl: process.env.QDRANT_URL ?? '',
    qdrantApiKey: process.env.QDRANT_API_KEY ?? '',

    // Sec-Härtung Phase 1 (2026-05-27)
    prodApprovalEnforce: process.env['ARGUS_PROD_APPROVAL_ENFORCE'] === 'true',
    rbacEnforce: process.env['ARGUS_RBAC_ENFORCE'] !== 'false',  // default true
    maxAgentSessionSeconds: parseInt(process.env['MAX_AGENT_SESSION_SECONDS'] ?? '600', 10),
    egressAllowlist: (process.env['ARGUS_EGRESS_ALLOWLIST'] ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    piiMlEnabled: process.env['PII_ML_ENABLED'] === 'true',
    piiMlUrl: process.env['PII_ML_URL'] ?? 'http://presidio-analyzer:3000',
    piiMlThreshold: parseFloat(process.env['PII_ML_THRESHOLD'] ?? '0.6'),
    piiMlEntities: (process.env['PII_ML_ENTITIES'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    piiMlLanguage: process.env['PII_ML_LANGUAGE'] ?? 'en',

    // Public Widget (Phase 3 — default off)
    publicWidgetEnabled: process.env['PUBLIC_WIDGET_ENABLED'] === 'true',
    shareLinksEnabled: process.env['SHARE_LINKS_ENABLED'] === 'true',
    widgetTokenSecret: (() => {
      const explicit = process.env['WIDGET_TOKEN_SECRET'];
      if (explicit) return explicit;
      // Deterministic derivation from SESSION_SECRET so no extra env var is required in dev.
      // A real deployment SHOULD set WIDGET_TOKEN_SECRET explicitly.
      return createHmac('sha256', sessionSecret).update('widget-token').digest('hex');
    })(),
    widgetTokenTtlSec: parseInt(process.env['WIDGET_TOKEN_TTL_SEC'] ?? '1800', 10),
    turnstileEnabled: process.env['TURNSTILE_ENABLED'] === 'true',
    turnstileSecret: process.env['TURNSTILE_SECRET'] ?? '',
    trustProxyHops: parseInt(process.env['TRUST_PROXY_HOPS'] ?? '1', 10),

    // Chat SPA (argus-chat-ui — default off)
    chatSpaEnabled: process.env['CHAT_SPA_ENABLED'] === 'true',

    // AI interaction transparency — safe default for AI Act Art. 50 support
    aiTransparencyNoticeEnabled: process.env['AI_TRANSPARENCY_NOTICE_ENABLED'] !== 'false',
    aiTransparencyNoticeText: process.env['AI_TRANSPARENCY_NOTICE_TEXT']
      ?? 'You are interacting with an AI agent. Responses may be inaccurate; verify important information and review tool actions before approval.',

    solutionPackEndpoints: attachSolutionPackTokenFiles(
      parseSolutionPackEndpoints(process.env['ARGUS_SOLUTION_PACK_ENDPOINTS'] ?? ''),
      process.env['ARGUS_SOLUTION_PACK_TOKEN_FILES'] ?? '',
    ),
    solutionPackCoreVersion: process.env['ARGUS_CORE_VERSION'] ?? '1.0.0',
    solutionPackDiscoveryTimeoutMs: parseInt(process.env['ARGUS_SOLUTION_PACK_DISCOVERY_TIMEOUT_MS'] ?? '5000', 10),
    solutionPackRefreshSec: parseInt(process.env['ARGUS_SOLUTION_PACK_REFRESH_SEC'] ?? '60', 10),
    solutionPackExecutionGrantSecret: loadExecutionGrantSecret(sessionSecret),
    runtimeMcpOrigin: parseRuntimeMcpOrigin(process.env['ARGUS_RUNTIME_MCP_ORIGIN'] ?? ''),
    managedRuntimeReadOnlyBundleIds: parseManagedRuntimeReadOnlyBundleIds(
      process.env['ARGUS_MANAGED_RUNTIME_READ_ONLY_BUNDLE_IDS'] ?? '',
    ),
  };
}

// ── Direct provider runtime ────────────────────────────────────────
export const ANTHROPIC_API_KEY = process.env['ANTHROPIC_API_KEY'] ?? '';
export const AGENT_WORKSPACE_URL = process.env['AGENT_WORKSPACE_URL'] ?? 'http://agent-workspace:3001';
export const WORKSPACE_SECRET = process.env['WORKSPACE_SECRET'] ?? '';

// �??�?? LangGraph (coding workflow orchestration) �??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??
export const LANGGRAPH_URL = process.env['LANGGRAPH_URL'] ?? 'http://argus-dev:2025';

// �??�?? n8n Integration (Coding Workflow Trigger via Jira) �??�??�??�??�??�??�??�??�??�??
// n8n-Webhook-URL die Argus aufruft wenn nur eine Ticket-ID eingegeben wird.
// n8n holt dann Jira-Details und ruft /api/coding/start zurück.
export const N8N_CODING_WEBHOOK_URL = process.env['N8N_CODING_WEBHOOK_URL'] ?? '';

// �??�?? Arize Phoenix (RAG observability) �??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??
export const PHOENIX_ENABLED = process.env['PHOENIX_ENABLED'] !== 'false';
export const PHOENIX_OTLP_ENDPOINT = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? 'http://phoenix:4317';

// �??�?? Password rotation policy �??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??
// Days after which the UI nags the user to rotate their password.
// 0 disables the feature. Default 365 (one year).
export const PASSWORD_MAX_AGE_DAYS = parseInt(process.env['PASSWORD_MAX_AGE_DAYS'] ?? '365', 10);

// �??�?? SDK Runner (history compaction for worker agents) �??�??�??�??�??�??�??�??�??�??�??�??
// Set USE_SDK_RUNNER=true to route worker agents through sdkRunner.ts
// which automatically compacts history when it grows too large.
export const USE_SDK_RUNNER =
  process.env['USE_SDK_RUNNER'] === 'true';

// Estimated token threshold above which history is compacted.
// Default 40000 leaves ~56k tokens free for the model's context window
// (claude-opus-4-6 has 200k context; system + tools + new turn use the rest).
export const SDK_COMPACT_THRESHOLD_TOKENS =
  parseInt(process.env['SDK_COMPACT_THRESHOLD_TOKENS'] ?? '40000', 10);

// �??�?? Continuous Evaluation �??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??�??
// Set CONTINUOUS_EVAL_ENABLED=true to score every agent response.
// Uses claude-haiku-4-5 as judge �?? ~$0.001 per evaluation.
export const CONTINUOUS_EVAL_ENABLED   = process.env['CONTINUOUS_EVAL_ENABLED'] === 'true';
export const EVAL_QUALITY_THRESHOLD    = parseFloat(process.env['EVAL_QUALITY_THRESHOLD'] ?? '0.7');
export const EVAL_JUDGE_MODEL          = process.env['EVAL_JUDGE_MODEL'] ?? 'claude-haiku-4-5';
