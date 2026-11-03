import { useMutation } from '@tanstack/react-query';
import { api } from './client';
import type { BlockDefinition } from './workflows';

export interface CopilotEdge {
  source: string;
  target: string;
}

export interface CopilotNodeUpdate {
  id: string;
  data: Record<string, unknown>;
}

export interface CopilotSuggestion {
  rationale: string;
  add_nodes: BlockDefinition[];
  update_nodes?: CopilotNodeUpdate[];
  add_edges: CopilotEdge[];
  input_params?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean';
    description: string;
    required: boolean;
    default?: string | number | boolean;
  }>;
  warnings?: string[];
}

export function useCopilot() {
  return useMutation({
    mutationFn: (vars: {
      workflowId: number;
      prompt: string;
      current_nodes: BlockDefinition[];
      current_edges: CopilotEdge[];
    }) =>
      api.post<CopilotSuggestion>('/api/workflows/copilot', {
        workflow_id: vars.workflowId,
        prompt: vars.prompt,
        current_nodes: vars.current_nodes,
        current_edges: vars.current_edges,
      }),
  });
}

export interface CopilotFieldVars {
  field_name: string;
  current_value: string;
  user_hint: string;
  node_type: string;
  node_label: string;
}
export function useCopilotField() {
  return useMutation({
    mutationFn: (vars: CopilotFieldVars) =>
      api.post<{ value: string }>('/api/workflows/copilot-field', vars),
  });
}
