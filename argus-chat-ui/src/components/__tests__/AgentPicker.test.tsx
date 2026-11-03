import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../../store/chat.js';
import { AgentPicker } from '../AgentPicker.js';

vi.mock('../../data-provider/hooks.js', () => ({
  useAgents: () => ({
    isLoading: false,
    data: [
      { id: 1, name: 'k8s', label: 'K8s Agent', description: 'Kubernetes operations', model: 'gpt-4o' },
      { id: 2, name: 'ops', label: 'Ops Agent', description: 'Operational review', model: 'gpt-4o-mini' },
    ],
  }),
}));

describe('AgentPicker', () => {
  beforeEach(() => {
    useChatStore.setState({ activeAgentId: undefined });
  });

  it('filters agents and selects the requested agent', async () => {
    render(<AgentPicker />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search agents' }), { target: { value: 'ops' } });
    expect(screen.queryByText('K8s Agent')).not.toBeInTheDocument();
    expect(screen.getByText('Ops Agent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /Ops Agent/ }));
    await waitFor(() => expect(useChatStore.getState().activeAgentId).toBe(2));
    expect(screen.getByRole('button', { name: /Ops Agent/ })).toBeInTheDocument();
  });

  it('closes the menu when an agent is selected externally', async () => {
    render(<AgentPicker />);

    act(() => useChatStore.getState().setAgent(1));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /K8s Agent/ })).toHaveAttribute('aria-expanded', 'false');
    });
    expect(screen.queryByRole('listbox', { name: 'Available agents' })).not.toBeInTheDocument();
  });
});
