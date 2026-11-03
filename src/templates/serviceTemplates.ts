// ── Service Templates for MCP Server Builder ──────────────────

// ── Types ────────────────────────────────────────────────────

export interface TemplateField {
  name: string;
  label: string;
  type: 'string' | 'number' | 'password' | 'select';
  required: boolean;
  default?: string;
  placeholder?: string;
  options?: string[]; // for 'select' type
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean';
  description: string;
  required: boolean;
  default?: string;
}

export interface TemplateToolDefinition {
  nameSuffix: string;
  description: string;
  backend: string;
  queryTemplate: string;
  parameters: ToolParameter[];
  category: string;
  /** Explicit semantic override for native POST-based search/read APIs. */
  readOnly?: boolean;
}

export interface ServiceTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  subcategory?: string;
  tags?: string[];
  backendType?: 'http' | 'mcp';
  docsUrl?: string;
  fields: TemplateField[];
  tools: TemplateToolDefinition[];
  buildBaseUrl: (fields: Record<string, string>) => string;
  buildAuthType?: (fields: Record<string, string>) => string;
  buildAuthValue?: (fields: Record<string, string>) => string;
  buildHealthPath?: (fields: Record<string, string>) => string;
  buildDefaultHeaders?: (fields: Record<string, string>) => Record<string, string>;
  /** Provider-specific metadata used by workflows as well as MCP tools. */
  buildConfig?: (fields: Record<string, string>) => Record<string, unknown>;
  buildMcpEndpoint?: (fields: Record<string, string>) => string;
}

// ── Template Registry ────────────────────────────────────────

import { ALL_TEMPLATES } from './templates/index.js';

export function getAllTemplates(): ServiceTemplate[] {
  return ALL_TEMPLATES;
}

export function getTemplateById(id: string): ServiceTemplate | undefined {
  return ALL_TEMPLATES.find(t => t.id === id);
}

export function getTemplatesByCategory(category: string): ServiceTemplate[] {
  return ALL_TEMPLATES.filter(t => t.category === category);
}

export function searchTemplates(query: string): ServiceTemplate[] {
  const q = query.toLowerCase();
  return ALL_TEMPLATES.filter(t =>
    t.name.toLowerCase().includes(q) ||
    t.description.toLowerCase().includes(q) ||
    (t.tags ?? []).some(tag => tag.toLowerCase().includes(q))
  );
}
