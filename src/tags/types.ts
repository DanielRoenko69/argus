export const TAGGABLE_RESOURCE_TYPES = [
  'agent',
  'blueprint',
  'public_widget',
  'knowledge_source',
  'repository_snapshot',
  'skill',
  'workflow',
  'workflow_template',
  'mcp_connection',
  'mcp_bundle',
  'mcp_tool',
  'mcp_capability',
  'aiops_service_profile',
  'ai_system',
] as const;

export type TaggableResourceType = typeof TAGGABLE_RESOURCE_TYPES[number];

export interface TagRef {
  id: string;
  label: string;
  color: string | null;
}

export interface WorkspaceTag extends TagRef {
  slug: string;
  description: string;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceRef {
  type: TaggableResourceType;
  id: string;
  label: string;
  href: string | null;
  version: string | null;
  tags: TagRef[];
  capturedAt: string;
}

export interface TagMutationInput {
  slug?: unknown;
  label?: unknown;
  color?: unknown;
  description?: unknown;
}

export interface NormalizedTagMutation {
  slug: string;
  label: string;
  color: string | null;
  description: string;
}
