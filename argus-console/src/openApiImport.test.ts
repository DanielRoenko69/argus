import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_API_OPERATION_FILTERS,
  filterOpenApiOperations,
  getSelectableOpenApiOperationKeys,
  isOpenApiOperationSelectable,
  reconcileOpenApiOperationSelection,
  sanitizeOpenApiPrefix,
  summarizeOpenApiOperations,
  toggleAllOpenApiOperations,
  toggleOpenApiOperation,
  toggleVisibleOpenApiOperations,
  type OpenApiImportOperation,
} from './openApiImport';

const operations: OpenApiImportOperation[] = [
  {
    key: 'GET /pets',
    name: 'pets__list',
    description: 'List every pet',
    method: 'GET',
    path: '/pets',
    isWrite: false,
    change: 'create',
  },
  {
    key: 'POST /pets',
    name: 'pets__create',
    description: 'Create a pet',
    method: 'POST',
    path: '/pets',
    isWrite: true,
    change: 'update',
  },
  {
    key: 'DELETE /pets/{id}',
    name: 'pets__delete',
    description: 'Delete a pet',
    method: 'DELETE',
    path: '/pets/{id}',
    isWrite: true,
    change: 'collision',
    collision: 'Name belongs to another source',
  },
  {
    key: 'TRACE /diagnostics',
    name: 'pets__diagnostics',
    description: 'Unsupported diagnostics operation',
    method: 'TRACE',
    path: '/diagnostics',
    isWrite: false,
    change: 'unsupported',
    unsupported: ['Method TRACE is not supported'],
  },
  {
    key: 'GET /health',
    name: 'pets__health',
    description: 'Service health',
    method: 'GET',
    path: '/health',
    isWrite: false,
    change: 'unchanged',
  },
];

describe('OpenAPI import prefix', () => {
  it('normalizes titles to a lowercase 32-character backend prefix', () => {
    expect(sanitizeOpenApiPrefix('  Pet Store API!  ')).toBe('pet_store_api');
    expect(sanitizeOpenApiPrefix('Über Café')).toBe('uber_cafe');
    expect(sanitizeOpenApiPrefix('A'.repeat(40))).toBe('a'.repeat(32));
  });

  it('guarantees a valid leading letter and a safe fallback', () => {
    expect(sanitizeOpenApiPrefix('42 / Service')).toBe('api_42_service');
    expect(sanitizeOpenApiPrefix('___---')).toBe('api');
    expect(sanitizeOpenApiPrefix('42'.repeat(30))).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  });
});

describe('OpenAPI operation filtering', () => {
  it('combines text search with read/write filters without reordering input', () => {
    expect(filterOpenApiOperations(operations, {
      search: 'service health',
      filter: 'read',
    }).map(operation => operation.key)).toEqual(['GET /health']);

    expect(filterOpenApiOperations(operations, {
      search: '/pets',
      filter: 'write',
    }).map(operation => operation.key)).toEqual(['POST /pets', 'DELETE /pets/{id}']);
  });

  it('filters changed and conflicting operations independently', () => {
    expect(filterOpenApiOperations(operations, {
      ...DEFAULT_OPEN_API_OPERATION_FILTERS,
      filter: 'changes',
    }).map(operation => operation.key)).toEqual([
      'GET /pets',
      'POST /pets',
    ]);
    expect(filterOpenApiOperations(operations, {
      ...DEFAULT_OPEN_API_OPERATION_FILTERS,
      filter: 'conflicts',
    }).map(operation => operation.key)).toEqual(['DELETE /pets/{id}']);
  });

  it('matches method, path, description and change labels case-insensitively', () => {
    expect(filterOpenApiOperations(operations, { search: 'TRACE', filter: 'all' })[0]?.name)
      .toBe('pets__diagnostics');
    expect(filterOpenApiOperations(operations, { search: 'UPDATE', filter: 'all' })[0]?.name)
      .toBe('pets__create');
  });
});

describe('OpenAPI operation selection', () => {
  it('never considers collisions or unsupported operations selectable', () => {
    expect(isOpenApiOperationSelectable(operations[0]!)).toBe(true);
    expect(isOpenApiOperationSelectable(operations[2]!)).toBe(false);
    expect(isOpenApiOperationSelectable(operations[3]!)).toBe(false);
    expect(getSelectableOpenApiOperationKeys(operations)).toEqual(new Set([
      'GET /pets',
      'POST /pets',
      'GET /health',
    ]));
  });

  it('treats empty issue descriptions and arrays as non-blocking', () => {
    expect(isOpenApiOperationSelectable({
      ...operations[0]!,
      collision: '  ',
      unsupported: [],
    })).toBe(true);
  });

  it('toggles a single row without mutating the prior selection', () => {
    const selected = new Set(['GET /pets']);
    const removed = toggleOpenApiOperation(selected, operations[0]!);
    const conflictAttempt = toggleOpenApiOperation(selected, operations[2]!);

    expect(removed).toEqual(new Set());
    expect(conflictAttempt).toEqual(new Set(['GET /pets']));
    expect(selected).toEqual(new Set(['GET /pets']));
  });

  it('toggles only visible selectable rows and preserves hidden selections', () => {
    const selected = new Set(['POST /pets']);
    const visible = [operations[0]!, operations[2]!, operations[3]!];
    const selectedVisible = toggleVisibleOpenApiOperations(selected, visible);

    expect(selectedVisible).toEqual(new Set(['POST /pets', 'GET /pets']));
    expect(toggleVisibleOpenApiOperations(selectedVisible, visible)).toEqual(new Set(['POST /pets']));
  });

  it('toggles all eligible operations and removes stale or blocked keys', () => {
    const initial = new Set(['stale', 'DELETE /pets/{id}']);
    const selectedAll = toggleAllOpenApiOperations(initial, operations);

    expect(selectedAll).toEqual(new Set(['GET /pets', 'POST /pets', 'GET /health']));
    expect(toggleAllOpenApiOperations(selectedAll, operations)).toEqual(new Set());
  });

  it('reconciles selection when a fresh preview changes eligibility', () => {
    expect(reconcileOpenApiOperationSelection(new Set([
      'GET /pets',
      'DELETE /pets/{id}',
      'TRACE /diagnostics',
      'stale',
    ]), operations)).toEqual(new Set(['GET /pets']));
  });
});

describe('OpenAPI operation summary', () => {
  it('counts access, changes, issues and valid selections', () => {
    expect(summarizeOpenApiOperations(operations, new Set([
      'GET /pets',
      'DELETE /pets/{id}',
      'stale',
    ]))).toEqual({
      total: 5,
      read: 3,
      write: 2,
      changes: 2,
      conflicts: 1,
      unsupported: 1,
      selectable: 3,
      selected: 1,
    });
  });

  it('returns zeroed counters for an empty preview', () => {
    expect(summarizeOpenApiOperations([])).toEqual({
      total: 0,
      read: 0,
      write: 0,
      changes: 0,
      conflicts: 0,
      unsupported: 0,
      selectable: 0,
      selected: 0,
    });
  });
});
