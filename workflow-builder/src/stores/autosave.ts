// Crash-recovery autosave to localStorage.
// Every 30s the current dirty-state is snapshotted; on next mount of a
// workflow with a fresher local snapshot than server data, the user is
// prompted to restore.

import { useEffect, useRef } from 'react';
import { useBuilderStore } from './builderStore';
import { buildSavePayload, type FlowState, type SaveFlowPayload } from '@/api/workflows';
import type { Node, Edge, Viewport } from 'reactflow';

const LS_KEY = (id: number) => `argus.builder.autosave.${id}`;
const INTERVAL_MS = 30_000;

export interface Snapshot {
  payload: SaveFlowPayload;
  ts: number;
}

export function useAutosave(workflowId: number | null): void {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    timer.current = setInterval(() => {
      const s = useBuilderStore.getState();
      if (!s.dirty) return;
      try {
        const snap: Snapshot = {
          payload: buildSavePayload(s.nodes, s.edges, s.viewport),
          ts: Date.now(),
        };
        localStorage.setItem(LS_KEY(workflowId), JSON.stringify(snap));
      } catch { /* quota or disabled */ }
    }, INTERVAL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [workflowId]);
}

/** Returns the recovered snapshot if local copy is newer than server, else null. */
export function checkRecovery(workflowId: number, serverFlow: FlowState | undefined): Snapshot | null {
  if (!serverFlow) return null;
  try {
    const raw = localStorage.getItem(LS_KEY(workflowId));
    if (!raw) return null;
    const snap = JSON.parse(raw) as Snapshot;
    const serverTs = new Date(serverFlow.updated_at).getTime();
    // Only offer if local is at least 2 seconds newer (avoid false-positives)
    if (snap.ts > serverTs + 2000) return snap;
  } catch { /* corrupt */ }
  return null;
}

export function clearRecovery(workflowId: number): void {
  try { localStorage.removeItem(LS_KEY(workflowId)); } catch { /* ignore */ }
}

/** Rebuild React-Flow arrays from a recovery snapshot's save-payload.
 *  Mirrors restoreFromFlow but operates on a SaveFlowPayload (block_definitions
 *  + steps' depends_on) instead of a full FlowState. */
export function payloadToFlowArrays(
  payload: SaveFlowPayload
): { nodes: Node[]; edges: Edge[]; viewport: Viewport } {
  const nodes: Node[] = (payload.block_definitions ?? []).map((b) => ({
    id: b.id,
    type: b.type,
    position: b.position,
    data: b.data,
  }));
  const edges: Edge[] = [];
  for (const step of payload.steps ?? []) {
    for (const dep of step.depends_on ?? []) {
      edges.push({ id: `e-${dep}-${step.id}`, source: dep, target: step.id });
    }
  }
  const viewport: Viewport = payload.canvas_state?.viewport ?? { x: 0, y: 0, zoom: 1 };
  return { nodes, edges, viewport };
}
