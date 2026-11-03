import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface PaletteSkill {
  id: number;
  name: string;
  label: string;
  category: string;
}
export interface PaletteAgent {
  id: number;
  name: string;
  label: string;
  agent_mode: string;
  model: string;
  agent_role?: string | null;
  runtime_type?: string | null;
  runtime_profile_label?: string | null;
  runtime_model?: string | null;
  runtime_enabled?: boolean | null;
  /** Item 3: enabled RAG indexes bound to this agent (palette-enriched). */
  rag_indexes?: { id: number; label: string; name: string }[];
}
export interface PaletteRagIndex {
  id: number;
  name: string;
  label: string;
  provider: string;
  description: string;
}
/** A single declared parameter of a tool, mirrored from the backend palette. */
export interface ToolParam {
  name: string;
  /** Use `string` (not a union) to match the API boundary — narrowing happens in the form. */
  type: string;
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
}

export interface PaletteTool {
  id: number;
  name: string;
  description: string;
  backend: string;
  tool_type: string;
  connection_id?: number | null;
  connection_name?: string | null;
  integration_id?: string;
  integration_label?: string;
  integration_brand?: string | null;
  action_label?: string;
  is_write?: boolean;
  risk_level?: 'low' | 'medium' | 'high';
  /**
   * Declared parameter schema (Component B). When absent or empty the tool
   * is treated as freeform → ToolConfigForm renders a raw-JSON args editor.
   */
  parameters?: ToolParam[];
  /** 'freeform' forces the JSON editor regardless of `parameters`. */
  freeform?: boolean;
}

export interface PaletteIntegration {
  id: string;
  label: string;
  description: string;
  category: string;
  brand: string | null;
  fallback_icon: string;
  state: 'ready' | 'unconfigured' | 'unavailable';
  tool_count: number;
  connection_count: number;
  can_configure: boolean;
  configure_href: string;
}

export interface Palette {
  skills: PaletteSkill[];
  agents: PaletteAgent[];
  tools: PaletteTool[];
  /** Provider groups derived from the live MCP Fabric, including setup state. */
  integrations?: PaletteIntegration[];
  /** Enabled Knowledge Sources accessible to standalone workflow nodes. */
  rag_indexes?: PaletteRagIndex[];
}

export function usePalette() {
  return useQuery({
    queryKey: ['palette'],
    queryFn: () => api.get<Palette>('/api/workflows/palette'),
    staleTime: 60_000,
  });
}
