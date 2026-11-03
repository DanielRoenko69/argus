/**
 * publicRoutes.test.ts — TDD for P3-7 + P3-8 + pentest hardening
 *
 * Uses: express + node:http + native fetch (same pattern as copilotRoutes.test.ts).
 * No supertest — not in the project's devDependencies.
 *
 * Tests (all stubs — no live DB/Redis/LLM):
 *
 * /public/widget/:slug/session
 *   S1. master-off (publicWidgetEnabled=false) → 404
 *   S2. unknown slug (getWidgetBySlug returns null) → 404
 *   S3. bad origin (not in allowlist) → 403
 *   S4. rate-limit exceeded → 429
 *   S5. happy path → 200 { token, sessionId, greeting, accent }
 *   S6. turnstile enabled, missing captcha_token → 403
 *   S7. turnstile enabled, captcha verify fails → 403
 *   S8. turnstile disabled, no captcha_token → 200
 *
 * /public/widget/:slug/chat
 *   C1. master-off → 404
 *   C2. unknown slug → 404
 *   C3. bad origin → 403
 *   C4. missing Authorization header → 401
 *   C5. invalid/expired token (verifyWidgetToken returns {ok:false}) → 401
 *   C6. rate-limit exceeded (after token check) → 429
 *   C7. daily token cap reached → 429
 *   C8. empty/missing message → 400
 *   C9. happy path — SSE stream, X-Widget-Token header set, audit written
 *
 * Pentest hardening (#4/#5/#8/#11):
 *   H4.  Host-header spoof — Origin=attacker.com + Host=argus → denied
 *   H5a. Missing Origin on /session POST → denied
 *   H5b. Missing Origin on /chat POST → denied (before token check)
 *   H5c. Same-origin iframe POST (Origin = server hostname) → allowed (#4+#5 regression)
 *   H8a. Redis daily-cap pre-debit blocks second concurrent request over the cap
 *   H8b. Redis unavailable → fail closed (503)
 *   H11a. Per-widget rate limit blocks when slug counter exceeds ceiling
 *   H11b. Per-widget Redis unavailable → fail closed (503)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import express from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../../config/env.js';
import type { PublicWidget } from '../widgetStore.js';
import type { AgentWithRag } from '../../agents/types.js';

// ── Mock all external dependencies ────────────────────────────

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
  return {
    hardenedRunAgentChat: jest.fn(),
    PublicChatRefused,
  };
});

jest.mock('../../audit/immutableAudit.js', () => ({
  writeImmutableAudit: jest.fn(),
}));

// agentRunner is dynamically imported inside publicRoutes — mock at module level
jest.mock('../../agents/agentRunner.js', () => ({
  runAgentChat: jest.fn(),
}));

// ── Import mocked modules ──────────────────────────────────────

import { getWidgetBySlug, isOriginAllowed } from '../widgetStore.js';
import { mintWidgetToken, verifyWidgetToken } from '../widgetToken.js';
import { getAgent } from '../../agents/agentStore.js';
import { hardenedRunAgentChat } from '../hardenedChat.js';
import { writeImmutableAudit } from '../../audit/immutableAudit.js';
import { registerPublicRoutes } from '../publicRoutes.js';

// ── Typed mocks ───────────────────────────────────────────────

const mockGetWidgetBySlug = getWidgetBySlug as jest.MockedFunction<typeof getWidgetBySlug>;
const mockIsOriginAllowed = isOriginAllowed as jest.MockedFunction<typeof isOriginAllowed>;
const mockMintWidgetToken = mintWidgetToken as jest.MockedFunction<typeof mintWidgetToken>;
const mockVerifyWidgetToken = verifyWidgetToken as jest.MockedFunction<typeof verifyWidgetToken>;
const mockGetAgent = getAgent as jest.MockedFunction<typeof getAgent>;
const mockHardenedRunAgentChat = hardenedRunAgentChat as jest.MockedFunction<typeof hardenedRunAgentChat>;
const mockWriteImmutableAudit = writeImmutableAudit as jest.MockedFunction<typeof writeImmutableAudit>;

// ── Constants ─────────────────────────────────────────────────

const ALLOWED_ORIGIN = 'https://example.com';
const SLUG = 'my-widget';
const AGENT_ID = 42;
const SESSION_ID = 'sess-abc123';
const FRESH_TOKEN = 'fresh.token.sig';

// ── Fixtures ──────────────────────────────────────────────────

function makeWidget(overrides: Partial<PublicWidget> = {}): PublicWidget {
  return {
    id: 1,
    agent_id: AGENT_ID,
    slug: SLUG,
    allowed_origins: [ALLOWED_ORIGIN],
    enabled: true,
    greeting: 'Hello from widget!',
    accent: '#FF0000',
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

function makeAgent(): AgentWithRag {
  return {
    id: AGENT_ID,
    name: 'public-bot',
    label: 'Public Bot',
    description: '',
    model: 'gpt-4o',
    temperature: 0.7,
    max_tokens: 2048,
    system_prompt: 'You are a helpful assistant.',
    agent_role: null,
    composite_id: null,
    composite_name: null,
    gitea_project: null,
    enabled: true,
    max_iterations: 5,
    created_by: null,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    agent_mode: 'chat',
    task_type: null,
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: null,
    bitbucket_repo: null,
    bundle_ids: null,
    llm_api_key: null,
    thinking_budget: 0,
    untrusted_tool_output_enforcement: false,
    entra_object_id: null,
    entra_app_id: null,
    entra_blueprint_id: null,
    entra_synced_at: null,
    entra_sync_error: null,
    codegraph_enabled: false,
    visibility: 'public',
    rag_indexes: [],
    skills: [],
  } as unknown as AgentWithRag;
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

// ── App factory ───────────────────────────────────────────────

/**
 * In-memory Redis stub — supports the subset of ioredis commands used by
 * publicRoutes (INCRBY, DECRBY, EXPIRE, SET, GETDEL, EVAL for rate-limiter).
 * Returned as { redisMock, store } so tests can pre-seed counters.
 */
