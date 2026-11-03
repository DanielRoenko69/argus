import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Boxes,
  Check,
  GitBranch,
  KeyRound,
  LockKeyhole,
  Network,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  Users,
  Workflow,
  Wrench,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  assignFabricTools,
  deleteFabricBundle,
  changeFabricBundleTools,
  getFabricBundle,
  getFabricManagement,
  saveFabricBundle,
  updateFabricBundleAccess,
} from '../api';
import { BundleEditor } from '../components/BundleEditor';
import { CapabilityDrawer } from '../components/CapabilityDrawer';
import { EmptyState, ErrorState, HealthBadge, LoadingState, PageHeader } from '../components/Ui';
import type { AccessPrincipalKind, BundleAccessPrincipal, FabricBundleMutation, FabricBundleToolChangeInput } from '../types';

type BundleWorkspaceTab = 'overview' | 'inventory' | 'members' | 'policies';

const principalIcons = {
  user: Users,
  api_key: KeyRound,
  agent: Bot,
  workflow: Workflow,
  group: Users,
  policy: ShieldCheck,
} satisfies Record<AccessPrincipalKind, typeof Users>;

const sourceLabels = {
  direct: 'Direct',
  unrestricted: 'All bundles',
  composite: 'Composite',
  group: 'Group policy',
};

function PrincipalCard({ principal }: { principal: BundleAccessPrincipal }) {
  const Icon = principalIcons[principal.kind];
  const content = (
    <>
      <span className={`principal-icon kind-${principal.kind}`}><Icon size={15} /></span>
      <span className="principal-copy">
        <b>{principal.label}</b>
        <small>{principal.secondary}</small>
      </span>
      <span className={`access-source source-${principal.source}`}>{sourceLabels[principal.source]}</span>
      {principal.kind === 'workflow' && <ArrowRight className="principal-link-arrow" size={13} />}
    </>
  );
  return principal.kind === 'workflow'
    ? <a className="principal-card is-link" href={`/build/workflows/studio/${principal.id}`}>{content}</a>
    : <article className="principal-card">{content}</article>;
}

