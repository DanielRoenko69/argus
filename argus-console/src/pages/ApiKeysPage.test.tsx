import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminApiKey, FabricResponse } from '../types';
import { ApiKeysPage } from './ApiKeysPage';

const api = vi.hoisted(() => ({
  deleteAdminApiKey: vi.fn(),
  getAdminApiKeys: vi.fn(),
  getApiKeyBindingTargets: vi.fn(),
  getFabric: vi.fn(),
  rotateAdminApiKey: vi.fn(),
  saveAdminApiKey: vi.fn(),
}));

vi.mock('../api', () => api);

const existingKey: AdminApiKey = {
  id: 7,
  key_prefix: 'ak_12345',
  key_suffix: 'cdef',
  label: 'deployment bot',
  allowed_bundles: [3],
  allowed_tools: ['github_*'],
  denied_tools: ['github_delete_*'],
  max_requests_per_minute: 60,
  scope: 'mcp',
  enabled: true,
  acting_as_user_id: 12,
  composite_id: null,
  expires_at: null,
  last_used_at: '2026-07-31T10:00:00.000Z',
  rotation_schedule: null,
  next_rotation_at: null,
  created_at: '2026-07-30T10:00:00.000Z',
};

const fabric: FabricResponse = {
  generatedAt: '2026-07-31T10:00:00.000Z',
  permissions: { canManage: true },
  stats: { servers: 1, healthy: 1, tools: 2, bundles: 1, trusted: 0, trustAttention: 0, mcpServers: 0 },
  servers: [],
  bundles: [{ id: 3, label: 'Catalog team', icon: '◈', serverCount: 1, toolCount: 2, access: 'unrestricted' }],
  tools: [],
};

function renderPage(keys: AdminApiKey[] = [existingKey]) {
  api.getAdminApiKeys.mockResolvedValue(keys);
  api.getFabric.mockResolvedValue(fabric);
  api.getApiKeyBindingTargets.mockResolvedValue([{ id: 3, username: 'alex', display_name: 'Alex Argus', role: 'platform_admin', is_self: true }]);
  api.saveAdminApiKey.mockResolvedValue(existingKey);
  api.rotateAdminApiKey.mockResolvedValue({ id: 7, label: 'deployment bot', key_prefix: 'ak_new12', key_suffix: '9876', api_key: 'ak_new-secret' });
  api.deleteAdminApiKey.mockResolvedValue({ deleted: true });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ApiKeysPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ApiKeysPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates a least-privilege key and requires acknowledgement of its one-time secret', async () => {
    renderPage([]);
    api.saveAdminApiKey.mockResolvedValue({ id: 9, label: 'catalog ci', key_prefix: 'ak_ci123', key_suffix: 'abcd', api_key: 'ak_once-only' });

    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    const dialog = screen.getByRole('form', { name: 'Create API key' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Label/ }), { target: { value: 'catalog ci' } });
    expect(within(dialog).getByRole('button', { name: 'Generate API key' })).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('combobox', { name: /Act as identity/ }), { target: { value: 'service' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Catalog team/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate API key' }));

    await waitFor(() => expect(api.saveAdminApiKey).toHaveBeenCalledWith(expect.objectContaining({
      label: 'catalog ci',
      allowed_bundles: [3],
      scope: 'mcp',
      acting_as_user_id: null,
    }), undefined));
    expect(await screen.findByText('ak_once-only')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close one-time secret' });
    expect(close).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I stored this key/ }));
    expect(close).toBeEnabled();
  });

  it('preserves user binding on edit and rotates only after confirmation', async () => {
    renderPage();

    const card = (await screen.findByRole('heading', { name: 'deployment bot' })).closest('article');
    expect(card).not.toBeNull();
    expect(within(card!).getByText('User-bound')).toBeInTheDocument();
    fireEvent.click(within(card!).getByRole('button', { name: 'Edit' }));
    expect(screen.queryByRole('combobox', { name: /Act as identity/ })).not.toBeInTheDocument();
    expect(api.getApiKeyBindingTargets).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save key policy' }));

    await waitFor(() => expect(api.saveAdminApiKey).toHaveBeenCalledWith(expect.objectContaining({
      acting_as_user_id: 12,
    }), 7));

    fireEvent.click(within(card!).getByRole('button', { name: 'Rotate' }));
    expect(within(card!).getByText('The current credential stops working immediately.')).toBeInTheDocument();
    fireEvent.click(within(card!).getByRole('button', { name: 'Confirm rotation' }));

    await waitFor(() => expect(api.rotateAdminApiKey).toHaveBeenCalledWith(7));
    expect(await screen.findByText('ak_new-secret')).toBeInTheDocument();
  });

  it('creates an explicitly selected user-bound key without widening bundle scope', async () => {
    renderPage([]);
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    expect(await screen.findByRole('option', { name: 'Alex Argus (@alex) — you' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: /Label/ }), { target: { value: 'Alex chat' } });
    const identity = screen.getByRole('combobox', { name: /Act as identity/ });
    expect(identity).toHaveValue('');
    fireEvent.change(identity, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate API key' }));
    await waitFor(() => expect(api.saveAdminApiKey).toHaveBeenCalledWith(expect.objectContaining({ acting_as_user_id: 3, allowed_bundles: [], scope: 'mcp' }), undefined));
  });

  it('shows identity loading/errors and permits retry without silently selecting service', async () => {
    renderPage([]);
    let fail!: (error: Error) => void;
    api.getApiKeyBindingTargets.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create API key' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Label/ }), { target: { value: 'Alex chat' } });
    expect(await screen.findByText('Loading eligible user identities…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate API key' })).toBeDisabled();
    fail(new Error('unavailable'));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry user identities' }));
    expect(await screen.findByRole('option', { name: 'Alex Argus (@alex) — you' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Act as identity/ })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Generate API key' })).toBeDisabled();
    expect(api.saveAdminApiKey).not.toHaveBeenCalled();
  });

  it('preserves an existing unbound key instead of silently binding it', async () => {
    renderPage([{ ...existingKey, acting_as_user_id: null }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByText(/Service identity: no user binding/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Act as identity/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save key policy' }));
    await waitFor(() => expect(api.saveAdminApiKey).toHaveBeenCalledWith(expect.objectContaining({ acting_as_user_id: null }), 7));
  });
});
