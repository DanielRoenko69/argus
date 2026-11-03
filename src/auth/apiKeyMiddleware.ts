import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { logger } from '../lib/logger.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { rateLimitCounter, httpRequestCounter } from '../lib/metrics.js';
import type { Config } from '../config/env.js';
import { getApiKeyRbac, validateDbApiKey } from './apiKeyRbac.js';
import { withRequestContext } from '../lib/requestContext.js';

// /metrics intentionally excluded — requires API key auth (Prometheus scraping uses Bearer token)
const PUBLIC_PATHS = new Set([
  '/health', '/ready', '/status', '/docs', '/admin', '/design-showcase',
  '/home', '/build/agents', '/build/knowledge', '/build/skills', '/build/workflows', '/runs', '/mcp-fabric', '/governance', '/observe', '/settings', '/connections',
  '/logs', '/grafana-view', '/login', '/audit', '/workflows', '/agents', '/chat',
]);
// Note: /api/admin/ and /api/audit/ are intentionally NOT here — they require session auth
// Note: /api/settings/ intentionally NOT here — those routes require requireAuth/requireAdmin
// Note: /api/internal/ uses X-Workspace-Secret-based auth (cluster-internal only);
// adding it here bypasses the API-key check so LangGraph + agent-workspace can call
// the creds-resolution endpoint without holding an MCP user-API-key.
// The endpoint itself enforces X-Workspace-Secret + fail-loud-503 if WORKSPACE_SECRET missing.
// MUST NOT be routed through Ingress (NetworkPolicy in Phase 2).
// /public/ is the anonymous-by-design public-widget surface (Phase 3). It is
// exempt from the global API-key gate so unauthenticated browser requests reach
// the route handlers, which enforce their OWN gates: PUBLIC_WIDGET_ENABLED master
// switch, origin allowlist, single-use token, per-IP + per-widget rate limits,
// daily token cap. Nothing under /public/ is reachable unless the master switch
// is on AND a widget is explicitly configured + enabled.
// /share/ is the anonymous read-only shared-conversation surface (P4). Like /public/, it
// is exempt from the global API-key gate so unauthenticated browser requests reach the
// route handlers, which enforce their OWN gates: SHARE_LINKS_ENABLED master switch (default
// off — the routes aren't even mounted when it's off), SHA256-hashed token lookup with
// expiry+revocation, and a per-IP rate limit. The stored snapshot is always PII-redacted.
const PUBLIC_PREFIXES = [
  '/api/nav/', '/api/logs/', '/api/metrics/', '/api/tools/', '/api/internal/', '/api/coding/webhook/',
  // Provider signals authenticate with a raw-body HMAC in their route. They
  // must reach that verifier before the global API-key gate.
  '/api/observability/aiops/provider-signals/',
  // External workflow deliveries authenticate with their per-workflow/global
  // HMAC secret inside triggerWorker. Requiring an Argus API key here would
  // make provider webhooks unreachable before signature verification.
  '/webhooks/wf/',
  // Browser pages still enforce their own session/admin guards. Exempting them here
  // lets unauthenticated navigation reach requireAuth and redirect to /login.
  '/build/', '/solutions/', '/runs/', '/governance/', '/observe/', '/settings/', '/connections/',
  '/mcp-fabric/', '/workflows/', '/agents/', '/chat/', '/embed/chat/',
  '/auth/', '/assets/', '/console-assets/', '/admin/', '/public/', '/share/',
];
// These paths accept API key OR session — process the key but don't reject if missing (route handles auth)
const API_KEY_OPTIONAL_PREFIXES = ['/api/agents/'];

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function apiKeyPrefix(key: string): string {
  return key.slice(0, 8);
}

