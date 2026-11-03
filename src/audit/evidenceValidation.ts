import {
  type AuditEvidenceCursor,
  type AuditEvidenceQuery,
} from './evidenceTypes.js';
import {
  type CanonicalAuditActorType,
  type CanonicalAuditOutcome,
  type CanonicalAuditRisk,
} from './canonicalAuditTypes.js';

const ACTOR_TYPES = ['human', 'service', 'system'] as const;
const OUTCOMES = ['success', 'failure', 'denied', 'cancelled'] as const;
const RISKS = ['low', 'medium', 'high', 'critical'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.-]{1,127}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@|/-]{0,255}$/;
const RESOURCE_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_CURSOR_LENGTH = 512;

export class AuditEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditEvidenceValidationError';
  }
}

function scalar(value: unknown, name: string, max = 256): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new AuditEvidenceValidationError(`${name} must be a string`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw new AuditEvidenceValidationError(`${name} must be at most ${max} characters`);
  return text;
}

function identifier(value: unknown, name: string): string | null {
  const text = scalar(value, name);
  if (text != null && !IDENTIFIER.test(text)) throw new AuditEvidenceValidationError(`${name} is invalid`);
  return text;
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[]): T | null {
  const text = scalar(value, name);
  if (text == null) return null;
  if (!allowed.includes(text as T)) throw new AuditEvidenceValidationError(`${name} is invalid`);
  return text as T;
}

function timestamp(value: unknown, name: string): string | null {
  const text = scalar(value, name, 64);
  if (text == null) return null;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime())) throw new AuditEvidenceValidationError(`${name} must be an ISO timestamp`);
  return parsed.toISOString();
}

function limit(value: unknown): number {
  const text = scalar(value, 'limit', 3);
  if (text == null) return 50;
  if (!/^\d+$/.test(text)) throw new AuditEvidenceValidationError('limit must be an integer');
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new AuditEvidenceValidationError('limit must be between 1 and 100');
  }
  return parsed;
}

export function encodeAuditEvidenceCursor(cursor: AuditEvidenceCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeAuditEvidenceCursor(value: string): AuditEvidenceCursor {
  if (value.length > MAX_CURSOR_LENGTH) throw new AuditEvidenceValidationError('cursor is too long');
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64url') !== value.replace(/=+$/u, '')) throw new Error('non-canonical encoding');
    const parsed = JSON.parse(decoded) as Record<string, unknown>;
    const occurredAt = typeof parsed['occurredAt'] === 'string' ? parsed['occurredAt'] : '';
    const eventId = typeof parsed['eventId'] === 'string' ? parsed['eventId'] : '';
    if (!Number.isFinite(Date.parse(occurredAt)) || !UUID.test(eventId)) throw new Error('invalid fields');
    return { occurredAt: new Date(occurredAt).toISOString(), eventId: eventId.toLowerCase() };
  } catch {
    throw new AuditEvidenceValidationError('cursor is invalid');
  }
}

export function parseAuditEvidenceQuery(input: Record<string, unknown>): AuditEvidenceQuery {
  const cursor = scalar(input['cursor'], 'cursor', MAX_CURSOR_LENGTH);
  if (cursor) decodeAuditEvidenceCursor(cursor);
  const from = timestamp(input['from'], 'from');
  const to = timestamp(input['to'], 'to');
  if (from && to && from > to) throw new AuditEvidenceValidationError('from must not be after to');

  const resourceType = scalar(input['resource_type'], 'resource_type', 64);
  if (resourceType != null && !RESOURCE_TYPE.test(resourceType)) {
    throw new AuditEvidenceValidationError('resource_type is invalid');
  }
  const action = scalar(input['action'], 'action', 128);
  if (action != null && !ACTION.test(action)) throw new AuditEvidenceValidationError('action is invalid');
  const tagId = scalar(input['tag'], 'tag', 19);
  if (tagId != null && !/^[1-9]\d{0,18}$/.test(tagId)) {
    throw new AuditEvidenceValidationError('tag must be a positive integer ID');
  }

  return {
    limit: limit(input['limit']),
    cursor,
    actorId: identifier(input['actor_id'], 'actor_id'),
    actorType: enumValue(input['actor_type'], 'actor_type', ACTOR_TYPES) as CanonicalAuditActorType | null,
    resourceType,
    resourceId: identifier(input['resource_id'], 'resource_id'),
    tagId,
    action,
    outcome: enumValue(input['outcome'], 'outcome', OUTCOMES) as CanonicalAuditOutcome | null,
    risk: enumValue(input['risk'], 'risk', RISKS) as CanonicalAuditRisk | null,
    policyId: identifier(input['policy_id'], 'policy_id'),
    rootRunId: identifier(input['root_run_id'], 'root_run_id'),
    traceId: identifier(input['trace_id'], 'trace_id'),
    environment: identifier(input['environment'], 'environment'),
    from,
    to,
  };
}
