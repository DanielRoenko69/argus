import type pg from 'pg';
import type { SessionUser } from '../auth/userAuth.js';
import { evaluatePermission } from '../auth/effectiveAccess.js';
import type { ArgusPermission } from '../auth/permissions.js';
import type { AuthorizedWorkspaceScope } from '../auth/workspaceScope.js';

export const GLOBAL_SEARCH_TYPES = ['agent', 'workflow', 'skill', 'knowledge', 'bundle'] as const;
export type GlobalSearchResourceType = typeof GLOBAL_SEARCH_TYPES[number];

export interface GlobalSearchInput {
  query: string;
  limit: number;
}

export interface GlobalSearchResult {
  type: GlobalSearchResourceType;
  id: string;
  title: string;
  subtitle: string;
  description: string;
  href: string;
  status: string | null;
  score: number;
}

export interface GlobalSearchResponse {
  schemaVersion: 1;
  generatedAt: string;
  query: string;
  results: GlobalSearchResult[];
  counts: Partial<Record<GlobalSearchResourceType, number>>;
  truncated: boolean;
  durationMs: number;
}

interface SearchRow {
  id: number | string;
  name: string;
  label: string | null;
  description: string | null;
  status: string | null;
}

interface SearchAdapter {
  type: GlobalSearchResourceType;
  permission: ArgusPermission;
  sql: string;
  href: (id: string) => string;
}

export class GlobalSearchInputError extends Error {
  constructor(readonly code: 'QUERY_TOO_SHORT' | 'QUERY_TOO_LONG' | 'INVALID_LIMIT', message: string) {
    super(message);
    this.name = 'GlobalSearchInputError';
  }
}

export function normalizeGlobalSearchInput(queryValue: unknown, limitValue: unknown): GlobalSearchInput {
  const query = typeof queryValue === 'string' ? queryValue.trim().replace(/\s+/g, ' ') : '';
  if (query.length < 2) throw new GlobalSearchInputError('QUERY_TOO_SHORT', 'Search requires at least 2 characters');
  if (query.length > 80) throw new GlobalSearchInputError('QUERY_TOO_LONG', 'Search is limited to 80 characters');

  const parsedLimit = limitValue == null || limitValue === '' ? 5 : Number(limitValue);
  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 10) {
    throw new GlobalSearchInputError('INVALID_LIMIT', 'Search limit must be between 1 and 10');
  }
  return { query, limit: parsedLimit };
}

const matchWhere = `position(lower($1) in lower(concat_ws(' ', candidate.name, candidate.label, candidate.description))) > 0`;
const matchWhereWithoutLabel = `position(lower($1) in lower(concat_ws(' ', candidate.name, candidate.description))) > 0`;

