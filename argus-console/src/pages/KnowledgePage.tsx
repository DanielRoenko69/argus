import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  BookOpen,
  Boxes,
  CheckCircle2,
  Cloud,
  Database,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Network,
  Plus,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
} from 'lucide-react';
import { deleteKnowledgeSource, getKnowledgeCatalog, getNativeCodeIndexes, saveKnowledgeSource } from '../api';
import { KnowledgeEditor } from '../components/KnowledgeEditor';
import { KnowledgePanel } from '../components/KnowledgePanel';
import { EmptyState, ErrorState, LoadingState, PageHeader, timeAgo } from '../components/Ui';
import { RepositoryGraphDialog } from '../features/repository-graph';
import { KnowledgeWorkspaceTabs } from '../features/knowledge/KnowledgeWorkspaceTabs';
import type { KnowledgeProviderDefinition, KnowledgeSource, KnowledgeSourceMutation } from '../types';
import type { NativeCodeIndexSnapshot } from '../types';

function providerLabel(provider: string, definitions: KnowledgeProviderDefinition[]): string {
  const definition = definitions.find(item => item.id === provider);
  return provider === 'pgvector' ? 'Built-in · pgvector' : definition?.label ?? provider;
}

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === 'pgvector') return <Database size={20} />;
  if (provider === 'qdrant' || provider === 'milvus') return <Server size={20} />;
  if (provider === 'azure_ai_search' || provider === 'pinecone') return <Cloud size={20} />;
  return <Network size={20} />;
}

