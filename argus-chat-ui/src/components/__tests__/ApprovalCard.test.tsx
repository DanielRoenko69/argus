import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSend } from '../../data-provider/client.js';
import { useMe } from '../../data-provider/hooks.js';
import type { ApprovalRequest } from '../../data-provider/sse.js';
import { ApprovalCard } from '../ApprovalCard.js';

vi.mock('../../data-provider/client.js', () => ({
  apiSend: vi.fn(),
}));

vi.mock('../../data-provider/hooks.js', () => ({
  useMe: vi.fn(),
}));

const approval: ApprovalRequest = {
  approval_id: '42',
  action_description: 'Restart the production worker',
  tool_name: 'workspace_exec',
  target_scope: 'production',
  parameters: { command: 'systemctl restart worker' },
  risk_level: 'high',
  risk_score: 80,
  risk_factors: [],
  expected_impacts: [],
  ttl_seconds: 3600,
  created_at: new Date(Date.now() - 1000).toISOString(),
};

function renderCard(role: string) {
  vi.mocked(useMe).mockReturnValue({
    data: { user: { id: 1, username: 'reviewer', display_name: 'Reviewer', role }, shareLinksEnabled: false },
  } as ReturnType<typeof useMe>);
  return render(<ApprovalCard approval={approval} />);
}

describe('ApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiSend).mockResolvedValue({});
  });

  it('shows decision controls for roles allowed by the backend hierarchy', () => {
    renderCard('operations_admin');

    expect(screen.getByRole('button', { name: 'Approve action' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Approval comment' })).toBeInTheDocument();
  });

  it('keeps read-only users from seeing decision controls', () => {
    renderCard('viewer');

    expect(screen.queryByRole('button', { name: 'Approve action' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot decide it/i)).toBeInTheDocument();
  });

  it('keeps the request actionable after a transient decision failure', async () => {
    vi.mocked(apiSend)
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce({});
    renderCard('agent_operator');

    const approveButton = screen.getByRole('button', { name: 'Approve action' });
    fireEvent.click(approveButton);

    await waitFor(() => expect(screen.getByText('temporarily unavailable')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Approve action' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve action' }));
    await waitFor(() => expect(screen.getByText(/Approved\./)).toBeInTheDocument());
    expect(apiSend).toHaveBeenCalledTimes(2);
  });
});
