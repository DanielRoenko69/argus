import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITY_STUDIO_FILTERS,
  filterCapabilityStudioTools,
  getCapabilityStudioStats,
} from './capabilityStudio';
import type { CapabilityStudioItem } from './types';

const base = {
  managedId: 1,
  managedBy: null,
  queryTemplate: 'SELECT 1',
  parameters: [],
  inputSchema: null,
  category: 'Operations',
  riskLevel: 'low' as const,
  requiredAuthMode: null,
  workflowCount: 0,
  editable: true,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const tools: CapabilityStudioItem[] = [
  {
    ...base,
    id: 'remote:1',
    managedId: null,
    backendId: 7,
    backend: 'remote:jira',
    backendLabel: 'jira',
    name: 'jira_get_issue',
    description: 'Read a project issue',
    source: 'remote' as const,
    enabled: true,
    isWrite: false,
    bundleIds: [2, 3],
  },
  {
    ...base,
    id: 'remote:2',
    managedId: null,
    backendId: 7,
    backend: 'remote:jira',
    backendLabel: 'jira',
    name: 'jira_update_issue',
    description: 'Update an issue',
    source: 'remote' as const,
    enabled: false,
    isWrite: true,
    bundleIds: [3],
  },
  {
    ...base,
    id: 'managed:3',
    backendId: 4,
    backend: 'custom:postgres',
    backendLabel: 'postgres',
    name: 'sql_query',
    description: 'Run a read-only query',
    source: 'managed' as const,
    enabled: true,
    isWrite: false,
    bundleIds: [],
  },
  {
    ...base,
    id: 'managed:4',
    backendId: null,
    backend: 'http',
    backendLabel: 'Direct HTTP',
    name: 'workspace_write',
    description: 'Write a local workspace file',
    source: 'managed' as const,
    enabled: false,
    isWrite: true,
    bundleIds: [],
  },
];

describe('capability studio catalog', () => {
  it('combines source kind, backend source and case-insensitive text filters', () => {
    const filtered = filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      search: '  PROJECT ISSUE ',
      view: 'remote',
      source: 7,
    });

    expect(filtered.map(tool => tool.name)).toEqual(['jira_get_issue']);
  });

  it('keeps disabled tools in source views and isolates them in the disabled view', () => {
    expect(filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      view: 'managed',
    }).map(tool => tool.name)).toEqual(['sql_query', 'workspace_write']);

    expect(filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      view: 'disabled',
      source: 'direct',
    }).map(tool => tool.name)).toEqual(['workspace_write']);
  });

  it('sorts deterministically by assignments without mutating the input', () => {
    const originalOrder = tools.map(tool => tool.name);
    const filtered = filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      sort: 'assignments',
      direction: 'desc',
    });

    expect(filtered.map(tool => tool.name)).toEqual([
      'jira_get_issue',
      'jira_update_issue',
      'sql_query',
      'workspace_write',
    ]);
    expect(tools.map(tool => tool.name)).toEqual(originalOrder);
  });

  it('filters imported capabilities through their backend source-health mapping', () => {
    const health = new Map([[4, 'drifted' as const], [7, 'current' as const]]);
    expect(filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      health: 'drifted',
    }, health).map(tool => tool.name)).toEqual(['sql_query']);
    expect(filterCapabilityStudioTools(tools, {
      ...DEFAULT_CAPABILITY_STUDIO_FILTERS,
      health: 'error',
    }, health)).toEqual([]);
  });

  it('uses a stable backend-aware tie-breaker for identically named tools', () => {
    const duplicates: CapabilityStudioItem[] = [
      { ...tools[2], id: 'managed:12', backendId: 12, name: 'query' },
      { ...tools[2], id: 'managed:3', backendId: 3, name: 'query' },
      { ...tools[2], id: 'managed:direct', backendId: null, name: 'query' },
    ];

    expect(filterCapabilityStudioTools(duplicates, DEFAULT_CAPABILITY_STUDIO_FILTERS)
      .map(tool => tool.backendId)).toEqual([3, 12, null]);
  });

  it('calculates catalog, governance, access and source statistics', () => {
    expect(getCapabilityStudioStats(tools)).toEqual({
      total: 4,
      enabled: 2,
      managed: 2,
      remote: 2,
      disabled: 2,
      assigned: 2,
      unassigned: 2,
      writeFlagged: 2,
      readOrOther: 2,
      sourceCount: 3,
    });
  });
});