function makeRedisMock(opts: {
  /** If true, all commands throw (simulates Redis being unavailable). */
  unavailable?: boolean;
} = {}): { redisMock: Redis; store: Map<string, number> } {
  const store = new Map<string, number>();

  const throwIfDown = () => {
    if (opts.unavailable) throw new Error('Redis connection refused');
  };

  const redisMock = {
    // Used by widgetToken (mint/verify)
    set: jest.fn(async () => { throwIfDown(); return 'OK'; }),
    getdel: jest.fn(async () => { throwIfDown(); return null; }),
    // Used by RateLimiter (sliding window Lua eval) — allow by default
    eval: jest.fn(async () => { throwIfDown(); return 1; }),
    // Atomic counter for token pre-debit (incrby) and per-widget rate limit
    incrby: jest.fn(async (key: string, delta: number) => {
      throwIfDown();
      const cur = (store.get(key) ?? 0) + delta;
      store.set(key, cur);
      return cur;
    }),
    decrby: jest.fn(async (key: string, delta: number) => {
      throwIfDown();
      const cur = (store.get(key) ?? 0) - delta;
      store.set(key, cur);
      return cur;
    }),
    incr: jest.fn(async (key: string) => {
      throwIfDown();
      const cur = (store.get(key) ?? 0) + 1;
      store.set(key, cur);
      return cur;
    }),
    expire: jest.fn(async () => { throwIfDown(); return 1; }),
  } as unknown as Redis;

  return { redisMock, store };
}

/**
 * Build a minimal Express app with publicRoutes registered.
 * poolQueryMock is a controllable jest mock function — callers may use
 * poolQueryMock.mockResolvedValueOnce(...) without any cast.
 */
function buildApp(config: Config, redisOpts?: Parameters<typeof makeRedisMock>[0]) {
  const app = express();
  app.use(express.json());

  // Use a typed wrapper so callers can call .mockResolvedValueOnce without casts.
  type QueryResult = { rows: unknown[]; rowCount: number };
  const poolQueryMock = jest.fn(async (_sql: string, _params?: unknown[]): Promise<QueryResult> =>
    ({ rows: [{ total_tokens: '0' }], rowCount: 1 }),
  );

  const pool = { query: poolQueryMock } as unknown as pg.Pool;

  const { redisMock, store: redisStore } = makeRedisMock(redisOpts ?? {});

  registerPublicRoutes(app, pool, redisMock, config);

  return { app, pool, poolQueryMock, redisMock, redisStore };
}

