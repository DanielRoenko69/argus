import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useBuilderStore } from '@/stores/builderStore';
import type { FlowState } from '@/api/workflows';
import type { Snapshot } from '@/stores/autosave';

const LS_KEY = (id: number) => `argus.builder.autosave.${id}`;

const baseTs = 1_700_000_000_000;
const serverFlow: FlowState = {
  id: 1, name: 'wf', description: '', steps: [], input_params: [],
  canvas_state: { viewport: { x: 0, y: 0, zoom: 1 } },
  trigger_config: {}, block_definitions: [], source: 'visual',
  enabled: true, updated_at: new Date(baseTs).toISOString(), can_edit: true,
};
let currentServerFlow: FlowState = serverFlow;

const snap: Snapshot = {
  ts: baseTs + 60_000,
  payload: {
    steps: [{ id: 'recovered', label: 'Recovered', type: 'tool', args: {} }],
    canvas_state: { viewport: { x: 9, y: 9, zoom: 3 }, theme: 'dark' },
    block_definitions: [
      { id: 'recovered', type: 'tool', position: { x: 1, y: 1 }, data: { label: 'Recovered' } },
    ],
  },
};

// Mock IO-heavy hooks so WorkflowEditor mounts in jsdom.
vi.mock('@/api/workflows', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/workflows')>();
  return {
    ...actual,
    useFlow: () => ({ data: currentServerFlow, isLoading: false, error: null }),
    useSaveFlow: () => ({ mutate: vi.fn() }),
  };
});
vi.mock('@/api/execution', () => ({
  useExecutionStream: () => {},
  useExecuteWorkflow: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/api/replay', () => ({
  useWorkflowReplay: () => ({ data: null, isLoading: false, error: null }),
}));
vi.mock('@/canvas/useKeyboardShortcuts', () => ({ useKeyboardShortcuts: () => {} }));
vi.mock('@/canvas/Canvas', () => ({ Canvas: () => <div data-testid="canvas" /> }));
vi.mock('@/execution/ExecutionLog', () => ({ ExecutionLog: () => null }));

// Mock heavy sidebar/panel components to keep render lightweight.
vi.mock('@/sidebar/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('@/canvas/TopBar', () => ({ TopBar: () => null }));
vi.mock('@/properties/PropertiesPanel', () => ({ PropertiesPanel: () => null }));
vi.mock('@/canvas/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/canvas/SearchReplace', () => ({ SearchReplace: () => null }));
vi.mock('@/copilot/CopilotPanel', () => ({ CopilotPanel: () => null }));

import { App } from '../App';

function renderAt(id: number) {
  return render(
    <MemoryRouter initialEntries={[`/workflows/${id}`]}>
      <Routes>
        <Route path="/workflows/:id" element={<App />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  useBuilderStore.getState().reset();
  useBuilderStore.getState().setReadOnly(false);
  currentServerFlow = serverFlow;
});

describe('crash-recovery wiring', () => {
  it('shows the recovery prompt when a newer local snapshot exists', () => {
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    renderAt(1);
    expect(screen.getByText('Ungespeicherte Änderungen wiederherstellen?')).toBeInTheDocument();
  });

  it('restores the snapshot into the store and clears it on accept', () => {
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    renderAt(1);
    fireEvent.click(screen.getByRole('button', { name: 'Wiederherstellen' }));
    const s = useBuilderStore.getState();
    expect(s.nodes.map((n) => n.id)).toEqual(['recovered']);
    expect(s.viewport).toEqual({ x: 9, y: 9, zoom: 3 });
    expect(localStorage.getItem(LS_KEY(1))).toBeNull();
    expect(screen.queryByText('Ungespeicherte Änderungen wiederherstellen?')).toBeNull();
  });

  it('clears the snapshot and hides the prompt on decline', () => {
    localStorage.setItem(LS_KEY(1), JSON.stringify(snap));
    renderAt(1);
    fireEvent.click(screen.getByRole('button', { name: 'Verwerfen' }));
    expect(localStorage.getItem(LS_KEY(1))).toBeNull();
    expect(screen.queryByText('Ungespeicherte Änderungen wiederherstellen?')).toBeNull();
  });

  it('keeps local canvas edits when the same workflow is refetched in the background', () => {
    const view = renderAt(1);
    useBuilderStore.getState().setNodes([{
      id: 'argus.agent.local',
      type: 'argus.agent',
      position: { x: 96, y: 96 },
      data: { label: 'Agent', args: {} },
    }]);

    currentServerFlow = {
      ...serverFlow,
      updated_at: new Date(baseTs + 120_000).toISOString(),
    };
    view.rerender(
      <MemoryRouter initialEntries={['/workflows/1']}>
        <Routes>
          <Route path="/workflows/:id" element={<App />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(useBuilderStore.getState().nodes.map((node) => node.id)).toEqual(['argus.agent.local']);
    expect(useBuilderStore.getState().dirty).toBe(true);
  });

  it('does NOT show the prompt when no newer snapshot exists', () => {
    renderAt(1);
    expect(screen.queryByText('Ungespeicherte Änderungen wiederherstellen?')).toBeNull();
  });
});
