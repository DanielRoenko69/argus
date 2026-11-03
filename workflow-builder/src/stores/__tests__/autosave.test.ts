import { describe, it, expect, beforeEach } from 'vitest';
import { checkRecovery, clearRecovery, payloadToFlowArrays, type Snapshot } from '../autosave';
import type { FlowState } from '@/api/workflows';

const LS_KEY = (id: number) => `argus.builder.autosave.${id}`;

function serverFlow(updatedAt: string): FlowState {
  return {
    id: 1, name: 'wf', description: '', steps: [], input_params: [],
    canvas_state: { viewport: { x: 0, y: 0, zoom: 1 } },
    trigger_config: {}, block_definitions: [], source: 'visual',
    enabled: true, updated_at: updatedAt,
  };
}

const snap: Snapshot = {
  ts: Date.now(),
  payload: {
    steps: [{ id: 'a', label: 'A', type: 'tool', args: {} }],
    canvas_state: { viewport: { x: 5, y: 6, zoom: 2 }, theme: 'dark' },
    block_definitions: [{ id: 'a', type: 'tool', position: { x: 1, y: 2 }, data: { label: 'A' } }],
  },
};

beforeEach(() => localStorage.clear());

describe('checkRecovery', () => {
  it('returns the snapshot when local is >2s newer than server', () => {
    const server = serverFlow(new Date(snap.ts - 5000).toISOString());
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    expect(checkRecovery(1, server)).toEqual(snap);
  });

  it('returns null when server is newer', () => {
    const server = serverFlow(new Date(snap.ts + 5000).toISOString());
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    expect(checkRecovery(1, server)).toBeNull();
  });

  it('clearRecovery removes the key', () => {
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    clearRecovery(1);
    expect(localStorage.getItem(LS_KEY(1))).toBeNull();
  });
});

describe('payloadToFlowArrays', () => {
  it('rebuilds nodes/edges/viewport from a snapshot payload', () => {
    const { nodes, edges, viewport } = payloadToFlowArrays(snap.payload);
    expect(nodes).toEqual([{ id: 'a', type: 'tool', position: { x: 1, y: 2 }, data: { label: 'A' } }]);
    expect(edges).toEqual([]);
    expect(viewport).toEqual({ x: 5, y: 6, zoom: 2 });
  });
});
