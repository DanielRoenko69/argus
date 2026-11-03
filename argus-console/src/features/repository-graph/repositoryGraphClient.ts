import type {
  RepositoryGraphLoader,
  RepositoryGraphNeighborhood,
  RepositoryGraphOverview,
  RepositoryGraphOverviewLoader,
  RepositoryGraphRequest,
  RepositoryFullGraph,
  RepositoryFullGraphLoader,
} from './types';

function responseError(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === 'string') return record.error;
    if (typeof record.message === 'string') return record.message;
  }
  return `Repository graph request failed (${status}).`;
}

function isNeighborhood(value: unknown): value is RepositoryGraphNeighborhood {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && Boolean(record.snapshot && typeof record.snapshot === 'object')
    && Array.isArray(record.nodes)
    && Array.isArray(record.edges)
    && typeof record.truncated === 'boolean';
}

function isOverview(value: unknown): value is RepositoryGraphOverview {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.schemaVersion === 1
    && Boolean(record.snapshot && typeof record.snapshot === 'object')
    && Boolean(record.totals && typeof record.totals === 'object')
    && Array.isArray(record.modules)
    && Array.isArray(record.dependencies)
    && typeof record.truncated === 'boolean';
}

function isFullGraph(value: unknown): value is RepositoryFullGraph {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<RepositoryFullGraph>;
  return candidate.schemaVersion === 1
    && Boolean(candidate.snapshot && typeof candidate.snapshot.id === 'string')
    && Array.isArray(candidate.files)
    && Array.isArray(candidate.symbols)
    && Array.isArray(candidate.relationTypes)
    && Array.isArray(candidate.edges)
    && typeof candidate.truncated === 'boolean'
    && Boolean(candidate.appliedLimits && typeof candidate.appliedLimits.returnedNodes === 'number');
}

export function repositoryGraphRequestUrl(request: RepositoryGraphRequest): string {
  const params = new URLSearchParams();
  params.set(request.entry.kind === 'seed' ? 'seed' : 'q', request.entry.value);
  if (request.nodeTypes.length) params.set('node_types', request.nodeTypes.join(','));
  if (request.edgeTypes.length) params.set('edge_types', request.edgeTypes.join(','));
  params.set('direction', request.direction);
  params.set('depth', String(request.depth));
  params.set('limit', String(request.limit));
  if (request.cursor) params.set('cursor', request.cursor);
  return `/api/ui/knowledge/repository-snapshots/${encodeURIComponent(request.snapshotId)}/graph?${params}`;
}

export function createRepositoryGraphLoader(fetcher: typeof fetch = fetch): RepositoryGraphLoader {
  return async (request, signal) => {
    const response = await fetcher(repositoryGraphRequestUrl(request), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(payload, response.status));
    if (!isNeighborhood(payload)) throw new Error('Repository graph returned an invalid response.');
    return payload;
  };
}

export function repositoryGraphOverviewUrl(snapshotId: string): string {
  return `/api/ui/knowledge/repository-snapshots/${encodeURIComponent(snapshotId)}/overview`;
}

export function repositoryFullGraphUrl(snapshotId: string): string {
  return `/api/ui/knowledge/repository-snapshots/${encodeURIComponent(snapshotId)}/full-graph`;
}

export function createRepositoryGraphOverviewLoader(fetcher: typeof fetch = fetch): RepositoryGraphOverviewLoader {
  return async (snapshotId, signal) => {
    const response = await fetcher(repositoryGraphOverviewUrl(snapshotId), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new Error(responseError(payload, response.status));
    if (!isOverview(payload)) throw new Error('Repository graph overview returned an invalid response.');
    return payload;
  };
}

export function createRepositoryFullGraphLoader(fetcher: typeof fetch = fetch): RepositoryFullGraphLoader {
  return async (snapshotId, signal) => {
    const response = await fetcher(repositoryFullGraphUrl(snapshotId), {
      method: 'GET',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal,
    });
    const payload = await response.json().catch(() => ({})) as unknown;
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
        ? String((payload as { error: string }).error)
        : `Repository full graph request failed (${response.status})`;
      throw new Error(message);
    }
    if (!isFullGraph(payload)) throw new Error('Repository full graph returned an invalid response.');
    return payload;
  };
}

export const loadRepositoryGraph = createRepositoryGraphLoader();
export const loadRepositoryGraphOverview = createRepositoryGraphOverviewLoader();
export const loadRepositoryFullGraph = createRepositoryFullGraphLoader();
