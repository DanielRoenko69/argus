/**
 * Distributed rate limiter — Redis-backed sliding window with in-memory fallback.
 *
 * When Redis is available: atomic Lua sliding-window across all replicas.
 * When Redis is unavailable: falls back to in-process token bucket (single-replica accurate).
 *
 * Sliding window: counts requests in the last `windowMs` milliseconds using a Redis ZSET.
 * Each member is a unique request ID (nanosecond timestamp), scored by timestamp.
 * Atomic via Lua — no TOCTOU race conditions.
 */

import { getRedisClient, getRedisEnabled } from './redis.js';
import { logger } from './logger.js';

// ── Lua: sliding window using ZSET ────────────────────────────
// KEYS[1] = rate limit key
// ARGV[1] = window size in ms
// ARGV[2] = max requests per window
// ARGV[3] = current timestamp (ms)
// ARGV[4] = unique request ID (ms + random suffix)
// Returns: 1 = allowed, 0 = blocked
const SLIDING_WINDOW_LUA = `
local key      = KEYS[1]
local window   = tonumber(ARGV[1])
local limit    = tonumber(ARGV[2])
local now      = tonumber(ARGV[3])
local reqId    = ARGV[4]
local cutoff   = now - window

redis.call('zremrangebyscore', key, '-inf', cutoff)
local count = redis.call('zcard', key)

if count < limit then
  redis.call('zadd', key, now, reqId)
  redis.call('pexpire', key, window * 2)
  return 1
end
return 0
`;

// ── In-memory token bucket (fallback) ────────────────────────

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

// ── RateLimiter class ─────────────────────────────────────────

export class RateLimiter {
  private buckets = new Map<string, TokenBucket>();
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per second
  private readonly windowMs = 60_000;  // 1-minute sliding window for Redis

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.refillRate = requestsPerMinute / 60;
  }

  async isAllowed(key: string): Promise<boolean> {
    const redis = getRedisClient();
    if (redis && getRedisEnabled()) {
      try {
        const now    = Date.now();
        const reqId  = `${now}-${Math.random().toString(36).slice(2, 8)}`;
        const result = await redis.eval(
          SLIDING_WINDOW_LUA, 1,
          `rl:${key}`,
          String(this.windowMs),
          String(this.maxTokens),
          String(now),
          reqId,
        ) as number;
        return result === 1;
      } catch (err) {
        logger.warn({ err, key }, 'Redis rate limit failed — falling back to in-memory');
      }
    }
    return this._inMemory(key);
  }

  private _inMemory(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      this.buckets.set(key, { tokens: this.maxTokens - 1, lastRefill: now });
      return true;
    }

    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRate);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  cleanup(): void {
    const stale = Date.now() - 300_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastRefill < stale) this.buckets.delete(key);
    }
  }
}
