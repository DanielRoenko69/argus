// Workflow export / import as plain JSON.

import type { FlowState } from '@/api/workflows';
import { api } from '@/api/client';

export async function downloadRunbook(workflowId: number, workflowName: string): Promise<void> {
  const res = await fetch(`/api/workflows/${workflowId}/runbook`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  const md = await res.text();
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${workflowName}.runbook.md`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface WorkflowExportV1 {
  $schema: 'argus-workflow/v1';
  name: string;
  description: string;
  steps: unknown[];
  input_params: unknown[];
  canvas_state: unknown;
  block_definitions: unknown[];
  trigger_config?: unknown;
  exported_at: string;
}

export function downloadFlowAsJson(flow: FlowState): void {
  const payload: WorkflowExportV1 = {
    $schema: 'argus-workflow/v1',
    name: flow.name,
    description: flow.description,
    steps: flow.steps,
    input_params: flow.input_params,
    canvas_state: flow.canvas_state,
    block_definitions: flow.block_definitions,
    trigger_config: flow.trigger_config,
    exported_at: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${flow.name}.workflow.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export async function importFlowFromJson(file: File): Promise<{ id: number; name: string }> {
  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<WorkflowExportV1>;
  if (parsed.$schema !== 'argus-workflow/v1') {
    throw new Error(`unsupported schema: ${parsed.$schema ?? 'missing'}`);
  }
  const newName = `${(parsed.name ?? 'imported').replace(/^tpl_/, '')}_import_${Date.now()}`
    .toLowerCase().replace(/[^a-z0-9_]/g, '_');

  // Create empty workflow first, then PUT /flow with the imported state
  const created = await api.post<{ id: number; name: string }>(`/api/admin/workflows`, {
    name: newName,
    description: parsed.description ?? `Imported on ${new Date().toLocaleString()}`,
    steps: parsed.steps ?? [],
    input_params: parsed.input_params ?? [],
  });
  await api.put(`/api/workflows/${created.id}/flow`, {
    canvas_state: parsed.canvas_state ?? {},
    block_definitions: parsed.block_definitions ?? [],
    trigger_config: parsed.trigger_config ?? {},
  });
  return { id: created.id, name: newName };
}
