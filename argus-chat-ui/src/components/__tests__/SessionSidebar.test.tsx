import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../data-provider/types.js';
import { useChatStore } from '../../store/chat.js';
import { SessionSidebar } from '../SessionSidebar.js';

const mockDelete = vi.fn();
const session: Session = {
  id: 'session-1',
  agent_id: 7,
  user_id: 1,
  messages: [{ id: 'user-1', role: 'user', content: 'Review the deployment', parentId: null }],
  created_at: '2026-08-19T10:00:00.000Z',
  last_active: '2026-08-19T10:01:00.000Z',
};

vi.mock('../../data-provider/hooks.js', () => ({
  useAgents: () => ({ data: [], isLoading: false, isError: false }),
  useSessions: () => ({ data: [session] }),
  useDeleteSession: () => ({ mutateAsync: mockDelete }),
}));

describe('SessionSidebar', () => {
  beforeEach(() => {
    useChatStore.setState({
      activeAgentId: 7,
      activeSessionId: 'session-1',
      streaming: false,
    });
    mockDelete.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('deletes a session when the delete button is clicked', async () => {
    mockDelete.mockResolvedValue({ deleted: true });
    render(<SessionSidebar onNewChat={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('session-1'));
    expect(useChatStore.getState().activeSessionId).toBeUndefined();
  });

  it('shows a visible error when deleting a session fails', async () => {
    mockDelete.mockRejectedValue(new Error('Delete request failed'));
    render(<SessionSidebar onNewChat={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Delete request failed');
    expect(useChatStore.getState().activeSessionId).toBe('session-1');
  });

  it('filters chat history from the search field', () => {
    render(<SessionSidebar onNewChat={vi.fn()} />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'deployment' } });
    expect(screen.getByText('Review the deployment')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search chats' }), { target: { value: 'incident' } });
    expect(screen.getByText('No matching chats.')).toBeInTheDocument();
  });
});
