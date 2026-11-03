import { createHash } from 'node:crypto';

export const CANONICAL_AUDIT_REDACTION_PROFILE = 'argus.audit.redaction.v1';
const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 100;
const MAX_STRING_LENGTH = 1_024;

const SENSITIVE_KEY = /(?:password|passphrase|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|client[_-]?secret|prompt|messages?|content|email|phone|address|ip[_-]?address|requester[_-]?ip|client[_-]?ip|^ip(?:v[46])?$)/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;
const COMMON_SECRET_VALUE = /\b(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{12,}\b/gi;
const EMAIL_VALUE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const IPV4_VALUE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PHONE_VALUE = /(?:\+\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{2,4}/g;

export type AuditJsonValue = null | boolean | number | string | AuditJsonValue[] | { [key: string]: AuditJsonValue };

function safeString(value: string): string {
  return value
    .replace(BEARER_VALUE, 'Bearer [REDACTED]')
    .replace(COMMON_SECRET_VALUE, REDACTED)
    .replace(EMAIL_VALUE, '[REDACTED_EMAIL]')
    .replace(IPV4_VALUE, '[REDACTED_IP]')
    .replace(PHONE_VALUE, '[REDACTED_PHONE]')
    .slice(0, MAX_STRING_LENGTH);
}

function redact(value: unknown, depth: number, seen: WeakSet<object>): AuditJsonValue {
  if (value == null) return null;
  if (typeof value === 'string') return safeString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return `[${typeof value}]`;
  if (depth >= MAX_DEPTH) return '[TRUNCATED_DEPTH]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ARRAY_ITEMS).map(item => redact(item, depth + 1, seen));
      if (value.length > MAX_ARRAY_ITEMS) items.push(`[TRUNCATED_${value.length - MAX_ARRAY_ITEMS}_ITEMS]`);
      return items;
    }
    const output: Record<string, AuditJsonValue> = {};
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
    for (const [key, item] of entries.slice(0, MAX_OBJECT_KEYS)) {
      output[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen);
    }
    if (entries.length > MAX_OBJECT_KEYS) output._truncatedKeys = entries.length - MAX_OBJECT_KEYS;
    return output;
  } finally {
    seen.delete(value);
  }
}

export function redactCanonicalAuditPayload(value: unknown): AuditJsonValue {
  return redact(value, 0, new WeakSet());
}

export function stableAuditJson(value: AuditJsonValue): string {
  if (Array.isArray(value)) return `[${value.map(stableAuditJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableAuditJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalAuditDigest(value: AuditJsonValue): string {
  return createHash('sha256').update(stableAuditJson(value)).digest('hex');
}
