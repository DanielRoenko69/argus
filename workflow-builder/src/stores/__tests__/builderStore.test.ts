import { describe, it, expect, beforeEach } from 'vitest';
import type { Node } from 'reactflow';
import { useBuilderStore } from '../builderStore';

const node = (id: string): Node => ({ id, type: 'tool', position: { x: 0, y: 0 }, data: {} });

describe('builderStore dirty tracking', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.getState().loadFlow([node('a')], [], { x: 0, y: 0, zoom: 1 });
  });

  it('loadFlow leaves the store clean', () => {
    expect(useBuilderStore.getState().dirty).toBe(false);
  });

  it('setNodes marks dirty by default (a real user edit)', () => {
    useBuilderStore.getState().setNodes([node('a'), node('b')]);
    expect(useBuilderStore.getState().dirty).toBe(true);
  });

  // Regression: React Flow fires 'dimensions'/'select' changes on mount; routing
  // those through setNodes used to flip a freshly-loaded workflow to dirty,
  // spuriously arming the unsaved-changes guard + autosave/recovery banner.
  it('setNodes with skipDirty keeps the store clean (benign mount-time change)', () => {
    useBuilderStore.getState().setNodes([node('a')], { skipDirty: true, skipHistory: true });
    expect(useBuilderStore.getState().dirty).toBe(false);
  });

  it('setEdges with skipDirty keeps the store clean', () => {
    useBuilderStore.getState().setEdges([], { skipDirty: true, skipHistory: true });
    expect(useBuilderStore.getState().dirty).toBe(false);
  });

  it('skipDirty does not reset an already-dirty flag', () => {
    useBuilderStore.getState().setNodes([node('a'), node('b')]); // dirty -> true
    useBuilderStore.getState().setNodes([node('a'), node('b')], { skipDirty: true });
    expect(useBuilderStore.getState().dirty).toBe(true); // preserved, not cleared
  });

  it('tracks multi-selection without marking the workflow dirty', () => {
    useBuilderStore.getState().loadFlow([node('a'), node('b'), node('c')], [], { x: 0, y: 0, zoom: 1 });
    useBuilderStore.getState().selectNodes(['a', 'c']);

    const state = useBuilderStore.getState();
    expect(state.nodes.filter((candidate) => candidate.selected).map((candidate) => candidate.id)).toEqual(['a', 'c']);
    expect(state.selectedNodeId).toBeNull();
    expect(state.dirty).toBe(false);
  });

  it('keeps the inspector selection for exactly one selected node', () => {
    useBuilderStore.getState().loadFlow([node('a'), node('b')], [], { x: 0, y: 0, zoom: 1 });
    useBuilderStore.getState().selectNodes(['b']);

    expect(useBuilderStore.getState().selectedNodeId).toBe('b');
  });

  it('removes a multi-selection and all connected edges as one history action', () => {
    useBuilderStore.getState().loadFlow(
      [node('a'), node('b'), node('c')],
      [
        { id: 'a-b', source: 'a', target: 'b' },
        { id: 'b-c', source: 'b', target: 'c' },
      ],
      { x: 0, y: 0, zoom: 1 },
    );
    useBuilderStore.getState().removeNodes(['a', 'b']);

    const state = useBuilderStore.getState();
    expect(state.nodes.map((candidate) => candidate.id)).toEqual(['c']);
    expect(state.edges).toEqual([]);
    expect(state.past).toHaveLength(1);
    expect(state.dirty).toBe(true);
  });

  it('applies a persisted Copilot graph as one undoable history action', () => {
    const existing = node('a');
    const generated = node('b');
    useBuilderStore.getState().loadFlow([existing], [], { x: 0, y: 0, zoom: 1 });

    useBuilderStore.getState().applyGraphPatch(
      [existing, generated],
      [{ id: 'a-b', source: 'a', target: 'b' }],
      { markClean: true },
    );

    expect(useBuilderStore.getState().nodes.map(candidate => candidate.id)).toEqual(['a', 'b']);
    expect(useBuilderStore.getState().edges).toHaveLength(1);
    expect(useBuilderStore.getState().dirty).toBe(false);
    expect(useBuilderStore.getState().past).toHaveLength(1);

    useBuilderStore.getState().undo();
    expect(useBuilderStore.getState().nodes.map(candidate => candidate.id)).toEqual(['a']);
    expect(useBuilderStore.getState().edges).toEqual([]);
    expect(useBuilderStore.getState().dirty).toBe(true);
  });
});
