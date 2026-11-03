import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FabricManagementBackend, FabricManagementResponse, FabricProfileRecord, FabricProfileSsoGroup, FabricResponse } from '../types';
import { McpFabricPage } from './McpFabricPage';

const api = vi.hoisted(() => ({
  applyFabricProfileRestore: vi.fn(),
  applyFabricProfileImport: vi.fn(),
  assignFabricTools: vi.fn(),
  checkFabricProfileDrift: vi.fn(),
  changeMcpTrust: vi.fn(),
  deleteFabricBundle: vi.fn(),
  deleteFabricConnection: vi.fn(),
  decideFabricProfileRestore: vi.fn(),
  discoverFabricConnection: vi.fn(),
  exportFabricProfile: vi.fn(),
  getFabric: vi.fn(),
  getFabricManagement: vi.fn(),
  getFabricProfiles: vi.fn(),
  getFabricProfileRestoreRequests: vi.fn(),
  getFabricProfileVersionDiff: vi.fn(),
  getFabricProfileVersions: vi.fn(),
  getServiceTemplateCatalog: vi.fn(),
  installServiceTemplate: vi.fn(),
  previewFabricProfileImport: vi.fn(),
  requestFabricProfileRestore: vi.fn(),
  saveFabricBundle: vi.fn(),
  saveFabricConnection: vi.fn(),
  testFabricConnection: vi.fn(),
}));

vi.mock('../api', () => api);

const server = {
  id: '17',
  name: 'catalog',
  type: 'http' as const,
  state: 'healthy' as const,
  latencyMs: 21,
  toolCount: 2,
  authType: 'none',
  endpoint: 'https://catalog.example/v1',
  bundleCount: 1,
  bundleNames: ['Catalog team'],
  error: null,
  trustStatus: 'not_applicable' as const,
  catalogFingerprint: null,
  trustedFingerprint: null,
  registryToolCount: null,
  firstSeenAt: null,
  lastSeenAt: null,
  changedAt: null,
  verifiedAt: null,
  verificationComment: null,
  changeSummary: { added: [], removed: [], changed: [] },
};

function connection(overrides: Partial<FabricManagementBackend> = {}): FabricManagementBackend {
  return {
    id: 17,
    name: 'catalog',
    description: 'Catalog API',
    type: 'http',
    managed: true,
    managedBy: 'openapi',
    sourceId: 4,
    enabled: true,
    state: 'healthy',
    endpoint: 'https://catalog.example/v1',
    baseUrl: 'https://catalog.example/v1',
    mcpEndpoint: null,
    authType: 'none',
    hasAuthValue: false,
    healthPath: '/health',
    defaultHeaders: {},
    timeoutMs: 10_000,
    tlsSkipVerify: false,
    authMode: 'service-account',
    oauthAuthorizeUrl: null,
    oauthTokenUrl: null,
    oauthClientId: null,
    hasOauthClientSecret: false,
    oauthScopes: [],
    oauthRevokeUrl: null,
    toolCount: 2,
    bundleIds: [3],
    workflowCount: 2,
    createdAt: '2026-07-30T10:00:00.000Z',
    updatedAt: '2026-07-31T10:00:00.000Z',
    ...overrides,
  };
}

