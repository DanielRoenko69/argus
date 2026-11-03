import { describe, expect, it } from 'vitest';
import { capabilityToolKey, countCapabilitySources, filterAvailableCapabilities } from './capabilityCatalog';
import type { FabricManagementTool } from './types';

const tools: FabricManagementTool[] = [
  { backendId: 2, name: 'jira_get_issue', description: 'Read issue', source: 'dynamic', enabled: true, isWrite: false, bundleIds: [] },
  { backendId: 2, name: 'jira_update_issue', description: 'Update issue', source: 'dynamic', enabled: true, isWrite: true, bundleIds: [7] },
  { backendId: null, name: 'workspace_read', description: 'Read file', source: 'dynamic', enabled: true, isWrite: false, bundleIds: [3] },
  { backendId: null, name: 'workspace_write', description: 'Write file', source: 'dynamic', enabled: false, isWrite: true, bundleIds: [] },
];

describe('bundle capability catalog', () => {
  it('excludes disabled tools and capabilities already included in the bundle', () => {
    expect(filterAvailableCapabilities(tools, 7, {
      search: '', access: 'all', assignment: 'all', source: 'all',
    }).map(tool => tool.name)).toEqual(['jira_get_issue', 'workspace_read']);
  });

  it('combines search, source, assignment and access filters', () => {
    expect(filterAvailableCapabilities(tools, 9, {
      search: 'issue', access: 'read', assignment: 'unassigned', source: 2,
    }).map(tool => tool.name)).toEqual(['jira_get_issue']);
    expect(filterAvailableCapabilities(tools, 9, {
      search: 'file', access: 'read', assignment: 'governed', source: 'direct',
    }).map(tool => tool.name)).toEqual(['workspace_read']);
  });

  it('uses stable backend-aware keys and counts direct tools as one source', () => {
    expect(capabilityToolKey(tools[0])).toBe('2:jira_get_issue');
    expect(capabilityToolKey(tools[2])).toBe('direct:workspace_read');
    expect(countCapabilitySources(tools)).toBe(2);
  });
});
