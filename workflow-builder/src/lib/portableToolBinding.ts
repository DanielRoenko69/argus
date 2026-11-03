import type { PaletteTool } from '@/api/palette';

export interface PortableToolBinding {
  integration_id: string;
  action_hints: string[];
  access: 'read' | 'write';
  required_parameters?: string[];
}

export interface PortableToolSelection {
  tool: string;
  integration_id: string | null;
  tool_binding: PortableToolBinding | null;
}

const ACTION_VERBS = new Set([
  'get', 'list', 'search', 'query', 'describe', 'inspect', 'read', 'fetch', 'count', 'show',
  'create', 'send', 'post', 'update', 'delete', 'merge', 'close', 'approve', 'write', 'push',
  'run', 'trigger', 'deploy', 'restart', 'scale', 'patch', 'apply', 'download', 'upload', 'reply',
]);

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function actionHint(tool: PaletteTool): string {
  const explicit = normalized(tool.action_label ?? '');
  if (explicit) return explicit;
  const segments = normalized(tool.name).split('_').filter(Boolean);
  const verbIndex = segments.findIndex(segment => ACTION_VERBS.has(segment));
  return (verbIndex >= 0 ? segments.slice(verbIndex) : segments).join('_');
}

/**
 * Keep the concrete tool for the current environment and attach a portable
 * capability contract for templates, exports and future connection changes.
 * Authentication remains exclusively owned by MCP Fabric.
 */
export function portableToolSelection(tool: PaletteTool): PortableToolSelection {
  const integrationId = tool.integration_id?.trim() || null;
  const hint = actionHint(tool);
  if (!integrationId || !hint) {
    return { tool: tool.name, integration_id: integrationId, tool_binding: null };
  }
  const requiredParameters = (tool.parameters ?? [])
    .filter(parameter => parameter.required)
    .map(parameter => parameter.name);
  const binding: PortableToolBinding = {
    integration_id: integrationId,
    action_hints: [hint],
    access: tool.is_write ? 'write' : 'read',
  };
  if (requiredParameters.length > 0) binding.required_parameters = requiredParameters;
  return {
    tool: tool.name,
    integration_id: integrationId,
    tool_binding: binding,
  };
}

export function portableToolNodeSeed(tool: PaletteTool): Record<string, unknown> {
  return {
    label: tool.action_label ?? tool.name,
    ...portableToolSelection(tool),
    args: {},
  };
}
