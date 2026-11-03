import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverviewResponse, RuntimeControlCatalog, RuntimePolicyRecord } from '../types';
import { RuntimeControlsPage } from './RuntimeControlsPage';

const api = vi.hoisted(() => ({
  deleteRuntimePolicy: vi.fn(),
  getOverview: vi.fn(),
  getRuntimeControls: vi.fn(),
  saveRuntimePolicy: vi.fn(),
  testRuntimePolicy: vi.fn(),
}));
vi.mock('../api', () => api);

const overview: OverviewResponse = {
  generatedAt: '2026-08-01T10:00:00.000Z',
  user: { id: 1, username: 'admin', displayName: 'Argus Admin', role: 'platform_admin' },
  attention: [],
  stats: { activeRuns: 0, successRate24h: null, completed24h: 0, failed24h: 0, workflowsInReview: 0, connectedTools: 0, agents: 0 },
  health: { state: 'healthy', healthy: 0, total: 0, degraded: 0 },
  runs: [],
};
const policy: RuntimePolicyRecord = {
  id: 11,
  name: 'change_freeze',
  description: 'Blocks production changes during a freeze.',
  webhookUrl: 'https://policy.example.test/decide',
  timeoutMs: 2500,
  toolPatterns: ['terraform_*', 'k8s_%'],
  enabled: true,
  onFailure: 'deny',
  hasHmacSecret: true,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-01T11:00:00.000Z',
};
const catalog: RuntimeControlCatalog = {
  generatedAt: '2026-08-01T12:00:00.000Z',
  hooks: [
    { name: 'destructive-cmd-guard', priority: 100, description: 'Blocks destructive commands', kind: 'built_in' },
    { name: 'external-policy-filter', priority: 800, description: 'Runs external policies', kind: 'external' },
    { name: 'human-approval-gate', priority: 900, description: 'Requires approval', kind: 'built_in' },
  ],
  policies: [policy],
  limits: { minTimeoutMs: 100, maxTimeoutMs: 30_000, maxPatterns: 50, maxPatternLength: 256 },
};

function renderPage(data: RuntimeControlCatalog = catalog, role = 'platform_admin') {
  api.getOverview.mockResolvedValue({ ...overview, user: { ...overview.user, role } });
  api.getRuntimeControls.mockResolvedValue(data);
  api.saveRuntimePolicy.mockResolvedValue(policy);
  api.deleteRuntimePolicy.mockResolvedValue({ deleted: true });
  api.testRuntimePolicy.mockResolvedValue({
    reachable: true, status: 200, ok: true, decision: 'deny', reason: 'change freeze',
    latencyMs: 12, signed: true, responsePreview: '{"allow":false,"reason":"change freeze"}',
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter initialEntries={['/governance/runtime-controls']}>
      <QueryClientProvider client={client}><RuntimeControlsPage /></QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('RuntimeControlsPage', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows the ordered chain and safe external policy posture', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Execution policies' })).toBeInTheDocument();
    expect(screen.getByText('Shared enforcement boundary active')).toBeInTheDocument();
    expect(screen.getByText('external policy filter')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'change_freeze' })).toBeInTheDocument();
    expect(screen.getByText('HMAC SHA-256')).toBeInTheDocument();
    expect(screen.getByText('Deny · closed')).toBeInTheDocument();
  });

  it('creates signed fail-closed policies with normalized pattern input', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'change_freeze' });
    fireEvent.click(screen.getByRole('button', { name: 'Add external policy' }));
    fireEvent.change(screen.getByLabelText('Policy name'), { target: { value: 'opa_gate' } });
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: 'https://opa.example.test/decide' } });
    fireEvent.change(screen.getByLabelText('Tool patterns'), { target: { value: 'workspace_*\nterraform_*, workspace_*' } });
    fireEvent.change(screen.getByLabelText('HMAC secret'), { target: { value: 'shared-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create policy' }));
    await waitFor(() => expect(api.saveRuntimePolicy).toHaveBeenCalledTimes(1));
    expect(api.saveRuntimePolicy).toHaveBeenCalledWith(expect.objectContaining({
      name: 'opa_gate', webhookUrl: 'https://opa.example.test/decide',
      toolPatterns: ['workspace_*', 'terraform_*'], onFailure: 'deny',
      secretAction: 'replace', hmacSecret: 'shared-secret', enabled: true,
    }), undefined);
  });

  it('keeps stored secrets on ordinary edits and runs a signed non-executing test', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'change_freeze' });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByText('The existing encrypted secret remains unchanged.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(api.saveRuntimePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ secretAction: 'keep' }), 11,
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByText('The real endpoint is called')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run policy test' }));
    await waitFor(() => expect(api.testRuntimePolicy).toHaveBeenCalledWith(
      11, 'workspace_read_file', { path: 'README.md' },
    ));
    expect(await screen.findByText('Request denied')).toBeInTheDocument();
    expect(screen.getByText(/HMAC signed/)).toBeInTheDocument();
  });

  it('requires the exact policy name for deletion and fails closed for non-admin users', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'change_freeze' });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const deleteButton = screen.getByRole('button', { name: 'Delete policy' });
    expect(deleteButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Confirm policy name'), { target: { value: 'change_freeze' } });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(api.deleteRuntimePolicy).toHaveBeenCalledWith(11));

    vi.clearAllMocks();
    renderPage(catalog, 'viewer');
    expect(await screen.findByText('Platform administrator access required.')).toBeInTheDocument();
  });
});
