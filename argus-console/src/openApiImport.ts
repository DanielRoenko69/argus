export type OpenApiOperationFilter = 'all' | 'read' | 'write' | 'changes' | 'conflicts';

export interface OpenApiImportOperation {
  key: string;
  name: string;
  description?: string | null;
  method?: string | null;
  path?: string | null;
  isWrite: boolean;
  change?: string | null;
  collision?: boolean | string | null;
  unsupported?: boolean | string | ReadonlyArray<string> | null;
}

export interface OpenApiOperationFilters {
  search: string;
  filter: OpenApiOperationFilter;
}

export interface OpenApiOperationSummary {
  total: number;
  read: number;
  write: number;
  changes: number;
  conflicts: number;
  unsupported: number;
  selectable: number;
  selected: number;
}

export const DEFAULT_OPEN_API_OPERATION_FILTERS: OpenApiOperationFilters = {
  search: '',
  filter: 'all',
};

const EMPTY_SELECTION: ReadonlySet<string> = new Set<string>();

/**
 * Produces a backend-safe import prefix while retaining as much of the title as possible.
 * The result always matches /^[a-z][a-z0-9_-]{0,31}$/.
 */
export function sanitizeOpenApiPrefix(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');

  if (!normalized) return 'api';
  const withValidStart = /^[a-z]/.test(normalized) ? normalized : `api_${normalized}`;
  return withValidStart.slice(0, 32);
}

function hasIssue(value: OpenApiImportOperation['collision'] | OpenApiImportOperation['unsupported']): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return value === true;
}

export function openApiOperationHasChange(operation: OpenApiImportOperation): boolean {
  const change = operation.change?.trim().toLowerCase();
  return Boolean(change && !['unchanged', 'collision', 'unsupported'].includes(change));
}

export function openApiOperationHasConflict(operation: OpenApiImportOperation): boolean {
  return hasIssue(operation.collision);
}

export function openApiOperationIsUnsupported(operation: OpenApiImportOperation): boolean {
  return hasIssue(operation.unsupported);
}

export function isOpenApiOperationSelectable(operation: OpenApiImportOperation): boolean {
  return !openApiOperationHasConflict(operation) && !openApiOperationIsUnsupported(operation);
}

export function filterOpenApiOperations<T extends OpenApiImportOperation>(
  operations: ReadonlyArray<T>,
  filters: OpenApiOperationFilters,
): T[] {
  const search = filters.search.trim().toLocaleLowerCase();

  return operations.filter(operation => {
    if (filters.filter === 'read' && operation.isWrite) return false;
    if (filters.filter === 'write' && !operation.isWrite) return false;
    if (filters.filter === 'changes' && !openApiOperationHasChange(operation)) return false;
    if (filters.filter === 'conflicts' && !openApiOperationHasConflict(operation)) return false;
    if (!search) return true;

    return [
      operation.name,
      operation.description ?? '',
      operation.method ?? '',
      operation.path ?? '',
      operation.change ?? '',
    ].join(' ').toLocaleLowerCase().includes(search);
  });
}

export function getSelectableOpenApiOperationKeys(
  operations: ReadonlyArray<OpenApiImportOperation>,
): Set<string> {
  return new Set(operations
    .filter(isOpenApiOperationSelectable)
    .map(operation => operation.key));
}

/** Removes stale, conflicting and unsupported keys after a new preview arrives. */
export function reconcileOpenApiOperationSelection(
  selectedKeys: ReadonlySet<string>,
  operations: ReadonlyArray<OpenApiImportOperation>,
): Set<string> {
  const selectableKeys = getSelectableOpenApiOperationKeys(operations);
  return new Set([...selectedKeys].filter(key => selectableKeys.has(key)));
}

export function toggleOpenApiOperation(
  selectedKeys: ReadonlySet<string>,
  operation: OpenApiImportOperation,
): Set<string> {
  const next = new Set(selectedKeys);
  if (!isOpenApiOperationSelectable(operation)) {
    next.delete(operation.key);
    return next;
  }
  if (next.has(operation.key)) next.delete(operation.key);
  else next.add(operation.key);
  return next;
}

function toggleOperationGroup(
  selectedKeys: ReadonlySet<string>,
  operations: ReadonlyArray<OpenApiImportOperation>,
): Set<string> {
  const selectableKeys = getSelectableOpenApiOperationKeys(operations);
  const allSelected = selectableKeys.size > 0
    && [...selectableKeys].every(key => selectedKeys.has(key));
  const next = new Set(selectedKeys);

  for (const operation of operations) {
    if (!isOpenApiOperationSelectable(operation)) next.delete(operation.key);
  }
  for (const key of selectableKeys) {
    if (allSelected) next.delete(key);
    else next.add(key);
  }
  return next;
}

/** Toggles selectable rows in the current filtered result and preserves hidden selections. */
export function toggleVisibleOpenApiOperations(
  selectedKeys: ReadonlySet<string>,
  visibleOperations: ReadonlyArray<OpenApiImportOperation>,
): Set<string> {
  return toggleOperationGroup(selectedKeys, visibleOperations);
}

/** Toggles every selectable row in the complete preview catalog. */
export function toggleAllOpenApiOperations(
  selectedKeys: ReadonlySet<string>,
  allOperations: ReadonlyArray<OpenApiImportOperation>,
): Set<string> {
  const reconciled = reconcileOpenApiOperationSelection(selectedKeys, allOperations);
  return toggleOperationGroup(reconciled, allOperations);
}

export function summarizeOpenApiOperations(
  operations: ReadonlyArray<OpenApiImportOperation>,
  selectedKeys: ReadonlySet<string> = EMPTY_SELECTION,
): OpenApiOperationSummary {
  let read = 0;
  let write = 0;
  let changes = 0;
  let conflicts = 0;
  let unsupported = 0;
  let selectable = 0;
  const selected = new Set<string>();

  for (const operation of operations) {
    if (operation.isWrite) write += 1;
    else read += 1;
    if (openApiOperationHasChange(operation)) changes += 1;
    if (openApiOperationHasConflict(operation)) conflicts += 1;
    if (openApiOperationIsUnsupported(operation)) unsupported += 1;
    if (isOpenApiOperationSelectable(operation)) {
      selectable += 1;
      if (selectedKeys.has(operation.key)) selected.add(operation.key);
    }
  }

  return {
    total: operations.length,
    read,
    write,
    changes,
    conflicts,
    unsupported,
    selectable,
    selected: selected.size,
  };
}
