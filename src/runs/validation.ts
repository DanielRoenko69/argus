import {
  RUN_DISPLAY_STATUSES,
  RUN_KINDS,
  RUN_STATUSES,
  type RunDisplayStatus,
  type RunKindV2,
  type RunReadModelQuery,
  type RunStatusV2,
} from './types.js';

const MAX_QUERY_LENGTH = 128;
const MAX_CURSOR_LENGTH = 512;
const MAX_FILTER_VALUES = 20;

export class RunReadModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunReadModelValidationError';
  }
}

function scalar(value: unknown, name: string): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new RunReadModelValidationError(`${name} must be a string`);
  return value.trim();
}

function enumValue<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  const raw = scalar(value, name);
  if (raw == null) return fallback;
  if (!allowed.includes(raw as T)) throw new RunReadModelValidationError(`${name} is invalid`);
  return raw as T;
}

function commaValues(value: unknown, name: string): string[] {
  const raw = scalar(value, name);
  if (!raw) return [];
  const values = [...new Set(raw.split(',').map(item => item.trim()).filter(Boolean))];
  if (values.length > MAX_FILTER_VALUES) throw new RunReadModelValidationError(`${name} accepts at most ${MAX_FILTER_VALUES} values`);
  return values;
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const raw = scalar(value, name);
  if (raw == null) return fallback;
  if (!/^\d+$/.test(raw)) throw new RunReadModelValidationError(`${name} must be an integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RunReadModelValidationError(`${name} must be between ${min} and ${max}`);
  }
  return parsed;
}

export function parseRunReadModelQuery(input: Record<string, unknown>): RunReadModelQuery {
  const kinds = commaValues(input['kind'], 'kind');
  if (kinds.some(kind => !RUN_KINDS.includes(kind as RunKindV2))) {
    throw new RunReadModelValidationError('kind contains an unsupported value');
  }
  const statuses = commaValues(input['status'], 'status');
  const allowedStatuses = new Set<string>([...RUN_STATUSES, ...RUN_DISPLAY_STATUSES]);
  if (statuses.some(status => !allowedStatuses.has(status))) {
    throw new RunReadModelValidationError('status contains an unsupported value');
  }
  const tagIds = commaValues(input['tag'], 'tag');
  if (tagIds.some(id => !/^[1-9]\d{0,18}$/.test(id))) {
    throw new RunReadModelValidationError('tag must contain positive integer IDs');
  }
  const query = scalar(input['q'], 'q') ?? '';
  if (query.length > MAX_QUERY_LENGTH) throw new RunReadModelValidationError(`q must be at most ${MAX_QUERY_LENGTH} characters`);
  const cursor = scalar(input['cursor'], 'cursor');
  if (cursor && cursor.length > MAX_CURSOR_LENGTH) throw new RunReadModelValidationError('cursor is too long');

  return {
    view: enumValue(input['view'], 'view', ['root', 'all'] as const, 'root'),
    includeChildren: enumValue(input['include_children'], 'include_children', ['none', 'summary', 'full'] as const, 'summary'),
    limit: integer(input['limit'], 'limit', 50, 1, 100),
    cursor,
    kinds: kinds as RunKindV2[],
    statuses: statuses as Array<RunStatusV2 | RunDisplayStatus>,
    tagIds,
    query,
    hours: integer(input['hours'], 'hours', 24 * 90, 1, 24 * 90),
  };
}

export interface RunCursor {
  updatedAt: string;
  id: string;
}

export function encodeRunCursor(cursor: RunCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeRunCursor(value: string): RunCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const updatedAt = typeof parsed['updatedAt'] === 'string' ? parsed['updatedAt'] : '';
    const id = typeof parsed['id'] === 'string' ? parsed['id'] : '';
    if (!updatedAt || !Number.isFinite(Date.parse(updatedAt)) || !id || id.length > 256) throw new Error('invalid fields');
    return { updatedAt: new Date(updatedAt).toISOString(), id };
  } catch {
    throw new RunReadModelValidationError('cursor is invalid');
  }
}
