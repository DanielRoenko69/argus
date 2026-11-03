import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useBuilderStore } from '@/stores/builderStore';

vi.mock('@/api/palette', () => ({
  usePalette: () => ({
    data: { skills: [], agents: [], tools: [], rag_indexes: [] },
    isLoading: false,
  }),
}));

import { Sidebar } from '../Sidebar';

function renderSidebar(onClose = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Sidebar mobileOpen onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe('responsive Blockbibliothek', () => {
  beforeEach(() => useBuilderStore.getState().reset());

  it('exposes the open drawer and its close controls accessibly', () => {
    const onClose = renderSidebar();
    expect(screen.getByRole('complementary', { name: 'Blockbibliothek' })).toHaveClass('is-open');

    fireEvent.click(screen.getAllByRole('button', { name: 'Blockbibliothek schließen' })[0]!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('adds a block without drag-and-drop and closes the mobile drawer', () => {
    const onClose = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Knowledge hinzufügen' }));

    const nodes = useBuilderStore.getState().nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type).toBe('argus.knowledge');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
