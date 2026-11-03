/**
 * publicCsp.test.ts — P3-5 TDD
 *
 * Tests:
 *   1. Allowed origin → ACAO + frame-ancestors set; X-Frame-Options removed.
 *   2. GET navigation without Origin → exact stored frame-ancestors, no CORS.
 *   3. Disallowed API origin → no permissive headers set at all.
 *   3. Unknown slug → next() called, no permissive headers.
 *   4. OPTIONS preflight from allowed origin → 204, no further processing.
 *   5. Non-widget path (no slug) → next() with no headers changed.
 *   6. Widget not found (stub returns null) → next(), no headers.
 */

import { publicCspMiddleware } from '../publicCsp.js';
import type { Request, Response, NextFunction } from 'express';
import type { PublicWidget } from '../widgetStore.js';

// ── Jest module mocking ───────────────────────────────────────

jest.mock('../widgetStore.js', () => ({
  getWidgetBySlug: jest.fn(),
  isOriginAllowed: jest.fn(),
  normalizePublicWidgetOrigin: jest.fn((origin: string) => /^https?:\/\//.test(origin) && !origin.includes(';') ? origin : null),
}));

import { getWidgetBySlug, isOriginAllowed } from '../widgetStore.js';
const mockGetWidget = getWidgetBySlug as jest.MockedFunction<typeof getWidgetBySlug>;
const mockIsOriginAllowed = isOriginAllowed as jest.MockedFunction<typeof isOriginAllowed>;

// ── Fixtures ──────────────────────────────────────────────────

function makeWidget(allowed_origins: string[] = ['https://example.com']): PublicWidget {
  return {
    id: 1,
    agent_id: 10,
    slug: 'test-widget',
    allowed_origins,
    enabled: true,
    greeting: null,
    accent: null,
    title: null,
    input_placeholder: null,
    launcher_icon_url: null,
    launcher_icon_alt: null,
    launcher_position: 'right',
    rate_limit_per_ip: 20,
    daily_token_cap: 50000,
    created_by: null,
    created_at: new Date(),
  };
}

/** Minimal stub pool — never queried by the CSP middleware itself. */
const stubPool = {} as import('pg').Pool;

/** Build a fake Express Request. */
function makeReq(opts: {
  path: string;
  method?: string;
  origin?: string;
}): Request {
  return {
    path: opts.path,
    method: opts.method ?? 'POST',
    headers: opts.origin ? { origin: opts.origin } : {},
  } as unknown as Request;
}

/** Build a spy Response with header tracking. */
function makeRes() {
  const headers: Record<string, string> = {};
  const removedHeaders: string[] = [];
  let statusCode: number | undefined;
  let ended = false;

  const res = {
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    removeHeader: jest.fn((name: string) => {
      removedHeaders.push(name.toLowerCase());
    }),
    status: jest.fn(function (code: number) {
      statusCode = code;
      return res;
    }),
    end: jest.fn(() => {
      ended = true;
    }),
    _headers: headers,
    _removedHeaders: removedHeaders,
    _statusCode: () => statusCode,
    _ended: () => ended,
  } as unknown as Response & {
    _headers: Record<string, string>;
    _removedHeaders: string[];
    _statusCode: () => number | undefined;
    _ended: () => boolean;
  };
  return res;
}

// ── Helpers ───────────────────────────────────────────────────

function extendedRes(res: ReturnType<typeof makeRes>) {
  return res as typeof res & {
    _headers: Record<string, string>;
    _removedHeaders: string[];
    _statusCode: () => number | undefined;
    _ended: () => boolean;
  };
}

// ── Tests ─────────────────────────────────────────────────────

describe('publicCspMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allowed origin → sets ACAO, Vary, Methods, Headers, frame-ancestors; removes X-Frame-Options; calls next()', async () => {
    const widget = makeWidget(['https://example.com']);
    mockGetWidget.mockResolvedValue(widget);
    mockIsOriginAllowed.mockReturnValue(true);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', origin: 'https://example.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);

    // CORS headers
    expect(r._headers['access-control-allow-origin']).toBe('https://example.com');
    expect(r._headers['vary']).toBe('Origin');
    expect(r._headers['access-control-allow-methods']).toBe('POST,OPTIONS');
    expect(r._headers['access-control-allow-headers']).toBe('content-type,authorization');

    // CSP frame-ancestors should include the widget's allowed origins
    const csp = r._headers['content-security-policy'] ?? '';
    expect(csp).toMatch(/^frame-ancestors /);
    expect(csp).toContain('https://example.com');

    // X-Frame-Options must be removed (helmet sets SAMEORIGIN which would block embedding)
    expect(r._removedHeaders).toContain('x-frame-options');

    // next() must be called (not a preflight)
    expect(next).toHaveBeenCalled();
  });

  test('iframe GET without Origin → applies exact stored frame policy without CORS', async () => {
    const widget = makeWidget(['https://docs.example.com', 'https://support.example.com']);
    mockGetWidget.mockResolvedValue(widget);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget', method: 'GET' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);
    expect(r._headers['access-control-allow-origin']).toBeUndefined();
    expect(r._headers['content-security-policy']).toBe("frame-ancestors 'self' https://docs.example.com https://support.example.com");
    expect(r._removedHeaders).toContain('x-frame-options');
    expect(next).toHaveBeenCalled();
  });

  test('disallowed origin → no permissive headers set; next() called', async () => {
    const widget = makeWidget(['https://example.com']);
    mockGetWidget.mockResolvedValue(widget);
    mockIsOriginAllowed.mockReturnValue(false);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', origin: 'https://evil.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);

    // No ACAO header — browser will block cross-origin request
    expect(r._headers['access-control-allow-origin']).toBeUndefined();
    // No frame-ancestors relaxation
    expect(r._headers['content-security-policy']).toBeUndefined();
    // X-Frame-Options NOT removed
    expect(r._removedHeaders).not.toContain('x-frame-options');

    // Route may 403 — we don't interfere
    expect(next).toHaveBeenCalled();
  });

  test('unknown slug (widget not found) → next() called, no permissive headers', async () => {
    mockGetWidget.mockResolvedValue(null);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/no-such-slug/chat', origin: 'https://example.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);
    expect(r._headers['access-control-allow-origin']).toBeUndefined();
    expect(r._headers['content-security-policy']).toBeUndefined();
    expect(r._removedHeaders).not.toContain('x-frame-options');
    expect(next).toHaveBeenCalled();
  });

  test('OPTIONS preflight from allowed origin → 204, next NOT called', async () => {
    const widget = makeWidget(['https://example.com']);
    mockGetWidget.mockResolvedValue(widget);
    mockIsOriginAllowed.mockReturnValue(true);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', method: 'OPTIONS', origin: 'https://example.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);

    // Preflight must be answered with 204 and CORS headers
    expect(r._statusCode()).toBe(204);
    expect(r._ended()).toBe(true);
    expect(r._headers['access-control-allow-origin']).toBe('https://example.com');

    // next() must NOT be called for preflight
    expect(next).not.toHaveBeenCalled();
  });

  test('path without /widget/ prefix (not a widget route) → next() with no headers', async () => {
    // getWidgetBySlug should not even be called
    mockGetWidget.mockResolvedValue(null);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/health', origin: 'https://example.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);
    // Should not have queried the DB
    expect(mockGetWidget).not.toHaveBeenCalled();
    expect(r._headers['access-control-allow-origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test('getWidgetBySlug throws → next() called, no permissive headers (fail-safe)', async () => {
    mockGetWidget.mockRejectedValue(new Error('DB error'));

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', origin: 'https://example.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);
    expect(r._headers['access-control-allow-origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  test('frame-ancestors includes all widget allowed_origins (not just the requesting one)', async () => {
    const widget = makeWidget(['https://a.com', 'https://b.com', 'https://c.com']);
    mockGetWidget.mockResolvedValue(widget);
    mockIsOriginAllowed.mockReturnValue(true);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', origin: 'https://a.com' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;

    await middleware(req, res, next);

    const r = extendedRes(res);
    const csp = r._headers['content-security-policy'] ?? '';
    // All three origins should be in the frame-ancestors directive
    expect(csp).toContain('https://a.com');
    expect(csp).toContain('https://b.com');
    expect(csp).toContain('https://c.com');
  });

  test('invalid stored origins never enter frame-ancestors', async () => {
    const widget = makeWidget(['https://safe.example', "https://bad.example; script-src *"]);
    mockGetWidget.mockResolvedValue(widget);
    mockIsOriginAllowed.mockReturnValue(true);

    const middleware = publicCspMiddleware(stubPool);
    const req = makeReq({ path: '/widget/test-widget/chat', origin: 'https://safe.example' });
    const res = makeRes();
    const next = jest.fn() as NextFunction;
    await middleware(req, res, next);

    const csp = extendedRes(res)._headers['content-security-policy'] ?? '';
    expect(csp).toContain('https://safe.example');
    expect(csp).not.toContain('script-src');
  });
});
