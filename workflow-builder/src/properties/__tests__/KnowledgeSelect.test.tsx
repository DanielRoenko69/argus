import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBuilderStore } from '@/stores/builderStore';

vi.mock('@/api/palette', () => ({
  usePalette: () => ({
    data: {
      skills: [],
      agents: [],
      tools: [],
      rag_indexes: [
        { id: 7, name: 'platform-runbooks', label: 'Platform Runbooks', provider: 'pgvector', description: '' },
        { id: 9, name: 'incident-search', label: 'Incident Search', provider: 'qdrant', description: '' },
      ],
    },
    isLoading: false,
  }),
}));

import '@/nodes/argus';
import { PropertiesPanel } from '../PropertiesPanel';

const NODE_ID = 'argus.knowledge.test';

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PropertiesPanel />
    </QueryClientProvider>,
  );
}

describe('Knowledge Source properties', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useBuilderStore.setState({
      nodes: [{
        id: NODE_ID,
        type: 'argus.knowledge',
        position: { x: 0, y: 0 },
        data: { label: 'Knowledge', index_name: null, args: { query: 'existing query', top_k: 5 } },
      }],
      selectedNodeId: NODE_ID,
    });
  });

  it('selects an enabled palette source by stable Argus name', () => {
    renderPanel();
    const sourceSelect = screen.getByRole('combobox');

    expect(screen.getByRole('option', { name: 'Platform Runbooks (pgvector)' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Incident Search (qdrant)' })).toBeInTheDocument();
    fireEvent.change(sourceSelect, { target: { value: 'platform-runbooks' } });

    const node = useBuilderStore.getState().nodes.find((candidate) => candidate.id === NODE_ID)!;
    expect((node.data as { index_name?: string }).index_name).toBe('platform-runbooks');
  });

  it('reads and updates nested step.args fields instead of creating a conflicting flat query', () => {
    renderPanel();
    const query = screen.getByDisplayValue('existing query');
    fireEvent.change(query, { target: { value: 'updated query' } });

    const node = useBuilderStore.getState().nodes.find((candidate) => candidate.id === NODE_ID)!;
    const data = node.data as { query?: string; args: { query: string } };
    expect(data.args.query).toBe('updated query');
    expect(data.query).toBeUndefined();
  });

  it('renders as the responsive inspector and closes through its backdrop control', () => {
    renderPanel();
    expect(screen.getByRole('complementary', { name: 'Block-Eigenschaften' }))
      .toHaveClass('builder-properties-panel');

    fireEvent.click(screen.getAllByRole('button', { name: 'Block-Eigenschaften schließen' })[0]!);
    expect(screen.queryByRole('complementary', { name: 'Block-Eigenschaften' })).not.toBeInTheDocument();
  });

  it('groups identity and runtime fields into scannable inspector sections', () => {
    renderPanel();

    expect(screen.getByRole('heading', { name: 'Allgemein' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Konfiguration' })).toBeInTheDocument();
    expect(screen.getByText('Name und Darstellung auf dem Canvas.')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Knowledge')).toBeInTheDocument();
    expect(screen.getByText('GEFAHRENBEREICH')).toBeInTheDocument();
  });
});
