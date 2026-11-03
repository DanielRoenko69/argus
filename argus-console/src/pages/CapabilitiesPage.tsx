import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Activity,
  ArrowDownAZ,
  ArrowRight,
  Boxes,
  Braces,
  Database,
  FileJson,
  Fingerprint,
  Link2,
  LockKeyhole,
  Pencil,
  Plus,
  Play,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import {
  deleteCapability,
  getCapabilityStudio,
  getOpenApiCapabilitySources,
  getOpenApiSourceRetirement,
  checkOpenApiCapabilitySource,
  importOpenApiCapabilities,
  previewOpenApiImport,
  retireOpenApiSource,
  runCapabilityPlayground,
  saveCapability,
  setCapabilityState,
} from '../api';
import {
  DEFAULT_CAPABILITY_STUDIO_FILTERS,
  filterCapabilityStudioTools,
  getCapabilityStudioStats,
  type CapabilityStudioFilters,
  type CapabilityStudioView,
} from '../capabilityStudio';
import { CapabilityEditor } from '../components/CapabilityEditor';
import { CapabilityPlayground, supportsCapabilityPlayground } from '../components/CapabilityPlayground';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { IntegrationWorkspaceTabs } from '../features/integrations/IntegrationWorkspaceTabs';
import { countOpenApiSourceHealth, OPEN_API_SOURCE_STATUS_META } from '../openApiSourceHealth';
import type { CapabilityMutation, CapabilityPlaygroundMutation, CapabilityStudioItem, OpenApiImportSource } from '../types';

const OpenApiImportWizard = lazy(() => import('../components/OpenApiImportWizard')
  .then(module => ({ default: module.OpenApiImportWizard })));
const OpenApiSourcePanel = lazy(() => import('../components/OpenApiSourcePanel')
  .then(module => ({ default: module.OpenApiSourcePanel })));

function LazyDialogFallback({ label }: { label: string }) {
  return <div className="editor-layer" role="status"><div className="lazy-dialog-loading"><Activity className="spin" size={20} /><span>{label}</span></div></div>;
}

const viewLabels: Array<[CapabilityStudioView, string]> = [
  ['all', 'All'],
  ['managed', 'Managed'],
  ['remote', 'Remote MCP'],
  ['disabled', 'Disabled'],
];

function sourceIcon(capability: CapabilityStudioItem) {
  if (capability.managedBy === 'openapi') return <FileJson size={16} />;
  if (capability.source === 'remote') return <Fingerprint size={16} />;
  if (capability.backend === 'postgresql') return <Database size={16} />;
  if (capability.backend === 'http') return <Link2 size={16} />;
  return <Braces size={16} />;
}

function sourcePresentation(capability: CapabilityStudioItem) {
  return capability.managedBy === 'openapi'
    ? { className: 'openapi', label: 'OpenAPI managed' }
    : { className: capability.source, label: capability.source };
}

