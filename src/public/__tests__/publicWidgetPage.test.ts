/**
 * publicWidgetPage.test.ts — TDD for P3-9 (updated for pentest #4+#5 hardening)
 *
 * Covers:
 *   Task 9a — GET /public/widget/:slug → serves a bare HTML page
 *   Task 9c — isApiRequestAllowed origin logic (same-origin + allowlist)
 *   Task 9b — chatCoreScript public-token mode (tested via chatCore tests)
 *
 * Route tests:
 *   G1. master-off → 404
 *   G2. unknown slug → 404
 *   G3. valid widget → 200, HTML with #chatMessages, no #agentList
 *   G4. valid widget → HTML contains /public/widget/:slug/session path (public-token mode)
 *   G5. valid widget → HTML contains /public/widget/:slug/chat path
 *   G6. valid widget → HTML contains Authorization (Bearer token header)
 *   G7. valid widget → HTML contains X-Widget-Token (response token refresh)
 *
 * isApiRequestAllowed unit tests (updated for #4+#5):
 *   A1. no Origin header → false (#5 — missing Origin now denied)
 *   A2. Origin hostname matches req.hostname → true (#4 — uses req.hostname not req.get('host'))
 *   A3. origin in allowlist → true
 *   A4. foreign origin not in allowlist → false
 *
 * /session same-origin allowance tests (updated for #4+#5):
 *   SO1. POST /session with no Origin header → 403 (#5 hardening)
 *   SO2. POST /session with same-host Origin → 200 (still allowed via hostname match)
 *
 * /chat same-origin allowance tests (updated for #4+#5):
 *   SO3. POST /chat with no Origin header → 403 (#5 hardening — not 401)
 *   SO4. POST /chat with same-host Origin → reaches token check (401), not 403
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../../config/env.js';
import type { PublicWidget } from '../widgetStore.js';

// ── Mock external dependencies ────────────────────────────────

jest.mock('../widgetStore.js', () => ({
  getWidgetBySlug: jest.fn(),
  isOriginAllowed: jest.fn(),
}));

jest.mock('../widgetToken.js', () => ({
  mintWidgetToken: jest.fn(),
  verifyWidgetToken: jest.fn(),
}));

jest.mock('../../agents/agentStore.js', () => ({
  getAgent: jest.fn(),
  createSession: jest.fn(),
}));

jest.mock('../hardenedChat.js', () => {
  class PublicChatRefused extends Error {
    constructor(reason: string) {
      super(reason);
      this.name = 'PublicChatRefused';
    }
  }
  return { hardenedRunAgentChat: jest.fn(), PublicChatRefused };
});

jest.mock('../../audit/immutableAudit.js', () => ({
  writeImmutableAudit: jest.fn(),
}));

jest.mock('../../agents/agentRunner.js', () => ({
  runAgentChat: jest.fn(),
}));

// ── Import mocked modules ──────────────────────────────────────

import { getWidgetBySlug, isOriginAllowed } from '../widgetStore.js';
import { mintWidgetToken, verifyWidgetToken } from '../widgetToken.js';
import { registerPublicRoutes, isApiRequestAllowed } from '../publicRoutes.js';

// ── Typed mocks ────────────────────────────────────────────────

const mockGetWidgetBySlug = getWidgetBySlug as jest.MockedFunction<typeof getWidgetBySlug>;
const mockIsOriginAllowed = isOriginAllowed as jest.MockedFunction<typeof isOriginAllowed>;
const mockMintWidgetToken = mintWidgetToken as jest.MockedFunction<typeof mintWidgetToken>;
const mockVerifyWidgetToken = verifyWidgetToken as jest.MockedFunction<typeof verifyWidgetToken>;

// ── Constants ──────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://example.com';
const SLUG = 'my-widget';
const AGENT_ID = 42;

// ── Fixtures ───────────────────────────────────────────────────

function makeWidget(overrides: Partial<PublicWidget> = {}): PublicWidget {
  return {
    id: 1,
    agent_id: AGENT_ID,
    slug: SLUG,
    allowed_origins: [ALLOWED_ORIGIN],
    enabled: true,
    greeting: 'Hello from widget!',
    accent: '#7c3aed',
    title: 'Ask Argus',
    input_placeholder: 'Ask a question...',
    launcher_icon_url: null,
    launcher_icon_alt: null,
    launcher_position: 'right',
    rate_limit_per_ip: 60,
    daily_token_cap: 10000,
    created_by: null,
    created_at: new Date(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicWidgetEnabled: true,
    widgetTokenSecret: 'test-secret-32-chars-long-for-hmac',
    widgetTokenTtlSec: 1800,
    turnstileEnabled: false,
    turnstileSecret: '',
    rateLimitPerMinute: 120,
    ...overrides,
  } as Config;
}

// ── App factory ────────────────────────────────────────────────

function buildApp(config: Config) {
  const app = express();
  app.use(express.json());

  type QueryResult = { rows: unknown[]; rowCount: number };
  const poolQueryMock = jest.fn(async (_sql: string, _params?: unknown[]): Promise<QueryResult> =>
    ({ rows: [{ total_tokens: '0' }], rowCount: 1 }),
  );

  const pool = { query: poolQueryMock } as unknown as pg.Pool;

  // Redis stub with incr/expire support for per-widget rate limit (#11) and
  // token pre-debit (#8).  All counters always return 1 (first request, allowed).
  const redisStore = new Map<string, number>();
  const redis = {
    set: jest.fn(async () => 'OK'),
    getdel: jest.fn(async () => null),
    eval: jest.fn(async () => 1),
    incr: jest.fn(async (key: string) => {
      const v = (redisStore.get(key) ?? 0) + 1;
      redisStore.set(key, v);
      return v;
    }),
    incrby: jest.fn(async (key: string, delta: number) => {
      const v = (redisStore.get(key) ?? 0) + delta;
      redisStore.set(key, v);
      return v;
    }),
    decrby: jest.fn(async (key: string, delta: number) => {
      const v = (redisStore.get(key) ?? 0) - delta;
      redisStore.set(key, v);
      return v;
    }),
    expire: jest.fn(async () => 1),
  } as unknown as Redis;

  registerPublicRoutes(app, pool, redis, config);
  return { app, pool, poolQueryMock };
}

async function startServer(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      server.keepAliveTimeout = 0;
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve({
          baseUrl,
          close: () => new Promise<void>((res) => {
            if (typeof (server as { closeAllConnections?: () => void }).closeAllConnections === 'function') {
              (server as { closeAllConnections: () => void }).closeAllConnections();
            }
            server.close(() => res());
          }),
        });
      } else {
        reject(new Error('server did not bind'));
      }
    });
    server.on('error', reject);
  });
}

// ── GET /public/widget/:slug route tests ───────────────────────

describe('GET /public/widget/:slug', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('G1 — master-off → 404', async () => {
    const config = makeConfig({ publicWidgetEnabled: false });
    const { app } = buildApp(config);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('G2 — unknown slug → 404', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(null);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('G3 — valid widget → 200 HTML with #chatMessages but no #agentList', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('id="chatMessages"');
      expect(html).not.toContain('id="agentList"');
      expect(html).not.toContain('id="settingsToggleBtn"');
      expect(html).not.toContain('id="settingsPanel"');
      expect(html).not.toContain('Neue Session');
      expect(html).not.toContain('function renderSettingsPanel');
      expect(html).not.toContain('System Prompt');
      expect(html).toContain('Hello from widget!');
      expect(html).toContain('<title>Ask Argus</title>');
      expect(html).toContain('placeholder="Ask a question..."');
      expect(html).toContain('aria-label="AI interaction notice"');
    } finally { await close(); }
  });

  it('G3b — public widget uses configured AI transparency text', async () => {
    const { app } = buildApp(makeConfig({
      aiTransparencyNoticeEnabled: true,
      aiTransparencyNoticeText: 'Configured AI notice',
    }));
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      expect(await res.text()).toContain('Configured AI notice');
    } finally { await close(); }
  });

  it('G4 — HTML contains /public/widget/:slug/session path (public-token mode)', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      const html = await res.text();
      expect(html).toContain(`/public/widget/${SLUG}/session`);
    } finally { await close(); }
  });

  it('G5 — HTML contains /public/widget/:slug/chat path', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      const html = await res.text();
      expect(html).toContain(`/public/widget/${SLUG}/chat`);
    } finally { await close(); }
  });

  it('G6 — HTML contains Authorization (Bearer token header logic)', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      const html = await res.text();
      expect(html).toContain('Authorization');
    } finally { await close(); }
  });

  it('G7 — HTML contains X-Widget-Token (response token refresh)', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      const html = await res.text();
      expect(html).toContain('X-Widget-Token');
    } finally { await close(); }
  });

  it('G8 — escapes stored greeting markup and ignores an unsafe accent', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget({
      greeting: '</title><script>alert("widget-xss")</script>',
      accent: 'red;}</style><script>alert(1)</script>',
    }));
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}`);
      const html = await res.text();
      expect(html).not.toContain('<script>alert("widget-xss")</script>');
      expect(html).not.toContain('red;}</style>');
      expect(html).toContain('&lt;/title&gt;');
    } finally { await close(); }
  });

  it('G9 — accepts bounded embed branding and escapes customer-facing copy', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValue(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const params = new URLSearchParams({
        accent: '#123456',
        title: 'Acme Assistant',
        greeting: 'Welcome <Acme>',
        placeholder: 'Ask Acme...',
      });
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}?${params}`);
      const html = await res.text();
      expect(html).toContain('<title>Acme Assistant</title>');
      expect(html).toContain('--accent: #123456');
      expect(html).toContain('Welcome &lt;Acme&gt;');
      expect(html).toContain('placeholder="Ask Acme..."');
      expect(html).not.toContain('Welcome <Acme>');
    } finally { await close(); }
  });
});

// ── isApiRequestAllowed unit tests (updated for #4+#5 hardening) ──

describe('isApiRequestAllowed', () => {
  const widget = makeWidget();

  /**
   * makeReq builds a minimal Express.Request stub.
   * @param hostname  The value Express sets as req.hostname (parsed, trusted-proxy aware).
   * @param origin    Optional Origin header value.
   */
  function makeReq(hostname: string, origin?: string): express.Request {
    return {
      headers: { ...(origin !== undefined ? { origin } : {}) },
      // req.hostname is the Express-parsed hostname (no port); it is what
      // isApiRequestAllowed now reads (#4 fix).
      hostname,
      get: (name: string) => {
        // req.get('host') is still present for completeness but is NOT used
        // by the hardened implementation.
        if (name.toLowerCase() === 'host') return hostname;
        return undefined;
      },
    } as unknown as express.Request;
  }

  beforeEach(() => {
    // For same-origin cases, isOriginAllowed should NOT be the deciding factor.
    // For the foreign-origin case, we do need isOriginAllowed to return false.
    mockIsOriginAllowed.mockReturnValue(false);
  });

  it('A1 — no Origin header → false (#5: missing Origin now denied)', () => {
    // #5: Absence of Origin indicates a non-browser client (curl, script).
    // The hardened implementation denies rather than allowing silently.
    const req = makeReq('argus.example.com');
    expect(isApiRequestAllowed(req, widget)).toBe(false);
  });

  it('A2 — Origin hostname matches req.hostname → true (#4: uses req.hostname)', () => {
    // #4: We compare new URL(origin).hostname against req.hostname (not req.get('host')).
    // This is immune to Host-header spoofing.
    const req = makeReq('argus.example.com', 'https://argus.example.com');
    expect(isApiRequestAllowed(req, widget)).toBe(true);
  });

  it('A3 — origin in widget allowlist → true', () => {
    mockIsOriginAllowed.mockReturnValueOnce(true);
    const req = makeReq('argus.example.com', ALLOWED_ORIGIN);
    expect(isApiRequestAllowed(req, widget)).toBe(true);
  });

  it('A4 — foreign origin not in allowlist → false', () => {
    mockIsOriginAllowed.mockReturnValueOnce(false);
    const req = makeReq('argus.example.com', 'https://evil.com');
    expect(isApiRequestAllowed(req, widget)).toBe(false);
  });
});

