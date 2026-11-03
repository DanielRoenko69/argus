import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useBuilderStore } from '@/stores/builderStore';

vi.mock('@/api/palette', () => ({
  usePalette: () => ({
    data: {
      skills: [],
      tools: [],
      agents: [
        {
          id: 5, name: 'researcher', label: 'Researcher', agent_mode: 'chat', model: 'gpt-4o', agent_role: 'knowledge',
          rag_indexes: [
            { id: 7, label: 'Postmortems', name: 'argus_postmortems' },
            { id: 9, label: 'Runbooks', name: 'runbooks' },
          ],
        },
      ],
    },
    isLoading: false,
  }),
}));

import { RagMultiSelect } from '../RagMultiSelect';

const NODE_ID = 'argus.agent.abc';

function seedAgentNode(args: Record<string, unknown> = {}) {
  useBuilderStore.setState({
    nodes: [{ id: NODE_ID, type: 'argus.agent', position: { x: 0, y: 0 }, data: { agent_id: 5, args } }],
    selectedNodeId: NODE_ID,
  });
}

describe('RagMultiSelect (Item 3 frontend)', () => {
  beforeEach(() => useBuilderStore.getState().reset());

  it('renders one checkbox per bound rag index of the selected agent', () => {
    seedAgentNode();
    render(<RagMultiSelect nodeId={NODE_ID} />);
    expect(screen.getByLabelText(/Postmortems/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Runbooks/i)).toBeInTheDocument();
  });

  it('resolves the same RAG bindings through a portable Agent role', () => {
    useBuilderStore.setState({
      nodes: [{ id: NODE_ID, type: 'argus.agent', position: { x: 0, y: 0 }, data: { agent_role: 'knowledge', args: {} } }],
      selectedNodeId: NODE_ID,
    });
    render(<RagMultiSelect nodeId={NODE_ID} />);
    expect(screen.getByLabelText(/Postmortems/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Runbooks/i)).toBeInTheDocument();
  });

  it('checking an index stores rag_index_ids as number[] in step args', () => {
    seedAgentNode();
    render(<RagMultiSelect nodeId={NODE_ID} />);
    fireEvent.click(screen.getByLabelText(/Postmortems/i));
    const node = useBuilderStore.getState().nodes.find((n) => n.id === NODE_ID)!;
    expect((node.data as { args: { rag_index_ids: unknown } }).args.rag_index_ids).toEqual([7]);
  });

  it('reflects pre-selected ids and toggles off back to empty (= agent default)', () => {
    seedAgentNode({ rag_index_ids: [7, 9] });
    render(<RagMultiSelect nodeId={NODE_ID} />);
    const cb = screen.getByLabelText(/Postmortems/i) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb); // off 7
    fireEvent.click(screen.getByLabelText(/Runbooks/i)); // off 9
    const node = useBuilderStore.getState().nodes.find((n) => n.id === NODE_ID)!;
    expect((node.data as { args: { rag_index_ids: unknown } }).args.rag_index_ids).toEqual([]);
  });

  it('shows a hint when the selected agent has no bound indexes', () => {
    useBuilderStore.setState({
      nodes: [{ id: NODE_ID, type: 'argus.agent', position: { x: 0, y: 0 }, data: { agent_id: 999, args: {} } }],
      selectedNodeId: NODE_ID,
    });
    render(<RagMultiSelect nodeId={NODE_ID} />);
    expect(screen.getByText(/kein.*RAG/i)).toBeInTheDocument();
  });
});
