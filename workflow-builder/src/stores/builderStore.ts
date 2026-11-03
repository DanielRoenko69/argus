// Builder state — nodes/edges/selection/dirty/viewport + undo/redo history.
// Adapted from sim/apps/sim/stores/workflows/workflow/store.ts (Apache 2.0).

import { create } from 'zustand';
import type { Node, Edge, Viewport, Connection } from 'reactflow';
import { addEdge as rfAddEdge } from 'reactflow';

interface Snapshot {
  nodes: Node[];
  edges: Edge[];
}

const HISTORY_LIMIT = 50;

interface BuilderState {
  nodes: Node[];
  edges: Edge[];
  viewport: Viewport;
  selectedNodeId: string | null;
  dirty: boolean;
  readOnly: boolean;
  past: Snapshot[];
  future: Snapshot[];

  setReadOnly: (readOnly: boolean) => void;

  // Mutations (push to history)
  setNodes: (nodes: Node[], opts?: { skipHistory?: boolean; skipDirty?: boolean }) => void;
  setEdges: (edges: Edge[], opts?: { skipHistory?: boolean; skipDirty?: boolean }) => void;
  setViewport: (vp: Viewport) => void;
  addNode: (node: Node) => void;
  applyGraphPatch: (nodes: Node[], edges: Edge[], opts?: { markClean?: boolean }) => void;
  updateNodeData: (id: string, patch: Record<string, unknown>) => void;
  removeNode: (id: string) => void;
  removeNodes: (ids: string[]) => void;
  duplicateNode: (id: string) => void;
  connect: (conn: Connection) => void;
  selectNode: (id: string | null) => void;
  selectNodes: (ids: string[]) => void;
  markClean: () => void;
  loadFlow: (nodes: Node[], edges: Edge[], viewport: Viewport) => void;
  reset: () => void;

  // History
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
}

function pushHistory(s: BuilderState): Snapshot[] {
  const past = [...s.past, { nodes: s.nodes, edges: s.edges }];
  if (past.length > HISTORY_LIMIT) past.shift();
  return past;
}

export const useBuilderStore = create<BuilderState>((set, get) => ({
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  selectedNodeId: null,
  dirty: false,
  readOnly: false,
  past: [],
  future: [],

  setReadOnly: (readOnly) => set({ readOnly }),

  setNodes: (nodes, opts) =>
    set((s) => s.readOnly ? s : ({
      nodes,
      dirty: opts?.skipDirty ? s.dirty : true,
      past: opts?.skipHistory ? s.past : pushHistory(s),
      future: opts?.skipHistory ? s.future : [],
    })),

  setEdges: (edges, opts) =>
    set((s) => s.readOnly ? s : ({
      edges,
      dirty: opts?.skipDirty ? s.dirty : true,
      past: opts?.skipHistory ? s.past : pushHistory(s),
      future: opts?.skipHistory ? s.future : [],
    })),

  setViewport: (viewport) => set({ viewport }),

  addNode: (node) =>
    set((s) => s.readOnly ? s : ({
      nodes: [...s.nodes, node],
      dirty: true,
      selectedNodeId: node.id,
      past: pushHistory(s),
      future: [],
    })),

  applyGraphPatch: (nodes, edges, opts) =>
    set((s) => s.readOnly ? s : ({
      nodes,
      edges,
      dirty: !opts?.markClean,
      selectedNodeId: null,
      past: pushHistory(s),
      future: [],
    })),

  updateNodeData: (id, patch) =>
    set((s) => s.readOnly ? s : ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)),
      dirty: true,
      past: pushHistory(s),
      future: [],
    })),

  removeNode: (id) =>
    set((s) => s.readOnly ? s : ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
      dirty: true,
      past: pushHistory(s),
      future: [],
    })),

  removeNodes: (ids) =>
    set((s) => {
      if (s.readOnly || ids.length === 0) return s;
      const selected = new Set(ids);
      return {
        nodes: s.nodes.filter((n) => !selected.has(n.id)),
        edges: s.edges.filter((e) => !selected.has(e.source) && !selected.has(e.target)),
        selectedNodeId: null,
        dirty: true,
        past: pushHistory(s),
        future: [],
      };
    }),

  duplicateNode: (id) => {
    const s = get();
    const original = s.nodes.find((n) => n.id === id);
    if (!original) return;
    const newId = `${original.type}.${crypto.randomUUID().slice(0, 8)}`;
    const dup: Node = {
      ...original,
      id: newId,
      position: { x: original.position.x + 40, y: original.position.y + 40 },
      data: JSON.parse(JSON.stringify(original.data)),
      selected: false,
    };
    set({
      nodes: [...s.nodes, dup],
      dirty: true,
      selectedNodeId: newId,
      past: pushHistory(s),
      future: [],
    });
  },

  connect: (conn) =>
    set((s) => ({
      edges: rfAddEdge(conn, s.edges),
      dirty: true,
      past: pushHistory(s),
      future: [],
    })),

  selectNode: (selectedNodeId) => set({ selectedNodeId }),

  selectNodes: (ids) =>
    set((s) => {
      const selected = new Set(ids);
      return {
        nodes: s.nodes.map((node) => ({ ...node, selected: selected.has(node.id) })),
        selectedNodeId: ids.length === 1 ? ids[0]! : null,
      };
    }),

  markClean: () => set({ dirty: false }),

  loadFlow: (nodes, edges, viewport) =>
    set({
      nodes, edges, viewport,
      dirty: false, selectedNodeId: null,
      past: [], future: [],
    }),

  reset: () =>
    set({
      nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 },
      selectedNodeId: null, dirty: false, past: [], future: [],
    }),

  undo: () => {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({
      nodes: prev.nodes,
      edges: prev.edges,
      past: s.past.slice(0, -1),
      future: [{ nodes: s.nodes, edges: s.edges }, ...s.future],
      dirty: true,
    });
  },

  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      nodes: next.nodes,
      edges: next.edges,
      past: [...s.past, { nodes: s.nodes, edges: s.edges }],
      future: s.future.slice(1),
      dirty: true,
    });
  },

  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
}));
