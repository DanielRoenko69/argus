/**
 * widgetToken.ts — P3-4
 *
 * Single-use, origin-bound, HMAC-signed widget tokens.
 *
 * Token format:
 *   base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(payloadPart, secret))
 *
 * Payload fields:
 *   slug     — widget slug
 *   agentId  — agent id (number)
 *   origin   — normalised request origin (bound at mint time)
 *   jti      — crypto.randomUUID() — stored in Redis for single-use enforcement
 *   exp      — unix epoch seconds (now + ttlSec)
 *
 * Verify rejects on (in order):
 *   1. bad-signature   — HMAC mismatch (constant-time compare)
 *   2. expired         — exp < now
 *   3. origin-mismatch — payload.origin !== normalise(requestOrigin)
 *   4. replay-or-expired — jti key missing / already consumed in Redis
 *
 * Redis API used (ioredis 5.x):
 *   set(key, value, 'EX', ttlSec, 'NX')  →  'OK' | null   (atomic set-if-not-exists)
 *   getdel(key)                            →  string | null (atomic get-and-delete)
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

// ── Types ─────────────────────────────────────────────────────

interface TokenPayload {
  slug: string;
  agentId: number;
  origin: string;   // normalised at mint time
  jti: string;
  exp: number;      // unix epoch seconds
}

export interface MintParams {
  slug: string;
  agentId: number;
  origin: string;
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  payload?: { slug: string; agentId: number; origin: string };
}

// ── Helpers ───────────────────────────────────────────────────

function toBase64Url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function fromBase64Url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function normalizeOrigin(origin: string): string {
  return origin.toLowerCase().trimEnd().replace(/\/+$/, '');
}

function hmacPart(payloadPart: string, secret: string): string {
  return toBase64Url(
    createHmac('sha256', secret).update(payloadPart).digest('binary'),
  );
}

// ── Mint ──────────────────────────────────────────────────────

/**
 * Mint a single-use origin-bound token and store its jti in Redis.
 */
export async function mintWidgetToken(
  redis: Redis,
  secret: string,
  ttlSec: number,
  params: MintParams,
): Promise<string> {
  const jti = randomUUID();
  const exp = Math.floor(Date.now() / 1000) + ttlSec;

  const payload: TokenPayload = {
    slug:    params.slug,
    agentId: params.agentId,
    origin:  normalizeOrigin(params.origin),
    jti,
    exp,
  };

  const payloadPart = toBase64Url(JSON.stringify(payload));
  const sigPart     = hmacPart(payloadPart, secret);
  const token       = `${payloadPart}.${sigPart}`;

  // Store jti for single-use enforcement. ttlSec=0 means "already expired" —
  // store with EX=1 so Redis accepts the command (minimum TTL) and the exp
  // check in verify will reject it before we even reach the Redis consume step.
  const redisTtl = Math.max(ttlSec, 1);
  await redis.set(`widget:jti:${jti}`, '1', 'EX', redisTtl, 'NX');

  return token;
}

// ── Verify ────────────────────────────────────────────────────

/**
 * Verify a widget token.  Never throws — all error paths return {ok:false}.
 */
export async function verifyWidgetToken(
  redis: Redis,
  secret: string,
  token: string,
  requestOrigin: string | undefined,
): Promise<VerifyResult> {
  try {
    // ── 1. Parse structure ────────────────────────────────────
    if (!token || typeof token !== 'string') return { ok: false, reason: 'bad-signature' };
    const dotIdx = token.indexOf('.');
    if (dotIdx < 1 || dotIdx === token.length - 1) return { ok: false, reason: 'bad-signature' };

    const payloadPart    = token.slice(0, dotIdx);
    const receivedSigPart = token.slice(dotIdx + 1);

    // ── 2. HMAC check (constant-time) ─────────────────────────
    const expectedSigPart = hmacPart(payloadPart, secret);

    const expectedBuf = Buffer.from(expectedSigPart);
    const receivedBuf = Buffer.from(receivedSigPart);

    // timingSafeEqual requires equal-length buffers; pad to expected length if
    // the received sig is a different length to avoid short-circuit leak.
    let sigsMatch: boolean;
    if (expectedBuf.length !== receivedBuf.length) {
      sigsMatch = false;
      // Still do a dummy constant-time compare to avoid timing side-channel
      timingSafeEqual(expectedBuf, expectedBuf);
    } else {
      sigsMatch = timingSafeEqual(expectedBuf, receivedBuf);
    }

    if (!sigsMatch) return { ok: false, reason: 'bad-signature' };

    // ── 3. Decode payload ─────────────────────────────────────
    let payload: TokenPayload;
    try {
      payload = JSON.parse(fromBase64Url(payloadPart)) as TokenPayload;
    } catch {
      return { ok: false, reason: 'bad-signature' };
    }

    if (!payload || typeof payload !== 'object') return { ok: false, reason: 'bad-signature' };

    // ── 4. Expiry check ───────────────────────────────────────
    // Treat exp <= nowSec as expired (ttl=0 mints with exp==now which is already expired).
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      return { ok: false, reason: 'expired' };
    }

    // ── 5. Origin check ───────────────────────────────────────
    const normRequest = requestOrigin ? normalizeOrigin(requestOrigin) : '';
    if (!normRequest || payload.origin !== normRequest) {
      return { ok: false, reason: 'origin-mismatch' };
    }

    // ── 6. Single-use: atomically consume the jti ─────────────
    if (!payload.jti || typeof payload.jti !== 'string') {
      return { ok: false, reason: 'replay-or-expired' };
    }

    const consumed = await redis.getdel(`widget:jti:${payload.jti}`);
    // getdel returns the stored value ('1') on first use, null if absent/already consumed
    if (!consumed) {
      return { ok: false, reason: 'replay-or-expired' };
    }

    // ── 7. Success ────────────────────────────────────────────
    return {
      ok: true,
      payload: {
        slug:    payload.slug,
        agentId: payload.agentId,
        origin:  payload.origin,
      },
    };
  } catch {
    // Any unexpected error (malformed base64, Redis failure, etc.) → reject
    return { ok: false, reason: 'internal-error' };
  }
}
