import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UserConnectionsResponse, WorkforceIdentityAccessResponse } from '../types';
import { ConnectionsPage } from './ConnectionsPage';

const api = vi.hoisted(() => ({
  disconnectUserConnection: vi.fn(),
  getUserConnections: vi.fn(),
  getWorkforceIdentityAccess: vi.fn(),
}));

vi.mock('../api', () => api);

const response: UserConnectionsResponse = {
  connections: [
    {
      backend_id: 3,
      name: 'github',
      auth_mode: 'permissive',
      oauth_scopes: ['repo:read'],
      connected: true,
      expires_at: '2026-08-01T10:00:00.000Z',
      scopes_granted: ['repo:read'],
      upstream_username: 'octocat',
      last_used_at: '2026-07-31T10:00:00.000Z',
      refresh_failed_at: null,
    },
    {
      backend_id: 5,
      name: 'jira',
      auth_mode: 'strict',
      oauth_scopes: ['read:jira-work'],
      connected: true,
      expires_at: '2026-07-30T10:00:00.000Z',
      scopes_granted: ['read:jira-work'],
      upstream_username: 'alex',
      last_used_at: null,
      refresh_failed_at: '2026-07-31T09:00:00.000Z',
    },
    {
      backend_id: 8,
      name: 'grafana',
      auth_mode: 'strict',
      oauth_scopes: ['dashboards:read'],
      connected: false,
      expires_at: null,
      scopes_granted: null,
      upstream_username: null,
      last_used_at: null,
      refresh_failed_at: null,
    },
  ],
};

const workforceResponse: WorkforceIdentityAccessResponse = {
  provider: { enabled: true, name: 'Argus MFA Demo' },
  session: {
    authMethod: 'oidc',
    mfaFresh: true,
    mfaVerifiedAt: '2026-07-31T10:00:00.000Z',
    mfaMethod: 'otp',
  },
  entitlement: { enabled: true, name: 'Workforce SSO' },
  stats: { available: 1, ready: 1, launched: 1, configuredBackends: 1 },
  portals: [{
    backendId: 11,
    backendName: 'gitea-local',
    backendIds: [11],
    backendNames: ['gitea-local'],
    connectionCount: 1,
    bundleIds: [2],
    mode: 'shared_oidc',
    application: 'Gitea',
    label: 'Open repository with SSO',
    providerName: 'Argus MFA Demo',
    presentationRole: 'Source code and pull requests',
    state: 'ready',
    premium: true,
    launchPath: '/api/ui/mcp-fabric/connections/11/sso-launch',
    lastLaunch: { auditId: 91, launchedAt: '2026-07-31T10:05:00.000Z' },
  }],
};

function renderPage(connections: UserConnectionsResponse = response) {
  api.getUserConnections.mockResolvedValue(connections);
  api.getWorkforceIdentityAccess.mockResolvedValue(workforceResponse);
  api.disconnectUserConnection.mockResolvedValue({ ok: true });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <ConnectionsPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('ConnectionsPage', () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('explains disabled delegation and removes connect actions without hiding disconnect', async () => {
    renderPage({ delegationEnabled: false, connections: response.connections.map(c => ({ ...c, readiness: 'disabled' })) });
    expect(await screen.findByText(/Personal API delegation is disabled/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Connect identity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Reauthorize/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Disconnect' })).toHaveLength(2);
  });

  it('does not claim expired non-refreshable tokens are connected', async () => {
    renderPage({ delegationEnabled: true, connections: [{ ...response.connections[0]!, readiness: 'reconnect_required' }] });
    expect(await screen.findByText('Re-auth required')).toBeInTheDocument();
    expect(screen.getByText('User OAuth · no fallback')).toBeInTheDocument();
  });

  it('shows OAuth state, scopes, reauthorization and a confirmed disconnect flow', async () => {
    renderPage();

    const github = (await screen.findByRole('heading', { name: 'github' })).closest('article');
    const jira = screen.getByRole('heading', { name: 'jira' }).closest('article');
    const grafana = screen.getByRole('heading', { name: 'grafana' }).closest('article');
    expect(github).not.toBeNull();
    expect(jira).not.toBeNull();
    expect(grafana).not.toBeNull();
    expect(within(github!).getByText('octocat')).toBeInTheDocument();
    expect(within(github!).getByText('repo:read')).toBeInTheDocument();
    expect(within(jira!).getByText('Re-auth required')).toBeInTheDocument();
    expect(within(jira!).getByRole('link', { name: /Reauthorize/ }))
      .toHaveAttribute('href', '/connections/connect/5');
    expect(within(grafana!).getByRole('link', { name: /Connect identity/ }))
      .toHaveAttribute('href', '/connections/connect/8');

    fireEvent.click(within(github!).getByRole('button', { name: 'Disconnect' }));
    expect(within(github!).getByText('Disconnect github?')).toBeInTheDocument();
    fireEvent.click(within(github!).getByRole('button', { name: 'Confirm disconnect' }));

    await waitFor(() => expect(api.disconnectUserConnection).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/Personal OAuth delegation disconnected/)).toBeInTheDocument();
  });

  it('separates workforce portal access from delegated OAuth credentials', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Open company applications' })).toBeInTheDocument();
    const gitea = screen.getByRole('heading', { name: 'Gitea' }).closest('article');
    expect(gitea).not.toBeNull();
    expect(within(gitea!).getByText('Ready with SSO')).toBeInTheDocument();
    expect(within(gitea!).getByText('#91')).toBeInTheDocument();
    expect(within(gitea!).getByRole('link', { name: /Open repository with SSO/ }))
      .toHaveAttribute('href', '/api/ui/mcp-fabric/connections/11/sso-launch');
    expect(screen.getByText('Workforce SSO is for people')).toBeInTheDocument();
    expect(screen.getByText('Personal OAuth is for delegated actions')).toBeInTheDocument();
  });

  it('shows and clears the signed OAuth callback result', async () => {
    window.history.replaceState({}, '', '/connections?connected=github');
    renderPage();

    expect(await screen.findByText('Connected to github.')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/connections');
    expect(window.location.search).toBe('');
  });
});
