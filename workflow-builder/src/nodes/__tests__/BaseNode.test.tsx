import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReactFlowProvider } from 'reactflow';
import { useBuilderStore } from '@/stores/builderStore';
import { useExecutionStore } from '@/stores/executionStore';

const NODE_ID = 'argus.agent.abc12345';

vi.mock('@/api/k8s', () => ({
  useStepBundles: () => ({
    data: { stepBundles: { [NODE_ID]: ['platform-read', 'observability'] } },
  }),
}));

import { BaseNode } from '../BaseNode';

function renderNode(props: Partial<React.ComponentProps<typeof BaseNode>> = {}) {
  return render(
    <MemoryRouter initialEntries={['/42']}>
      <Routes>
        <Route
          path="/:id"
          element={(
            <ReactFlowProvider>
              <BaseNode
                icon="Bot"
                label="Agent"
                category="argus"
                selected={false}
                nodeId={NODE_ID}
                {...props}
              >
                <span>gpt-5</span>
              </BaseNode>
            </ReactFlowProvider>
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('BaseNode visual system', () => {
  beforeEach(() => {
    useBuilderStore.getState().reset();
    useExecutionStore.getState().reset();
    useBuilderStore.setState({
      nodes: [{
        id: NODE_ID,
        type: 'argus.agent',
        position: { x: 0, y: 0 },
        data: { label: 'Incident Commander' },
      }],
    });
  });

  it('shows the user-defined canvas label, category and directional ports', () => {
    const { container } = renderNode();

    expect(screen.getByRole('article', { name: 'Agent: Incident Commander' })).toHaveAttribute('data-category', 'argus');
    expect(screen.getByText('ARGUS · Agent')).toBeInTheDocument();
    expect(screen.getByText('Incident Commander')).toBeInTheDocument();
    expect(screen.getByLabelText('2 Backend-Bundles')).toHaveTextContent('platform-read');
    expect(container.querySelectorAll('.builder-node-handle')).toHaveLength(2);
    expect(screen.getByText('IN')).toBeInTheDocument();
    expect(screen.getByText('OUT')).toBeInTheDocument();
  });

  it('communicates execution state and duration without relying on colour', () => {
    useExecutionStore.getState().setStepStatus(NODE_ID, { status: 'running', durationMs: 1240 });
    renderNode({ selected: true });

    expect(screen.getByText('Läuft')).toBeInTheDocument();
    expect(screen.getByText('1.2 s')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAttribute('data-status', 'running');
    expect(screen.getByRole('article')).toHaveClass('is-selected');
  });

  it('supports start and terminal nodes with only the appropriate port', () => {
    const { container } = renderNode({ hasInput: false, hasOutput: true });

    expect(container.querySelector('.builder-node-handle-input')).not.toBeInTheDocument();
    expect(container.querySelector('.builder-node-handle-output')).toBeInTheDocument();
  });
});