/** Start server on a random port, return baseUrl + close fn. */
async function startServer(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      // Disable keep-alive so connections close immediately after each response,
      // allowing server.close() to resolve without waiting for idle sockets.
      server.keepAliveTimeout = 0;
      const addr = server.address();
      if (typeof addr === 'object' && addr) {
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve({
          baseUrl,
          close: () => new Promise<void>((res) => {
            // closeAllConnections() (Node 18.2+) force-closes any remaining sockets.
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

// ── /session tests ─────────────────────────────────────────────

describe('POST /public/widget/:slug/session', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('S1 — master-off → 404', async () => {
    const config = makeConfig({ publicWidgetEnabled: false });
    const { app } = buildApp(config);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('S2 — unknown slug → 404', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(null);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('S3 — bad origin → 403 with error body', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(false);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
        body: '{}',
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('origin not allowed');
    } finally { await close(); }
  });

  it('S4 — rate-limit exceeded → 429', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(false);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      expect(res.status).toBe(429);
    } finally { spy.mockRestore(); await close(); }
  });

  it('S5 — happy path → 200 with token, sessionId, greeting, accent', async () => {
    const { app, poolQueryMock } = buildApp(makeConfig());
    const widget = makeWidget();
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockMintWidgetToken.mockResolvedValueOnce('minted.token.value');
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { token: string; sessionId: string; greeting: string | null; accent: string | null };
      expect(body.token).toBe('minted.token.value');
      expect(typeof body.sessionId).toBe('string');
      expect(body.sessionId.length).toBeGreaterThan(0);
      expect(body.greeting).toBe(widget.greeting);
      expect(body.accent).toBe(widget.accent);
    } finally { spy.mockRestore(); await close(); }
  });

  it('S6 — turnstile enabled, missing captcha_token → 403', async () => {
    const { app } = buildApp(makeConfig({ turnstileEnabled: true, turnstileSecret: 'ts-secret' }));
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}', // no captcha_token
      });
      expect(res.status).toBe(403);
    } finally { spy.mockRestore(); await close(); }
  });

  it('S7 — turnstile enabled, captcha verify fails → 403', async () => {
    // When turnstile is enabled and the Cloudflare verification fails (network
    // error or {success:false}), the route must return 403.
    //
    // Strategy: verifyTurnstile() has a try/catch that returns false on any
    // network error. We SELECTIVELY mock global.fetch so ONLY the Cloudflare
    // siteverify call rejects instantly (→ caught → false → 403), while the
    // test's own request to the local server passes through to the real fetch.
    // This removes the real-network dependency that made this test flake under
    // parallel load (a real fetch to challenges.cloudflare.com could take >5s to
    // fail on a restricted network), making the verdict fast and deterministic.
    const { app } = buildApp(makeConfig({ turnstileEnabled: true, turnstileSecret: 'ts-secret' }));
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const realFetch = global.fetch;
    const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((input, init?) => {
      if (String(input).includes('challenges.cloudflare.com')) {
        return Promise.reject(new Error('turnstile network blocked in test'));
      }
      return realFetch(input as Parameters<typeof realFetch>[0], init);
    });
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: JSON.stringify({ captcha_token: 'bad-token' }),
      });
      // verifyTurnstile's siteverify fetch rejects → caught → false → 403
      expect(res.status).toBe(403);
    } finally { fetchSpy.mockRestore(); spy.mockRestore(); await close(); }
  });

  it('S8 — turnstile disabled, no captcha_token → 200', async () => {
    const { app, poolQueryMock } = buildApp(makeConfig({ turnstileEnabled: false }));
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockMintWidgetToken.mockResolvedValueOnce('tok.en.value');
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}', // no captcha_token — turnstile disabled
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { token: string };
      expect(body.token).toBe('tok.en.value');
    } finally { spy.mockRestore(); await close(); }
  });
});

// ── /chat tests ───────────────────────────────────────────────

