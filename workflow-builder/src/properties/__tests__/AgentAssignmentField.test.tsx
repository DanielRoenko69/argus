import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBuilderStore } from '@/stores/builderStore';

vi.mock('@/api/palette', () => ({
  usePalette: () => ({
    data: {
      skills: [],
      tools: [],
      agents: [{
        id: 5,
        name: 'delivery_planner',
        label: 'Delivery Planner',
        agent_mode: 'worker',
        agent_role: 'planner',
        model: 'claude-opus-4-6',
        runtime_type: 'codex',
        runtime_profile_label: 'Codex Terra',
        runtime_model: 'gpt-5.6-terra',
        runtime_enabled: true,
      }, {
        id: 6,
        name: 'secure_reviewer',
        label: 'Secure Reviewer',
        agent_mode: 'reviewer',
        agent_role: 'reviewer',
        model: 'claude-opus-4-6',
        runtime_type: 'claude',
        runtime_profile_label: 'Claude Pro',
        runtime_model: 'claude-opus-4-6',
        runtime_enabled: true,
      }],
    },
    isLoading: false,
  }),
}));

import { AgentAssignmentField } from '../PropertiesPanel';

const NODE_ID = 'agent-step';

function seed(data: Record<string, unknown>) {
  useBuilderStore.setState({
    nodes: [{ id: NODE_ID, type: 'argus.agent', position: { x: 0, y: 0 }, data }],
    selectedNodeId: NODE_ID,
  });
}

describe('AgentAssignmentField', () => {
  beforeEach(() => useBuilderStore.getState().reset());

  it('previews the Core Agent and effective runtime for a portable role', () => {
    seed({ label: 'Plan', agent_role: 'planner', agent_id: null });
    render(<AgentAssignmentField nodeId={NODE_ID} />);

    expect(screen.getByRole('combobox', { name: 'Agent-Rolle' })).toHaveValue('planner');
    expect(screen.getByText('Auflösungskandidat')).toBeInTheDocument();
    expect(screen.getByText('Delivery Planner')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6-terra · Codex Terra')).toBeInTheDocument();
  });

  it('stores only the selected portable role', () => {
    seed({ label: 'Review' });
    render(<AgentAssignmentField nodeId={NODE_ID} />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Agent-Rolle' }), { target: { value: 'reviewer' } });

    expect(useBuilderStore.getState().nodes[0]?.data).toMatchObject({
      agent_role: 'reviewer',
      agent_id: null,
    });
    expect(screen.getByText('Secure Reviewer')).toBeInTheDocument();
  });

  it('switches from a role to an inferred concrete Agent without retaining the role', () => {
    seed({ label: 'Plan', agent_role: 'planner' });
    render(<AgentAssignmentField nodeId={NODE_ID} />);

    fireEvent.click(screen.getByRole('button', { name: 'Konkreter Agent' }));

    expect(screen.getByRole('combobox', { name: 'Konkreter Agent' })).toHaveValue('5');
    expect(useBuilderStore.getState().nodes[0]?.data).toMatchObject({
      agent_id: 5,
      agent_role: null,
    });
  });
});
