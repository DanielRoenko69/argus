import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Boxes, ExternalLink, FileJson, Fingerprint, KeyRound, Layers3, LayoutTemplate, LockKeyhole, Network, PackageSearch, Pencil, RefreshCw, Search, Server, ShieldCheck, Workflow, Wrench, X } from 'lucide-react';
import {
  assignFabricTools,
  changeMcpTrust,
  deleteFabricBundle,
  deleteFabricConnection,
  discoverFabricConnection,
  getFabric,
  getFabricManagement,
  saveFabricBundle,
  saveFabricConnection,
  testFabricConnection,
} from '../api';
import { BundleEditor } from '../components/BundleEditor';
import { BundleGlyph } from '../components/BundleGlyph';
import { BundleInspectorDialog } from '../components/BundleInspectorDialog';
import { BrandIcon, resolveBackendBrand } from '../components/BrandIcon';
import { ConnectionEditor } from '../components/ConnectionEditor';
import { FabricProfilesDialog } from '../components/FabricProfilesDialog';
import { McpMarketplace } from '../components/McpMarketplace';
import { ServiceTemplateMarketplace } from '../components/ServiceTemplateMarketplace';
import { ToolCoveragePanel } from '../components/ToolCoveragePanel';
import { EmptyState, ErrorState, HealthBadge, LoadingState, PageHeader } from '../components/Ui';
import { IntegrationWorkspaceTabs, type IntegrationWorkspaceView } from '../features/integrations/IntegrationWorkspaceTabs';
import type { McpCatalogItem } from '../data/mcpCatalog';
import type { FabricBundleMutation, FabricConnectionMutation, FabricServer } from '../types';

function localReturnPath(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  return value;
}

function BackendMark({ server, className = 'server-icon' }: { server: Pick<FabricServer, 'name' | 'endpoint'>; className?: string }) {
  return (
    <BrandIcon
      brand={resolveBackendBrand(server.name, server.endpoint) ?? ''}
      label={server.name}
      className={className}
      fallback={Server}
    />
  );
}