export function KnowledgePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<KnowledgeSource | null | undefined>(undefined);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [graphSnapshot, setGraphSnapshot] = useState<NativeCodeIndexSnapshot | null>(null);
  const [notice, setNotice] = useState('');
  const activeView = new URLSearchParams(location.search).get('view') === 'repository' ? 'repository' : 'sources';
  const query = useQuery({ queryKey: ['knowledge-catalog'], queryFn: getKnowledgeCatalog, staleTime: 10_000 });
  const codeIndexesQuery = useQuery({
    queryKey: ['native-code-indexes'],
    queryFn: () => getNativeCodeIndexes(25),
    staleTime: 10_000,
  });
  const saveMutation = useMutation({
    mutationFn: ({ input, id }: { input: KnowledgeSourceMutation; id?: number }) => saveKnowledgeSource(input, id),
    onSuccess: async (saved, variables) => {
      setNotice(variables.id == null ? `Knowledge source “${saved.label}” created.` : `Knowledge source “${saved.label}” updated.`);
      setEditing(undefined);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['knowledge-catalog'] }), queryClient.invalidateQueries({ queryKey: ['agent-studio'] })]);
    },
  });
  const deleteMutation = useMutation({
    mutationFn: (source: KnowledgeSource) => deleteKnowledgeSource(source.id),
    onSuccess: async () => {
      setNotice('Knowledge source and its Argus-managed documents deleted.');
      setEditing(undefined);
      setDetailId(null);
      await Promise.all([queryClient.invalidateQueries({ queryKey: ['knowledge-catalog'] }), queryClient.invalidateQueries({ queryKey: ['agent-studio'] })]);
    },
  });

  useEffect(() => {
    if (new URLSearchParams(location.search).get('create') !== 'knowledge') return;
    saveMutation.reset();
    deleteMutation.reset();
    setEditing(null);
    const params = new URLSearchParams(location.search);
    params.delete('create');
    navigate({ pathname: location.pathname, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const sources = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return (query.data?.sources ?? []).filter(source => !normalized
      || `${source.label} ${source.name} ${source.description} ${source.provider} ${source.index_name}`.toLowerCase().includes(normalized));
  }, [query.data?.sources, search]);

  const codeIndexes = codeIndexesQuery.data ?? [];
  const visibleCodeIndexes = useMemo(() => {
    const normalized = search.trim().toLowerCase();
    return codeIndexes.filter(index => !normalized || [
      index.repositoryKey,
      index.branchName,
      index.commitSha,
      index.provider,
      index.parserVersion ?? '',
      index.graphSchemaVersion ?? '',
      Object.keys(index.languages).join(' '),
    ].join(' ').toLowerCase().includes(normalized));
  }, [codeIndexes, search]);

  if (query.isLoading) return <LoadingState label="Loading Argus Knowledge…" />;
  if (query.error) return <ErrorState error={query.error} />;
  if (!query.data) return null;

  const builtIn = query.data.sources.filter(source => source.provider === 'pgvector');
  const documentCount = builtIn.reduce((total, source) => total + source.documents.length, 0);
  const chunkCount = builtIn.reduce((total, source) => total + source.documents.reduce((sum, document) => sum + document.chunk_count, 0), 0);
  const enabledCount = query.data.sources.filter(source => source.enabled).length;
  const detailSource = detailId == null ? null : query.data.sources.find(source => source.id === detailId) ?? null;
  const showCodeIndexes = activeView === 'repository';

  return <>
    <PageHeader eyebrow="BUILD · KNOWLEDGE" title="Argus Knowledge" description="Ground agents in governed RAG sources using the built-in pgvector store or an existing retrieval provider." actions={activeView === 'sources' ? <button className="button button-primary" type="button" onClick={() => { saveMutation.reset(); setEditing(null); }}><Plus size={15} />Add RAG source</button> : undefined} />
    <KnowledgeWorkspaceTabs active={activeView === 'repository' ? 'repositories' : 'sources'} />

    {notice && <div className="connection-notice is-success" role="status"><CheckCircle2 size={16} /><span>{notice}</span><button type="button" aria-label="Dismiss notification" onClick={() => setNotice('')}><X size={14} /></button></div>}

    <section className="knowledge-default-banner"><span><Database size={20} /></span><div><small>DEFAULT ENGINE</small><b>Built-in PostgreSQL + pgvector</b><p>No separate vector database is required. External providers remain optional adapters behind the same Argus retrieval contract.</p></div><em><ShieldCheck size={13} />No vector-store lock-in</em></section>

    <section className="metric-grid build-metrics" aria-label="Knowledge summary">
      <article className="metric-card"><span className="metric-icon violet"><BookOpen size={17} /></span><div><span>RAG sources</span><strong>{query.data.sources.length}</strong><small>{enabledCount} enabled</small></div></article>
      <article className="metric-card"><span className="metric-icon blue"><FileText size={17} /></span><div><span>Managed documents</span><strong>{documentCount}</strong><small>inside built-in knowledge</small></div></article>
      <article className="metric-card"><span className="metric-icon teal"><Sparkles size={17} /></span><div><span>Indexed chunks</span><strong>{chunkCount}</strong><small>pgvector retrieval units</small></div></article>
      <article className="metric-card"><span className="metric-icon amber"><Network size={17} /></span><div><span>External adapters</span><strong>{query.data.sources.length - builtIn.length}</strong><small>{query.data.providers.filter(provider => provider.kind === 'external').length} provider types registered</small></div></article>
    </section>

    <div className="build-toolbar">
      <label className="search-field"><Search size={16} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder={activeView === 'repository' ? 'Search repository snapshots' : 'Search RAGs and providers'} /></label>
    </div>

    {showCodeIndexes && <section className="knowledge-code-indexes" aria-label="Repository snapshots">
      <header><div><span><GitCommitHorizontal size={16} /></span><div><small>NATIVE CODE INTELLIGENCE</small><h2>Repository snapshots</h2><p>Immutable Graphify snapshots pinned to the exact Git commit used by governed Dev runs.</p></div></div><em>{codeIndexes.filter(index => index.status === 'ready').length} READY</em></header>
      {codeIndexesQuery.isLoading ? <LoadingState label="Loading repository snapshots…" />
        : codeIndexesQuery.error ? <div className="knowledge-code-index-error" role="alert">{codeIndexesQuery.error.message}</div>
          : visibleCodeIndexes.length === 0 ? <EmptyState title={search.trim() ? 'No matching repository snapshots' : 'No repository snapshots yet'} description={search.trim() ? 'Change the search or select All sources.' : 'Run Argus Dev with the Code Intelligence Read and Index bundles to create the first commit-bound snapshot.'} />
            : <div className="knowledge-code-index-grid">{visibleCodeIndexes.slice(0, 6).map(index => {
              const graphAvailable = index.status === 'ready' || index.status === 'superseded';
              return <article key={index.id}>
                <header><span className={`knowledge-code-status is-${index.status}`}><i />{index.status}</span><code>#{index.id}</code></header>
                <h3>{index.repositoryKey}</h3>
                <div className="knowledge-code-revision"><span><GitBranch size={12} />{index.branchName}</span><span><GitCommitHorizontal size={12} /><code title={index.commitSha}>{index.commitSha.slice(0, 12)}</code></span></div>
                <div className="knowledge-code-counts"><span><b>{index.fileCount}</b> files</span><span><b>{index.symbolCount}</b> symbols</span><span><b>{index.edgeCount}</b> relations</span><span><b>{index.documentCount}</b> chunks</span></div>
                <div className="knowledge-code-languages">{Object.entries(index.languages).slice(0, 5).map(([language, count]) => <span key={language}>{language} <b>{count}</b></span>)}</div>
                <footer><span>{index.provider}{index.parserVersion ? ` · ${index.parserVersion}` : ''}</span><time dateTime={index.finishedAt ?? index.createdAt}>{timeAgo(index.finishedAt ?? index.createdAt)}</time></footer>
                <div className="knowledge-code-graph-actions"><span>Commit-bound · read-only</span><button className="knowledge-code-graph-button" type="button" disabled={!graphAvailable} title={graphAvailable ? `Open immutable Graphify snapshot ${index.id}` : 'Graph is available after indexing completes'} onClick={() => setGraphSnapshot(index)}><Network size={13} />View Graphify</button></div>
              </article>;
            })}</div>}
    </section>}

    {activeView === 'sources' && (sources.length ? <section className="knowledge-card-grid" aria-label="RAG sources">{sources.map(source => {
      const chunks = source.documents.reduce((total, document) => total + document.chunk_count, 0);
      return <article className={`knowledge-card is-${source.provider}${source.enabled ? '' : ' is-disabled'}`} key={source.id}>
        <header><span className="knowledge-source-icon"><ProviderIcon provider={source.provider} /></span><div><span className={`availability-badge${source.enabled ? '' : ' is-disabled'}`}><i />{source.enabled ? 'Enabled' : 'Disabled'}</span></div></header>
        <div className="knowledge-card-title"><small>{source.name}</small><h2>{source.label}</h2><p>{source.description || 'No knowledge-source description provided yet.'}</p></div>
        <div className="knowledge-provider-line"><Database size={14} /><span><small>PROVIDER</small><b>{providerLabel(source.provider, query.data.providers)}</b></span></div>
        {source.provider === 'pgvector' ? <div className="knowledge-card-facts"><span><FileText size={12} /><b>{source.documents.length}</b> documents</span><span><Sparkles size={12} /><b>{chunks}</b> chunks</span><span><Boxes size={12} />top <b>{source.top_k}</b></span></div> : <div className="knowledge-external-endpoint"><Network size={12} /><span><b>{source.index_name}</b><small>{source.endpoint}</small></span></div>}
        <div className="knowledge-card-updated">Updated {source.updated_at ? timeAgo(source.updated_at) : '—'}</div>
        <footer><button type="button" onClick={() => setDetailId(source.id)}><Search size={13} />Open workbench</button><button className="is-primary" type="button" onClick={() => { saveMutation.reset(); setEditing(source); }}><Settings2 size={13} />Configure</button></footer>
      </article>;
    })}</section> : <section className="panel"><EmptyState title="No matching RAG sources" description="Change the search or create the first pgvector or external RAG source." /></section>)}

    {editing !== undefined && <KnowledgeEditor key={editing?.id ?? 'new'} source={editing} providers={query.data.providers} busy={saveMutation.isPending || deleteMutation.isPending} error={saveMutation.error?.message ?? deleteMutation.error?.message ?? null} onClose={() => { if (!saveMutation.isPending && !deleteMutation.isPending) setEditing(undefined); }} onSave={input => saveMutation.mutate({ input, id: editing?.id })} onDelete={source => deleteMutation.mutate(source)} />}
    {detailSource && <KnowledgePanel source={detailSource} provider={query.data.providers.find(item => item.id === detailSource.provider)} onClose={() => setDetailId(null)} onEdit={() => { setDetailId(null); saveMutation.reset(); setEditing(detailSource); }} />}
    {graphSnapshot && <RepositoryGraphDialog snapshot={graphSnapshot} onClose={() => setGraphSnapshot(null)} />}
  </>;
}