describe('POST /public/widget/:slug/chat', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('C1 — master-off → 404', async () => {
    const { app } = buildApp(makeConfig({ publicWidgetEnabled: false }));
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer some.token' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('C2 — unknown slug → 404', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(null);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer some.token' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('C3 — bad origin → 403', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(false);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com', Authorization: 'Bearer some.token' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('C4 — missing Authorization → 401', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        // No Authorization header
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(401);
    } finally { await close(); }
  });

  it('C5 — invalid/expired token → 401 with reason', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({ ok: false, reason: 'expired' });
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer expired.token.value' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(401);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('expired');
    } finally { await close(); }
  });

  it('C6 — rate-limit exceeded (after token check) → 429', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(false);
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer valid.token.value' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(429);
    } finally { spy.mockRestore(); await close(); }
  });

  it('C7 — daily token cap reached → 429 with friendly error', async () => {
    const widget = makeWidget({ daily_token_cap: 1000 });
    const { app, poolQueryMock } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);

    // Daily cap query returns total >= cap
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ total_tokens: '1000' }],
      rowCount: 1,
    });

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer valid.token.value' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(429);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('daily limit reached');
    } finally { spy.mockRestore(); await close(); }
  });

  it('C8 — empty message → 400', async () => {
    const { app, poolQueryMock } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);

    // Daily cap not reached
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ total_tokens: '0' }],
      rowCount: 1,
    });

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN, Authorization: 'Bearer valid.token.value' },
        body: JSON.stringify({ sessionId: SESSION_ID, message: '' }), // empty
      });
      expect(res.status).toBe(400);
    } finally { spy.mockRestore(); await close(); }
  });

  it('C9 — happy path: SSE stream, X-Widget-Token header, audit written with ip_hash not raw IP', async () => {
    const { app, poolQueryMock } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });
    mockGetAgent.mockResolvedValueOnce(makeAgent());
    mockMintWidgetToken.mockResolvedValueOnce(FRESH_TOKEN);

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);

    // Daily cap not reached
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ total_tokens: '0' }],
      rowCount: 1,
    });

    // hardenedRunAgentChat yields chunks then ends
    (mockHardenedRunAgentChat as jest.Mock).mockImplementationOnce(async function* () {
      yield 'data: {"content":"hello"}\n\n';
      yield 'data: [DONE]\n\n';
    });

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          Authorization: 'Bearer valid.token.value',
        },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Tell me something' }),
      });

      // SSE content-type
      expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

      // Fresh token for next turn MUST be in the response header
      expect(res.headers.get('x-widget-token')).toBe(FRESH_TOKEN);

      // Drain the body
      await res.text();

      // writeImmutableAudit must have been called (fire-and-forget — allow one tick)
      await new Promise(r => setTimeout(r, 10));

      expect(mockWriteImmutableAudit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          eventType: 'agent_public_chat',
          apiKeyPrefix: `public:${SLUG}`,
          model: 'public-widget',
        }),
      );

      // Verify IP is hashed, not raw
      const auditCall = mockWriteImmutableAudit.mock.calls[0];
      const auditEntry = auditCall?.[1] as { requesterIp?: string } | undefined;
      // Raw IPs should NOT appear
      expect(auditEntry?.requesterIp).not.toBe('127.0.0.1');
      expect(auditEntry?.requesterIp).not.toBe('::1');
      expect(auditEntry?.requesterIp).not.toBe('::ffff:127.0.0.1');
      // Must be a non-empty string (the HMAC hash)
      expect(typeof auditEntry?.requesterIp).toBe('string');
      expect((auditEntry?.requesterIp ?? '').length).toBeGreaterThan(10);
    } finally { spy.mockRestore(); await close(); }
  });
});

// ── Pentest hardening tests (#4/#5/#8/#11) ────────────────────

describe('isApiRequestAllowed — pentest hardening', () => {
  // Re-use the real isApiRequestAllowed implementation (not mocked at module level).
  // We test it via the HTTP endpoints so the full gate chain fires.
  beforeEach(() => { jest.clearAllMocks(); });

  // ── #4: Host-header spoof ─────────────────────────────────────
  it('H4 — Origin=attacker.com with spoofed Host header → 403 (session)', async () => {
    const { app } = buildApp(makeConfig());
    // Widget allows only ALLOWED_ORIGIN
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    // isOriginAllowed (allowlist check) should return false for attacker
    mockIsOriginAllowed.mockReturnValueOnce(false);
    const { baseUrl, close } = await startServer(app);
    try {
      // Attacker sends Origin=attacker.com; the Host header they send is irrelevant
      // once we fix #4 (we use req.hostname not req.get('host')).
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://attacker.com',
          // Host header is set by fetch to 127.0.0.1:<port> — with the old bug
          // new URL('https://attacker.com').host !== req.get('host') so it falls
          // through to allowlist — isOriginAllowed returns false → 403.
          // With the fix, req.hostname is used; attacker.com !== 127.0.0.1 → not
          // same-origin, isOriginAllowed(false) → 403.
        },
        body: '{}',
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('origin not allowed');
    } finally { await close(); }
  });

  // ── #5: Missing Origin → denied ───────────────────────────────
  it('H5a — missing Origin on /session POST → 403', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // No Origin header — direct curl-style call, not from a browser
        body: '{}',
      });
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('origin not allowed');
    } finally { await close(); }
  });

  it('H5b — missing Origin on /chat POST → 403', async () => {
    const { app } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(makeWidget());
    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer some.token' },
        // No Origin header
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      expect(res.status).toBe(403);
    } finally { await close(); }
  });

  it('H5c — same-origin iframe POST (Origin = server hostname) → still allowed [regression]', async () => {
    const { app, poolQueryMock } = buildApp(makeConfig());
    const widget = makeWidget();
    // The request comes from the iframe on the same Argus host.
    // isOriginAllowed will NOT be called (same-origin path short-circuits).
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    // mockIsOriginAllowed must NOT be called for same-origin — so no mock needed.
    mockMintWidgetToken.mockResolvedValueOnce('minted.same-origin.token');
    poolQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);
    const { baseUrl, close } = await startServer(app);
    try {
      // Extract just the host part (127.0.0.1:PORT) to construct the same-origin value
      const url = new URL(baseUrl);
      const sameOrigin = `${url.protocol}//${url.host}`;

      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: sameOrigin,  // matches req.hostname (sans port) via fix #4
        },
        body: '{}',
      });
      // Should succeed (same-origin iframe is always allowed)
      expect(res.status).toBe(200);
    } finally { spy.mockRestore(); await close(); }
  });
});

