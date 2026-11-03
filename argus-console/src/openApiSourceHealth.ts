import type {
  OpenApiCapabilitySource,
  OpenApiCapabilitySourceStatus,
  OpenApiSourceAuthSnapshot,
} from './types';

export type OpenApiSourceListFilter = 'all' | OpenApiCapabilitySourceStatus;

export interface OpenApiSourceHealthCounts {
  total: number;
  unchecked: number;
  current: number;
  drifted: number;
  error: number;
  attention: number;
}

export const OPEN_API_SOURCE_STATUS_META: Record<OpenApiCapabilitySourceStatus, {
  label: string;
  detail: string;
}> = {
  unchecked: { label: 'Unchecked', detail: 'No source comparison has run yet.' },
  current: { label: 'Current', detail: 'The observed source matches the imported baseline.' },
  drifted: { label: 'Drift detected', detail: 'The source differs from the imported capabilities.' },
  error: { label: 'Unavailable', detail: 'The last source check could not complete.' },
};

export function countOpenApiSourceHealth(
  sources: ReadonlyArray<OpenApiCapabilitySource>,
): OpenApiSourceHealthCounts {
  const counts: OpenApiSourceHealthCounts = {
    total: sources.length,
    unchecked: 0,
    current: 0,
    drifted: 0,
    error: 0,
    attention: 0,
  };
  for (const source of sources) counts[source.status] += 1;
  counts.attention = counts.drifted + counts.error;
  return counts;
}

export function filterOpenApiSources(
  sources: ReadonlyArray<OpenApiCapabilitySource>,
  search: string,
  status: OpenApiSourceListFilter,
): OpenApiCapabilitySource[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return sources
    .filter(source => status === 'all' || source.status === status)
    .filter(source => {
      if (!normalizedSearch) return true;
      return [
        source.name,
        source.prefix,
        source.source.kind,
        source.source.url ?? '',
        OPEN_API_SOURCE_STATUS_META[source.status].label,
      ].join(' ').toLocaleLowerCase().includes(normalizedSearch);
    })
    .sort((left, right) => {
      const priority = (value: OpenApiCapabilitySourceStatus) => (
        value === 'drifted' ? 0 : value === 'error' ? 1 : value === 'unchecked' ? 2 : 3
      );
      return priority(left.status) - priority(right.status)
        || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
        || left.id - right.id;
    });
}

export function formatOpenApiSourceAuth(auth: OpenApiSourceAuthSnapshot): string {
  if (!auth || auth.type === 'none') return 'None';
  if (auth.type === 'header') return auth.headerName ? `API key · ${auth.headerName}` : 'API key header';
  if (auth.type === 'bearer') return 'Bearer token';
  return 'Basic authentication';
}

export function shortSourceDigest(value: string | null | undefined): string {
  if (!value) return '—';
  return value.length > 14 ? `${value.slice(0, 7)}…${value.slice(-5)}` : value;
}
