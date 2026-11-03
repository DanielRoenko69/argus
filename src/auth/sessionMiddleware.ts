import type { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { getSession } from './userAuth.js';
import { hasFreshMfaSession } from './userAuth.js';
import type { SessionUser } from './userAuth.js';
import { hasRole, type ArgusRole } from './roles.js';
import { evaluatePermission } from './effectiveAccess.js';
import type { ArgusPermission } from './permissions.js';

/** Extends the Express Request with user info from session. */
export interface AuthenticatedRequest extends Request {
  user?: SessionUser;
}

export function parseCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

/** Parse the `argus_session` cookie value from a Cookie header (or undefined). */
export function parseArgusSessionCookie(cookieHeader: string | undefined): string | undefined {
  return parseCookieValue(cookieHeader, 'argus_session');
}

/**
 * Session middleware: reads `argus_session` cookie and attaches `req.user`.
 * Always calls next() - pages decide themselves whether to require auth.
 */
export function createSessionMiddleware(pool: pg.Pool) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const sessionId = parseCookieValue(req.headers.cookie, 'argus_session');
    if (sessionId) {
      try {
        const user = await getSession(pool, sessionId);
        if (user) {
          (req as AuthenticatedRequest).user = user;
        }
      } catch {
        // Session lookup failed - treat as unauthenticated
      }
    }
    next();
  };
}

/** Guard: redirects to /login if no authenticated user. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    // For API requests, return 401 JSON
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return;
    }
    res.redirect('/login');
    return;
  }
  next();
}

/** Guard: requires platform_admin role (highest privilege). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthenticatedRequest).user;
  if (!user || !hasRole(user.role, 'platform_admin')) {
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Nur Platform-Administratoren', required: 'platform_admin' });
      return;
    }
    res.status(403).send('Zugriff verweigert');
    return;
  }
  next();
}

/**
 * Role-based guard factory. Use for granular per-route access control.
 *
 * Example: router.post('/api/admin/keys', requireRole('operations_admin'), handler)
 *
 * Respects full role hierarchy: platform_admin passes any role check.
 */
export function requireRole(minRole: ArgusRole) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    const role = user?.role ?? 'viewer';
    if (hasRole(role, minRole)) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Unzureichende Berechtigungen',
      required: minRole,
      current: role,
    });
  };
}

/**
 * Named-permission guard used while legacy role guards are migrated route by
 * route. UI capability responses are discoverability only; this middleware is
 * the enforcement boundary for any endpoint that opts into the new contract.
 */
export function requirePermission(permission: ArgusPermission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return;
    }
    const decision = evaluatePermission({ role: user.role }, permission);
    if (decision.allowed) {
      next();
      return;
    }
    res.status(403).json({
      error: 'Unzureichende Berechtigungen',
      requiredPermission: permission,
      decision: decision.reason,
    });
  };
}

/**
 * Requires a recent provider-verified MFA assertion. API callers receive a
 * machine-readable step-up URL; browser pages are redirected to the same
 * signed OIDC flow. Local sessions always fail closed.
 */
export function requireFreshMfa(maxAgeSeconds: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as AuthenticatedRequest).user;
    if (!user) {
      res.status(401).json({ error: 'Nicht authentifiziert' });
      return;
    }
    if (hasFreshMfaSession(user, maxAgeSeconds)) {
      next();
      return;
    }
    const returnTo = req.method === 'GET' && req.originalUrl.startsWith('/')
      ? req.originalUrl
      : '/governance/compliance';
    const stepUpUrl = `/auth/oidc/step-up?returnTo=${encodeURIComponent(returnTo)}`;
    if (req.path.startsWith('/api/')) {
      res.status(428).json({
        error: 'Frische MFA-Bestätigung erforderlich',
        code: 'MFA_STEP_UP_REQUIRED',
        stepUpUrl,
        maxAgeSeconds,
      });
      return;
    }
    res.redirect(stepUpUrl);
  };
}

/**
 * CSRF defense for state-changing requests (POST/PUT/DELETE/PATCH).
 *
 * Defense layers (defense-in-depth):
 *   1. Session cookie uses SameSite=Lax — browsers refuse to send it on
 *      cross-site subrequests and unsafe methods while OIDC top-level callbacks
 *      can still establish a usable browser session.
 *   2. This middleware additionally validates that Origin/Referer header host
 *      matches the request's Host header. Browsers always set Origin on
 *      cross-origin POST/PUT/DELETE, and forging it requires control over the
 *      victim's browser (which already implies a worse compromise).
 *
 * GET/HEAD/OPTIONS are exempt because they should be side-effect-free.
 *
 * Endpoints that must accept cross-origin requests (e.g. the MCP transport,
 * which is called by external agents using API-key auth) are not session-cookie
 * authenticated, so they bypass this middleware naturally — apply it only to
 * routes that rely on the session cookie.
 */
export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }

  const host = req.headers.host;
  if (!host) {
    res.status(400).json({ error: 'Missing Host header' });
    return;
  }

  // Prefer Origin (always present on cross-origin POSTs); fall back to Referer.
  const origin = (req.headers.origin as string | undefined) ?? '';
  const referer = (req.headers.referer as string | undefined) ?? '';
  const sourceUrl = origin || referer;

  if (!sourceUrl) {
    // No Origin and no Referer: most likely a non-browser client. Reject for
    // session-cookie-protected routes.
    res.status(403).json({ error: 'CSRF: missing Origin/Referer header' });
    return;
  }

  let sourceHost: string;
  try {
    sourceHost = new URL(sourceUrl).host;
  } catch {
    res.status(403).json({ error: 'CSRF: malformed Origin/Referer header' });
    return;
  }

  if (sourceHost !== host) {
    res.status(403).json({ error: 'CSRF: Origin/Referer does not match Host' });
    return;
  }

  next();
}

/** Helper to set the session cookie on a response.
 *  SameSite=Lax is required for Authorization Code redirects: a Strict cookie
 *  set during the cross-site IdP callback is not sent on the immediate landing
 *  redirect in Chromium. Lax still blocks cross-site unsafe requests, while
 *  requireSameOrigin protects every session-authenticated mutation. */
export function setSessionCookie(res: Response, sessionId: string, maxAgeHours: number, isProduction: boolean): void {
  const maxAge = maxAgeHours * 3600;
  const parts = [
    `argus_session=${sessionId}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${maxAge}`,
  ];
  if (isProduction) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

/** Helper to clear the session cookie. */
export function clearSessionCookie(res: Response): void {
  res.setHeader('Set-Cookie', 'argus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
