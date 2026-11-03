/**
 * publicCsp.ts — P3-5
 *
 * Per-route CSP + CORS middleware for /public/* routes.
 *
 * SECURITY CONTRACT:
 *   • This middleware ONLY modifies framing headers for a valid, enabled
 *     /public/widget/:slug GET and derives them from the stored allowlist.
 *     Browser iframe navigations do not reliably send an Origin header.
 *   • CORS headers are set only when the request Origin is explicitly allowed.
 *   • It NEVER modifies headers for non-/public/* routes — it must only be
 *     mounted under app.use('/public', publicCspMiddleware(pool)).
 *   • It does NOT set permissive headers when the widget is not found or the
 *     origin is not in the allowlist (default-deny).
 *   • It overrides X-Frame-Options (set by helmet's frameguard) and the global
 *     frame-ancestors CSP FOR THIS RESPONSE ONLY, allowing the widget to be
 *     embedded in the caller's page. The global helmet config is untouched.
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import pg from 'pg';
import { getWidgetBySlug, isOriginAllowed, normalizePublicWidgetOrigin } from './widgetStore.js';

/**
 * Extract the widget slug from a /public/widget/:slug/... path.
 * Returns null if the path does not match.
 */
function extractSlug(path: string): string | null {
  // Match /widget/<slug> optionally followed by anything
  const m = /^\/widget\/([^/]+)(?:\/.*)?$/.exec(path);
  return m ? (m[1] ?? null) : null;
}

/**
 * Build a `publicCspMiddleware` bound to the given database pool.
 *
 * Mount ONLY on the /public prefix:
 *   app.use('/public', publicCspMiddleware(pool))
 *
 * The middleware runs AFTER the global helmet block so that for allowed
 * origins it can override the frame-ancestors and X-Frame-Options headers
 * set by helmet. For disallowed or unknown slugs it calls next() without
 * touching any headers.
 */
export function publicCspMiddleware(pool: pg.Pool): RequestHandler {
  return async function publicCsp(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const slug = extractSlug(req.path);

    // No slug match → not a widget request; pass through untouched.
    if (!slug) {
      next();
      return;
    }

    // Look up widget. getWidgetBySlug enforces the triple security gate:
    //   widget.enabled = true AND agent.visibility = 'public' AND agent.enabled = true.
    const widget = await getWidgetBySlug(pool, slug).catch(() => null);

    // Unknown slug or any gate failed → next() without any permissive headers.
    if (!widget) {
      next();
      return;
    }

    const setFramePolicy = () => {
      const frameAncestors = [
        "'self'",
        ...widget.allowed_origins
          .map(normalizePublicWidgetOrigin)
          .filter((candidate): candidate is string => candidate != null),
      ].join(' ');
      res.setHeader('Content-Security-Policy', `frame-ancestors ${frameAncestors}`);
      res.removeHeader('X-Frame-Options');
    };

    // GET is the iframe navigation itself. Navigation requests commonly omit
    // Origin, so allow framing only through the browser-enforced, exact stored
    // allowlist. Unknown/disabled widgets never reach this point.
    if (req.method === 'GET') setFramePolicy();

    const origin = req.headers['origin'] as string | undefined;

    // Origin not in allowlist → do NOT set ACAO (browser will block cross-origin),
    // do NOT relax framing. Continue to route handler which may 403.
    if (!isOriginAllowed(widget, origin)) {
      next();
      return;
    }

    // ── Allowed origin: set CORS + relaxed framing headers ──────────────

    // CORS
    res.setHeader('Access-Control-Allow-Origin', origin!);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type,authorization');

    // API requests do not need framing, but retaining the historical response
    // contract for an explicitly allowed Origin is harmless and predictable.
    if (req.method !== 'GET') setFramePolicy();

    // Handle CORS preflight — respond immediately, do not forward to the route.
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    next();
  };
}