export function CapabilitiesPage() {
  const [filters, setFilters] = useState<CapabilityStudioFilters>(DEFAULT_CAPABILITY_STUDIO_FILTERS);
  const [editorTarget, setEditorTarget] = useState<'new' | number | null>(null);
  const [playgroundTarget, setPlaygroundTarget] = useState<number | null>(null);
  const [openApiImporterOpen, setOpenApiImporterOpen] = useState(false);
  const [openApiInitialSource, setOpenApiInitialSource] = useState<OpenApiImportSource | undefined>();
  const [sourcePanelOpen, setSourcePanelOpen] = useState(false);
  const [sourcePanelTarget, setSourcePanelTarget] = useState<number | null>(null);
  const [notice, setNotice] = useState('');
  const queryClient = useQueryClient();
  useEffect(() => {
    const sourceId = new URL(window.location.href).searchParams.get('source');
    if (!sourceId || !/^[1-9]\d*$/.test(sourceId)) return;
    const parsed = Number(sourceId);
    if (!Number.isSafeInteger(parsed)) return;
    setSourcePanelTarget(parsed);
    setSourcePanelOpen(true);
  }, []);
  const clearSourceDeepLink = () => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('source')) return;
    url.searchParams.delete('source');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
  };
  const query = useQuery({
    queryKey: ['mcp-fabric', 'capabilities'],
    queryFn: getCapabilityStudio,
    staleTime: 10_000,
  });
  const sourceQuery = useQuery({
    queryKey: ['mcp-fabric', 'capability-sources'],
    queryFn: getOpenApiCapabilitySources,
    staleTime: 30_000,
    retry: 1,
  });
  const invalidateRegistry = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'capabilities'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'manage'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-fabric'] }),
      queryClient.invalidateQueries({ queryKey: ['access-policies'] }),
      queryClient.invalidateQueries({ queryKey: ['mcp-fabric', 'capability-sources'] }),
    ]);
  };
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: CapabilityMutation; id?: number }) => saveCapability(input, id),
    onSuccess: async (result, variables) => {
      setEditorTarget(null);
      setNotice(result.warning || (variables.id == null
        ? `Capability “${result.capability.name}” created and added to the runtime catalog.`
        : `Capability “${result.capability.name}” updated.`));
      await invalidateRegistry();
    },
  });
  const stateMutation = useMutation({
    mutationFn: ({ id, enabled, name }: { id: number; enabled: boolean; name: string }) =>
      setCapabilityState(id, enabled).then(result => ({ ...result, name })),
    onSuccess: async result => {
      setNotice(`${result.name} ${result.enabled ? 'enabled' : 'disabled'}.`);
      await invalidateRegistry();
    },
  });
  const playgroundMutation = useMutation({
    mutationFn: ({ id, input }: { id: number; input: CapabilityPlaygroundMutation }) =>
      runCapabilityPlayground(id, input),
  });
  const deleteMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      deleteCapability(id, name).then(result => ({ ...result, name })),
    onSuccess: async result => {
      setEditorTarget(null);
      setNotice(`Capability “${result.name}” deleted. Its final definition remains in the admin audit trail.`);
      await invalidateRegistry();
    },
  });

  const allCapabilities = query.data?.capabilities ?? [];
  const sourceHealthByBackend = useMemo(() => new Map(
    (sourceQuery.data?.sources ?? []).map(source => [source.backendId, source.status]),
  ), [sourceQuery.data?.sources]);
  const sourceByBackend = useMemo(() => new Map(
    (sourceQuery.data?.sources ?? []).map(source => [source.backendId, source]),
  ), [sourceQuery.data?.sources]);
  const sourceHealthCounts = useMemo(
    () => countOpenApiSourceHealth(sourceQuery.data?.sources ?? []),
    [sourceQuery.data?.sources],
  );
  const capabilities = useMemo(
    () => filterCapabilityStudioTools(allCapabilities, filters, sourceHealthByBackend),
    [allCapabilities, filters, sourceHealthByBackend],
  );
  const stats = useMemo(() => getCapabilityStudioStats(allCapabilities), [allCapabilities]);
  const bundleById = useMemo(
    () => new Map((query.data?.bundles ?? []).map(bundle => [bundle.id, bundle])),
    [query.data?.bundles],
  );
  const sourceOptions = useMemo(() => {
    const ids = new Set(allCapabilities
      .map(capability => capability.backendId)
      .filter((backendId): backendId is number => backendId != null));
    return (query.data?.backends ?? []).filter(backend => ids.has(backend.id));
  }, [allCapabilities, query.data?.backends]);
  const editorCapability = typeof editorTarget === 'number'
    ? allCapabilities.find(capability => capability.managedId === editorTarget) ?? null
    : null;
  const playgroundCapability = playgroundTarget == null
    ? null
    : allCapabilities.find(capability => capability.managedId === playgroundTarget) ?? null;
  const mutationError = saveMutation.error?.message ?? deleteMutation.error?.message ?? null;

  if (query.isLoading) return <LoadingState label="Loading governed capability registry…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const patchFilters = (patch: Partial<CapabilityStudioFilters>) => setFilters(current => ({ ...current, ...patch }));

  return (
    <>
      <PageHeader
        eyebrow="OPERATE · INTEGRATIONS"
        title="Capabilities"
        description="Create, govern and inspect every tool that agents and workflows can discover through Argus."
        actions={(
          <>
            <button type="button" className="button button-secondary capability-health-trigger" onClick={() => { setNotice(''); setSourcePanelTarget(null); setSourcePanelOpen(true); }}><Activity size={15} />Source health{sourceHealthCounts.attention > 0 && <em>{sourceHealthCounts.attention}</em>}</button>
            <button type="button" className="button button-secondary" onClick={() => { setNotice(''); setOpenApiInitialSource(undefined); setOpenApiImporterOpen(true); }}><FileJson size={15} />Import OpenAPI</button>
            <button
              type="button"
              className="button button-primary"
              onClick={() => {
                setNotice('');
                saveMutation.reset();
                deleteMutation.reset();
                setEditorTarget('new');
              }}
            ><Plus size={15} />New capability</button>
          </>
        )}
      />

      <IntegrationWorkspaceTabs active="capabilities" />

      {notice && (
        <div className="fabric-notice" role="status">
          <ShieldCheck size={16} /><span>{notice}</span>
          <button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button>
        </div>
      )}
      {stateMutation.error && (
        <div className="scope-notice" role="alert"><AlertTriangle size={15} /><span><b>Status update failed.</b> {stateMutation.error.message}</span></div>
      )}

      <section className="metric-grid capability-studio-metrics" aria-label="Capability registry summary">
        <article className="metric-card">
          <span className="metric-icon violet"><Wrench size={17} /></span>
          <div><span>Capabilities</span><strong>{stats.total}</strong><small>{stats.managed} managed · {stats.remote} remote</small></div>
        </article>
        <article className="metric-card">
          <span className="metric-icon teal"><ShieldCheck size={17} /></span>
          <div><span>Runtime active</span><strong>{stats.enabled}</strong><small>{stats.disabled} disabled definitions</small></div>
        </article>
        <article className="metric-card">
          <span className={`metric-icon ${stats.writeFlagged > 0 ? 'amber' : 'teal'}`}><LockKeyhole size={17} /></span>
          <div><span>Write flagged</span><strong>{stats.writeFlagged}</strong><small>eligible for stronger oversight</small></div>
        </article>
        <article className="metric-card">
          <span className={`metric-icon ${stats.unassigned > 0 ? 'amber' : 'blue'}`}><Boxes size={17} /></span>
          <div><span>Without boundary</span><strong>{stats.unassigned}</strong><small>{stats.assigned} governed by bundles</small></div>
        </article>
      </section>

      <div className="build-toolbar capability-studio-toolbar">
        <div className="segmented-filter" aria-label="Filter capability registry">
          {viewLabels.map(([value, label]) => (
            <button type="button" className={filters.view === value ? 'is-active' : ''} onClick={() => patchFilters({ view: value })} key={value}>{label}</button>
          ))}
        </div>
        <label className="search-field">
          <Search size={15} />
          <input value={filters.search} onChange={event => patchFilters({ search: event.target.value })} placeholder="Search capabilities, sources and categories" />
        </label>
        <select
          className="capability-toolbar-select"
          aria-label="Capability source"
          value={String(filters.source)}
          onChange={event => patchFilters({
            source: event.target.value === 'all' || event.target.value === 'direct'
              ? event.target.value
              : Number(event.target.value),
          })}
        >
          <option value="all">All sources</option>
          <option value="direct">Direct / internal</option>
          {sourceOptions.map(backend => <option value={backend.id} key={backend.id}>{backend.name}</option>)}
        </select>
        <select className="capability-toolbar-select" aria-label="OpenAPI source health" value={filters.health} onChange={event => patchFilters({ health: event.target.value as CapabilityStudioFilters['health'] })}>
          <option value="all">All source health</option>
          <option value="drifted">Drift detected</option>
          <option value="error">Unavailable</option>
          <option value="unchecked">Unchecked</option>
          <option value="current">Current</option>
        </select>
        <select className="capability-toolbar-select" aria-label="Sort capabilities" value={filters.sort} onChange={event => patchFilters({ sort: event.target.value as CapabilityStudioFilters['sort'] })}>
          <option value="name">Sort: name</option>
          <option value="source">Sort: source</option>
          <option value="assignments">Sort: boundaries</option>
          <option value="access">Sort: access type</option>
          <option value="status">Sort: status</option>
        </select>
        <button
          type="button"
          className="icon-button capability-sort-direction"
          aria-label={`Sort ${filters.direction === 'asc' ? 'descending' : 'ascending'}`}
          onClick={() => patchFilters({ direction: filters.direction === 'asc' ? 'desc' : 'asc' })}
        ><ArrowDownAZ size={16} className={filters.direction === 'desc' ? 'is-desc' : ''} /></button>
      </div>

      <section className="panel table-panel capability-studio-panel">
        <div className="capability-registry-heading">
          <span><b>{capabilities.length}</b> matching definitions</span>
          <span><Fingerprint size={13} />Remote MCP definitions are synchronized from their connection catalog and remain read-only here.</span>
        </div>
        {capabilities.length > 0 ? (
          <div className="data-table capability-studio-table">
            <div className="data-row data-head"><span>Capability</span><span>Source</span><span>Access & risk</span><span>Boundaries</span><span>Status</span></div>
            {capabilities.map(capability => {
              const pending = stateMutation.isPending && stateMutation.variables?.id === capability.managedId;
              const source = sourcePresentation(capability);
              const bundleLabels = capability.bundleIds
                .map(bundleId => bundleById.get(bundleId))
                .filter((bundle): bundle is NonNullable<typeof bundle> => Boolean(bundle));
              const openApiSource = capability.backendId == null ? null : sourceByBackend.get(capability.backendId) ?? null;
              return (
                <div className={`data-row capability-studio-row source-${capability.source}${capability.enabled ? '' : ' is-disabled'}`} key={capability.id}>
                  <div className="capability-registry-primary">
                    <span
                      className={`capability-source-icon source-${source.className}`}
                      aria-label={capability.managedBy === 'openapi' ? 'OpenAPI-managed source' : undefined}
                    >{sourceIcon(capability)}</span>
                    <span><code>{capability.name}</code><small>{capability.description || 'No model-facing description provided'}</small></span>
                  </div>
                  <div className="capability-registry-source">
                    <span className={`capability-origin origin-${source.className}`}>{source.label}</span>
                    <b>{capability.backendLabel}</b>
                    <small>{capability.category || 'Uncategorized'} · updated {timeAgo(capability.updatedAt)}</small>
                    {openApiSource && <span className={`capability-source-health-badge status-${openApiSource.status}`}>{OPEN_API_SOURCE_STATUS_META[openApiSource.status].label}</span>}
                  </div>
                  <div className="capability-access-stack">
                    <span className={capability.isWrite ? 'is-write' : 'is-read'}>{capability.isWrite ? 'Write flagged' : 'Read / other'}</span>
                    <em className={`risk-${capability.riskLevel}`}>{capability.riskLevel} risk</em>
                    {capability.requiredAuthMode && <small>{capability.requiredAuthMode}</small>}
                  </div>
                  <div className="capability-boundary-stack">
                    {bundleLabels.length > 0 ? bundleLabels.slice(0, 2).map(bundle => (
                      <span className="bundle-chip" key={bundle.id}>{bundle.icon || '◈'} {bundle.label}</span>
                    )) : <span className="bundle-chip is-unscoped">No bundle boundary</span>}
                    {bundleLabels.length > 2 && <small>+{bundleLabels.length - 2} more</small>}
                    {capability.workflowCount > 0 && <small>{capability.workflowCount} workflow reference{capability.workflowCount === 1 ? '' : 's'}</small>}
                  </div>
                  <div className="capability-registry-actions">
                    {capability.managedId != null && capability.source === 'managed' ? (
                      <button
                        type="button"
                        className={`capability-state-toggle${capability.enabled ? ' is-enabled' : ''}`}
                        disabled={pending}
                        aria-label={`${capability.enabled ? 'Disable' : 'Enable'} ${capability.name}`}
                        onClick={() => {
                          if (capability.enabled && capability.workflowCount > 0
                            && !window.confirm(`Disable ${capability.name}? ${capability.workflowCount} workflow references may fail.`)) return;
                          setNotice('');
                          stateMutation.reset();
                          stateMutation.mutate({ id: capability.managedId!, enabled: !capability.enabled, name: capability.name });
                        }}
                      ><i /><span>{pending ? 'Saving…' : capability.enabled ? 'Enabled' : 'Disabled'}</span></button>
                    ) : (
                      <span className={`capability-synced-state${capability.enabled ? '' : ' is-offline'}`}><i />{capability.source === 'remote' ? 'Synced' : 'Platform'}</span>
                    )}
                    {supportsCapabilityPlayground(capability) && (
                      <button
                        type="button"
                        className="capability-edit-action capability-playground-action"
                        onClick={() => {
                          setNotice('');
                          playgroundMutation.reset();
                          stateMutation.reset();
                          setPlaygroundTarget(capability.managedId!);
                        }}
                      ><Play size={12} />Playground</button>
                    )}
                    {capability.managedBy === 'openapi' ? (
                      <button
                        type="button"
                        className="capability-edit-action capability-manage-source-action"
                        aria-label={`Manage OpenAPI source for ${capability.name}`}
                        onClick={() => {
                          setNotice('');
                          setSourcePanelTarget(openApiSource?.id ?? null);
                          setSourcePanelOpen(true);
                        }}
                      ><LockKeyhole size={11} />Manage source</button>
                    ) : capability.editable && capability.managedId != null ? (
                      <button
                        type="button"
                        className="capability-edit-action"
                        onClick={() => {
                          setNotice('');
                          saveMutation.reset();
                          deleteMutation.reset();
                          setEditorTarget(capability.managedId);
                        }}
                      ><Pencil size={12} />Edit</button>
                    ) : capability.source === 'remote' ? (
                      <a className="capability-edit-action" href="/mcp-fabric#connections">Connection <ArrowRight size={12} /></a>
                    ) : <span className="capability-locked-action"><LockKeyhole size={11} />Read only</span>}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="No matching capabilities" description="Change the registry filters or create the first managed capability." />
        )}
      </section>

      <section className="capability-studio-principles" aria-label="Capability lifecycle model">
        <article><span><SlidersHorizontal size={15} /></span><div><small>IMPLEMENTATION</small><b>Server-validated definitions</b><p>Methods, templates, parameters and egress targets are validated again by the Argus backend.</p></div></article>
        <article><span><ShieldCheck size={15} /></span><div><small>AUTHORIZATION</small><b>Additive bundle boundaries</b><p>Connected-system policies and direct assignments update atomically with the capability.</p></div></article>
        <article><span><Fingerprint size={15} /></span><div><small>LIFECYCLE</small><b>Audited runtime refresh</b><p>Every mutation writes an admin audit snapshot and refreshes the active dynamic-tool catalog.</p></div></article>
      </section>

      {editorTarget !== null && (editorTarget === 'new' || editorCapability) && (
        <CapabilityEditor
          key={editorTarget}
          capability={editorCapability}
          bundles={query.data.bundles}
          backends={query.data.backends}
          saving={saveMutation.isPending}
          deleting={deleteMutation.isPending}
          error={mutationError}
          onClose={() => {
            setEditorTarget(null);
            saveMutation.reset();
            deleteMutation.reset();
          }}
          onSave={input => saveMutation.mutate({
            input,
            ...(editorCapability?.managedId != null ? { id: editorCapability.managedId } : {}),
          })}
          onDelete={editorCapability?.managedId != null
            ? () => deleteMutation.mutate({ id: editorCapability.managedId!, name: editorCapability.name })
            : null}
        />
      )}
      {openApiImporterOpen && (
        <Suspense fallback={<LazyDialogFallback label="Loading OpenAPI importer…" />}>
          <OpenApiImportWizard
            bundles={query.data.bundles}
            initialSource={openApiInitialSource}
            onPreview={previewOpenApiImport}
            onImport={importOpenApiCapabilities}
            onComplete={async (result, previewResult) => {
              setNotice(`${previewResult.title}: ${result.created.read} read and ${result.created.write} write capabilities imported${result.warnings.length > 0 ? ' with runtime refresh warnings' : ''}.`);
              await invalidateRegistry();
            }}
            onClose={() => { setOpenApiImporterOpen(false); setOpenApiInitialSource(undefined); }}
          />
        </Suspense>
      )}
      {sourcePanelOpen && (
        <Suspense fallback={<LazyDialogFallback label="Loading source health…" />}>
          <OpenApiSourcePanel
            sources={sourceQuery.data?.sources ?? []}
            loading={sourceQuery.isLoading || sourceQuery.isFetching}
            error={sourceQuery.error?.message ?? null}
            initialSourceId={sourcePanelTarget ?? undefined}
            onCheck={checkOpenApiCapabilitySource}
            onRefresh={async () => { await sourceQuery.refetch(); }}
            onPreviewRetirement={getOpenApiSourceRetirement}
            onRetire={retireOpenApiSource}
            onRetired={async result => {
              setSourcePanelOpen(false);
              setSourcePanelTarget(null);
              clearSourceDeepLink();
              const preserved = [
                result.preservedBundleIds.length > 0
                  ? `${result.preservedBundleIds.length} bundle${result.preservedBundleIds.length === 1 ? '' : 's'}`
                  : '',
                result.preservedWorkflowIds.length > 0
                  ? `${result.preservedWorkflowIds.length} workflow${result.preservedWorkflowIds.length === 1 ? '' : 's'}`
                  : '',
              ].filter(Boolean).join(' and ');
              setNotice(`Source “${result.prefix}” retired. ${result.deletedCapabilityCount} imported capabilit${result.deletedCapabilityCount === 1 ? 'y' : 'ies'} removed${preserved ? `; ${preserved} preserved for review` : ''}${result.warnings.length > 0 ? ' · runtime refresh warning' : ''}.`);
              await invalidateRegistry();
            }}
            onReimport={source => {
              setSourcePanelOpen(false);
              setSourcePanelTarget(null);
              clearSourceDeepLink();
              setOpenApiInitialSource(source);
              setOpenApiImporterOpen(true);
            }}
            onClose={() => { setSourcePanelOpen(false); setSourcePanelTarget(null); clearSourceDeepLink(); }}
          />
        </Suspense>
      )}
      {playgroundCapability && playgroundCapability.managedId != null && (
        <CapabilityPlayground
          capability={playgroundCapability}
          running={playgroundMutation.isPending}
          activating={stateMutation.isPending && stateMutation.variables?.id === playgroundCapability.managedId}
          error={playgroundMutation.error?.message
            ?? (stateMutation.error && stateMutation.variables?.id === playgroundCapability.managedId
              ? stateMutation.error.message
              : null)}
          onRun={input => {
            playgroundMutation.reset();
            return playgroundMutation.mutateAsync({ id: playgroundCapability.managedId!, input });
          }}
          onActivate={() => {
            stateMutation.reset();
            return stateMutation.mutateAsync({
              id: playgroundCapability.managedId!,
              enabled: true,
              name: playgroundCapability.name,
            }).then(() => undefined);
          }}
          onClose={() => {
            if (playgroundMutation.isPending || stateMutation.isPending) return;
            setPlaygroundTarget(null);
            playgroundMutation.reset();
          }}
        />
      )}
    </>
  );
}
