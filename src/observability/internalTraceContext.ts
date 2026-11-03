import { timingSafeEqual } from 'node:crypto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NativeTraceEnvelope {
  rootTraceId: string;
  parentTraceId: string;
  parentSpanId: string | null;
}

type HeaderMap = Record<string, string | string[] | undefined>;

function headerValue(headers: HeaderMap, name: string): string {
  const value = headers[name];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function safeSecretEqual(provided: string, expected: string): boolean {
  if (!provided || !expected || provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch {
    return false;
  }
}

/**
 * Parse cross-process native trace headers only for callers that also know the
 * internal workspace secret. Public API/API-key callers cannot forge parentage.
 */
export function readTrustedNativeTraceEnvelope(
  headers: HeaderMap,
  expectedSecret: string,
): NativeTraceEnvelope | null {
  if (!safeSecretEqual(headerValue(headers, 'x-workspace-secret'), expectedSecret)) return null;

  const rootTraceId = headerValue(headers, 'x-argus-root-trace-id').trim();
  if (!UUID_RE.test(rootTraceId)) return null;

  const rawParentTraceId = headerValue(headers, 'x-argus-parent-trace-id').trim();
  const parentTraceId = rawParentTraceId || rootTraceId;
  if (!UUID_RE.test(parentTraceId)) return null;

  const rawParentSpanId = headerValue(headers, 'x-argus-parent-span-id').trim();
  if (rawParentSpanId && !UUID_RE.test(rawParentSpanId)) return null;

  return { rootTraceId, parentTraceId, parentSpanId: rawParentSpanId || null };
}