const adapters: SearchAdapter[] = [
  {
    type: 'agent',
    permission: 'agents.read',
    sql: `SELECT candidate.id, candidate.name, candidate.label, candidate.description,
                 CASE WHEN candidate.enabled THEN 'Ready' ELSE 'Disabled' END AS status
            FROM mcp_agents candidate
           WHERE ${matchWhere}
             AND ($2::int[] IS NULL OR candidate.bundle_ids IS NULL
                  OR cardinality(candidate.bundle_ids) = 0 OR candidate.bundle_ids && $2::int[])
             AND $3::text = 'default' AND $4::text = 'default'
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT $5`,
    href: id => `/build/agents?agent=${encodeURIComponent(id)}`,
  },
  {
    type: 'workflow',
    permission: 'workflows.read',
    sql: `SELECT candidate.id, candidate.name, candidate.name AS label, candidate.description,
                 CASE WHEN candidate.enabled THEN 'Ready' ELSE 'Disabled' END AS status
            FROM mcp_workflows candidate
           WHERE ${matchWhereWithoutLabel}
             AND ($2::int[] IS NULL
                  OR NOT EXISTS (SELECT 1 FROM mcp_workflow_bundles scope WHERE scope.workflow_id = candidate.id)
                  OR EXISTS (SELECT 1 FROM mcp_workflow_bundles scope
                              WHERE scope.workflow_id = candidate.id AND scope.bundle_id = ANY($2::int[])))
             AND candidate.tenant_key = $3
             AND candidate.workspace_key = $4
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT $5`,
    href: id => `/build/workflows/studio/${encodeURIComponent(id)}`,
  },
  {
    type: 'skill',
    permission: 'skills.read',
    sql: `SELECT candidate.id, candidate.name, candidate.label, candidate.description,
                 candidate.category AS status
            FROM mcp_skills candidate
           WHERE ${matchWhere}
             AND ($2::int[] IS NULL
                  OR NOT EXISTS (SELECT 1 FROM mcp_bundle_skills scope WHERE scope.skill_id = candidate.id)
                  OR EXISTS (SELECT 1 FROM mcp_bundle_skills scope
                              WHERE scope.skill_id = candidate.id AND scope.bundle_id = ANY($2::int[])))
             AND $3::text = 'default' AND $4::text = 'default'
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT $5`,
    href: id => `/build/skills?skill=${encodeURIComponent(id)}`,
  },
  {
    type: 'knowledge',
    permission: 'knowledge.read',
    sql: `SELECT candidate.id, candidate.name, candidate.label, candidate.description,
                 CASE WHEN candidate.enabled THEN candidate.provider ELSE 'Disabled' END AS status
           FROM mcp_rag_indexes candidate
           WHERE ${matchWhere}
             AND $3::text = 'default' AND $4::text = 'default'
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT $5`,
    href: id => `/build/knowledge?source=${encodeURIComponent(id)}`,
  },
  {
    type: 'bundle',
    permission: 'integrations.read',
    sql: `SELECT candidate.id, candidate.name, candidate.label, candidate.description,
                 'Access bundle'::text AS status
            FROM mcp_service_bundles candidate
           WHERE ${matchWhere}
             AND ($2::int[] IS NULL OR candidate.id = ANY($2::int[]))
             AND $3::text = 'default' AND $4::text = 'default'
           ORDER BY candidate.updated_at DESC, candidate.id
           LIMIT $5`,
    href: id => `/mcp-fabric/bundles/${encodeURIComponent(id)}`,
  },
];

function boundedText(value: string | null, max = 180): string {
  const normalized = (value ?? '').trim().replace(/\s+/g, ' ');
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function resultScore(query: string, row: SearchRow): number {
  const needle = query.toLocaleLowerCase();
  const title = (row.label || row.name).toLocaleLowerCase();
  const name = row.name.toLocaleLowerCase();
  const description = (row.description ?? '').toLocaleLowerCase();
  if (title === needle) return 100;
  if (name === needle) return 96;
  if (title.startsWith(needle)) return 86;
  if (name.startsWith(needle)) return 82;
  if (title.includes(needle)) return 70;
  if (name.includes(needle)) return 66;
  if (description.includes(needle)) return 45;
  return 20;
}

export async function searchWorkspaceResources(
  pool: pg.Pool,
  user: SessionUser,
  scope: AuthorizedWorkspaceScope,
  input: GlobalSearchInput,
  now: () => number = Date.now,
): Promise<GlobalSearchResponse> {
  const startedAt = now();
  const allowedBundles = user.allowed_bundles;
  const visibleAdapters = adapters.filter(adapter => evaluatePermission({ role: user.role }, adapter.permission).allowed);

  const groups = await Promise.all(visibleAdapters.map(async adapter => {
    const candidateLimit = input.limit * 3 + 1;
    const params = [
      input.query,
      allowedBundles,
      scope.tenantKey,
      scope.workspaceKey,
      candidateLimit,
    ];
    const response = await pool.query<SearchRow>(adapter.sql, params);
    const ranked = response.rows
      .map(row => ({
        type: adapter.type,
        id: String(row.id),
        title: boundedText(row.label || row.name, 120),
        subtitle: boundedText(row.name, 120),
        description: boundedText(row.description),
        href: adapter.href(String(row.id)),
        status: row.status ? boundedText(row.status, 60) : null,
        score: resultScore(input.query, row),
      }))
      .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
    return { type: adapter.type, results: ranked.slice(0, input.limit), truncated: ranked.length > input.limit };
  }));

  const results = groups.flatMap(group => group.results)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
  const counts = Object.fromEntries(groups.map(group => [group.type, group.results.length])) as GlobalSearchResponse['counts'];
  return {
    schemaVersion: 1,
    generatedAt: new Date(startedAt).toISOString(),
    query: input.query,
    results,
    counts,
    truncated: groups.some(group => group.truncated),
    durationMs: Math.max(0, now() - startedAt),
  };
}
