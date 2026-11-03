/**
 * Shared Langfuse client factory. Pool-cached by `publicKey|host` so the
 * gateway callback and the agent-level tracing helper hit the same client
 * instance (one batch-flush loop, one TCP pool).
 *
 * Shared Langfuse client for direct provider and agent observability.
 * non-gateway code (agent runner, compliance runner, langgraph nodes) can
 * reuse it without importing gateway internals.
 */

import { Langfuse as LangfuseSdk } from 'langfuse';
import { logger } from './logger.js';

export interface LangfuseClient {
  trace: (params: Record<string, unknown>) => LangfuseTrace;
  flushAsync: () => Promise<void>;
}

export interface LangfuseTrace {
  id: string;
  generation: (params: Record<string, unknown>) => LangfuseGeneration;
  span:       (params: Record<string, unknown>) => LangfuseSpan;
  event:      (params: Record<string, unknown>) => void;
  update:     (params: Record<string, unknown>) => void;
  score:      (params: Record<string, unknown>) => void;
}

export interface LangfuseGeneration {
  id: string;
  end:    (params: Record<string, unknown>) => void;
  update: (params: Record<string, unknown>) => void;
}

export interface LangfuseSpan {
  id: string;
  end:    (params: Record<string, unknown>) => void;
  update: (params: Record<string, unknown>) => void;
  generation: (params: Record<string, unknown>) => LangfuseGeneration;
  span:       (params: Record<string, unknown>) => LangfuseSpan;
  event:      (params: Record<string, unknown>) => void;
}

const _pool = new Map<string, LangfuseClient>();

/**
 * Get a pooled Langfuse client. Returns null when env credentials are missing
 * — callers should treat null as "tracing disabled" and continue silently.
 *
 * Pool key includes publicKey + baseUrl so per-request credential overrides
 * Reuse a separate client per credential set.
 */
export function getLangfuseClient(
  pk?: string,
  sk?: string,
  host?: string,
): LangfuseClient | null {
  const publicKey = pk   ?? process.env['LANGFUSE_PUBLIC_KEY']  ?? '';
  const secretKey = sk   ?? process.env['LANGFUSE_SECRET_KEY']  ?? '';
  const baseUrl   = host ?? process.env['LANGFUSE_HOST']        ?? 'http://langfuse:3100';
  if (!publicKey || !secretKey) return null;

  const key = `${publicKey}|${baseUrl}`;
  let client = _pool.get(key);
  if (!client) {
    try {
      client = new LangfuseSdk({
        publicKey,
        secretKey,
        baseUrl,
        flushInterval: parseInt(process.env['LANGFUSE_FLUSH_INTERVAL'] ?? '5000', 10),
      }) as unknown as LangfuseClient;
      _pool.set(key, client);
      logger.info({ baseUrl, pk_prefix: publicKey.slice(0, 12) }, 'Langfuse SDK initialized');
    } catch (err) {
      logger.warn({ err }, 'Langfuse SDK init failed — tracing disabled');
      return null;
    }
  }
  return client;
}

export function isLangfuseConfigured(): boolean {
  return !!(process.env['LANGFUSE_PUBLIC_KEY'] && process.env['LANGFUSE_SECRET_KEY']);
}
