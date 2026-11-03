import type { FabricManagementTool } from './types';

export type CapabilityAccessFilter = 'all' | 'read' | 'write';
export type CapabilityAssignmentFilter = 'all' | 'unassigned' | 'governed';
export type CapabilitySourceFilter = 'all' | 'direct' | number;

export interface CapabilityCatalogFilters {
  search: string;
  access: CapabilityAccessFilter;
  assignment: CapabilityAssignmentFilter;
  source: CapabilitySourceFilter;
}

export function capabilityToolKey(tool: Pick<FabricManagementTool, 'backendId' | 'name'>): string {
  return `${tool.backendId ?? 'direct'}:${tool.name}`;
}

export function filterAvailableCapabilities(
  tools: FabricManagementTool[],
  bundleId: number,
  filters: CapabilityCatalogFilters,
): FabricManagementTool[] {
  const search = filters.search.trim().toLowerCase();
  return tools
    .filter(tool => tool.enabled && !tool.bundleIds.includes(bundleId))
    .filter(tool => filters.access === 'all'
      || (filters.access === 'write' ? tool.isWrite : !tool.isWrite))
    .filter(tool => filters.assignment === 'all'
      || (filters.assignment === 'unassigned' ? tool.bundleIds.length === 0 : tool.bundleIds.length > 0))
    .filter(tool => filters.source === 'all'
      || (filters.source === 'direct' ? tool.backendId == null : tool.backendId === filters.source))
    .filter(tool => !search || `${tool.name} ${tool.description}`.toLowerCase().includes(search))
    .sort((left, right) => {
      const assignmentOrder = Number(left.bundleIds.length > 0) - Number(right.bundleIds.length > 0);
      return assignmentOrder || left.name.localeCompare(right.name);
    });
}

export function countCapabilitySources(tools: FabricManagementTool[]): number {
  return new Set(tools.map(tool => tool.backendId ?? 'direct')).size;
}
