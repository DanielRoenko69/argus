import type { CapabilityStudioItem, OpenApiCapabilitySourceStatus } from './types';

export type CapabilityStudioView = 'all' | 'managed' | 'remote' | 'disabled';
export type CapabilityStudioSourceFilter = 'all' | 'direct' | number;
export type CapabilityStudioSort = 'name' | 'source' | 'assignments' | 'access' | 'status';
export type CapabilityStudioSortDirection = 'asc' | 'desc';
export type CapabilityStudioHealthFilter = 'all' | OpenApiCapabilitySourceStatus;

export interface CapabilityStudioFilters {
  search: string;
  view: CapabilityStudioView;
  source: CapabilityStudioSourceFilter;
  health: CapabilityStudioHealthFilter;
  sort: CapabilityStudioSort;
  direction: CapabilityStudioSortDirection;
}

export interface CapabilityStudioStats {
  total: number;
  enabled: number;
  managed: number;
  remote: number;
  disabled: number;
  assigned: number;
  unassigned: number;
  writeFlagged: number;
  readOrOther: number;
  sourceCount: number;
}

export const DEFAULT_CAPABILITY_STUDIO_FILTERS: CapabilityStudioFilters = {
  search: '',
  view: 'all',
  source: 'all',
  health: 'all',
  sort: 'name',
  direction: 'asc',
};

function matchesView(tool: CapabilityStudioItem, view: CapabilityStudioView): boolean {
  if (view === 'managed') return tool.source === 'managed';
  if (view === 'remote') return tool.source === 'remote';
  if (view === 'disabled') return !tool.enabled;
  return true;
}

function matchesSource(tool: CapabilityStudioItem, source: CapabilityStudioSourceFilter): boolean {
  if (source === 'all') return true;
  if (source === 'direct') return tool.backendId == null;
  return tool.backendId === source;
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}

function comparePrimary(
  left: CapabilityStudioItem,
  right: CapabilityStudioItem,
  sort: CapabilityStudioSort,
): number {
  if (sort === 'source') {
    const kindOrder = compareText(left.source, right.source);
    return kindOrder || (left.backendId ?? -1) - (right.backendId ?? -1);
  }
  if (sort === 'assignments') return left.bundleIds.length - right.bundleIds.length;
  if (sort === 'access') return Number(left.isWrite) - Number(right.isWrite);
  if (sort === 'status') return Number(left.enabled) - Number(right.enabled);
  return compareText(left.name, right.name);
}

/**
 * Filters and sorts the management catalog without mutating the API response.
 * `managed` maps to locally stored dynamic tools; `remote` maps to discovered MCP tools.
 * Disabled tools deliberately remain visible in either source view and can also be isolated
 * through the dedicated `disabled` view.
 */
export function filterCapabilityStudioTools(
  tools: ReadonlyArray<CapabilityStudioItem>,
  filters: CapabilityStudioFilters,
  sourceHealthByBackend: ReadonlyMap<number, OpenApiCapabilitySourceStatus> = new Map(),
): CapabilityStudioItem[] {
  const search = filters.search.trim().toLocaleLowerCase();

  return tools
    .map((tool, index) => ({ tool, index }))
    .filter(({ tool }) => matchesView(tool, filters.view))
    .filter(({ tool }) => matchesSource(tool, filters.source))
    .filter(({ tool }) => filters.health === 'all'
      || tool.backendId != null && sourceHealthByBackend.get(tool.backendId) === filters.health)
    .filter(({ tool }) => {
      if (!search) return true;
      const searchable = [
        tool.name,
        tool.description,
        tool.source,
        tool.backendLabel,
        tool.category ?? '',
        tool.backendId == null ? 'direct' : String(tool.backendId),
        tool.backendId == null ? '' : sourceHealthByBackend.get(tool.backendId) ?? '',
      ].join(' ').toLocaleLowerCase();
      return searchable.includes(search);
    })
    .sort((left, right) => {
      const primary = comparePrimary(left.tool, right.tool, filters.sort);
      if (primary) return filters.direction === 'asc' ? primary : -primary;

      const nameOrder = compareText(left.tool.name, right.tool.name);
      if (nameOrder) return nameOrder;

      const backendOrder = (left.tool.backendId ?? Number.MAX_SAFE_INTEGER)
        - (right.tool.backendId ?? Number.MAX_SAFE_INTEGER);
      if (backendOrder) return backendOrder;
      const keyOrder = compareText(left.tool.id, right.tool.id);
      return keyOrder || left.index - right.index;
    })
    .map(({ tool }) => tool);
}

export function getCapabilityStudioStats(
  tools: ReadonlyArray<CapabilityStudioItem>,
): CapabilityStudioStats {
  let enabled = 0;
  let managed = 0;
  let remote = 0;
  let disabled = 0;
  let assigned = 0;
  let writeFlagged = 0;
  const sources = new Set<number | 'direct'>();

  for (const tool of tools) {
    if (tool.enabled) enabled += 1;
    else disabled += 1;

    if (tool.source === 'managed') managed += 1;
    if (tool.source === 'remote') remote += 1;

    if (tool.bundleIds.length > 0) assigned += 1;
    if (tool.isWrite) writeFlagged += 1;
    sources.add(tool.backendId ?? 'direct');
  }

  return {
    total: tools.length,
    enabled,
    managed,
    remote,
    disabled,
    assigned,
    unassigned: tools.length - assigned,
    writeFlagged,
    readOrOther: tools.length - writeFlagged,
    sourceCount: sources.size,
  };
}