export function createApiKeyMiddleware(config: Config) {
  const rateLimiter = new RateLimiter(config.rateLimitPerMinute);

  // Cleanup stale rate limit buckets every 5 minutes
  setInterval(() => rateLimiter.cleanup(), 300_000).unref();

  const handle = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Track all HTTP requests
    res.on('finish', () => {
      httpRequestCounter.inc({ method: req.method, path: req.path, status: String(res.statusCode) });
    });

    if (PUBLIC_PATHS.has(req.path) || PUBLIC_PREFIXES.some(p => req.path.startsWith(p))) {
      next(); return;
    }

    // Skip API key check if already authenticated via OAuth2 or session cookie
    if ((req as unknown as Record<string, unknown>).authenticated) { next(); return; }
    if ((req as unknown as Record<string, unknown>).user) { next(); return; }
    // A Solution Pack execution grant has already been signature-, scope- and
    // revocation-checked by the preceding middleware. It is deliberately not
    // interpreted as a long-lived API key here.
    if ((req as unknown as Record<string, unknown>).executionGrant) { next(); return; }

    const isOptional = API_KEY_OPTIONAL_PREFIXES.some(p => req.path.startsWith(p));

    const queryKey  = req.query.api_key as string | undefined;
    const xApiKey   = req.headers['x-api-key'] as string | undefined;
    const authHeader = req.headers['authorization'];

    if (!authHeader && !xApiKey && !queryKey) {
      if (isOptional) { next(); return; }
      res.status(401).json({ error: 'Missing Authorization, X-API-Key header, or api_key query parameter' });
      return;
    }

    const token = queryKey ?? xApiKey ?? (
      authHeader!.startsWith('Bearer ') ? authHeader!.slice(7) : authHeader!
    );

    const matchedKey = config.apiKeys.find(key => safeCompare(token, key));
    const dbEntry    = matchedKey ? undefined : validateDbApiKey(token);

    if (!matchedKey && !dbEntry) {
      logger.warn({ path: req.path }, 'Invalid API key attempt');
      if (isOptional) { next(); return; }
      res.status(403).json({ error: 'Invalid API key' });
      return;
    }

    const keyPrefix = matchedKey ? apiKeyPrefix(matchedKey) : dbEntry!.key_prefix;

    // Distributed rate limiting (Redis sliding window, in-memory fallback)
    if (!await rateLimiter.isAllowed(keyPrefix)) {
      rateLimitCounter.inc({ api_key_prefix: keyPrefix });
      logger.warn({ apiKey: keyPrefix }, 'Rate limit exceeded');
      res.status(429).json({ error: 'Rate limit exceeded. Try again later.' });
      return;
    }

    const rbac = dbEntry ?? getApiKeyRbac(keyPrefix);
    (req as unknown as Record<string, unknown>).apiKeyPrefix = keyPrefix;
    (req as unknown as Record<string, unknown>).allowedBundles = rbac?.allowed_bundles ?? null;
    (req as unknown as Record<string, unknown>).allowedTools = rbac?.allowed_tools ?? null;
    (req as unknown as Record<string, unknown>).deniedTools = rbac?.denied_tools ?? null;
    (req as unknown as Record<string, unknown>).apiKeyScope = rbac?.scope ?? 'both';
    (req as unknown as Record<string, unknown>).tenantKey = rbac?.tenant_key ?? 'default';
    (req as unknown as Record<string, unknown>).workspaceKey = rbac?.workspace_key ?? 'default';

    // API-Key-User-Binding: when this key is bound to an mcp_users row, propagate
    // the user identity via AsyncLocalStorage so deep tool-execution code
    // (customBackends → upstream OAuth resolution) sees the calling user even
    // though the request came from Cursor/VS Code without an SSO session.
    const actingUserId = (rbac as { acting_as_user_id?: number | null } | undefined)?.acting_as_user_id ?? null;
    if (actingUserId != null) {
      const actingUsername = (rbac as { acting_as_username?: string | null } | undefined)?.acting_as_username ?? null;
      const actingRole = (rbac as { acting_as_role?: string | null } | undefined)?.acting_as_role ?? null;
      const actingGroups = (rbac as { acting_as_entra_groups?: string[] } | undefined)?.acting_as_entra_groups ?? [];
      (req as unknown as Record<string, unknown>).callingUser = {
        id: actingUserId,
        username: actingUsername,
        role: actingRole,
        entra_groups: actingGroups,
      };
      withRequestContext(
        {
          callingUser: {
            id: actingUserId,
            ...(actingUsername ? { username: actingUsername } : {}),
            ...(actingRole ? { role: actingRole } : {}),
            entra_groups: actingGroups,
          },
        },
        () => { next(); },
      );
      return;
    }

    next();
  };

  return (req: Request, res: Response, next: NextFunction): void => {
    handle(req, res, next).catch(next);
  };
}