// ── Same-origin allowance integration tests (updated for #4+#5) ──

describe('POST /public/widget/:slug/session — same-origin allowance', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('SO1 — no Origin header → 403 (#5 hardening: missing Origin now denied)', async () => {
    // #5: A missing Origin header indicates a non-browser client (curl, etc.).
    // Real browser iframes always send Origin on POST — so this is now denied.
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No Origin header
        body: '{}',
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('origin not allowed');
    } finally { await close(); }
  });

  it('SO2 — same-host Origin → still allowed (200): hostname match is unaffected by #4+#5', async () => {
    // #4 fix uses req.hostname; for same-origin iframe new URL(origin).hostname === req.hostname.
    // Legitimate embeds are not broken.
    const { app, poolQueryMock } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockMintWidgetToken.mockResolvedValueOnce('minted.tok2');
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      const addr = new URL(baseUrl);
      // Use just the hostname (no port) to match what a real browser sends when
      // the page was served on the default port.  In test, hostname = '127.0.0.1'.
      const selfOrigin = `http://${addr.hostname}`;
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: selfOrigin },
        body: '{}',
      });
      expect(res.status).toBe(200);
    } finally { spy.mockRestore(); await close(); }
  });
});

describe('POST /public/widget/:slug/chat — same-origin allowance', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('SO3 — no Origin header → 403 (#5 hardening: missing Origin now denied, not 401)', async () => {
    // #5: A missing Origin is now rejected before reaching the token check.
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No Origin header, no Authorization
        body: JSON.stringify({ sessionId: 'x', message: 'hi' }),
      });
      // #5 gate fires first — 403, not 401
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('SO4 — same-host Origin → reaches token check (401), not origin-403', async () => {
    // Same-origin iframe with valid Origin still passes the origin gate.
    // The first failing check after that is the missing Authorization → 401.
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const addr = new URL(baseUrl);
      const selfOrigin = `http://${addr.hostname}`;
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: selfOrigin },
        // No Authorization
        body: JSON.stringify({ sessionId: 'x', message: 'hi' }),
      });
      // Per-widget rate limit passes (fresh counter = 1 < ceiling).
      // Token check fails → 401 (not 403).
      expect(res.status).toBe(401);
    } finally { await close(); }
  });
});
