// Pure node-data → argus.tool step shape. Kept framework-free so it is
// unit-testable and reused by buildSavePayload's tool branch. Emits exactly
// { type:'argus.tool', tool, args, cred_ref? } per the integration-node spec.

import type { CredRef } from '@/api/workflows';

export interface ToolNodeData {
  label?: string;
  tool?: string | null;
  args?: Record<string, unknown>;
  cred_ref?: { bundle_id?: number } | null;
}

export interface SerializedToolStep {
  type: 'argus.tool';
  tool: string | null;
  args: Record<string, unknown>;
  cred_ref?: CredRef;
}

export function serializeToolNodeData(data: ToolNodeData): SerializedToolStep {
  const step: SerializedToolStep = {
    type: 'argus.tool',
    tool: typeof data.tool === 'string' ? data.tool : null,
    args: data.args ?? {},
  };
  if (data.cred_ref && typeof data.cred_ref.bundle_id === 'number') {
    step.cred_ref = { bundle_id: data.cred_ref.bundle_id };
  }
  return step;
}
