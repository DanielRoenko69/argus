/**
 * publicRoutes.ts — P3-7 + P3-8
 *
 * Registers the public anonymous widget routes under /public/widget/:slug/...
 *
 * SECURITY INVARIANTS (in order, enforced at the top of EVERY handler):
 *   1. Master switch — publicWidgetEnabled=false → 404 (hard gate)
 *   2. Widget lookup — getWidgetBySlug triple gate (widget.enabled AND
 *      agent.visibility='public' AND agent.enabled) → 404
 *   3. Origin check — isOriginAllowed → 403
 *   4. Per-IP rate-limit (keyed slug:ip) — over → 429
 *   5. /session only: Turnstile CAPTCHA (when enabled) → 403
 *   6. /chat only: single-use token verification → 401
 *   7. /chat only: daily-token cap → 429
 *
 * Never logs raw IP — only HMAC-SHA256 hash.
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import pg from 'pg';
import type { Redis } from 'ioredis';
import type { Config } from '../config/env.js';
import { getWidgetBySlug, isOriginAllowed, type PublicWidget } from './widgetStore.js';
import { mintWidgetToken, verifyWidgetToken } from './widgetToken.js';
import { hardenedRunAgentChat, PublicChatRefused } from './hardenedChat.js';
import { getAgent } from '../agents/agentStore.js';
import { writeImmutableAudit } from '../audit/immutableAudit.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { logger } from '../lib/logger.js';
import { CSS_VARS } from '../shared/navHtml.js';
import { chatCoreCss, chatCoreMarkup, chatCoreScript } from '../agents/chat/chatCore.js';

// ── Per-slug rate-limiter registry ────────────────────────────
// One RateLimiter instance per widget rate_limit_per_ip value, reused across
// requests. LRU eviction is not needed — the number of distinct rate limits is
// bounded by the number of widgets (typically small).
const rateLimiters = new Map<number, RateLimiter>();

function getRateLimiter(ratePerMin: number): RateLimiter {
  let rl = rateLimiters.get(ratePerMin);
  if (!rl) {
    rl = new RateLimiter(ratePerMin);
    rateLimiters.set(ratePerMin, rl);
  }
  return rl;
}

// ── IP hashing ────────────────────────────────────────────────

function hashIp(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(ip).digest('hex');
}

// ── API origin check — Task 9c (hardened: #4 + #5) ───────────
//
// Security model:
//   The embedding gate is frame-ancestors CSP (set by publicCspMiddleware on the
//   GET page response). That is browser-enforced and non-spoofable.
//
//   For the same-origin /session and /chat API calls made BY the widget iframe,
//   the browser sends Origin = Argus origin (same as the server's host), NOT a
//   host listed in allowed_origins. We therefore allow:
//     - requests whose Origin HOSTNAME matches req.hostname (same-origin iframe fetch)
//     - requests whose Origin ∈ widget.allowed_origins (cross-origin embed)
//
//   SECURITY (#5): Missing Origin is now DENIED. A browser POST always sends
//   Origin; its absence indicates a direct/non-browser client (curl, scripts, etc.)
//   that should not bypass origin enforcement. Legitimate same-origin iframe POSTs
//   are unaffected because browsers always send Origin on cross-site and same-site
//   cross-origin POST requests; the same-origin short-circuit below handles them.
//
//   SECURITY (#4): We compare new URL(origin).hostname against req.hostname
//   (Express-parsed; honours X-Forwarded-Host from trusted proxy only), NOT
//   against req.get('host') which is fully attacker-controllable. We use
//   .hostname (no port) on both sides so port differences are normalised.
//
export function isApiRequestAllowed(req: Request, widget: PublicWidget): boolean {
  const rawOrigin = req.headers['origin'];
  const origin: string | undefined = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;

  // #5 — Missing Origin: non-browser clients (curl, scripts) omit Origin on
  // POST requests.  A real browser iframe ALWAYS sends Origin on a POST, so a
  // missing Origin here means this is not a legitimate in-browser widget call.
  // Deny to close the curl-with-no-Origin bypass.
  if (!origin) return false;

  // Same-origin (#4 fix): compare .hostname (no port) so we are immune to an
  // attacker setting Host: argus.internal in their request — we read
  // req.hostname which Express derives from the trusted-proxy chain, not the
  // raw Host header value.
  try {
    const originHostname = new URL(origin).hostname;
    if (originHostname === req.hostname) return true;
  } catch {
    // Malformed origin → fall through to allowlist check
  }

  // Allowlisted external origin (cross-origin embed from a permitted host page).
  return isOriginAllowed(widget, origin);
}

// ── Public widget page HTML builder — Task 9a ──────────────────

function escapePublicHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

function publicScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

interface PublicWidgetBranding {
  accent?: string;
  title?: string;
  greeting?: string;
  placeholder?: string;
}

function boundedQueryText(value: unknown, maxLength: number): string | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') return undefined;
  const normalized = candidate.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function publicWidgetBranding(query: Request['query']): PublicWidgetBranding {
  const accent = boundedQueryText(query['accent'], 7);
  const title = boundedQueryText(query['title'], 80);
  const greeting = boundedQueryText(query['greeting'], 500);
  const placeholder = boundedQueryText(query['placeholder'], 160);
  return {
    ...(accent && /^#[0-9a-fA-F]{6}$/.test(accent) ? { accent } : {}),
    ...(title ? { title } : {}),
    ...(greeting ? { greeting } : {}),
    ...(placeholder ? { placeholder } : {}),
  };
}

function accentChannels(accent: string): string {
  return [accent.slice(1, 3), accent.slice(3, 5), accent.slice(5, 7)]
    .map(channel => Number.parseInt(channel, 16))
    .join(', ');
}

function buildPublicWidgetPage(slug: string, widget: PublicWidget, config: Config, branding: PublicWidgetBranding = {}): string {
  const features = { sessions: false, attachments: false, modelOverride: false } as const;
  const storedAccent = widget.accent && /^#[0-9a-fA-F]{6}$/.test(widget.accent) ? widget.accent : null;
  const safeAccent = branding.accent ?? storedAccent ?? '#111318';
  const accentRgb = accentChannels(safeAccent);
  const title = branding.title ?? widget.title ?? 'Assistant';
  const greeting = branding.greeting ?? widget.greeting;

  const agentsJson = publicScriptJson([{
    id: widget.agent_id,
    label: title,
  }]);

  const markup = chatCoreMarkup({
    features,
    showAgentList: false,
    visitorMode: true,
    welcomeMessage: greeting,
    inputPlaceholder: branding.placeholder ?? widget.input_placeholder ?? 'Write a message…',
    aiTransparency: {
      enabled: config.aiTransparencyNoticeEnabled !== false,
      notice: config.aiTransparencyNoticeText
        || 'You are interacting with an AI agent. Responses may be inaccurate; verify important information and review tool actions before approval.',
    },
  });
  const script = chatCoreScript({
    authMode: 'public-token',
    features,
    visitorMode: true,
    sessionsApiBase: '',
    publicSlug: slug,
    agentsJson,
  });

  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapePublicHtml(title)}</title>
  <style>
    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }
    ${CSS_VARS}
    html, body { height: 100%; width: 100%; overflow: hidden; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; font-size: 13px; }
    .agents-root { height: 100%; width: 100%; }
    :root {
      --accent: ${safeAccent};
      --accent-light: color-mix(in srgb, ${safeAccent} 62%, white);
      --accent-glow: rgba(${accentRgb}, .12);
    }
    ${chatCoreCss}
    .visitor-welcome .msg-bubble { border-color: rgba(${accentRgb}, .22); }
    .msg.user .msg-bubble { background: rgba(${accentRgb}, .12); border-color: rgba(${accentRgb}, .24); }
    .msg.assistant .msg-avatar { color: var(--accent-light); border-color: rgba(${accentRgb}, .24); }
    .ai-transparency-badge { color: var(--accent-light); background: rgba(${accentRgb}, .10); }
    .chat-input-box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(${accentRgb}, .10); }
    .chat-send-btn:hover { background: color-mix(in srgb, ${safeAccent} 82%, black); }
  </style>
</head>
<body>
  ${markup}
  <script>
    // Auto-select the single agent on load
    document.addEventListener('DOMContentLoaded', function() {
      selectAgent(${widget.agent_id});
    });
    ${script}
  </script>
</body>
</html>`;
}

// ── Turnstile verification ────────────────────────────────────

async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string,
): Promise<boolean> {
  try {
    const body = new URLSearchParams({
      secret,
      response: token,
      remoteip: ip,
    });
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body,
    });
    if (!resp.ok) return false;
    const json = await resp.json() as { success?: boolean };
    return json.success === true;
  } catch {
    return false;
  }
}

// ── Route helpers ─────────────────────────────────────────────

/** Extract Bearer token from Authorization header. Returns null if absent/malformed. */
function extractBearer(req: Request): string | null {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7).trim();
  return token || null;
}