export function BundleDetailPage() {
  const { bundleId } = useParams();
  const parsedId = Number(bundleId);
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<BundleWorkspaceTab>('overview');
  const [editorOpen, setEditorOpen] = useState(false);
  const [capabilityDrawerOpen, setCapabilityDrawerOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedToolIds, setSelectedToolIds] = useState<string[]>([]);
  const [toolAction, setToolAction] = useState<'move' | 'remove'>('move');
  const [targetBundleId, setTargetBundleId] = useState(0);
  const [accessSearch, setAccessSearch] = useState('');
  const [accessFilter, setAccessFilter] = useState<'all' | 'identity' | 'automation' | 'inherited'>('all');
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['mcp-fabric', 'bundle', parsedId],
    queryFn: () => getFabricBundle(parsedId),
    enabled: Number.isInteger(parsedId) && parsedId > 0,
  });
  const managementQuery = useQuery({
    queryKey: ['mcp-fabric', 'manage'],
    queryFn: getFabricManagement,
    enabled: query.data?.permissions.canManage === true,
    staleTime: 15_000,
  });
  const accessMutation = useMutation({
    mutationFn: (input: { kind: 'user' | 'api_key' | 'agent' | 'workflow'; id: number; granted: boolean }) =>
      updateFabricBundleAccess(parsedId, input),
    onSuccess: async result => {
      setNotice(result.granted ? 'Bundle access granted.' : 'Bundle access revoked.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'bundle', parsedId] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
    },
  });
  const saveMutation = useMutation({
    mutationFn: (input: FabricBundleMutation) => saveFabricBundle(input, parsedId),
    onSuccess: async result => {
      setEditorOpen(false);
      setNotice(`Bundle “${result.bundle.label}” updated.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'bundle', parsedId] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'manage'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteFabricBundle(parsedId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
      navigate('/mcp-fabric');
    },
  });
  const toolMutation = useMutation({
    mutationFn: (input: FabricBundleToolChangeInput) => changeFabricBundleTools(parsedId, input),
    onSuccess: async result => {
      const target = managementQuery.data?.bundles.find(bundle => bundle.id === result.targetBundleId);
      setNotice(result.action === 'move'
        ? `${result.changed} tool${result.changed === 1 ? '' : 's'} moved to “${target?.label ?? 'target bundle'}”.`
        : `${result.changed} tool${result.changed === 1 ? '' : 's'} removed from this bundle.`);
      setSelectedToolIds([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'bundle'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'manage'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
    },
  });
  const addCapabilitiesMutation = useMutation({
    mutationFn: assignFabricTools,
    onSuccess: async result => {
      setCapabilityDrawerOpen(false);
      setNotice(`${result.assigned} capabilit${result.assigned === 1 ? 'y' : 'ies'} added to this bundle.`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'bundle', parsedId] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'manage'] }),
        queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
        queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      ]);
    },
    onError: async () => {
      await queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'manage'] });
    },
  });

  const otherBundles = useMemo(
    () => (managementQuery.data?.bundles ?? []).filter(bundle => bundle.id !== parsedId),
    [managementQuery.data, parsedId],
  );
  useEffect(() => {
    if (otherBundles.some(bundle => bundle.id === targetBundleId)) return;
    setTargetBundleId(otherBundles[0]?.id ?? 0);
    if (otherBundles.length === 0) setToolAction('remove');
  }, [otherBundles, targetBundleId]);

  const principalGroups = useMemo(() => {
    const principals = query.data?.access.principals ?? [];
    return {
      identities: principals.filter(item => ['user', 'api_key', 'agent', 'group'].includes(item.kind)),
      automation: principals.filter(item => item.kind === 'workflow'),
      policies: principals.filter(item => item.kind === 'policy'),
    };
  }, [query.data]);
  const accessCandidates = useMemo(() => {
    const normalized = accessSearch.trim().toLowerCase();
    return (query.data?.access.candidates ?? []).filter(candidate => {
      if (accessFilter === 'identity' && !['user', 'api_key', 'agent'].includes(candidate.kind)) return false;
      if (accessFilter === 'automation' && candidate.kind !== 'workflow') return false;
      if (accessFilter === 'inherited' && !['inherited', 'unrestricted'].includes(candidate.access)) return false;
      return !normalized
        || `${candidate.label} ${candidate.secondary} ${candidate.kind} ${candidate.reason}`.toLowerCase().includes(normalized);
    });
  }, [accessFilter, accessSearch, query.data]);
  const openCapabilityCatalog = () => {
    setNotice('');
    addCapabilitiesMutation.reset();
    setCapabilityDrawerOpen(true);
  };

  if (!Number.isInteger(parsedId) || parsedId < 1) {
    return <ErrorState error={new Error('Invalid bundle identifier')} />;
  }
  if (query.isLoading) return <LoadingState label="Resolving bundle access…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const { access, bundle, connections, permissions, stats, tools } = query.data;
  const restrictedConnections = connections.filter(connection => connection.toolAccessMode === 'selected');
  const editorBundle = managementQuery.data?.bundles.find(item => item.id === parsedId) ?? null;
  const selectedTools = tools.filter(tool => selectedToolIds.includes(tool.id));
  const targetBundle = otherBundles.find(item => item.id === targetBundleId) ?? null;
  const effectiveMembers = access.candidates.filter(candidate => candidate.access !== 'none').length;
  const workspaceTabs: Array<{
    id: BundleWorkspaceTab;
    label: string;
    count?: number;
    icon: typeof Boxes;
  }> = [
    { id: 'overview', label: 'Overview', icon: Boxes },
    { id: 'inventory', label: 'Connections & tools', count: stats.connections + stats.tools, icon: Network },
    { id: 'members', label: 'Members', count: access.redacted ? undefined : effectiveMembers, icon: Users },
    { id: 'policies', label: 'Policies', count: access.redacted ? undefined : principalGroups.policies.length + restrictedConnections.length, icon: ShieldCheck },
  ];

  return (
    <>
      <a className="back-link" href="/mcp-fabric"><ArrowLeft size={14} />Back to MCP Fabric</a>
      <PageHeader
        eyebrow="ACCESS BUNDLE"
        title={bundle.label}
        description={bundle.description || 'Reusable authorization boundary for MCP connections and capabilities.'}
        actions={permissions.canManage
          ? (
            <button
              type="button"
              className="button button-secondary"
              disabled={managementQuery.isLoading}
              onClick={() => {
                setNotice('');
                saveMutation.reset();
                deleteMutation.reset();
                setEditorOpen(true);
              }}
            >
              <SlidersHorizontal size={15} />
              {managementQuery.isLoading ? 'Loading configuration…' : 'Configure bundle'}
            </button>
          )
          : undefined}
      />

      {notice && (
        <div className="bundle-workspace-notice" role="status">
          <ShieldCheck size={14} />
          <span>{notice}</span>
          <button type="button" aria-label="Dismiss notice" onClick={() => setNotice('')}>×</button>
        </div>
      )}
      {managementQuery.error && (
        <div className="bundle-workspace-error" role="alert">
          Bundle configuration is temporarily unavailable: {managementQuery.error.message}
        </div>
      )}

      <section className="bundle-identity-strip">
        <span className="bundle-detail-icon" aria-hidden="true">{bundle.icon || '◈'}</span>
        <div>
          <small>Stable endpoint</small>
          <code>{bundle.endpoint}</code>
        </div>
        <div>
          <small>Internal name</small>
          <code>{bundle.name}</code>
        </div>
        {bundle.agentRole && <div><small>Agent role</small><strong>{bundle.agentRole}</strong></div>}
      </section>

      <nav className="bundle-workspace-tabs" role="tablist" aria-label="Bundle workspace">
        {workspaceTabs.map(item => {
          const Icon = item.icon;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === item.id}
              className={activeTab === item.id ? 'is-active' : ''}
              onClick={() => {
                setActiveTab(item.id);
                accessMutation.reset();
              }}
              key={item.id}
            >
              <Icon size={15} />
              <span>{item.label}</span>
              {item.count != null && <em>{item.count}</em>}
            </button>
          );
        })}
      </nav>

      {activeTab === 'overview' && <section className="metric-grid fabric-metrics" aria-label="Bundle summary">
        <article className="metric-card">
          <span className="metric-icon teal"><Network size={17} /></span>
          <div><span>Connections</span><strong>{stats.connections}</strong><small>systems in boundary</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon blue"><Wrench size={17} /></span>
          <div><span>Capabilities</span><strong>{stats.tools}</strong><small>direct and inherited</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon violet"><Users size={17} /></span>
          <div><span>Identities</span><strong>{access.redacted ? '—' : stats.identities}</strong><small>access paths</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon amber"><GitBranch size={17} /></span>
          <div><span>Workflows</span><strong>{access.redacted ? '—' : stats.workflows}</strong><small>bundle bindings</small></div>
        </article>
      </section>}

      {(activeTab === 'overview' || activeTab === 'members') && <section className="panel access-graph-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">{activeTab === 'overview' ? 'EFFECTIVE ACCESS' : 'MEMBER ACCESS'}</span>
            <h2>{activeTab === 'overview' ? 'Who can reach what' : 'Who can enter this bundle'}</h2>
            <p className="panel-description">
              {activeTab === 'overview'
                ? 'Assignment paths flow through this bundle to its connections and tools.'
                : 'Manage direct user, API-key, agent and workflow assignments from one place.'}
            </p>
          </div>
          <div className="panel-heading-actions">
            {activeTab === 'overview' && <span className="policy-indicator"><ShieldCheck size={15} />Explainable policy</span>}
            {permissions.canManage && activeTab === 'overview' && (
              <button type="button" onClick={() => setActiveTab('members')}>
                <Settings2 size={14} />Manage members
              </button>
            )}
          </div>
        </div>

        {activeTab === 'overview' && <div className="access-graph">
          <div className="access-column">
            <span className="graph-label">IDENTITIES & AUTOMATION</span>
            {access.redacted ? (
              <div className="access-redacted">
                <KeyRound size={18} />
                <b>Access identities are protected</b>
                <span>Platform admins can inspect users, keys, agents and workflow bindings.</span>
              </div>
            ) : principalGroups.identities.length + principalGroups.automation.length > 0 ? (
              <div className="principal-list">
                {[...principalGroups.identities, ...principalGroups.automation].map(principal =>
                  <PrincipalCard principal={principal} key={`${principal.kind}-${principal.id}`} />,
                )}
              </div>
            ) : (
              <EmptyState title="No identity paths" description="No users, keys, agents or workflows currently reference this bundle." />
            )}
          </div>

          <div className="graph-flow" aria-hidden="true"><span /><ArrowRight size={17} /></div>

          <article className="bundle-core-card">
            <span className="bundle-core-icon">{bundle.icon || <Boxes size={22} />}</span>
            <small>ACCESS BOUNDARY</small>
            <h3>{bundle.label}</h3>
            <code>{bundle.name}</code>
            {!access.redacted && principalGroups.policies.length > 0 && (
              <div className="bundle-policy-list">
                {principalGroups.policies.map(policy => (
                  <a href="/governance/policies" title={policy.secondary} key={policy.id}>
                    <ShieldCheck size={12} />{policy.label}
                  </a>
                ))}
              </div>
            )}
          </article>

          <div className="graph-flow" aria-hidden="true"><span /><ArrowRight size={17} /></div>

          <div className="access-column">
            <span className="graph-label">CONNECTION POLICY → TOOLS</span>
            <div className="capability-summary">
              <article><Network size={17} /><span><b>{connections.length}</b> connected systems</span></article>
              <article><Wrench size={17} /><span><b>{tools.length}</b> effective tools</span></article>
              <article>
                <LockKeyhole size={17} />
                <span>
                  <b>{restrictedConnections.length}</b>
                  selected-tool {restrictedConnections.length === 1 ? 'policy' : 'policies'}
                </span>
              </article>
            </div>
            {connections.length > 0 && (
              <div className="capability-route-list">
                {connections.slice(0, 4).map(connection => (
                  <span key={connection.id}>
                    <b>{connection.name}</b>
                    <em className={connection.toolAccessMode === 'selected' ? 'is-selected' : ''}>
                      {connection.toolAccessMode === 'selected'
                        ? `${connection.toolCount} selected`
                        : 'All tools'}
                    </em>
                  </span>
                ))}
                {connections.length > 4 && <small>+{connections.length - 4} more connections</small>}
              </div>
            )}
          </div>
        </div>}

        {activeTab === 'overview' && <div className="policy-note"><ShieldCheck size={15} /><span>{access.note}</span></div>}
        {activeTab === 'members' && permissions.canManage && (
          <div className="access-manager">
            <div className="access-manager-heading">
              <div>
                <span className="eyebrow">PRINCIPAL ASSIGNMENTS</span>
                <h3>Who can enter this bundle</h3>
                <p>Direct restricted grants are editable here. Global and inherited access remains controlled at its source.</p>
              </div>
              <strong>{effectiveMembers} effective paths</strong>
            </div>
            <div className="access-manager-toolbar">
              <div className="segmented-filter" aria-label="Filter access principals">
                {([
                  ['all', 'All'],
                  ['identity', 'Identities'],
                  ['automation', 'Workflows'],
                  ['inherited', 'Inherited'],
                ] as const).map(([value, label]) => (
                  <button
                    type="button"
                    className={accessFilter === value ? 'is-active' : ''}
                    onClick={() => setAccessFilter(value)}
                    key={value}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <label className="search-field">
                <Search size={15} />
                <input
                  value={accessSearch}
                  onChange={event => setAccessSearch(event.target.value)}
                  placeholder="Search users, agents, keys…"
                />
              </label>
            </div>
            {accessMutation.error && (
              <div className="access-manager-error" role="alert">{accessMutation.error.message}</div>
            )}
            <div className="access-candidate-list">
              {accessCandidates.map(candidate => {
                const Icon = principalIcons[candidate.kind];
                const manageable = candidate.editable
                  && ['user', 'api_key', 'agent', 'workflow'].includes(candidate.kind);
                const pending = accessMutation.isPending
                  && accessMutation.variables?.kind === candidate.kind
                  && accessMutation.variables.id === Number(candidate.id);
                return (
                  <article className={`access-candidate access-${candidate.access}`} key={`${candidate.kind}-${candidate.id}`}>
                    <span className={`principal-icon kind-${candidate.kind}`}><Icon size={15} /></span>
                    <span className="principal-copy">
                      <b>{candidate.label}</b>
                      <small>{candidate.secondary}{candidate.enabled ? '' : ' · disabled'}</small>
                    </span>
                    <span className="access-candidate-origin">
                      <em>{candidate.access === 'none' ? 'No access' : candidate.access}</em>
                      <small>{candidate.reason}</small>
                    </span>
                    {manageable ? (
                      <button
                        type="button"
                        className={candidate.access === 'direct' ? 'is-revoke' : 'is-grant'}
                        disabled={pending}
                        onClick={() => {
                          if (!['user', 'api_key', 'agent', 'workflow'].includes(candidate.kind)) return;
                          accessMutation.reset();
                          accessMutation.mutate({
                            kind: candidate.kind as 'user' | 'api_key' | 'agent' | 'workflow',
                            id: Number(candidate.id),
                            granted: candidate.access !== 'direct',
                          });
                        }}
                      >
                        {candidate.access === 'direct' ? <LockKeyhole size={12} /> : <ShieldCheck size={12} />}
                        {pending ? 'Saving…' : candidate.access === 'direct' ? 'Revoke' : 'Grant'}
                      </button>
                    ) : (
                      <span className="access-candidate-locked"><LockKeyhole size={11} />Source managed</span>
                    )}
                  </article>
                );
              })}
              {accessCandidates.length === 0 && (
                <EmptyState title="No matching principals" description="Change the access filter or search phrase." />
              )}
            </div>
            <div className="access-manager-note">
              <KeyRound size={14} />
              <span>Removing the final explicit Agent bundle is blocked because the legacy Agent model interprets an empty list as global access.</span>
            </div>
          </div>
        )}
        {activeTab === 'members' && !permissions.canManage && (
          <div className="access-redacted">
            <KeyRound size={18} />
            <b>Member assignments are protected</b>
            <span>Platform administrators can inspect and change direct bundle access.</span>
          </div>
        )}
      </section>}

      {activeTab === 'inventory' && <div className="bundle-detail-grid">
        <section className="panel">
          <div className="panel-heading">
            <div><span className="eyebrow">CONNECTIONS</span><h2>Systems in bundle</h2></div>
          </div>
          {connections.length > 0 ? (
            <div className="detail-list">
              {connections.map(connection => (
                <article className="detail-list-row" key={connection.id}>
                  <span className="detail-row-icon"><Network size={16} /></span>
                  <span className="detail-row-copy">
                    <b>{connection.name}</b>
                    <small>{connection.endpoint || connection.description || 'Internal connection'}</small>
                  </span>
                  <span className="detail-row-meta">
                    <HealthBadge state={connection.state} />
                    <small>{connection.toolCount} tools</small>
                    <em className={`connection-policy-badge mode-${connection.toolAccessMode}`}>
                      {connection.toolAccessMode === 'selected' ? 'Selected only' : 'All tools'}
                    </em>
                  </span>
                </article>
              ))}
            </div>
          ) : <EmptyState title="No connections" description="Assign an MCP server or backend to this bundle." />}
        </section>

        <section className="panel bundle-tool-manager">
          <div className="panel-heading">
            <div><span className="eyebrow">TOOL REGISTRY</span><h2>Effective capabilities</h2></div>
            {permissions.canManage && (
              <div className="bundle-tool-heading-actions">
                {tools.length > 0 && (
                  <div className="bundle-tool-selection-actions">
                    <span>{selectedTools.length} selected</span>
                    <button type="button" onClick={() => setSelectedToolIds(tools.map(tool => tool.id))}>Select all</button>
                    <button type="button" disabled={selectedTools.length === 0} onClick={() => setSelectedToolIds([])}>Clear</button>
                  </div>
                )}
                <button
                  type="button"
                  className="button button-secondary bundle-add-capabilities"
                  disabled={managementQuery.isLoading || !managementQuery.data}
                  onClick={openCapabilityCatalog}
                >
                  <Plus size={13} />
                  {managementQuery.isLoading ? 'Loading catalog…' : 'Add capabilities'}
                </button>
              </div>
            )}
          </div>
          {permissions.canManage && selectedTools.length > 0 && (
            <div className="bundle-tool-change-review">
              <div className="bundle-tool-change-heading">
                <span><GitBranch size={15} /></span>
                <div>
                  <small>CHANGE PREVIEW</small>
                  <b>Review capability boundary update</b>
                </div>
                <em>{selectedTools.length} tool{selectedTools.length === 1 ? '' : 's'}</em>
              </div>
              <div className="bundle-tool-change-controls">
                <div className="tool-action-switch" role="group" aria-label="Tool change action">
                  <button
                    type="button"
                    className={toolAction === 'move' ? 'is-active' : ''}
                    disabled={otherBundles.length === 0}
                    onClick={() => setToolAction('move')}
                  >
                    <ArrowRight size={13} />Move
                  </button>
                  <button
                    type="button"
                    className={toolAction === 'remove' ? 'is-active is-danger' : ''}
                    onClick={() => setToolAction('remove')}
                  >
                    <Trash2 size={13} />Remove
                  </button>
                </div>
                {toolAction === 'move' && (
                  <label>
                    <span>Target bundle</span>
                    <select value={targetBundleId} onChange={event => setTargetBundleId(Number(event.target.value))}>
                      {otherBundles.map(option => <option value={option.id} key={option.id}>{option.label}</option>)}
                    </select>
                  </label>
                )}
              </div>
              <div className="bundle-tool-diff">
                <span className="is-remove"><b>−</b><strong>{bundle.label}</strong><em>{selectedTools.length} capabilities</em></span>
                {toolAction === 'move' && targetBundle && (
                  <span className="is-add"><b>+</b><strong>{targetBundle.label}</strong><em>{selectedTools.length} capabilities</em></span>
                )}
              </div>
              <div className="bundle-tool-change-list">
                {selectedTools.slice(0, 6).map(tool => <code key={tool.id}>{tool.name}</code>)}
                {selectedTools.length > 6 && <small>+{selectedTools.length - 6} more</small>}
              </div>
              <div className="bundle-tool-change-footer">
                <span>
                  {toolAction === 'move'
                    ? 'Source and target update atomically. Existing connection assignments remain intact.'
                    : 'Final direct assignments are protected from becoming globally unscoped.'}
                </span>
                <button
                  type="button"
                  className={toolAction === 'remove' ? 'is-danger' : ''}
                  disabled={toolMutation.isPending || (toolAction === 'move' && targetBundleId < 1)}
                  onClick={() => toolMutation.mutate({
                    action: toolAction,
                    ...(toolAction === 'move' ? { targetBundleId } : {}),
                    tools: selectedTools.map(tool => ({ backendId: tool.backendId, name: tool.name })),
                  })}
                >
                  {toolMutation.isPending
                    ? 'Applying…'
                    : toolAction === 'move' ? 'Apply move' : 'Remove from bundle'}
                </button>
              </div>
              {toolMutation.error && <div className="access-manager-error" role="alert">{toolMutation.error.message}</div>}
            </div>
          )}
          {tools.length > 0 ? (
            <div className="detail-list">
              {tools.map(tool => (
                <article className={`detail-list-row tool-manage-row${selectedToolIds.includes(tool.id) ? ' is-selected' : ''}`} key={tool.id}>
                  {permissions.canManage ? (
                    <button
                      type="button"
                      className="tool-row-selector"
                      aria-label={`${selectedToolIds.includes(tool.id) ? 'Deselect' : 'Select'} ${tool.name}`}
                      aria-pressed={selectedToolIds.includes(tool.id)}
                      onClick={() => setSelectedToolIds(current => current.includes(tool.id)
                        ? current.filter(id => id !== tool.id)
                        : [...current, tool.id])}
                    >
                      {selectedToolIds.includes(tool.id) ? <Check size={14} /> : <Wrench size={15} />}
                    </button>
                  ) : <span className="detail-row-icon"><Wrench size={16} /></span>}
                  <span className="detail-row-copy">
                    <code>{tool.name}</code>
                    <small>{tool.server} · {tool.description || 'No description'}</small>
                  </span>
                  <span className={`membership-badge membership-${tool.membership}`}>
                    {tool.membership === 'direct_and_connection' ? 'Direct + server' : tool.membership}
                  </span>
                </article>
              ))}
            </div>
          ) : (
            <div className="bundle-capability-empty">
              <EmptyState title="No capabilities" description="Attach tools directly or expose them through a bundled connection." />
              {permissions.canManage && (
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={managementQuery.isLoading || !managementQuery.data}
                  onClick={openCapabilityCatalog}
                >
                  <Plus size={13} />Browse capability catalog
                </button>
              )}
            </div>
          )}
        </section>
      </div>}

      {activeTab === 'policies' && (
        <div className="bundle-policy-workspace">
          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">COMPOSITE POLICIES</span>
                <h2>Policy paths including this bundle</h2>
                <p className="panel-description">Composite policies can narrow the bundle with final allow and deny patterns.</p>
              </div>
              {permissions.canManage && (
                <a className="button button-secondary" href="/governance/policies?tab=composites">
                  Edit policies <ArrowRight size={14} />
                </a>
              )}
            </div>
            {access.redacted ? (
              <div className="access-redacted">
                <ShieldCheck size={18} />
                <b>Policy assignments are protected</b>
                <span>Platform administrators can inspect composite and group policy paths.</span>
              </div>
            ) : principalGroups.policies.length > 0 ? (
              <div className="bundle-policy-cards">
                {principalGroups.policies.map(policy => (
                  <a href="/governance/policies?tab=composites" key={policy.id}>
                    <span className="principal-icon kind-policy"><ShieldCheck size={15} /></span>
                    <span>
                      <b>{policy.label}</b>
                      <small>{policy.secondary}</small>
                    </span>
                    <ArrowRight size={14} />
                  </a>
                ))}
              </div>
            ) : (
              <EmptyState
                title="No composite policy path"
                description="This bundle is currently reached only through direct, unrestricted or workflow assignments."
              />
            )}
          </section>

          <section className="panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">CONNECTION POLICIES</span>
                <h2>Capability boundaries</h2>
                <p className="panel-description">Each connected backend either follows future discoveries or exposes an explicit allowlist.</p>
              </div>
              {permissions.canManage && (
                <button
                  type="button"
                  onClick={() => {
                    saveMutation.reset();
                    deleteMutation.reset();
                    setEditorOpen(true);
                  }}
                >
                  <SlidersHorizontal size={14} />Configure
                </button>
              )}
            </div>
            {connections.length > 0 ? (
              <div className="connection-policy-list">
                {connections.map(connection => (
                  <article key={connection.id}>
                    <span className="detail-row-icon"><Network size={15} /></span>
                    <span>
                      <b>{connection.name}</b>
                      <small>{connection.toolAccessMode === 'all'
                        ? 'Future discovered tools are included automatically.'
                        : `${connection.allowedToolCount} of ${connection.toolCount} tools are exposed.`}
                      </small>
                    </span>
                    <em className={`connection-policy-badge mode-${connection.toolAccessMode}`}>
                      {connection.toolAccessMode === 'all' ? 'All tools' : 'Selected only'}
                    </em>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="No connection policies" description="Attach a connection to establish a capability boundary." />
            )}
            <div className="policy-note"><ShieldCheck size={15} /><span>{access.note}</span></div>
          </section>
        </div>
      )}

      {editorOpen && managementQuery.data && editorBundle && (
        <BundleEditor
          key={`${editorBundle.id}-${editorBundle.updatedAt}`}
          bundle={editorBundle}
          backends={managementQuery.data.backends}
          skills={managementQuery.data.skills}
          tools={managementQuery.data.tools}
          saving={saveMutation.isPending}
          deleting={deleteMutation.isPending}
          error={saveMutation.error?.message ?? deleteMutation.error?.message ?? null}
          onClose={() => {
            setEditorOpen(false);
            saveMutation.reset();
            deleteMutation.reset();
          }}
          onSave={input => saveMutation.mutate(input)}
          onDelete={() => deleteMutation.mutate()}
        />
      )}
      {capabilityDrawerOpen && managementQuery.data && editorBundle && (
        <CapabilityDrawer
          data={managementQuery.data}
          bundleId={parsedId}
          bundleLabel={bundle.label}
          currentToolCount={tools.length}
          currentBackendIds={editorBundle.backendIds}
          saving={addCapabilitiesMutation.isPending}
          error={addCapabilitiesMutation.error?.message ?? null}
          onClose={() => {
            setCapabilityDrawerOpen(false);
            addCapabilitiesMutation.reset();
          }}
          onAssign={input => addCapabilitiesMutation.mutate(input)}
        />
      )}
    </>
  );
}
