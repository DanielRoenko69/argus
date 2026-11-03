import { createHash } from 'node:crypto';
import type {
  RepositoryGraphDirection,
  RepositoryGraphNodeType,
  RepositoryGraphQuery,
} from './repositoryGraphTypes.js';

export const REPOSITORY_GRAPH_LIMITS = Object.freeze({
  maxDepth: 3,
  maxPageNodes: 100,
  maxTraversalNodes: 400,
  maxTraversalEdges: 800,
  maxResponseBytes: 256 * 1024,
  maxSearchLength: 128,
  maxSeedLength: 128,
  maxFilterValues: 32,
  maxSeedMatches: 10,
  maxOverviewModules: 40,
  maxOverviewDependencies: 120,
  maxLanguagesPerModule: 8,
  queryBudgetMs: 2_000,
  maxFullGraphNodes: 50_000,
  maxFullGraphEdges: 150_000,
  maxFullGraphResponseBytes: 24 * 1024 * 1024,
  fullGraphQueryBudgetMs: 15_000,
});

const NODE_TYPES = new Set<RepositoryGraphNodeType>(['file', 'symbol']);
const DIRECTIONS = new Set<RepositoryGraphDirection>(['inbound', 'outbound', 'both']);
const EDGE_TYPE = /^[a-z][a-z0-9_.:-]{0,63}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,1024}$/;

export class RepositoryGraphValidationError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = 'RepositoryGraphValidationError';
  }
}

function one(value: unknown, field: string): string | null {
  if (value == null || value === '') return null;
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new RepositoryGraphValidationError(`${field} must be a single string`);
  }
  return value;
}

function bounded(value: unknown, field: string, maximum: number): string | null {
  const raw = one(value, field);
  if (raw == null) return null;
  const normalized = raw.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new RepositoryGraphValidationError(`${field} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function integer(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value == null || value === '') return fallback;
  const raw = one(value, field);
  if (raw == null || !/^\d+$/u.test(raw)) {
    throw new RepositoryGraphValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RepositoryGraphValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function list(value: unknown, field: string): string[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new RepositoryGraphValidationError(`${field} must be a comma-separated string`);
  }
  const values = [...new Set(value.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  if (values.length > REPOSITORY_GRAPH_LIMITS.maxFilterValues) {
    throw new RepositoryGraphValidationError(`${field} exceeds the ${REPOSITORY_GRAPH_LIMITS.maxFilterValues} value limit`);
  }
  return values;
}

export function parseRepositoryGraphQuery(input: Record<string, unknown>): RepositoryGraphQuery {
  const seed = bounded(input['seed'], 'seed', REPOSITORY_GRAPH_LIMITS.maxSeedLength);
  const search = bounded(input['q'], 'q', REPOSITORY_GRAPH_LIMITS.maxSearchLength);
  if ((seed == null) === (search == null)) {
    throw new RepositoryGraphValidationError('provide exactly one of seed or q');
  }
  if (seed != null && !/^(?:file|symbol):[1-9]\d*$/u.test(seed)) {
    throw new RepositoryGraphValidationError('seed must be an opaque file:<id> or symbol:<id> identifier');
  }

  const rawNodeTypes = list(input['node_types'], 'node_types');
  if (rawNodeTypes.some(type => !NODE_TYPES.has(type as RepositoryGraphNodeType))) {
    throw new RepositoryGraphValidationError('node_types contains an unknown node type');
  }
  const nodeTypes = (rawNodeTypes.length === 0 ? ['file', 'symbol'] : rawNodeTypes) as RepositoryGraphNodeType[];

  const edgeTypes = list(input['edge_types'], 'edge_types');
  if (edgeTypes.some(type => !EDGE_TYPE.test(type))) {
    throw new RepositoryGraphValidationError('edge_types contains an invalid edge type');
  }

  const rawDirection = (bounded(input['direction'], 'direction', 16) ?? 'both').toLowerCase();
  if (!DIRECTIONS.has(rawDirection as RepositoryGraphDirection)) {
    throw new RepositoryGraphValidationError('direction must be inbound, outbound, or both');
  }

  const cursor = bounded(input['cursor'], 'cursor', 1024);
  if (cursor != null && !CURSOR.test(cursor)) {
    throw new RepositoryGraphValidationError('cursor is malformed');
  }

  return {
    seed,
    search,
    nodeTypes,
    edgeTypes,
    direction: rawDirection as RepositoryGraphDirection,
    depth: integer(input['depth'], 'depth', 1, 0, REPOSITORY_GRAPH_LIMITS.maxDepth),
    limit: integer(input['limit'], 'limit', 50, 1, REPOSITORY_GRAPH_LIMITS.maxPageNodes),
    cursor,
  };
}
function fingerprint(snapshotId: number, query: RepositoryGraphQuery): string {
  return createHash('sha256').update(JSON.stringify({
    snapshotId,
    seed: query.seed,
    search: query.search,
    nodeTypes: query.nodeTypes,
    edgeTypes: query.edgeTypes,
    direction: query.direction,
    depth: query.depth,
    limit: query.limit,
  })).digest('base64url').slice(0, 24);
}

export function encodeRepositoryGraphCursor(snapshotId: number, query: RepositoryGraphQuery, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset, f: fingerprint(snapshotId, query) }), 'utf8').toString('base64url');
}

export function decodeRepositoryGraphCursor(snapshotId: number, query: RepositoryGraphQuery): number {
  if (query.cursor == null) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (parsed['v'] !== 1 || parsed['f'] !== fingerprint(snapshotId, query)
      || !Number.isSafeInteger(parsed['o']) || Number(parsed['o']) < 0
      || Number(parsed['o']) > REPOSITORY_GRAPH_LIMITS.maxTraversalNodes) {
      throw new Error('invalid cursor payload');
    }
    return Number(parsed['o']);
  } catch {
    throw new RepositoryGraphValidationError('cursor does not belong to this snapshot and query');
  }
}

export function parseRepositoryGraphSnapshotId(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) {
    throw new RepositoryGraphValidationError('snapshot id must be a positive integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new RepositoryGraphValidationError('snapshot id must be a positive integer');
  return parsed;
}