export function McpFabricPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const browserSearch = typeof window === 'undefined' ? '' : window.location.search;
  const searchParams = new URLSearchParams(location.search || browserSearch);
  const requestedCreate = searchParams.get('create');
  const requestedCatalog = searchParams.get('catalog');
  const requestedServer = searchParams.get('server');
  const requestedReturnTo = localReturnPath(searchParams.get('returnTo'));
  const requestedNewConnection = requestedCreate === 'mcp' ? 'mcp' : searchParams.get('new');
  const requestedServiceTemplate = searchParams.get('serviceTemplate');
  const requestedView = searchParams.get('view');
  const connectionDeepLink = Boolean(requestedServer || requestedCatalog || requestedNewConnection || requestedServiceTemplate);
  const activeView: IntegrationWorkspaceView = requestedView === 'advanced'
    ? 'advanced'
    : requestedView === 'connections' || requestedView === 'backends' || connectionDeepLink
      ? 'connections'
      : 'access';
  const [search, setSearch] = useState('');
  const [selectedBundle, setSelectedBundle] = useState<string | null>(null);
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<'new' | number | null>(() => requestedCreate === 'bundle' ? 'new' : null);
  const [connectionEditorTarget, setConnectionEditorTarget] = useState<'new' | number | null>(
    requestedNewConnection === 'mcp' || requestedNewConnection === 'http' ? 'new' : null,
  );
  const [marketplaceOpen, setMarketplaceOpen] = useState(Boolean(requestedCatalog));
  const [templateMarketplaceOpen, setTemplateMarketplaceOpen] = useState(Boolean(requestedServiceTemplate));
  const [profilesOpen, setProfilesOpen] = useState(false);
  const [connectionPreset, setConnectionPreset] = useState<{
    type?: 'mcp' | 'http';
    name: string;
    description: string;
    baseUrl: string;
    mcpEndpoint: string;
  } | null>(() => requestedNewConnection === 'mcp' || requestedNewConnection === 'http'
    ? {
        type: requestedNewConnection,
        name: '',
        description: '',
        baseUrl: '',
        mcpEndpoint: '/mcp',
      }
    : null);
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const url = new URL(window.location.href);
    const oauthState = url.searchParams.get('oauth');
    if (!oauthState) return;
    const connectionId = url.searchParams.get('connection');
    const message = url.searchParams.get('message');
    setNotice(oauthState === 'connected'
      ? `User OAuth connected${connectionId ? ` for connection #${connectionId}` : ''}.`
      : `User OAuth failed${message ? `: ${message}` : '.'}`);
    url.searchParams.delete('oauth');
    url.searchParams.delete('connection');
    url.searchParams.delete('message');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  }, []);

  const query = useQuery({ queryKey: ['mcp-fabric'], queryFn: getFabric, refetchInterval: 30_000 });
  const managementQuery = useQuery({
    queryKey: ['mcp-fabric', 'manage'],
    queryFn: getFabricManagement,
    enabled: Boolean(query.data?.permissions.canManage),
    staleTime: 15_000,
  });
  const trustMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'trust' | 'quarantine' }) =>
      changeMcpTrust(id, action),
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setNotice(variables.action === 'trust'
        ? 'The current MCP tool catalog is approved and available to new governed runs.'
        : 'The MCP connection is quarantined and unavailable to new governed runs.');
    },
  });
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: FabricBundleMutation; id?: number }) => saveFabricBundle(input, id),
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setEditorTarget(null);
      setNotice(variables.id == null
        ? `Bundle “${result.bundle.label}” was created.`
        : `Bundle “${result.bundle.label}” was updated.`);
    },
  });
  const assignToolsMutation = useMutation({
    mutationFn: assignFabricTools,
    onSuccess: async result => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
      const bundle = managementQuery.data?.bundles.find(item => item.id === result.bundleId);
      setNotice(`${result.assigned} tool${result.assigned === 1 ? '' : 's'} assigned to “${bundle?.label ?? `Bundle #${result.bundleId}`}”.`);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteFabricBundle(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setEditorTarget(null);
      setSelectedBundle(null);
      setSelectedServer(null);
      setNotice('Bundle deleted. Its connections and tools were preserved.');
    },
  });
  const saveConnectionMutation = useMutation({
    mutationFn: ({ input, id }: { input: FabricConnectionMutation; id?: number }) =>
      saveFabricConnection(input, id),
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setNotice(result.warning
        ? `Connection “${result.connection.name}” was saved, but is not reachable: ${result.warning}`
        : !result.connection.enabled
          ? `Connection “${result.connection.name}” was saved disabled for verification.`
        : variables.id == null
          ? `Connection “${result.connection.name}” was created and synchronized.`
          : `Connection “${result.connection.name}” was updated.`);
    },
  });
  const deleteConnectionMutation = useMutation({
    mutationFn: (id: number) => deleteFabricConnection(id),
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setConnectionEditorTarget(null);
      setConnectionPreset(null);
      setSelectedServer(null);
      setNotice(`Connection deleted. ${result.toolsDeleted} associated dynamic tool${result.toolsDeleted === 1 ? '' : 's'} removed.`);
    },
  });
  const testConnectionMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      testFabricConnection(id).then(result => ({ ...result, name })),
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setNotice(result.reachable
        ? `${result.name} is reachable${result.latencyMs == null ? '' : ` in ${result.latencyMs} ms`}${result.toolCount == null ? '' : ` · ${result.toolCount} tools`}.`
        : `${result.name} is not reachable: ${result.error || 'connection failed'}`);
    },
  });
  const discoverConnectionMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      discoverFabricConnection(id).then(result => ({ ...result, name })),
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setNotice(`${result.name} synchronized ${result.toolCount} tools · trust status ${result.trustStatus}.`);
    },
  });
  const testAllConnectionsMutation = useMutation({
    mutationFn: async () => {
      const testable = (managementQuery.data?.backends ?? [])
        .filter(connection => connection.managed && connection.enabled)
        .slice(0, 25);
      const results = await Promise.all(testable.map(async connection => ({
        name: connection.name,
        result: await testFabricConnection(connection.id),
      })));
      return {
        total: results.length,
        reachable: results.filter(item => item.result.reachable).length,
      };
    },
    onSuccess: async result => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
      setNotice(`Connection check complete: ${result.reachable}/${result.total} reachable.`);
    },
  });

  useEffect(() => {
    if (requestedCreate !== 'bundle' && requestedCreate !== 'mcp') return;
    if (requestedCreate === 'bundle') {
      saveMutation.reset();
      deleteMutation.reset();
      setNotice(null);
      setEditorTarget('new');
    } else {
      saveConnectionMutation.reset();
      deleteConnectionMutation.reset();
      setConnectionPreset({ type: 'mcp', name: '', description: '', baseUrl: '', mcpEndpoint: '/mcp' });
      setConnectionEditorTarget('new');
    }
    const params = new URLSearchParams(location.search);
    params.delete('create');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate, requestedCreate]);

  useEffect(() => {
    if (!requestedServer || !query.data) return;
    const server = query.data.servers.find(item => item.name === requestedServer);
    if (!server) return;
    setSelectedServer(server.name);
    const params = new URLSearchParams(location.search);
    params.delete('server');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '', hash: '#connections' }, { replace: true });
  }, [location.pathname, location.search, navigate, query.data, requestedServer]);

  const servers = useMemo(() => {
    const allServers = query.data?.servers ?? [];
    if (!selectedBundle) return allServers;
    return allServers.filter(server => server.bundleNames.includes(selectedBundle));
  }, [query.data, selectedBundle]);

  const tools = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data?.tools ?? []).filter(tool => {
      if (selectedBundle && !tool.bundleNames.includes(selectedBundle)) return false;
      if (selectedServer && tool.server !== selectedServer && tool.server !== `custom:${selectedServer}`) return false;
      return !normalized || `${tool.name} ${tool.server} ${tool.description} ${tool.bundleNames.join(' ')}`.toLowerCase().includes(normalized);
    });
  }, [query.data, search, selectedBundle, selectedServer]);
  const selectedServerData = query.data?.servers.find(server => server.name === selectedServer);
  const selectedManagedConnection = managementQuery.data?.backends.find(
    connection => connection.id === Number(selectedServerData?.id) && connection.managed,
  );
  const editorBundle = typeof editorTarget === 'number'
    ? managementQuery.data?.bundles.find(bundle => bundle.id === editorTarget)
    : null;
  const editorConnection = typeof connectionEditorTarget === 'number'
    ? managementQuery.data?.backends.find(connection => connection.id === connectionEditorTarget && connection.managed)
    : null;
  const editorError = saveMutation.error?.message ?? deleteMutation.error?.message ?? null;
  const connectionEditorError = saveConnectionMutation.error?.message
    ?? deleteConnectionMutation.error?.message
    ?? null;
  const openCatalogPreset = (item: McpCatalogItem) => {
    const parsed = new URL(item.suggestedUrl);
    const endpoint = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/mcp';
    setConnectionPreset({
      type: 'mcp',
      name: item.id,
      description: `${item.description}\n\nCatalog source: ${item.repository}`,
      baseUrl: parsed.origin,
      mcpEndpoint: endpoint,
    });
    saveConnectionMutation.reset();
    deleteConnectionMutation.reset();
    setNotice(null);
    setMarketplaceOpen(false);
    setConnectionEditorTarget('new');
  };
  const openCustomConnection = (type: 'mcp' | 'http') => {
    setConnectionPreset({
      type,
      name: '',
      description: '',
      baseUrl: '',
      mcpEndpoint: '/mcp',
    });
    saveConnectionMutation.reset();
    deleteConnectionMutation.reset();
    setNotice(null);
    setMarketplaceOpen(false);
    setConnectionEditorTarget('new');
  };

  if (query.isLoading) return <LoadingState label="Discovering MCP fabric…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const { bundles, permissions, stats } = query.data;
  const selectedBundleRecord = selectedBundle
    ? bundles.find(bundle => bundle.label === selectedBundle)
    : null;
  const selectedManagedBundle = selectedBundleRecord
    ? managementQuery.data?.bundles.find(bundle => bundle.id === selectedBundleRecord.id)
    : null;
  const selectedBundleConnections = selectedBundleRecord
    ? query.data.servers.filter(server => server.bundleNames.includes(selectedBundleRecord.label))
    : [];
  const clearScope = () => {
    setSelectedBundle(null);
    setSelectedServer(null);
  };
  const closeBundleInspector = () => {
    setSelectedBundle(null);
    setSelectedServer(null);
  };

  return (
    <>
      <PageHeader
        eyebrow="OPERATE"
        title="MCP Fabric"
        description="Compose governed capability bundles, connect their backends and inspect the effective tool catalog."
        actions={permissions.canManage
          ? (
            <>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={managementQuery.isLoading || managementQuery.isError}
                  onClick={() => {
                    setNotice(null);
                    setProfilesOpen(true);
                  }}
                >
                  <Layers3 size={16} />Bundle Sets
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={managementQuery.isLoading || managementQuery.isError}
                  onClick={() => {
                    setNotice(null);
                    setTemplateMarketplaceOpen(true);
                  }}
                >
                  <LayoutTemplate size={16} />Connector templates
                </button>
                <button
                  className="button button-secondary"
                  type="button"
                  disabled={managementQuery.isLoading || managementQuery.isError}
                  onClick={() => {
                    setConnectionPreset(null);
                    setNotice(null);
                    setMarketplaceOpen(true);
                  }}
                >
                  <PackageSearch size={16} />Browse catalog
                </button>
                <button
                  className="button button-primary"
                  type="button"
                  disabled={managementQuery.isLoading || managementQuery.isError}
                  onClick={() => {
                    saveMutation.reset();
                    deleteMutation.reset();
                    setNotice(null);
                    setEditorTarget('new');
                  }}
                >
                  <Boxes size={16} />New bundle
                </button>
              </>
            )
          : undefined}
      />

      <IntegrationWorkspaceTabs active={activeView} />

      {notice && (
        <div className="fabric-notice" role="status">
          <ShieldCheck size={16} /><span>{notice}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={14} /></button>
        </div>
      )}

      {permissions.canManage && managementQuery.error && (
        <div className="scope-notice" role="alert">
          <AlertTriangle size={16} />
          <span><b>Bundle management is temporarily unavailable.</b> {managementQuery.error.message}</span>
        </div>
      )}

      {(testConnectionMutation.error || discoverConnectionMutation.error || testAllConnectionsMutation.error) && (
        <div className="scope-notice" role="alert">
          <AlertTriangle size={16} />
          <span>
            <b>Connection operation failed.</b>{' '}
            {testConnectionMutation.error?.message
              ?? discoverConnectionMutation.error?.message
              ?? testAllConnectionsMutation.error?.message}
          </span>
        </div>
      )}

      {(stats.ssoPortals ?? 0) > 0 && (
        <section className="panel backend-sso-overview" aria-label="Workforce SSO federation">
          <div className="backend-sso-overview-copy">
            <span className="backend-sso-premium"><ShieldCheck size={13} />PREMIUM · WORKFORCE SSO</span>
            <h2>One identity, governed backend access</h2>
            <p>Your verified Argus identity opens connected engineering and operations consoles through the same workforce provider. Agent and workflow credentials remain separately governed.</p>
          </div>
          <div className="backend-sso-flow" aria-label="Identity federation path">
            <span><KeyRound size={16} /><small>Identity provider</small><b>SSO + MFA</b></span>
            <i><ArrowRight size={15} /></i>
            <span><ShieldCheck size={16} /><small>Argus policy</small><b>Bundles + audit</b></span>
            <i><ArrowRight size={15} /></i>
            <span><ExternalLink size={16} /><small>Backend portals</small><b>{stats.readySsoPortals ?? 0}/{stats.ssoPortals ?? 0} ready</b></span>
          </div>
        </section>
      )}

      <section className="metric-grid fabric-metrics" aria-label="MCP fabric summary">
        <article className="metric-card">
          <span className="metric-icon teal"><Boxes size={17} /></span>
          <div><span>Access bundles</span><strong>{stats.bundles}</strong><small>authorization boundaries</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon violet"><Network size={17} /></span>
          <div><span>Connected systems</span><strong>{stats.servers}</strong><small>{stats.healthy} healthy</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon blue"><Wrench size={17} /></span>
          <div><span>Registered tools</span><strong>{stats.tools}</strong><small>effective registry</small></div>
        </article>
        <article className="metric-card">
          <span className={`metric-icon ${stats.trustAttention > 0 ? 'amber' : 'teal'}`}><Fingerprint size={17} /></span>
          <div>
            <span>MCP trust</span>
            <strong>{stats.trusted}/{stats.mcpServers}</strong>
            <small>{stats.trustAttention > 0 ? `${stats.trustAttention} need review` : 'catalogs verified'}</small>
          </div>
        </article>
      </section>

      {activeView === 'access' && permissions.canManage && managementQuery.data && (
        <ToolCoveragePanel
          data={managementQuery.data}
          saving={assignToolsMutation.isPending}
          error={assignToolsMutation.error?.message ?? null}
          onAssign={input => {
            assignToolsMutation.reset();
            setNotice(null);
            assignToolsMutation.mutate(input);
          }}
        />
      )}

      {activeView === 'access' && <section className="panel bundle-section" id="access-bundles">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">ACCESS CONTROL</span>
            <h2>Backend bundles</h2>
            <p className="panel-description">Bundles group servers and tools into reusable authorization boundaries for users, API keys and agents.</p>
          </div>
          <div className="panel-heading-actions">
            <span className="policy-indicator"><ShieldCheck size={15} />Effective access</span>
          </div>
        </div>
        {bundles.length > 0 ? (
          <div className="bundle-grid">
            {bundles.map(bundle => {
              const managedBundle = managementQuery.data?.bundles.find(item => item.id === bundle.id);
              const bundleServers = query.data.servers.filter(server => server.bundleNames.includes(bundle.label));
              const brandedServers = bundleServers.filter(server => resolveBackendBrand(server.name, server.endpoint)).slice(0, 3);
              return (
              <article className={`bundle-card${selectedBundle === bundle.label ? ' is-selected' : ''}`} key={bundle.id}>
                <button
                  className="bundle-filter-button"
                  type="button"
                  aria-pressed={selectedBundle === bundle.label}
                  onClick={() => {
                    setSelectedBundle(bundle.label);
                    setSelectedServer(null);
                  }}
                >
                  <div className="bundle-card-head">
                    {brandedServers.length > 0 ? (
                      <span className="bundle-provider-stack" aria-label={`${bundle.label} providers`}>
                        {brandedServers.map(server => <BackendMark server={server} className="bundle-provider-icon" key={server.id} />)}
                      </span>
                    ) : (
                      <span className="bundle-icon" aria-hidden="true"><BundleGlyph icon={bundle.icon} size={17} /></span>
                    )}
                    <span className="access-badge"><i />{bundle.access === 'unrestricted' ? 'Available to you' : 'Granted'}</span>
                  </div>
                  <h3>{bundle.label}</h3>
                  <div className="bundle-card-stats">
                    <span><b>{bundle.serverCount}</b> servers</span>
                    <span><b>{bundle.toolCount}</b> tools</span>
                    {managedBundle && <span><b>{managedBundle.workflowCount}</b> workflows</span>}
                  </div>
                </button>
                <div className="bundle-card-actions">
                  <a className="bundle-open-link" href={`/mcp-fabric/bundles/${bundle.id}`}>
                    Inspect access graph <ArrowRight size={13} />
                  </a>
                  {managedBundle && managedBundle.workflowCount > 0 && (
                    <Link className="bundle-impact-link" to={`/build/workflows?bundles=${bundle.id}`}>
                      <Workflow size={12} />Workflow impact
                    </Link>
                  )}
                  {permissions.canManage && (
                    <button
                      className="bundle-edit-link"
                      type="button"
                      disabled={managementQuery.isLoading || managementQuery.isError}
                      onClick={() => {
                        saveMutation.reset();
                        deleteMutation.reset();
                        setNotice(null);
                        setEditorTarget(bundle.id);
                      }}
                    >
                      <Pencil size={12} />Edit
                    </button>
                  )}
                </div>
              </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="No access bundles visible"
            description="Create a bundle to scope related backends and tools, then grant it to users or agents."
          />
        )}
        {servers.some(server => server.type !== 'database' && server.bundleCount === 0) && (
          <div className="scope-notice">
            <KeyRound size={16} />
            <span><b>Unscoped connections are visible outside bundle restrictions.</b> Assign them to a bundle before delegating access.</span>
          </div>
        )}
      </section>}

      {activeView === 'connections' && <section className="panel server-section" id="connections">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">CONNECTIONS</span>
            <h2>{selectedBundle ? `Systems in ${selectedBundle}` : 'Servers and systems'}</h2>
          </div>
          <div className="panel-heading-actions">
            {(selectedBundle || selectedServer) && <button type="button" onClick={clearScope}>Clear filter</button>}
            {permissions.canManage && (
              <button
                type="button"
                disabled={testAllConnectionsMutation.isPending || managementQuery.isLoading}
                onClick={() => {
                  setNotice(null);
                  testAllConnectionsMutation.mutate();
                }}
              >
                <RefreshCw size={14} className={testAllConnectionsMutation.isPending ? 'spin' : ''} />
                {testAllConnectionsMutation.isPending ? 'Testing…' : 'Test connections'}
              </button>
            )}
          </div>
        </div>
        {servers.length > 0 ? (
          <div className="server-grid">
            {servers.map(server => {
              const managedConnection = managementQuery.data?.backends.find(
                connection => connection.id === Number(server.id) && connection.managed,
              );
              const operationPending = (
                testConnectionMutation.isPending
                && testConnectionMutation.variables?.id === managedConnection?.id
              ) || (
                discoverConnectionMutation.isPending
                && discoverConnectionMutation.variables?.id === managedConnection?.id
              );
              return (
                <article
                  className={`server-card${selectedServer === server.name ? ' is-selected' : ''}`}
                  key={server.id}
                >
                  <button
                    className="server-card-select"
                    type="button"
                    aria-pressed={selectedServer === server.name}
                    onClick={() => setSelectedServer(current => current === server.name ? null : server.name)}
                  >
                    <div className="server-card-head">
                      <BackendMark server={server} />
                      <span className="server-badges">
                        {managedConnection?.managedBy === 'openapi' && (
                          <span className="source-lineage-badge"><FileJson size={12} />OpenAPI managed</span>
                        )}
                        {server.type === 'mcp' && (
                          <span className={`trust-badge trust-${server.trustStatus}`}>
                            {server.trustStatus === 'trusted' && <ShieldCheck size={12} />}
                            {(server.trustStatus === 'changed' || server.trustStatus === 'quarantined') && <LockKeyhole size={12} />}
                            {server.trustStatus}
                          </span>
                        )}
                        {server.ssoPortal && (
                          <span className={`backend-sso-badge is-${server.ssoPortal.state}`}>
                            <KeyRound size={11} />
                            {server.ssoPortal.state === 'ready'
                              ? 'Workforce SSO'
                              : server.ssoPortal.state === 'sso_required'
                                ? 'SSO sign-in required'
                                : 'Premium SSO'}
                          </span>
                        )}
                        <HealthBadge state={server.state} />
                      </span>
                    </div>
                    <h3>{server.name}</h3>
                    <p>{server.endpoint || 'Internal connection'}</p>
                    <div className="server-stats">
                      <span><b>{server.toolCount}</b> tools</span>
                      <span><b>{server.latencyMs == null ? '—' : `${server.latencyMs} ms`}</b> latency</span>
                      <span><b>{server.bundleCount}</b> bundles</span>
                      {managedConnection && <span><b>{managedConnection.workflowCount}</b> workflows</span>}
                    </div>
                    {managedConnection?.executionTargets?.length ? (
                      <div className="server-runtime-target">
                        <Server size={13} />
                        <span>
                          <b>{managedConnection.executionTargets[0].targetLabel}</b>
                          <small>{managedConnection.executionTargets[0].cluster} · {managedConnection.executionTargets.length} namespace{managedConnection.executionTargets.length === 1 ? '' : 's'}</small>
                        </span>
                      </div>
                    ) : null}
                    <div className="bundle-chip-row" aria-label={`Access bundles for ${server.name}`}>
                      {server.bundleNames.length > 0
                        ? server.bundleNames.slice(0, 3).map(bundle => <span className="bundle-chip" key={bundle}>{bundle}</span>)
                        : <span className={`bundle-chip ${server.type === 'database' ? 'is-internal' : 'is-unscoped'}`}>
                            {server.type === 'database' ? 'Platform internal' : 'Unscoped'}
                          </span>}
                      {server.bundleNames.length > 3 && <span className="bundle-chip">+{server.bundleNames.length - 3}</span>}
                    </div>
                    {server.error && <small className="server-error">{server.error}</small>}
                  </button>
                  {((permissions.canManage && managedConnection) || server.ssoPortal) && (
                    <div className="server-card-actions">
                      {server.ssoPortal?.state === 'ready' && server.ssoPortal.launchPath && (
                        <a
                          className="server-sso-link"
                          href={server.ssoPortal.launchPath}
                          target="_blank"
                          rel="noreferrer"
                          title={server.ssoPortal.presentationRole}
                        >
                          <KeyRound size={12} />{server.ssoPortal.label}<ExternalLink size={11} />
                        </a>
                      )}
                      {server.ssoPortal?.state === 'sso_required' && (
                        <a className="server-sso-link" href="/auth/oidc/login"><KeyRound size={12} />Sign in with workforce SSO</a>
                      )}
                      {server.ssoPortal?.state === 'premium_required' && (
                        <span className="server-sso-locked"><LockKeyhole size={12} />Premium SSO</span>
                      )}
                      {permissions.canManage && managedConnection && <button
                        type="button"
                        disabled={operationPending}
                        onClick={() => {
                          setNotice(null);
                          testConnectionMutation.reset();
                          testConnectionMutation.mutate({ id: managedConnection.id, name: managedConnection.name });
                        }}
                      >
                        <RefreshCw size={12} className={operationPending ? 'spin' : ''} />Test
                      </button>}
                      {permissions.canManage && managedConnection?.type === 'mcp' && (
                        <button
                          type="button"
                          disabled={operationPending}
                          onClick={() => {
                            setNotice(null);
                            discoverConnectionMutation.reset();
                            discoverConnectionMutation.mutate({ id: managedConnection.id, name: managedConnection.name });
                          }}
                        >
                          <Wrench size={12} />Sync tools
                        </button>
                      )}
                      {permissions.canManage && managedConnection && managedConnection.workflowCount > 0 && managedConnection.bundleIds.length > 0 && (
                        <Link
                          className="server-impact-link"
                          to={`/build/workflows?bundles=${managedConnection.bundleIds.join(',')}`}
                        ><Workflow size={12} />{managedConnection.workflowCount} workflows</Link>
                      )}
                      {permissions.canManage && managedConnection && (managedConnection.managedBy === 'openapi' ? (
                        <Link
                          className="server-source-link"
                          to={`/mcp-fabric/capabilities${managedConnection.sourceId == null ? '' : `?source=${managedConnection.sourceId}`}`}
                        ><LockKeyhole size={12} />Manage source</Link>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            saveConnectionMutation.reset();
                            deleteConnectionMutation.reset();
                            setConnectionPreset(null);
                            setNotice(null);
                            setConnectionEditorTarget(managedConnection.id);
                          }}
                        >
                          <Pencil size={12} />Edit
                        </button>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : <EmptyState title="No systems in this bundle" description="Assign a backend to the bundle or select a different access boundary." />}
        {selectedServerData?.type === 'mcp' && (
          <div className={`trust-review trust-review-${selectedServerData.trustStatus}`}>
            <div className="trust-review-copy">
              <span className="trust-review-icon">
                {selectedServerData.trustStatus === 'trusted' ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />}
              </span>
              <div>
                <span className="eyebrow">REGISTRY TRUST</span>
                <h3>{selectedServerData.trustStatus === 'trusted' ? 'Catalog verified' : 'Catalog review required'}</h3>
                <p>
                  {selectedServerData.trustStatus === 'changed'
                    ? 'Argus detected a catalog change and blocked this server’s tools until an administrator trusts the new fingerprint.'
                    : selectedServerData.trustStatus === 'quarantined'
                      ? 'This server is explicitly quarantined. Its tools are hidden from new agent sessions and cannot execute.'
                      : selectedServerData.trustStatus === 'unverified'
                        ? 'This is the first observed catalog. Verify its tools and fingerprint before marking the server as trusted.'
                        : 'The active catalog matches the fingerprint approved by an administrator.'}
                </p>
              </div>
            </div>
            <div className="trust-facts">
              <span><small>Catalog fingerprint</small><code title={selectedServerData.catalogFingerprint ?? ''}>{selectedServerData.catalogFingerprint?.slice(0, 16) ?? 'pending'}…</code></span>
              <span><small>Last observed</small><b>{selectedServerData.lastSeenAt ? new Date(selectedServerData.lastSeenAt).toLocaleString() : 'Not discovered'}</b></span>
              <span><small>Catalog delta</small><b>+{selectedServerData.changeSummary.added.length} / −{selectedServerData.changeSummary.removed.length} / ~{selectedServerData.changeSummary.changed.length}</b></span>
            </div>
            {(selectedServerData.changeSummary.added.length > 0
              || selectedServerData.changeSummary.removed.length > 0
              || selectedServerData.changeSummary.changed.length > 0) && (
              <div className="catalog-delta" aria-label="Catalog changes">
                {selectedServerData.changeSummary.added.map(tool => <code className="delta-added" key={`added-${tool}`}>+ {tool}</code>)}
                {selectedServerData.changeSummary.removed.map(tool => <code className="delta-removed" key={`removed-${tool}`}>− {tool}</code>)}
                {selectedServerData.changeSummary.changed.map(tool => <code className="delta-changed" key={`changed-${tool}`}>~ {tool}</code>)}
              </div>
            )}
            {permissions.canManage && (
              <div className="trust-actions">
                {selectedManagedConnection?.type === 'mcp' && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={discoverConnectionMutation.isPending}
                    onClick={() => {
                      setNotice(null);
                      discoverConnectionMutation.reset();
                      discoverConnectionMutation.mutate({ id: selectedManagedConnection.id, name: selectedManagedConnection.name });
                    }}
                  >
                    <RefreshCw size={15} className={discoverConnectionMutation.isPending ? 'spin' : ''} />
                    {discoverConnectionMutation.isPending ? 'Refreshing catalog…' : 'Refresh catalog'}
                  </button>
                )}
                {selectedServerData.trustStatus !== 'trusted' && (
                  <button
                    className="button button-primary"
                    type="button"
                    disabled={trustMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Trust the current tool catalog from ${selectedServerData.name}?`)) {
                        trustMutation.mutate({ id: selectedServerData.id, action: 'trust' });
                      }
                    }}
                  >
                    <ShieldCheck size={15} />{selectedServerData.trustStatus === 'changed' ? 'Approve updated catalog' : 'Trust current catalog'}
                  </button>
                )}
                {selectedServerData.trustStatus !== 'quarantined' && (
                  <button
                    className="button button-secondary"
                    type="button"
                    disabled={trustMutation.isPending}
                    onClick={() => {
                      if (window.confirm(`Quarantine ${selectedServerData.name} and block its tools?`)) {
                        trustMutation.mutate({ id: selectedServerData.id, action: 'quarantine' });
                      }
                    }}
                  >
                    <LockKeyhole size={15} />Quarantine
                  </button>
                )}
                {requestedReturnTo && <Link className="button button-secondary" to={requestedReturnTo}>Return to Argus Dev <ArrowRight size={13} /></Link>}
                {trustMutation.error && <small className="mutation-error">{trustMutation.error.message}</small>}
              </div>
            )}
          </div>
        )}
      </section>}

      {activeView === 'advanced' && <section className="panel registry-panel" id="tool-registry">
        <div className="panel-heading registry-heading">
          <div>
            <span className="eyebrow">TOOL REGISTRY</span>
            <h2>{selectedServer ? `Capabilities from ${selectedServer}` : selectedBundle ? `Capabilities in ${selectedBundle}` : 'Effective capabilities'}</h2>
          </div>
          <div className="registry-heading-actions">
            {permissions.canManage && <a className="button button-secondary" href="/mcp-fabric/capabilities"><Wrench size={13} />Open Capability Studio</a>}
            <label className="search-field">
              <Search size={16} />
              <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search tools and servers" />
            </label>
          </div>
        </div>
        {tools.length > 0 ? (
          <div className="data-table tool-table">
            <div className="data-row data-head"><span>Tool</span><span>Server</span><span>Description</span><span>Bundles</span></div>
            {tools.slice(0, 40).map(tool => (
              <div className="data-row" key={tool.id}>
                <div className="tool-name"><span><Wrench size={15} /></span><code>{tool.name}</code></div>
                <span>{tool.server}</span>
                <span className="tool-description">{tool.description || 'No description provided'}</span>
                <span className="table-bundles">
                  {tool.bundleNames.length > 0
                    ? tool.bundleNames.slice(0, 2).map(bundle => <span className="bundle-chip" key={bundle}>{bundle}</span>)
                    : <span className="bundle-chip is-unscoped">Unscoped</span>}
                  {tool.bundleNames.length > 2 && <small>+{tool.bundleNames.length - 2}</small>}
                </span>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No matching tools" description="Try a different server or capability name." />}
      </section>}

      {editorTarget !== null
        && managementQuery.data
        && (editorTarget === 'new' || editorBundle) && (
          <BundleEditor
            key={editorTarget}
            bundle={editorBundle ?? null}
            backends={managementQuery.data.backends}
            skills={managementQuery.data.skills}
            tools={managementQuery.data.tools}
            saving={saveMutation.isPending}
            deleting={deleteMutation.isPending}
            error={editorError}
            onClose={() => {
              setEditorTarget(null);
              saveMutation.reset();
              deleteMutation.reset();
            }}
            onSave={input => saveMutation.mutate({
              input,
              ...(typeof editorTarget === 'number' ? { id: editorTarget } : {}),
            })}
            onDelete={typeof editorTarget === 'number'
              ? () => deleteMutation.mutate(editorTarget)
              : null}
          />
        )}

      {selectedBundleRecord && (
        <BundleInspectorDialog
          bundle={selectedBundleRecord}
          managedBundle={selectedManagedBundle ?? null}
          connections={selectedBundleConnections}
          backends={managementQuery.data?.backends ?? []}
          onClose={closeBundleInspector}
        />
      )}

      {profilesOpen && managementQuery.data && (
        <FabricProfilesDialog
          bundles={managementQuery.data.bundles}
          backends={managementQuery.data.backends}
          skills={managementQuery.data.skills}
          onClose={() => setProfilesOpen(false)}
          onApplied={setNotice}
        />
      )}

      {marketplaceOpen && managementQuery.data && (
        <McpMarketplace
          connections={managementQuery.data.backends}
          initialSelection={requestedCatalog}
          onClose={() => setMarketplaceOpen(false)}
          onConnect={openCatalogPreset}
          onCustom={openCustomConnection}
        />
      )}

      {templateMarketplaceOpen && managementQuery.data && (
        <ServiceTemplateMarketplace
          bundles={managementQuery.data.bundles}
          initialSelection={requestedServiceTemplate}
          onClose={() => setTemplateMarketplaceOpen(false)}
          onInstalled={result => {
            void queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] });
            setNotice(`Connector “${result.connection.name}” was staged with ${result.capabilities.length} capabilities. Open the connection to test and activate it.`);
          }}
        />
      )}

      {connectionEditorTarget !== null
        && managementQuery.data
        && (connectionEditorTarget === 'new' || (editorConnection && editorConnection.managedBy !== 'openapi')) && (
          <ConnectionEditor
            key={connectionEditorTarget}
            connection={editorConnection ?? null}
            preset={connectionPreset}
            bundles={managementQuery.data.bundles}
            saving={saveConnectionMutation.isPending}
            deleting={deleteConnectionMutation.isPending}
            error={connectionEditorError}
            onClose={() => {
              setConnectionEditorTarget(null);
              setConnectionPreset(null);
              saveConnectionMutation.reset();
              deleteConnectionMutation.reset();
            }}
            onSave={(input, idOverride) => saveConnectionMutation.mutateAsync({
              input,
              ...(idOverride != null
                ? { id: idOverride }
                : typeof connectionEditorTarget === 'number'
                  ? { id: connectionEditorTarget }
                  : {}),
            })}
            onTest={id => testConnectionMutation.mutateAsync({
              id,
              name: editorConnection?.name ?? connectionPreset?.name ?? 'Connection',
            })}
            onDiscover={id => discoverConnectionMutation.mutateAsync({
              id,
              name: editorConnection?.name ?? connectionPreset?.name ?? 'Connection',
            })}
            onTrust={id => trustMutation.mutateAsync({ id: String(id), action: 'trust' })}
            onDelete={typeof connectionEditorTarget === 'number'
              ? () => deleteConnectionMutation.mutate(connectionEditorTarget)
              : null}
          />
        )}
    </>
  );
}