// ── #8: Daily-cap TOCTOU — Redis pre-debit ────────────────────

describe('#8 Daily token cap — Redis pre-debit', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('H8a — concurrent request that tips over the cap → 429', async () => {
    const dailyCap = 5000;
    const widget = makeWidget({ daily_token_cap: dailyCap });

    // Pre-seed the Redis counter to just below the cap so that the reserve
    // (message.length/4 + 1000) will push it over.
    const message = 'Hello';
    const reserve = Math.ceil(message.length / 4) + 1000; // = 1002 for 5-char msg

    // We build the app with our controllable redis store
    const { app, poolQueryMock, redisMock, redisStore } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });

    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);

    // Pre-seed: put counter at (cap - reserve + 1) so the INCRBY tips over
    const todayKey = `widget:tokens:${SLUG}:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
    redisStore.set(todayKey, dailyCap - reserve + 1);

    // Pool query is for session INSERT + daily cap audit (but Redis wins)
    poolQueryMock.mockResolvedValue({ rows: [{ total_tokens: '0' }], rowCount: 1 });

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          Authorization: 'Bearer valid.token.value',
        },
        body: JSON.stringify({ sessionId: SESSION_ID, message }),
      });
      expect(res.status).toBe(429);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('daily limit reached');
    } finally { spy.mockRestore(); await close(); }
  });

  it('H8b — Redis unavailable for cap check → fail closed (503)', async () => {
    const widget = makeWidget({ daily_token_cap: 5000 });
    const { app, poolQueryMock } = buildApp(makeConfig(), { unavailable: true });
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);
    mockVerifyWidgetToken.mockResolvedValueOnce({
      ok: true,
      payload: { slug: SLUG, agentId: AGENT_ID, origin: ALLOWED_ORIGIN.toLowerCase() },
    });

    // RateLimiter falls back to in-memory when Redis is unavailable — allow it
    const { RateLimiter } = await import('../../lib/rateLimiter.js');
    const spy = jest.spyOn(RateLimiter.prototype, 'isAllowed').mockResolvedValueOnce(true);

    poolQueryMock.mockResolvedValue({ rows: [{ total_tokens: '0' }], rowCount: 1 });

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ALLOWED_ORIGIN,
          Authorization: 'Bearer valid.token.value',
        },
        body: JSON.stringify({ sessionId: SESSION_ID, message: 'Hello' }),
      });
      // Fail closed: Redis down → deny
      expect(res.status).toBe(503);
    } finally { spy.mockRestore(); await close(); }
  });
});

// ── #11: Per-widget rate limit ────────────────────────────────

describe('#11 Per-widget rate limit (Redis)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('H11a — per-widget minute counter exceeds ceiling → 429', async () => {
    const widget = makeWidget({ rate_limit_per_ip: 10 }); // ceiling = 10*10 = 100/min
    const { app, redisStore } = buildApp(makeConfig());
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);

    // Pre-seed the per-widget counter above the ceiling
    const minute = Math.floor(Date.now() / 60_000);
    const widgetRlKey = `widget:rl:${SLUG}:${minute}`;
    redisStore.set(widgetRlKey, 100); // already at ceiling

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      expect(res.status).toBe(429);
      const body = await res.json() as { error: string };
      expect(body.error).toBe('widget rate limit exceeded');
    } finally { await close(); }
  });

  it('H11b — Redis unavailable for per-widget limit → fail closed (503)', async () => {
    const widget = makeWidget();
    const { app } = buildApp(makeConfig(), { unavailable: true });
    mockGetWidgetBySlug.mockResolvedValueOnce(widget);
    mockIsOriginAllowed.mockReturnValueOnce(true);

    const { baseUrl, close } = await startServer(app);
    try {
      const res = await fetch(`${baseUrl}/public/widget/${SLUG}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: ALLOWED_ORIGIN },
        body: '{}',
      });
      // Fail closed: Redis down → deny
      expect(res.status).toBe(503);
    } finally { await close(); }
  });
});