function renderPage(
  managedConnection: FabricManagementBackend,
  fabricServer: FabricResponse['servers'][number] = server,
  profileGroups: FabricProfileSsoGroup[] = [],
  profiles: FabricProfileRecord[] = [],
) {
  if (!window.location.search) window.history.replaceState({}, '', '/mcp-fabric?view=backends');
  api.getServiceTemplateCatalog.mockResolvedValue({
    generatedAt: '2026-08-21T10:00:00.000Z', categories: [], templates: [],
  });
  api.getFabricProfiles.mockResolvedValue({ profiles, groups: profileGroups });
  api.getFabricProfileRestoreRequests.mockResolvedValue({ requests: [] });
  api.getFabricProfileVersions.mockResolvedValue({ versions: [] });
  api.getFabricProfileVersionDiff.mockResolvedValue({ diff: null });
  api.getFabric.mockResolvedValue({
    generatedAt: '2026-07-31T10:00:00.000Z',
    permissions: { canManage: true },
    stats: { servers: 1, healthy: 1, tools: 2, bundles: 1, trusted: 0, trustAttention: 0, mcpServers: 0 },
    servers: [fabricServer],
    bundles: [{
      id: 3,
      label: 'Catalog team',
      icon: '◈',
      serverCount: 1,
      toolCount: 2,
      access: 'unrestricted',
    }],
    tools: [],
  } satisfies FabricResponse);
  api.getFabricManagement.mockResolvedValue({
    generatedAt: '2026-07-31T10:00:00.000Z',
    bundles: [{
      id: 3,
      name: 'catalog-team',
      label: 'Catalog team',
      description: 'Catalog access',
      icon: '◈',
      agentRole: null,
      systemPrompt: null,
      backendIds: [17],
      skillIds: [],
      workflowIds: [9, 11],
      workflowCount: 2,
      toolPolicies: [],
      backendCount: 1,
      toolCount: 2,
      compositeCount: 0,
      createdAt: '2026-07-30T10:00:00.000Z',
      updatedAt: '2026-07-31T10:00:00.000Z',
    }],
    backends: [managedConnection],
    skills: [],
    tools: [],
  } satisfies FabricManagementResponse);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <McpFabricPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('McpFabricPage connection ownership', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    window.history.replaceState({}, '', '/');
  });

  it('opens a provider requested by the visual workflow integration catalog', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?catalog=github&returnTo=%2Fworkflows%2Fbuilder%2F145');
    renderPage(connection({ managedBy: null, sourceId: null }));

    const marketplace = await screen.findByRole('dialog', { name: 'Connect trusted building blocks' });
    expect(marketplace.querySelector('.marketplace-detail h3')).toHaveTextContent('GitHub');
    expect(within(marketplace).getByRole('button', { name: 'Configure connection' })).toBeInTheDocument();
  });

  it('opens the governed connector installer requested by a portable workflow', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?serviceTemplate=slack&returnTo=%2Fbuild%2Fworkflows%2Fstudio%2F147');
    renderPage(connection({ managedBy: null, sourceId: null }));

    expect(await screen.findByRole('dialog', { name: 'Install governed connectors' })).toBeInTheDocument();
  });

  it('shows OpenAPI lineage and routes source-owned connections to Capability Studio', async () => {
    renderPage(connection());

    const connectionCard = (await screen.findByRole('heading', { name: 'catalog' })).closest('article');
    expect(connectionCard).not.toBeNull();
    expect(await screen.findByText('OpenAPI managed', {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(within(connectionCard!).getByRole('button', { name: 'Test' })).toBeInTheDocument();
    expect(within(connectionCard!).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(connectionCard!).getByRole('link', { name: 'Manage source' }))
      .toHaveAttribute('href', '/mcp-fabric/capabilities?source=4');
    expect(screen.getByRole('link', { name: '2 workflows' }))
      .toHaveAttribute('href', '/build/workflows?bundles=3');
  });

  it('separates connection, access and advanced inventory into explicit workspace views', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?view=access');
    renderPage(connection());

    expect(await screen.findByRole('heading', { name: 'Backend bundles' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Servers and systems' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Effective capabilities' })).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Workflow impact' }))
      .toHaveAttribute('href', '/build/workflows?bundles=3');

    fireEvent.click(screen.getByRole('button', { name: /Catalog team/ }));
    const details = await screen.findByRole('dialog', { name: 'Catalog team' });
    expect(within(details).getByText('Catalog access')).toBeInTheDocument();
    expect(within(details).getByText('catalog')).toBeInTheDocument();
    expect(within(details).getByRole('link', { name: /Open full bundle/ }))
      .toHaveAttribute('href', '/mcp-fabric/bundles/3');
    expect(screen.queryByText('ACTIVE FABRIC SCOPE')).not.toBeInTheDocument();
    fireEvent.click(within(details).getByRole('button', { name: 'Close bundle details' }));
    expect(screen.queryByRole('dialog', { name: 'Catalog team' })).not.toBeInTheDocument();
  });

  it('opens Bundle Sets as a modal workspace', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?view=access');
    renderPage(connection());

    const bundleSetsButton = await screen.findByRole('button', { name: 'Bundle Sets' });
    await waitFor(() => expect(bundleSetsButton).toBeEnabled());
    fireEvent.click(bundleSetsButton);
    const dialog = await screen.findByRole('dialog', { name: 'Bundle Sets' });
    expect(within(dialog).getByRole('button', { name: /Create from Fabric/ })).toBeInTheDocument();
    expect(within(dialog).getByText('Credentials stay local')).toBeInTheDocument();
    expect(api.getFabricProfiles).toHaveBeenCalledOnce();
  });

  it('checks an applied Bundle Set for drift on demand', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?view=access');
    const manifest = {
      apiVersion: 'fabric.argus.dev/v1alpha1' as const,
      kind: 'FabricProfile' as const,
      metadata: { name: 'platform-team', label: 'Platform team', description: '', version: '1.0.0' },
      spec: { connectors: [], bundles: [{
        name: 'catalog-team', label: 'Catalog team', description: '', icon: '', systemPrompt: null, agentRole: null,
        connectors: [], skills: [], directTools: [],
      }], access: null },
    };
    const profile: FabricProfileRecord = {
      id: 12, name: 'platform-team', label: 'Platform team', description: '', manifestVersion: '1.0.0',
      revision: 2, manifest, manifestDigest: 'a'.repeat(64), source: 'imported', installedBundleIds: [3],
      appliedMappings: {}, createdBy: 'admin', updatedBy: 'admin', lastAppliedAt: '2026-09-13T10:00:00.000Z',
      drift: {
        status: 'in_sync', checkedAt: '2026-09-13T10:30:00.000Z', profileId: 12, profileRevision: 2,
        manifestDigest: 'a'.repeat(64), counts: { total: 0, critical: 0, warning: 0 }, findings: [],
        findingDigest: 'b'.repeat(64), source: 'scheduled', transitionSequence: 1,
        consecutiveFailures: 0, lastErrorCode: null, lastErrorAt: null,
        changedAt: '2026-09-13T10:30:00.000Z', notifiedAt: null,
      },
      createdAt: '2026-09-13T09:00:00.000Z', updatedAt: '2026-09-13T10:00:00.000Z',
    };
    api.checkFabricProfileDrift.mockResolvedValue({
      replayed: false,
      drift: {
        status: 'drifted', checkedAt: '2026-09-13T11:00:00.000Z', profileId: 12, profileRevision: 2,
        manifestDigest: 'a'.repeat(64), counts: { total: 1, critical: 1, warning: 0 },
        findings: [{
          code: 'tool_policy_changed', severity: 'critical', resourceType: 'connector', resource: 'catalog-team:github',
          message: 'Tool policy for github in catalog-team changed', expected: { mode: 'selected' }, actual: { mode: 'all' },
        }],
      },
    });
    renderPage(connection(), server, [], [profile]);

    const bundleSetsButton = await screen.findByRole('button', { name: 'Bundle Sets' });
    await waitFor(() => expect(bundleSetsButton).toBeEnabled());
    fireEvent.click(bundleSetsButton);
    const dialog = await screen.findByRole('dialog', { name: 'Bundle Sets' });
    const checkDriftButton = await within(dialog).findByRole('button', { name: 'Check drift' });
    expect(within(dialog).getByText('In sync')).toBeInTheDocument();
    expect(within(dialog).getByText(/automatically/)).toBeInTheDocument();
    fireEvent.click(checkDriftButton);

    await waitFor(() => expect(api.checkFabricProfileDrift).toHaveBeenCalledWith(12));
    expect(within(dialog).getByText('Drift detected')).toBeInTheDocument();
    expect(within(dialog).getByText(/Tool policy for github/)).toBeInTheDocument();
  });

  it('captures selected bundles as a portable Bundle Set', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?view=access');
    api.exportFabricProfile.mockResolvedValue({ profile: { label: 'Platform engineering' } });
    renderPage(connection());

    const bundleSetsButton = await screen.findByRole('button', { name: 'Bundle Sets' });
    await waitFor(() => expect(bundleSetsButton).toBeEnabled());
    fireEvent.click(bundleSetsButton);
    const dialog = await screen.findByRole('dialog', { name: 'Bundle Sets' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Create from Fabric/ }));
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Platform engineering' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Portable SSO group aliases/ }), {
      target: { value: 'Platform Engineers, SRE On Call' },
    });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Catalog team/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Bundle Set' }));

    await waitFor(() => expect(api.exportFabricProfile).toHaveBeenCalledOnce());
    expect(api.exportFabricProfile.mock.calls[0]?.[0]).toEqual({
      name: 'platform-engineering',
      label: 'Platform engineering',
      description: '',
      version: '1.0.0',
      bundleIds: [3],
      createComposite: true,
      groupBindings: [
        { logicalName: 'platform-engineers', required: true },
        { logicalName: 'sre-on-call', required: true },
      ],
    });
  });

  it('maps portable group aliases to local SSO groups before preview', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?view=access');
    renderPage(connection(), server, [{ name: 'entra-platform-team', memberCount: 4 }]);

    const bundleSetsButton = await screen.findByRole('button', { name: 'Bundle Sets' });
    await waitFor(() => expect(bundleSetsButton).toBeEnabled());
    fireEvent.click(bundleSetsButton);
    const dialog = await screen.findByRole('dialog', { name: 'Bundle Sets' });
    fireEvent.click(within(dialog).getByRole('button', { name: /Import & apply/ }));
    const manifest = {
      apiVersion: 'fabric.argus.dev/v1alpha1',
      kind: 'FabricProfile',
      metadata: { name: 'platform-team', label: 'Platform team', description: '', version: '1.0.0' },
      spec: {
        connectors: [],
        bundles: [{ name: 'platform_team', label: 'Platform team', description: '', icon: '', systemPrompt: null, agentRole: null, connectors: [], skills: [], directTools: [] }],
        access: { compositeName: 'platform-team-access', description: '', toolAllowPatterns: [], toolDenyPatterns: [], groupBindings: [{ logicalName: 'platform-engineers', required: true }] },
      },
    };
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Fabric Profile JSON' }), {
      target: { value: JSON.stringify(manifest) },
    });
    const groupMapping = await within(dialog).findByRole('combobox', {
      name: 'SSO group mapping for platform-engineers',
    });
    fireEvent.change(groupMapping, { target: { value: 'entra-platform-team' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Preview changes' }));

    await waitFor(() => expect(api.previewFabricProfileImport.mock.calls[0]?.[0]).toEqual({
      manifest,
      mappings: { backends: {}, skills: {}, groups: { 'platform-engineers': 'entra-platform-team' } },
    }));
  });

  it('shows a locally bundled provider logo for recognizable backends', async () => {
    renderPage(
      connection({ name: 'github_argus_core', endpoint: 'https://api.github.com' }),
      { ...server, name: 'github_argus_core', endpoint: 'https://api.github.com' },
    );

    const logo = await screen.findByRole('img', { name: 'github_argus_core logo' });
    expect(logo.querySelector('img')).toHaveAttribute('src', '/console-assets/brand/github.svg');
  });

  it('opens the bundle workspace first on the canonical MCP Fabric route', async () => {
    window.history.replaceState({}, '', '/mcp-fabric');
    api.getServiceTemplateCatalog.mockResolvedValue({ generatedAt: '2026-08-21T10:00:00.000Z', categories: [], templates: [] });
    api.getFabric.mockResolvedValue({
      generatedAt: '2026-07-31T10:00:00.000Z', permissions: { canManage: true },
      stats: { servers: 1, healthy: 1, tools: 2, bundles: 1, trusted: 0, trustAttention: 0, mcpServers: 0 },
      servers: [server], bundles: [{ id: 3, label: 'Catalog team', icon: '◈', serverCount: 1, toolCount: 2, access: 'unrestricted' }], tools: [],
    } satisfies FabricResponse);
    api.getFabricManagement.mockResolvedValue({
      generatedAt: '2026-07-31T10:00:00.000Z', bundles: [], backends: [], skills: [], tools: [],
    } satisfies FabricManagementResponse);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    render(<MemoryRouter><QueryClientProvider client={queryClient}><McpFabricPage /></QueryClientProvider></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Backend bundles' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Servers and systems' })).not.toBeInTheDocument();
  });

  it('keeps the connection editor available for regular managed backends', async () => {
    renderPage(connection({ managedBy: null, sourceId: null }));

    const connectionCard = (await screen.findByRole('heading', { name: 'catalog' })).closest('article');
    expect(connectionCard).not.toBeNull();
    expect(screen.queryByText('OpenAPI managed')).not.toBeInTheDocument();
    expect(await within(connectionCard!).findByRole('button', { name: 'Edit' }, { timeout: 3_000 })).toBeInTheDocument();
    expect(within(connectionCard!).queryByRole('link', { name: 'Manage source' })).not.toBeInTheDocument();
  });

  it('opens a changed catalog from a preflight deep link and exposes sync, approval and return actions', async () => {
    window.history.replaceState({}, '', '/mcp-fabric?server=github_argus_core&returnTo=%2Fsolutions%2Fargus.dev#connections');
    api.discoverFabricConnection.mockResolvedValue({ connected: true, error: null, toolCount: 44, trustStatus: 'changed' });
    api.changeMcpTrust.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage(
      connection({ id: 208, name: 'github_argus_core', type: 'mcp', managedBy: null, sourceId: null, toolCount: 44 }),
      {
        ...server,
        id: '208',
        name: 'github_argus_core',
        type: 'mcp',
        toolCount: 44,
        trustStatus: 'changed',
        catalogFingerprint: 'f'.repeat(64),
        trustedFingerprint: '9'.repeat(64),
        registryToolCount: 44,
        changeSummary: { added: [], removed: [], changed: ['issue_write'] },
      },
    );

    expect(await screen.findByRole('heading', { name: 'Catalog review required' })).toBeVisible();
    expect(screen.getByText('~ issue_write')).toBeVisible();
    expect(screen.getByRole('link', { name: /Return to Argus Dev/ }))
      .toHaveAttribute('href', '/solutions/argus.dev');

    fireEvent.click(screen.getByRole('button', { name: 'Refresh catalog' }));
    await waitFor(() => expect(api.discoverFabricConnection).toHaveBeenCalledWith(208));
    fireEvent.click(screen.getByRole('button', { name: 'Approve updated catalog' }));
    await waitFor(() => expect(api.changeMcpTrust).toHaveBeenCalledWith('208', 'trust'));
  });
});