// ── Per-widget rate limit (#11) ───────────────────────────────
//
// In addition to the per-IP sliding-window limit (handled by RateLimiter), we
// enforce an absolute per-widget-per-minute ceiling using a Redis INCR counter.
// This prevents a botnet spread across many IPs from overwhelming a single widget.
//
// Key:  widget:rl:<slug>:<unixMinute>
// Cap:  widget.rate_limit_per_ip * 10  (sane default; e.g. 20 rps → 200/min)
//
// FAIL CLOSED: if Redis is unavailable the request is denied (503) rather than
// silently bypassing the gate.
//
async function checkWidgetRateLimit(
  redis: Redis,
  slug: string,
  ceiling: number,
): Promise<{ allowed: boolean; redisDown: boolean }> {
  const minute = Math.floor(Date.now() / 60_000);
  const key = `widget:rl:${slug}:${minute}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      // First request this minute — set TTL so keys expire automatically
      await redis.expire(key, 60);
    }
    return { allowed: count <= ceiling, redisDown: false };
  } catch {
    return { allowed: false, redisDown: true };
  }
}

// ── Daily token cap — Redis atomic pre-debit (#8) ─────────────
//
// Guard 7 previously SUMmed audit rows BEFORE streaming and wrote the row
// AFTER, creating a TOCTOU window where concurrent requests all passed the
// check and collectively blew the cap.
//
// Fix: use a Redis counter as the enforcement mechanism:
//   Key:   widget:tokens:<slug>:<YYYYMMDD-UTC>   (daily, 26h TTL)
//   Flow:  INCRBY reserve → if total > cap DECRBY reserve + return 429
//          After turn: INCRBY (actual - reserve) to reconcile
//
// FAIL CLOSED: Redis unavailable → deny (503).
//
export const WIDGET_OUTPUT_TOKEN_RESERVE = 1000;

function dailyTokenKey(slug: string): string {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // YYYYMMDD UTC
  return `widget:tokens:${slug}:${d}`;
}

/**
 * Atomically pre-debit `reserve` tokens for this widget day.
 * Returns { allowed:false, redisDown:true } if Redis is unavailable.
 * Returns { allowed:false, redisDown:false } if the cap would be exceeded.
 * Returns { allowed:true }                  if the debit succeeded.
 *
 * Callers MUST call reconcileDailyTokens() after the turn completes
 * (passing the actual vs reserve difference) regardless of success/failure.
 */
async function preDebitDailyTokens(
  redis: Redis,
  slug: string,
  reserve: number,
  cap: number,
): Promise<{ allowed: boolean; redisDown: boolean }> {
  const key = dailyTokenKey(slug);
  try {
    const total = await redis.incrby(key, reserve);
    if (total === reserve) {
      // First increment today — set a 26h TTL so the key expires automatically
      await redis.expire(key, 26 * 3600);
    }
    if (total > cap) {
      // Over cap — roll back the reservation and reject
      await redis.decrby(key, reserve);
      return { allowed: false, redisDown: false };
    }
    return { allowed: true, redisDown: false };
  } catch {
    return { allowed: false, redisDown: true };
  }
}

/**
 * Reconcile the daily counter after the turn: adjust by (actual - reserve).
 * May result in a INCRBY (actual > reserve) or DECRBY (actual < reserve).
 * Fire-and-forget: errors are swallowed — the audit row is the durable record.
 */
async function reconcileDailyTokens(
  redis: Redis,
  slug: string,
  actualTokens: number,
  reserve: number,
): Promise<void> {
  const diff = actualTokens - reserve;
  if (diff === 0) return;
  const key = dailyTokenKey(slug);
  try {
    if (diff > 0) await redis.incrby(key, diff);
    else await redis.decrby(key, -diff);
  } catch {
    // Swallow — reconciliation is best-effort; the audit row is the truth
  }
}

// ── Main export ───────────────────────────────────────────────

export function registerPublicRoutes(
  app: Application,
  pool: pg.Pool,
  redis: Redis,
  config: Config,
): void {

  // ──────────────────────────────────────────────────────────────
  // GET /public/widget/:slug  — Task 9a
  // Serves a bare chrome-less HTML page that mounts the widget chat
  // in public-token mode. The host page embeds this in an <iframe>.
  //
  // The browser-enforced frame-ancestors CSP (set by publicCspMiddleware
  // on this response) controls who may embed — that is the non-spoofable
  // embedding gate. Do NOT add X-Frame-Options or framing headers here.
  // ──────────────────────────────────────────────────────────────
  app.get('/public/widget/:slug', async (req: Request, res: Response): Promise<void> => {
    // Guard 1: master switch
    if (!config.publicWidgetEnabled) { res.status(404).end(); return; }

    const slug = String(req.params['slug'] ?? '');

    // Guard 2: widget lookup (triple gate)
    const widget = await getWidgetBySlug(pool, slug).catch(() => null);
    if (!widget) { res.status(404).end(); return; }

    // Serve the public chat page
    res.type('html').send(buildPublicWidgetPage(slug, widget, config, publicWidgetBranding(req.query)));
  });

  // ──────────────────────────────────────────────────────────────
  // POST /public/widget/:slug/session
  // Creates an anonymous public session and returns a single-use token.
  // ──────────────────────────────────────────────────────────────
  app.post('/public/widget/:slug/session', async (req: Request, res: Response): Promise<void> => {
    // Guard 1: master switch
    if (!config.publicWidgetEnabled) { res.status(404).end(); return; }

    const slug = String(req.params['slug'] ?? '');

    // Guard 2: widget lookup (triple gate)
    const widget = await getWidgetBySlug(pool, slug).catch(() => null);
    if (!widget) { res.status(404).end(); return; }

    // Guard 3: origin check (Task 9c, hardened #4+#5)
    // Deny if Origin is absent (non-browser/direct client).
    // Allow if Origin hostname = req.hostname (same-origin iframe fetch).
    // Allow if Origin ∈ widget.allowed_origins (cross-origin embed).
    // See isApiRequestAllowed for full security model comment.
    if (!isApiRequestAllowed(req, widget)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }

    // Normalise origin for downstream use (session creation, token binding)
    const rawOriginHeader = req.headers['origin'];
    const origin: string | undefined = Array.isArray(rawOriginHeader)
      ? rawOriginHeader[0]
      : rawOriginHeader;

    // Guard 3b: per-widget rate limit (#11) — atomic Redis INCR, fail closed
    // Applied BEFORE per-IP check to stop botnets across many IPs.
    const widgetCeiling = widget.rate_limit_per_ip * 10;
    const widgetRl = await checkWidgetRateLimit(redis, slug, widgetCeiling);
    if (widgetRl.redisDown) {
      res.status(503).json({ error: 'service temporarily unavailable' });
      return;
    }
    if (!widgetRl.allowed) {
      res.status(429).json({ error: 'widget rate limit exceeded' });
      return;
    }

    // Guard 4: per-IP rate-limit
    const ip = req.ip ?? '0.0.0.0';
    const rlKey = `${slug}:${ip}`;
    const rl = getRateLimiter(widget.rate_limit_per_ip);
    const allowed = await rl.isAllowed(rlKey);
    if (!allowed) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    // Guard 5: Turnstile CAPTCHA (when enabled)
    if (config.turnstileEnabled) {
      const captchaToken = (req.body as Record<string, unknown>).captcha_token;
      if (!captchaToken || typeof captchaToken !== 'string') {
        res.status(403).json({ error: 'captcha required' });
        return;
      }
      const valid = await verifyTurnstile(captchaToken, config.turnstileSecret, ip);
      if (!valid) {
        res.status(403).json({ error: 'captcha verification failed' });
        return;
      }
    }

    // Create anonymous public session with kind='public', origin, ip_hash columns
    const ipHash = hashIp(ip, config.widgetTokenSecret);
    const sessionId = randomUUID();

    try {
      await pool.query(
        `INSERT INTO mcp_agent_sessions
           (id, agent_id, user_id, messages, kind, origin, ip_hash)
         VALUES ($1, $2, NULL, '[]', 'public', $3, $4)`,
        [sessionId, widget.agent_id, origin ?? null, ipHash],
      );
    } catch (err) {
      logger.error({ err, slug }, 'Failed to create public session');
      res.status(500).json({ error: 'session creation failed' });
      return;
    }

    // Mint single-use token bound to this origin
    const token = await mintWidgetToken(redis, config.widgetTokenSecret, config.widgetTokenTtlSec, {
      slug,
      agentId: widget.agent_id,
      origin: origin ?? '',
    });

    res.status(200).json({
      token,
      sessionId,
      greeting: widget.greeting,
      accent: widget.accent,
    });
  });

  // ──────────────────────────────────────────────────────────────
  // POST /public/widget/:slug/chat
  // Verifies the single-use token, streams the agent reply, issues
  // a fresh token for the next turn, writes the immutable audit entry.
  // ──────────────────────────────────────────────────────────────
  app.post('/public/widget/:slug/chat', async (req: Request, res: Response): Promise<void> => {
    // Guard 1: master switch
    if (!config.publicWidgetEnabled) { res.status(404).end(); return; }

    const slug = String(req.params['slug'] ?? '');

    // Guard 2: widget lookup (triple gate)
    const widget = await getWidgetBySlug(pool, slug).catch(() => null);
    if (!widget) { res.status(404).end(); return; }

    // Guard 3: origin check (Task 9c, hardened #4+#5)
    // Deny if Origin is absent (non-browser/direct client).
    // Allow if Origin hostname = req.hostname (same-origin iframe fetch).
    // Allow if Origin ∈ widget.allowed_origins (cross-origin embed).
    if (!isApiRequestAllowed(req, widget)) {
      res.status(403).json({ error: 'origin not allowed' });
      return;
    }

    // Normalise origin for downstream use (token binding, audit)
    const rawOriginChatHeader = req.headers['origin'];
    const origin: string | undefined = Array.isArray(rawOriginChatHeader)
      ? rawOriginChatHeader[0]
      : rawOriginChatHeader;

    // Guard 3b: per-widget rate limit (#11) — atomic Redis INCR, fail closed
    // Applied before the token check to shed botnet load early.
    const widgetCeilChat = widget.rate_limit_per_ip * 10;
    const widgetRlChat = await checkWidgetRateLimit(redis, slug, widgetCeilChat);
    if (widgetRlChat.redisDown) {
      res.status(503).json({ error: 'service temporarily unavailable' });
      return;
    }
    if (!widgetRlChat.allowed) {
      res.status(429).json({ error: 'widget rate limit exceeded' });
      return;
    }

    // Guard 6: single-use token verification (also consumes the token)
    const rawToken = extractBearer(req);
    if (!rawToken) {
      res.status(401).json({ error: 'missing token' });
      return;
    }
    const verifyResult = await verifyWidgetToken(redis, config.widgetTokenSecret, rawToken, origin);
    if (!verifyResult.ok) {
      res.status(401).json({ error: verifyResult.reason ?? 'invalid token' });
      return;
    }

    // Guard 4: per-IP rate-limit (after token check so bad tokens don't count against IP)
    const ip = req.ip ?? '0.0.0.0';
    const rlKey = `${slug}:${ip}`;
    const rl = getRateLimiter(widget.rate_limit_per_ip);
    const allowed = await rl.isAllowed(rlKey);
    if (!allowed) {
      res.status(429).json({ error: 'rate limit exceeded' });
      return;
    }

    // Validate message early — needed to compute the token reserve for Guard 7
    const body = req.body as { sessionId?: string; message?: string };
    const message = body.message;
    if (!message || typeof message !== 'string' || !message.trim()) {
      res.status(400).json({ error: 'message is required' });
      return;
    }
    const sessionId = body.sessionId ?? '';

    // Guard 7: daily token cap — Redis atomic pre-debit (#8 TOCTOU fix)
    //
    // Reserve = input estimate + fixed output reserve.  After the turn we
    // reconcile the counter to the actual measured tokens.  This prevents
    // concurrent requests from all passing a TOCTOU check and collectively
    // blowing the cap.  Fail CLOSED: Redis unavailable → 503.
    const tokenReserve = Math.ceil(message.length / 4) + WIDGET_OUTPUT_TOKEN_RESERVE;
    const capResult = await preDebitDailyTokens(redis, slug, tokenReserve, widget.daily_token_cap);
    if (capResult.redisDown) {
      res.status(503).json({ error: 'service temporarily unavailable' });
      return;
    }
    if (!capResult.allowed) {
      res.status(429).json({ error: 'daily limit reached' });
      return;
    }

    // Load agent
    const agent = await getAgent(pool, widget.agent_id);
    if (!agent) {
      // Roll back reservation — agent not found means no tokens will be used
      void reconcileDailyTokens(redis, slug, 0, tokenReserve);
      res.status(404).json({ error: 'agent not found' });
      return;
    }

    // Compute IP hash (never log raw IP)
    const ipHash = hashIp(ip, config.widgetTokenSecret);

    // Mint a FRESH single-use token for the NEXT turn
    const freshToken = await mintWidgetToken(redis, config.widgetTokenSecret, config.widgetTokenTtlSec, {
      slug,
      agentId: widget.agent_id,
      origin: origin ?? '',
    });

    // Set SSE headers (copy from the existing /api/agents/:id/sessions/:sid/chat route)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    // Fresh token for next turn — set BEFORE flushing headers
    res.setHeader('X-Widget-Token', freshToken);
    res.flushHeaders();

    // Dynamically import runAgentChat (matches the pattern used in src/index.ts)
    const { runAgentChat } = await import('../agents/agentRunner.js');

    // Heartbeat to prevent proxy idle timeout
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25_000);

    let inputTokens = 0;
    let outputTokens = 0;
    let isError = false;
    let errorType: string | undefined;

    try {
      const chunks: string[] = [];
      for await (const chunk of hardenedRunAgentChat(
        { runAgentChat, pool, config },
        { widget, agent, sessionId, origin: origin!, ipHash, message },
      )) {
        res.write(chunk);
        chunks.push(chunk);
      }
      // Estimate token usage from message + response lengths (hardenedRunAgentChat
      // does not expose usage metadata, so we use character-based estimates).
      // This is a best-effort approximation; actual token counting would require
      // propagating usage from the model response in agentRunner.ts.
      inputTokens = Math.ceil(message.length / 4);
      const responseText = chunks.join('');
      outputTokens = Math.ceil(responseText.length / 4);
    } catch (err) {
      isError = true;
      if (err instanceof PublicChatRefused) {
        errorType = err.message;
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      } else {
        errorType = err instanceof Error ? err.message : 'runner-error';
        res.write(`data: ${JSON.stringify({ error: 'An error occurred. Please try again.' })}\n\n`);
        logger.error({ err, slug }, 'Public widget chat runner error');
      }
      res.write('data: [DONE]\n\n');
    } finally {
      clearInterval(heartbeat);
      res.end();
    }

    // Reconcile Redis daily counter to actual token usage (fire-and-forget)
    const actualTokens = inputTokens + outputTokens;
    void reconcileDailyTokens(redis, slug, actualTokens, tokenReserve);

    // P3-8: Write immutable audit entry (fire-and-forget, never log raw IP)
    writeImmutableAudit(pool, {
      eventType: 'agent_public_chat',
      model: 'public-widget',
      apiKeyPrefix: `public:${slug}`,
      requesterIp: ipHash,         // HMAC-SHA256 hash — never raw IP
      sessionId: sessionId || null,
      inputTokens,
      outputTokens,
      isError,
      errorType: isError ? (errorType ?? 'unknown') : (origin ?? undefined),
    });
  });
}
