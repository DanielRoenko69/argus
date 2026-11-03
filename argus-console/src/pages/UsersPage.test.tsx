import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser, FabricResponse, OverviewResponse } from '../types';
import { UsersPage } from './UsersPage';

const api = vi.hoisted(() => ({
  changeAdminUserPassword: vi.fn(),
  createAdminUser: vi.fn(),
  deleteAdminUser: vi.fn(),
  getAdminUsers: vi.fn(),
  getFabric: vi.fn(),
  getOverview: vi.fn(),
  updateAdminUser: vi.fn(),
}));

vi.mock('../api', () => api);

const users: AdminUser[] = [
  { id: 1, username: 'alex', display_name: 'Alex', role: 'platform_admin', allowed_bundles: null, enabled: true, created_at: '2026-01-01T10:00:00Z', last_login: '2026-07-31T09:00:00Z', workspace_scopes: [{ tenant_key: 'default', workspace_key: 'default', is_default: true }] },
  { id: 2, username: 'alex', display_name: 'Alex Morgan', role: 'developer', allowed_bundles: [3], enabled: true, created_at: '2026-05-01T10:00:00Z', last_login: null, workspace_scopes: [{ tenant_key: 'acme', workspace_key: 'platform', is_default: true }] },
];

const fabric: FabricResponse = {
  generatedAt: '2026-07-31T10:00:00Z',
  permissions: { canManage: true },
  stats: { servers: 1, healthy: 1, tools: 2, bundles: 1, trusted: 0, trustAttention: 0, mcpServers: 0 },
  servers: [],
  bundles: [{ id: 3, label: 'Catalog team', icon: '◈', serverCount: 1, toolCount: 2, access: 'unrestricted' }],
  tools: [],
};

const overview: OverviewResponse = {
  generatedAt: '2026-07-31T10:00:00Z',
  user: { id: 1, username: 'alex', displayName: 'Alex', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 1, total: 1, degraded: 0 },
  runs: [],
};

function renderPage(data: AdminUser[] = users) {
  api.getAdminUsers.mockResolvedValue(data);
  api.getFabric.mockResolvedValue(fabric);
  api.getOverview.mockResolvedValue(overview);
  api.createAdminUser.mockImplementation(async input => ({ ...input, id: 9, created_at: '2026-07-31T10:00:00Z', last_login: null }));
  api.updateAdminUser.mockImplementation(async (id, input) => ({ ...users.find(user => user.id === id), ...input }));
  api.changeAdminUserPassword.mockResolvedValue({ updated: true });
  api.deleteAdminUser.mockResolvedValue({ deleted: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={queryClient}><UsersPage /></QueryClientProvider></MemoryRouter>);
}

describe('UsersPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates a modern-role user with an explicit bundle boundary', async () => {
    renderPage([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Create user' }));
    const dialog = screen.getByRole('dialog', { name: 'Create user' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Username/ }), { target: { value: 'sasha' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Display name/ }), { target: { value: 'Sasha Reed' } });
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Platform role' }), { target: { value: 'operations_admin' } });
    const passwords = within(dialog).getAllByLabelText(/Password/i);
    fireEvent.change(passwords[0], { target: { value: 'SecurePass123!' } });
    fireEvent.change(passwords[1], { target: { value: 'SecurePass123!' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Catalog team/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create user' }));

    await waitFor(() => expect(api.createAdminUser).toHaveBeenCalledWith(expect.objectContaining({
      username: 'sasha',
      display_name: 'Sasha Reed',
      role: 'operations_admin',
      allowed_bundles: [3],
      enabled: true,
      workspace_scopes: [{ tenant_key: 'default', workspace_key: 'default', is_default: true }],
    })));
  });

  it('adds another authorized workspace and can make it the default', async () => {
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Alex Morgan' })).closest('article');
    fireEvent.click(within(card!).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit alex' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Tenant key' }), { target: { value: 'acme' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Workspace key' }), { target: { value: 'payments' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add workspace' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Use acme/payments as default' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save user' }));

    await waitFor(() => expect(api.updateAdminUser).toHaveBeenCalledWith(2, expect.objectContaining({
      workspace_scopes: [
        { tenant_key: 'acme', workspace_key: 'platform', is_default: false },
        { tenant_key: 'acme', workspace_key: 'payments', is_default: true },
      ],
    })));
  });

  it('locks self-demotion and deep-links the selected identity into access policies', async () => {
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Alex' })).closest('article');
    expect(card).not.toBeNull();
    expect(within(card!).getByRole('link', { name: 'Policies' })).toHaveAttribute('href', '/governance/policies?tab=users&user=1');
    expect(within(card!).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.click(within(card!).getByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit alex' });
    expect(within(dialog).getByRole('combobox', { name: 'Platform role' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'User enabled' })).toBeDisabled();
  });

  it('requires the exact username before deleting another identity', async () => {
    renderPage();
    const card = (await screen.findByRole('heading', { name: 'Alex Morgan' })).closest('article');
    fireEvent.click(within(card!).getByRole('button', { name: 'Delete' }));
    const confirm = within(card!).getByRole('button', { name: 'Confirm deletion' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(card!).getByRole('textbox', { name: 'Type alex to confirm deletion' }), { target: { value: 'alex' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(api.deleteAdminUser).toHaveBeenCalledWith(2));
  });
});
