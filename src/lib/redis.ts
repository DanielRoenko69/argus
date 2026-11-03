import { createHash } from 'crypto';
import { logger } from './logger.js';

let redisClient: import('ioredis').Redis | null = null;
let redisEnabled = false;
let cacheNamespace = 'gateway';
let defaultTtlSec = 300;

export interface CacheConfig {
  enabled: boolean;
  url: string;
  ttlSec: number;
  namespace: string;
}

export async function initCache(config: CacheConfig): Promise<void> {
  redisEnabled = config.enabled;
  cacheNamespace = config.namespace;
  defaultTtlSec = config.ttlSec;

  if (!redisEnabled) {
    logger.info('Redis cache disabled');
    return;
  }

  try {
    const { Redis } = await import('ioredis');
    redisClient = new Redis(config.url, {
      retryStrategy: (times) => Math.min(times * 50, 2000),
      maxRetriesPerRequest: 3,
    });

    redisClient.on('connect', () => logger.info({ url: config.url }, 'Redis cache connected'));
    redisClient.on('error', (err) => logger.error({ err }, 'Redis cache error'));
  } catch (err) {
    logger.error({ err }, 'Failed to initialize Redis cache');
    redisEnabled = false;
  }
}

export function shutdownCache(): void {
  if (redisClient) {
    redisClient.disconnect();
    redisClient = null;
    logger.info('Redis cache disconnected');
  }
}

export function getRedisClient(): import('ioredis').Redis | null {
  return redisClient;
}

export function getRedisEnabled(): boolean {
  return redisEnabled;
}

export function isCacheEnabled(): boolean {
  return redisEnabled && redisClient != null;
}

/** Build a deterministic cache key from request + keyPrefix */
export function buildCacheKey(body: Record<string, unknown>, keyPrefix: string): string {
  const canonical = JSON.stringify({
    model: body.model,
    messages: body.messages,
    temperature: body.temperature,
    max_tokens: body.max_tokens,
    top_p: body.top_p,
    tools: body.tools,
    tool_choice: body.tool_choice,
    response_format: body.response_format,
    user: body.user,
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return `${cacheNamespace}:${keyPrefix}:${hash}`;
}

export async function cacheGet(key: string): Promise<Record<string, unknown> | null> {
  if (!redisClient || !redisEnabled) return null;
  try {
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    logger.debug({ err, key }, 'Cache get failed');
    return null;
  }
}

export async function cacheSet(key: string, value: Record<string, unknown>, ttlSec?: number): Promise<void> {
  if (!redisClient || !redisEnabled) return;
  try {
    await redisClient.setex(key, ttlSec ?? defaultTtlSec, JSON.stringify(value));
  } catch (err) {
    logger.debug({ err, key }, 'Cache set failed');
  }
}

export async function cacheInvalidatePattern(pattern: string): Promise<number> {
  if (!redisClient || !redisEnabled) return 0;
  try {
    const keys = await redisClient.keys(`${cacheNamespace}:${pattern}`);
    if (keys.length === 0) return 0;
    await redisClient.del(...keys);
    return keys.length;
  } catch (err) {
    logger.error({ err, pattern }, 'Cache invalidate pattern failed');
    return 0;
  }
}

export async function cacheFlushAll(): Promise<void> {
  if (!redisClient || !redisEnabled) return;
  try {
    const keys = await redisClient.keys(`${cacheNamespace}:*`);
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
    logger.info({ count: keys.length }, 'Cache flushed');
  } catch (err) {
    logger.error({ err }, 'Cache flush failed');
  }
}

export async function cacheStats(): Promise<{ keys: number }> {
  if (!redisClient || !redisEnabled) {
    return { keys: 0 };
  }
  try {
    const keys = await redisClient.keys(`${cacheNamespace}:*`);
    return { keys: keys.length };
  } catch (err) {
    logger.error({ err }, 'Cache stats failed');
    return { keys: 0 };
  }
}
