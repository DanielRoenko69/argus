import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/* ── Hooks mocked so the modal can drive create/list/revoke without a network ── */
const { mockCreate, mockRevoke } = vi.hoisted(() => ({ mockCreate: vi.fn(), mockRevoke: vi.fn() }));
let mockShares: Array<{ id: number; title: string; created_at: string; expires_at: string; hasPassword: boolean }> = [];

vi.mock('../../data-provider/hooks.js', () => ({
  useMyShares: (_enabled?: boolean) => ({ data: mockShares }),
  useCreateShare: (_agentId: number, _sid: string) => ({ mutateAsync: mockCreate, isPending: false }),
  useRevokeShare: () => ({ mutateAsync: mockRevoke }),
}));

import { ShareModal } from '../ShareModal.js';

function Wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
}

describe('ShareModal', () => {
  beforeEach(() => {
    mockShares = [];
    mockCreate.mockReset();
    mockRevoke.mockReset();
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });
  afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

  it('opens the dialog and posts {expiryDays, password} then shows the returned url', async () => {
    mockCreate.mockResolvedValue({ id: 7, url: 'http://x/share/tok123' });
    render(<Wrapper><ShareModal agentId={3} sid="s1" /></Wrapper>);
    fireEvent.click(screen.getByRole('button', { name: /share conversation/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/expires/i), { target: { value: '30' } });
    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'hunter2' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
    });
    expect(mockCreate).toHaveBeenCalledWith({ expiryDays: 30, password: 'hunter2' });
    await waitFor(() => expect(screen.getByDisplayValue('http://x/share/tok123')).toBeInTheDocument());
  });

  it('lists existing shares and revokes one', async () => {
    mockShares = [{ id: 5, title: 'Hallo', created_at: '2026-06-01', expires_at: '2099-01-01', hasPassword: false }];
    mockRevoke.mockResolvedValue({ revoked: true });
    render(<Wrapper><ShareModal agentId={3} sid="s1" /></Wrapper>);
    fireEvent.click(screen.getByRole('button', { name: /share conversation/i }));
    expect(screen.getByText('Hallo')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /revoke share/i }));
    });
    expect(mockRevoke).toHaveBeenCalledWith(5);
  });
});
