import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HermesDevConnectionsPanel } from './HermesDevConnectionsPanel';

const api = vi.hoisted(() => ({
  createHermesDevConnection: vi.fn(),
  getHermesDevConnections: vi.fn(),
  revokeHermesDevConnection: vi.fn(),
  rotateHermesDevConnection: vi.fn(),
  testHermesDevConnection: vi.fn(),
}));

vi.mock('../api', () => api);

function renderPanel() {
  api.getHermesDevConnections.mockResolvedValue({
    identity: { id: 7, username: 'entra:subject-7', displayName: 'Hermes Developer', role: 'developer', authentication: 'sso' },
    connections: [],
    bundles: [{
      id: 3, name: 'github', label: 'GitHub', toolCount: 7,
    }],
  });
  api.createHermesDevConnection.mockResolvedValue({
    connection: {
      id: 4, label: 'Laptop Hermes', userId: 7, username: 'hermes-dev', displayName: 'Hermes Developer',
      apiKeyId: 12, keyPrefix: 'ak_test', keySuffix: 'cafe', bundleIds: [3], enabled: true,
      clientSeen: false, lastUsedAt: null, lastTestedAt: null, lastTestState: null,
      lastTestDetail: null, revokedAt: null, createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    },
    apiKey: 'ak_once_only', endpointPath: '/mcp/hermes-dev',
    environment: { ARGUS_HERMES_DEV_MCP_URL: 'http://localhost:3000/mcp/hermes-dev', ARGUS_HERMES_DEV_MCP_KEY: 'ak_once_only' },
    configYaml: 'mcp_servers:\n  argus_dev:\n    url: "${ARGUS_HERMES_DEV_MCP_URL}"',
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><HermesDevConnectionsPanel /></QueryClientProvider>);
}

describe('HermesDevConnectionsPanel', () => {
  afterEach(() => vi.clearAllMocks());

  it('uses the authenticated SSO identity automatically and shows the delegated secret once', async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: /Connect Hermes/ }));
    fireEvent.change(screen.getByLabelText('Hermes connection name'), { target: { value: 'Laptop Hermes' } });
    fireEvent.click(await screen.findByText('GitHub'));
    expect(screen.queryByLabelText('Hermes Argus identity')).not.toBeInTheDocument();
    expect(screen.getByText('SSO identity · developer')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: /Create connection/ });
    await waitFor(() => expect(create).toBeEnabled());
    fireEvent.click(create);

    await waitFor(() => expect(api.createHermesDevConnection).toHaveBeenCalledWith({
      label: 'Laptop Hermes', bundleIds: [3],
    }));
    expect(await screen.findByRole('dialog', { name: 'Hermes connection secret' })).toHaveTextContent('ak_once_only');
    expect(screen.getByText('Hermes config.yaml')).toBeInTheDocument();
  });
});
