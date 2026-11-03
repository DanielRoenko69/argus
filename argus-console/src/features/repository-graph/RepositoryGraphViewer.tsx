import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Boxes,
  CheckCircle2,
  ChevronRight,
  GitCommitHorizontal,
  ListTree,
  LoaderCircle,
  LockKeyhole,
  Network,
  RefreshCw,
  SearchCode,
  ShieldCheck,
  Waypoints,
  X,
} from 'lucide-react';
import { RepositoryGraphArchitecturePanel } from './RepositoryGraphArchitecturePanel';
import { RepositoryGraphCanvas } from './RepositoryGraphCanvas';
import { RepositoryGraphDetails } from './RepositoryGraphDetails';
import { RepositoryGraphFilters } from './RepositoryGraphFilters';
import { RepositoryGraphListFallback } from './RepositoryGraphListFallback';
import { RepositoryFullGraphCanvas } from './RepositoryFullGraphCanvas';
import { RepositoryFullGraphDetails } from './RepositoryFullGraphDetails';
import { RepositoryFullGraphPanel } from './RepositoryFullGraphPanel';
import { loadRepositoryFullGraph, loadRepositoryGraph, loadRepositoryGraphOverview } from './repositoryGraphClient';
import type {
  RepositoryGraphEdge,
  RepositoryGraphEntry,
  RepositoryGraphFiltersState,
  RepositoryGraphLoader,
  RepositoryGraphNeighborhood,
  RepositoryGraphNode,
  RepositoryGraphOverview,
  RepositoryGraphOverviewLoader,
  RepositoryGraphRequest,
  RepositoryFullGraph,
  RepositoryFullGraphLoader,
} from './types';
import './repositoryGraph.css';

const CLIENT_NODE_LIMIT = 200;
const CLIENT_EDGE_LIMIT = 1_600;
const ARCHITECTURE_DEPENDENCY_PREVIEW_LIMIT = 12;
const DEFAULT_FILTERS: RepositoryGraphFiltersState = {
  nodeTypes: ['file', 'symbol'],
  edgeTypes: [],
  direction: 'both',
  depth: 1,
};

type LoadMode = 'replace' | 'merge';
type ViewerMode = 'graph' | 'list';
type InitialViewerScope = 'architecture' | 'neighborhood';
type ViewerScope = InitialViewerScope | 'full';

export interface RepositoryGraphViewerProps {
  snapshotId: string;
  initialEntry?: RepositoryGraphEntry;
  initialView?: InitialViewerScope;
  loadGraph?: RepositoryGraphLoader;
  loadOverview?: RepositoryGraphOverviewLoader;
  loadFullGraph?: RepositoryFullGraphLoader;
  onClose?: () => void;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function mergeNeighborhood(
  current: RepositoryGraphNeighborhood | null,
  incoming: RepositoryGraphNeighborhood,
): { neighborhood: RepositoryGraphNeighborhood; clientTruncated: boolean } {
  if (!current) {
    const nodes = incoming.nodes.slice(0, CLIENT_NODE_LIMIT);
    const visibleIds = new Set(nodes.map(node => node.id));
    const visibleEdges = incoming.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
    return {
      neighborhood: { ...incoming, nodes, edges: visibleEdges.slice(0, CLIENT_EDGE_LIMIT) },
      clientTruncated: incoming.nodes.length > CLIENT_NODE_LIMIT || visibleEdges.length > CLIENT_EDGE_LIMIT,
    };
  }
  if (current.snapshot.id !== incoming.snapshot.id
    || current.snapshot.commitSha !== incoming.snapshot.commitSha
    || current.snapshot.graphDigest !== incoming.snapshot.graphDigest) {
    throw new Error('Repository graph expansion did not match the open immutable snapshot.');
  }

  const nodeMap = new Map(current.nodes.map(node => [node.id, node]));
  for (const node of incoming.nodes) nodeMap.set(node.id, node);
  const nodes = [...nodeMap.values()].slice(0, CLIENT_NODE_LIMIT);
  const visibleIds = new Set(nodes.map(node => node.id));
  const edgeMap = new Map(current.edges.map(edge => [edge.id, edge]));
  for (const edge of incoming.edges) edgeMap.set(edge.id, edge);
  const allEdges = [...edgeMap.values()].filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const edges = allEdges.slice(0, CLIENT_EDGE_LIMIT);
  const clientTruncated = nodeMap.size > nodes.length || allEdges.length > edges.length;

  return {
    neighborhood: {
      ...incoming,
      nodes,
      edges,
      truncated: current.truncated || incoming.truncated || clientTruncated,
      truncationReasons: [...new Set([...current.truncationReasons, ...incoming.truncationReasons])],
      authorizedLinks: [...new Map([...current.authorizedLinks, ...incoming.authorizedLinks].map(link => [`${link.kind}:${link.href}`, link])).values()],
    },
    clientTruncated,
  };
}

interface VisibleGraph {
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
}

interface ArchitectureGraph extends VisibleGraph {
  dependencies: RepositoryGraphEdge[];
  moduleCount: number;
}

function relationCount(edge: RepositoryGraphEdge): number {
  return Number(edge.metadata?.['relationCount'] ?? 1);
}

function architectureGraph(overview: RepositoryGraphOverview | null, search: string): ArchitectureGraph {
  if (!overview) return { nodes: [], edges: [], dependencies: [], moduleCount: 0 };
  const query = search.trim().toLowerCase();
  const modules = overview.modules.filter(module => !query
    || module.path.toLowerCase().includes(query)
    || Object.keys(module.languages).some(language => language.toLowerCase().includes(query)));
  const visibleIds = new Set(modules.map(module => module.id));
  const repositoryId = 'repository:root';
  const nodes: RepositoryGraphNode[] = [{
    id: repositoryId,
    type: 'repository',
    label: overview.snapshot.repository,
    href: null,
    metadata: {
      branch: overview.snapshot.branch,
      modules: overview.totals.modules,
      files: overview.totals.files,
      symbols: overview.totals.symbols,
      relations: overview.totals.edges,
      documents: overview.totals.documents,
      testFiles: overview.totals.testFiles,
    },
  }, ...modules.map(module => ({
    id: module.id,
    type: 'module' as const,
    label: module.path,
    href: null,
    metadata: {
      path: module.path,
      files: module.fileCount,
      symbols: module.symbolCount,
      documents: module.documentCount,
      testFiles: module.testFileCount,
      languages: Object.entries(module.languages).map(([language, count]) => `${language} ${count}`).join(', ') || 'unknown',
    },
  }))];
  const containment: RepositoryGraphEdge[] = modules.map(module => ({
    id: `contains:${module.id}`,
    source: repositoryId,
    target: module.id,
    type: 'contains',
  }));
  const dependencies: RepositoryGraphEdge[] = overview.dependencies
    .filter(dependency => visibleIds.has(dependency.source) && visibleIds.has(dependency.target))
    .map(dependency => ({
      id: dependency.id,
      source: dependency.source,
      target: dependency.target,
      type: dependency.relations.join(', ') || 'depends_on',
      metadata: { relationCount: dependency.relationCount },
    }));
  return { nodes, edges: containment, dependencies, moduleCount: modules.length };
}

function visibleArchitectureGraph(
  graph: ArchitectureGraph,
  focusNodeId: string | null,
): VisibleGraph {
  const focus = focusNodeId ? graph.nodes.find(node => node.id === focusNodeId && node.type === 'module') : null;
  if (!focus) {
    const visibleDependencies = [...graph.dependencies]
      .sort((left, right) => relationCount(right) - relationCount(left) || left.id.localeCompare(right.id))
      .slice(0, ARCHITECTURE_DEPENDENCY_PREVIEW_LIMIT);
    return { nodes: graph.nodes, edges: [...graph.edges, ...visibleDependencies] };
  }

  const edges = graph.dependencies.filter(edge => edge.source === focus.id || edge.target === focus.id);
  const visibleIds = new Set([focus.id, ...edges.flatMap(edge => [edge.source, edge.target])]);
  return {
    nodes: graph.nodes.filter(node => node.type === 'module' && visibleIds.has(node.id)),
    edges,
  };
}

function visibleNeighborhoodGraph(data: RepositoryGraphNeighborhood | null, focusNodeId: string | null): VisibleGraph {
  if (!data) return { nodes: [], edges: [] };
  const focus = focusNodeId ? data.nodes.find(node => node.id === focusNodeId) : null;
  if (!focus) return { nodes: data.nodes, edges: data.edges };
  const edges = data.edges.filter(edge => edge.source === focus.id || edge.target === focus.id);
  const visibleIds = new Set([focus.id, ...edges.flatMap(edge => [edge.source, edge.target])]);
  return {
    nodes: data.nodes.filter(node => visibleIds.has(node.id)),
    edges,
  };
}

export function RepositoryGraphViewer({
  snapshotId,
  initialEntry,
  initialView = 'neighborhood',
  loadGraph = loadRepositoryGraph,
  loadOverview = loadRepositoryGraphOverview,
  loadFullGraph = loadRepositoryFullGraph,
  onClose,
}: RepositoryGraphViewerProps) {
  const [scope, setScope] = useState<ViewerScope>(initialView);
  const [filters, setFilters] = useState<RepositoryGraphFiltersState>(DEFAULT_FILTERS);
  const [entry, setEntry] = useState<RepositoryGraphEntry | null>(initialEntry ?? null);
  const [search, setSearch] = useState(initialEntry?.kind === 'search' ? initialEntry.value : '');
  const [architectureSearch, setArchitectureSearch] = useState('');
  const [data, setData] = useState<RepositoryGraphNeighborhood | null>(null);
  const [overview, setOverview] = useState<RepositoryGraphOverview | null>(null);
  const [fullGraph, setFullGraph] = useState<RepositoryFullGraph | null>(null);
  const [fullSearch, setFullSearch] = useState('');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [architectureFocusId, setArchitectureFocusId] = useState<string | null>(null);
  const [neighborhoodFocusId, setNeighborhoodFocusId] = useState<string | null>(null);
  const [originModuleId, setOriginModuleId] = useState<string | null>(null);
  const [viewerMode, setViewerMode] = useState<ViewerMode>('graph');
  const [busy, setBusy] = useState(false);
  const [overviewBusy, setOverviewBusy] = useState(false);
  const [fullGraphBusy, setFullGraphBusy] = useState(false);
  const [error, setError] = useState('');
  const [overviewError, setOverviewError] = useState('');
  const [fullGraphError, setFullGraphError] = useState('');
  const [clientTruncated, setClientTruncated] = useState(false);
  const [lastRequest, setLastRequest] = useState<RepositoryGraphRequest | null>(null);
  const dataRef = useRef<RepositoryGraphNeighborhood | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const overviewAbortRef = useRef<AbortController | null>(null);
  const fullGraphAbortRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const overviewSequence = useRef(0);
  const fullGraphSequence = useRef(0);

  const requestGraph = useCallback(async (
    request: RepositoryGraphRequest,
    mode: LoadMode,
  ): Promise<RepositoryGraphNeighborhood | null> => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError('');
    setLastRequest(request);
    try {
      const result = await loadGraph(request, controller.signal);
      if (result.snapshot.id !== snapshotId) throw new Error('Repository graph returned a different snapshot than requested.');
      if (sequence !== requestSequence.current) return null;
      const merged = mergeNeighborhood(mode === 'merge' ? dataRef.current : null, result);
      dataRef.current = merged.neighborhood;
      setData(merged.neighborhood);
      setClientTruncated(previous => mode === 'merge' ? previous || merged.clientTruncated : merged.clientTruncated);
      setEntry(request.entry);
      if (mode === 'replace') {
        setNeighborhoodFocusId(null);
        setSelectedNodeId(result.nodes[0]?.id ?? null);
      }
      return merged.neighborhood;
    } catch (caught) {
      if (sequence !== requestSequence.current || isAbortError(caught)) return null;
      setError(caught instanceof Error ? caught.message : 'Repository graph could not be loaded.');
      return null;
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }, [loadGraph, snapshotId]);

  const requestOverview = useCallback(async () => {
    overviewAbortRef.current?.abort();
    const controller = new AbortController();
    overviewAbortRef.current = controller;
    const sequence = ++overviewSequence.current;
    setOverviewBusy(true);
    setOverviewError('');
    try {
      const result = await loadOverview(snapshotId, controller.signal);
      if (result.snapshot.id !== snapshotId) throw new Error('Repository architecture returned a different snapshot than requested.');
      if (sequence !== overviewSequence.current) return;
      setOverview(result);
      setSelectedNodeId('repository:root');
      setArchitectureFocusId(null);
    } catch (caught) {
      if (sequence !== overviewSequence.current || isAbortError(caught)) return;
      setOverviewError(caught instanceof Error ? caught.message : 'Repository architecture could not be loaded.');
    } finally {
      if (sequence === overviewSequence.current) setOverviewBusy(false);
    }
  }, [loadOverview, snapshotId]);

  const requestFullGraph = useCallback(async () => {
    fullGraphAbortRef.current?.abort();
    const controller = new AbortController();
    fullGraphAbortRef.current = controller;
    const sequence = ++fullGraphSequence.current;
    setFullGraphBusy(true);
    setFullGraphError('');
    try {
      const result = await loadFullGraph(snapshotId, controller.signal);
      if (result.snapshot.id !== snapshotId) throw new Error('Repository full graph returned a different snapshot than requested.');
      if (sequence !== fullGraphSequence.current) return;
      setFullGraph(result);
      setSelectedNodeId(null);
    } catch (caught) {
      if (sequence !== fullGraphSequence.current || isAbortError(caught)) return;
      setFullGraphError(caught instanceof Error ? caught.message : 'Repository full graph could not be loaded.');
    } finally {
      if (sequence === fullGraphSequence.current) setFullGraphBusy(false);
    }
  }, [loadFullGraph, snapshotId]);

  const makeRequest = useCallback((nextEntry: RepositoryGraphEntry, cursor?: string): RepositoryGraphRequest => ({
    snapshotId,
    entry: nextEntry,
    nodeTypes: filters.nodeTypes,
    edgeTypes: filters.edgeTypes,
    direction: filters.direction,
    depth: filters.depth,
    limit: 100,
    ...(cursor ? { cursor } : {}),
  }), [filters, snapshotId]);

  useEffect(() => () => {
    abortRef.current?.abort();
    overviewAbortRef.current?.abort();
    fullGraphAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    abortRef.current?.abort();
    overviewAbortRef.current?.abort();
    fullGraphAbortRef.current?.abort();
    requestSequence.current += 1;
    overviewSequence.current += 1;
    fullGraphSequence.current += 1;
    setData(null);
    dataRef.current = null;
    setOverview(null);
    setFullGraph(null);
    setFullSearch('');
    setFullGraphBusy(false);
    setError('');
    setOverviewError('');
    setFullGraphError('');
    setClientTruncated(false);
    setSelectedNodeId(null);
    setArchitectureFocusId(null);
    setNeighborhoodFocusId(null);
    setOriginModuleId(null);
    setFilters(DEFAULT_FILTERS);
    setArchitectureSearch('');
    setScope(initialView);
    const nextEntry = initialEntry ?? null;
    setEntry(nextEntry);
    setSearch(nextEntry?.kind === 'search' ? nextEntry.value : '');
    if (initialView === 'architecture') void requestOverview();
    else if (nextEntry) void requestGraph({
      snapshotId,
      entry: nextEntry,
      nodeTypes: DEFAULT_FILTERS.nodeTypes,
      edgeTypes: DEFAULT_FILTERS.edgeTypes,
      direction: DEFAULT_FILTERS.direction,
      depth: DEFAULT_FILTERS.depth,
      limit: 100,
    }, 'replace');
  }, [initialEntry?.kind, initialEntry?.value, initialView, requestGraph, requestOverview, snapshotId]);

  const architecture = useMemo(() => architectureGraph(overview, architectureSearch), [architectureSearch, overview]);
  const architectureVisible = useMemo(
    () => visibleArchitectureGraph(architecture, architectureFocusId),
    [architecture, architectureFocusId],
  );
  const neighborhoodVisible = useMemo(
    () => visibleNeighborhoodGraph(data, neighborhoodFocusId),
    [data, neighborhoodFocusId],
  );
  const activeNodes = scope === 'architecture' ? architectureVisible.nodes : scope === 'neighborhood' ? neighborhoodVisible.nodes : [];
  const activeEdges = scope === 'architecture' ? architectureVisible.edges : scope === 'neighborhood' ? neighborhoodVisible.edges : [];
  const selectedNode = activeNodes.find(node => node.id === selectedNodeId) ?? null;
  const focusedModule = overview?.modules.find(module => module.id === architectureFocusId) ?? null;
  const originModule = overview?.modules.find(module => module.id === originModuleId) ?? null;
  const activeSnapshot = scope === 'architecture' ? overview?.snapshot : scope === 'neighborhood' ? data?.snapshot : fullGraph?.snapshot;
  const activeBusy = scope === 'architecture' ? overviewBusy : scope === 'neighborhood' ? busy : fullGraphBusy;
  const activeError = scope === 'architecture' ? overviewError : scope === 'neighborhood' ? error : fullGraphError;
  const availableEdgeTypes = useMemo(() => [...new Set([
    ...filters.edgeTypes,
    ...(data?.edges.map(edge => edge.type) ?? []),
  ])].sort(), [data?.edges, filters.edgeTypes]);

  useEffect(() => {
    if (scope !== 'architecture' || !architectureFocusId) return;
    if (architecture.nodes.some(node => node.id === architectureFocusId)) return;
    setArchitectureFocusId(null);
    setSelectedNodeId('repository:root');
  }, [architecture.nodes, architectureFocusId, scope]);

  const runSearch = () => {
    const value = search.trim();
    if (!value) return;
    const nextEntry: RepositoryGraphEntry = { kind: 'search', value };
    setClientTruncated(false);
    void requestGraph(makeRequest(nextEntry), 'replace');
  };
  const applyFilters = () => {
    if (entry) void requestGraph(makeRequest(entry), 'replace');
    else runSearch();
  };
  const explore = (nodeId: string) => {
    if (scope === 'architecture') {
      const module = overview?.modules.find(candidate => candidate.id === nodeId);
      const value = !module || module.path === '(root)' ? '*' : `${module.path}/`;
      const nextEntry: RepositoryGraphEntry = { kind: 'search', value };
      setOriginModuleId(module?.id ?? null);
      setScope('neighborhood');
      setSearch(value);
      setData(null);
      dataRef.current = null;
      setClientTruncated(false);
      setSelectedNodeId(null);
      void requestGraph(makeRequest(nextEntry), 'replace');
      return;
    }
    setNeighborhoodFocusId(nodeId);
    setSelectedNodeId(nodeId);
    const nextEntry: RepositoryGraphEntry = { kind: 'seed', value: nodeId };
    void requestGraph(makeRequest(nextEntry), 'merge');
  };
  const loadMore = () => {
    if (!data?.nextCursor || !lastRequest) return;
    void requestGraph({ ...lastRequest, cursor: data.nextCursor }, 'merge');
  };
  const retry = () => {
    if (scope === 'architecture') void requestOverview();
    else if (scope === 'full') void requestFullGraph();
    else if (lastRequest) void requestGraph(lastRequest, data ? 'merge' : 'replace');
  };
  const showFullArchitecture = () => {
    setScope('architecture');
    setArchitectureFocusId(null);
    setNeighborhoodFocusId(null);
    setOriginModuleId(null);
    setSelectedNodeId('repository:root');
    if (!overview && !overviewBusy) void requestOverview();
  };
  const showRepositoryCodeSearch = () => {
    setScope('neighborhood');
    setOriginModuleId(null);
    setNeighborhoodFocusId(null);
    setSelectedNodeId(data?.nodes[0]?.id ?? null);
  };
  const showRepositoryFullGraph = () => {
    setScope('full');
    setViewerMode('graph');
    setSelectedNodeId(null);
    if (!fullGraph && !fullGraphBusy) void requestFullGraph();
  };
  const showModuleArchitecture = () => {
    if (!originModule) return showFullArchitecture();
    setScope('architecture');
    setArchitectureFocusId(originModule.id);
    setNeighborhoodFocusId(null);
    setSelectedNodeId(originModule.id);
  };
  const goBack = () => {
    if (scope === 'full') return showFullArchitecture();
    if (scope === 'neighborhood' && neighborhoodFocusId) {
      setNeighborhoodFocusId(null);
      return;
    }
    if (scope === 'neighborhood') return showModuleArchitecture();
    if (architectureFocusId) showFullArchitecture();
  };
  const selectNode = (nodeId: string) => {
    setSelectedNodeId(nodeId);
    if (scope === 'full') return;
    if (scope === 'architecture') {
      const node = architecture.nodes.find(candidate => candidate.id === nodeId);
      setArchitectureFocusId(node?.type === 'module' ? node.id : null);
      return;
    }
    setNeighborhoodFocusId(nodeId);
  };
  const searchFullGraph = () => {
    if (!fullGraph) return;
    const query = fullSearch.trim().toLowerCase();
    if (!query) return;
    const file = fullGraph.files.find(candidate => candidate[1].toLowerCase().includes(query));
    if (file) {
      setSelectedNodeId(`file:${file[0]}`);
      return;
    }
    const symbol = fullGraph.symbols.find(candidate => candidate[1].toLowerCase().includes(query) || candidate[2].toLowerCase().includes(query));
    setSelectedNodeId(symbol ? `symbol:${symbol[0]}` : null);
  };
  const clearNeighborhoodFocus = () => setNeighborhoodFocusId(null);
  const canGoBack = Boolean(architectureFocusId || scope === 'neighborhood' || scope === 'full');
  const repositoryLabel = activeSnapshot?.repository ?? 'Repository';

  return <section className="repository-graph-viewer" aria-label="Immutable repository graph viewer">
    <header className="repository-graph-header">
      <div className="repository-graph-title">
        <span><Network aria-hidden="true" size={19} /></span>
        <div><small>READ-ONLY · GRAPHIFY</small><h2>Repository graph</h2><p>{scope === 'architecture' ? 'Open the complete graph at once, or focus a module for a smaller inspection.' : scope === 'full' ? 'Every available file, function and relationship in one immutable canvas.' : 'Follow direct relationships in the bounded, immutable code neighborhood.'}</p></div>
      </div>
      <div className="repository-graph-header-actions">
        {scope !== 'full' && <div className="repository-graph-view-toggle" aria-label="Repository graph view">
          <button type="button" className={viewerMode === 'graph' ? 'is-active' : ''} aria-pressed={viewerMode === 'graph'} onClick={() => setViewerMode('graph')}><Network size={13} />Graph</button>
          <button type="button" className={viewerMode === 'list' ? 'is-active' : ''} aria-pressed={viewerMode === 'list'} onClick={() => setViewerMode('list')}><ListTree size={13} />Accessible list</button>
        </div>}
        {onClose && <button className="repository-graph-close" type="button" aria-label="Close repository graph" onClick={onClose}><X size={17} /></button>}
      </div>
    </header>

    {activeSnapshot && <div className="repository-graph-identity" aria-label="Immutable snapshot identity">
      <span><ShieldCheck aria-hidden="true" size={15} /><b>Immutable snapshot</b></span>
      <span><GitCommitHorizontal aria-hidden="true" size={14} />Commit <code title={activeSnapshot.commitSha}>{activeSnapshot.commitSha}</code></span>
      <span><LockKeyhole aria-hidden="true" size={14} />Digest <code title={activeSnapshot.graphDigest}>{activeSnapshot.graphDigest}</code></span>
      <span>Status <b>{activeSnapshot.status}</b> · {activeSnapshot.repository} · {activeSnapshot.branch} · {activeSnapshot.provider}</span>
    </div>}

    {activeSnapshot && <nav className="repository-graph-breadcrumb" aria-label="Repository graph path">
      <button type="button" className="repository-graph-back" disabled={!canGoBack} onClick={goBack}><ArrowLeft size={13} />Back</button>
      <button type="button" onClick={showFullArchitecture}>{repositoryLabel}</button>
      {scope === 'architecture' && focusedModule && <><ChevronRight size={12} /><span>{focusedModule.path}</span></>}
      {scope === 'neighborhood' && originModule && <><ChevronRight size={12} /><button type="button" onClick={showModuleArchitecture}>{originModule.path}</button></>}
      {scope === 'neighborhood' && <><ChevronRight size={12} /><button type="button" onClick={clearNeighborhoodFocus}>Code neighborhood</button></>}
      {scope === 'neighborhood' && neighborhoodFocusId && selectedNode && <><ChevronRight size={12} /><span>{selectedNode.label}</span></>}
      {scope === 'full' && <><ChevronRight size={12} /><span>Complete code graph</span></>}
    </nav>}

    <div className="repository-graph-body">
      {scope === 'architecture'
        ? <RepositoryGraphArchitecturePanel
            overview={overview}
            search={architectureSearch}
            visibleModules={architecture.moduleCount}
            focusedModule={focusedModule?.path ?? null}
            visibleNeighbors={architectureVisible.nodes.length}
            shownDependencies={architectureVisible.edges.filter(edge => edge.type !== 'contains').length}
            totalDependencies={architecture.dependencies.length}
            busy={overviewBusy}
            onSearchChange={setArchitectureSearch}
            onRefresh={() => void requestOverview()}
            onShowAll={showFullArchitecture}
            onShowFullGraph={showRepositoryFullGraph}
          />
        : scope === 'full' && fullGraph
          ? <RepositoryFullGraphPanel graph={fullGraph} search={fullSearch} onSearchChange={setFullSearch} onSearch={searchFullGraph} onBack={showFullArchitecture} />
          : scope === 'full'
            ? <aside className="repository-full-graph-panel" aria-label="Complete repository graph controls" />
            : <RepositoryGraphFilters
            search={search}
            filters={filters}
            availableEdgeTypes={availableEdgeTypes}
            disabled={busy}
            onSearchChange={setSearch}
            onSearch={runSearch}
            onFiltersChange={setFilters}
            onApply={applyFilters}
          />}

      <main className="repository-graph-main">
        {activeError && <div className="repository-graph-error" role="alert"><AlertTriangle size={16} /><span>{activeError}</span><button type="button" onClick={retry}><RefreshCw size={13} />Retry</button></div>}
        {scope === 'architecture' && overview?.truncated && <div className="repository-graph-truncation" role="status">
          <AlertTriangle size={15} /><span><b>Bounded architecture</b> Showing {overview.modules.length} of {overview.totals.modules} modules and {overview.dependencies.length} of {overview.totals.dependencies} cross-module dependencies.</span>
        </div>}
        {scope === 'neighborhood' && (data?.truncated || clientTruncated) && <div className="repository-graph-truncation" role="status">
          <AlertTriangle size={15} /><span><b>Bounded result</b> This view is intentionally incomplete{data?.truncationReasons.length ? ` (${data.truncationReasons.join(', ')})` : ''}{clientTruncated ? `; the viewer retained its first ${CLIENT_NODE_LIMIT} nodes` : ''}.</span>
        </div>}
        {scope === 'full' && fullGraph?.truncated && <div className="repository-graph-truncation" role="status">
          <AlertTriangle size={15} /><span><b>Full-graph safety limit reached</b> The snapshot exceeds this renderer's limits ({fullGraph.truncationReasons.join(', ')}).</span>
        </div>}

        {scope === 'architecture' && !overview && !overviewBusy && !overviewError && <div className="repository-graph-start"><Boxes aria-hidden="true" size={28} /><h3>Architecture overview unavailable</h3><p>Refresh the immutable overview to map this repository snapshot.</p></div>}
        {scope === 'architecture' && !overview && overviewBusy && <div className="repository-graph-loading" role="status"><LoaderCircle className="is-spinning" size={22} />Loading repository architecture…</div>}
        {scope === 'architecture' && overview && architecture.moduleCount === 0 && <div className="repository-graph-start"><Boxes size={26} /><h3>No matching modules</h3><p>Try another module path or programming language.</p></div>}

        {scope === 'neighborhood' && !data && !busy && !error && <div className="repository-graph-start">
          <Network aria-hidden="true" size={28} /><h3>Start with a bounded search</h3><p>Search for a file path or symbol. Argus never sends the unrestricted repository graph to the browser.</p>
        </div>}
        {scope === 'neighborhood' && !data && busy && <div className="repository-graph-loading" role="status"><LoaderCircle className="is-spinning" size={22} />Loading immutable neighborhood…</div>}
        {scope === 'neighborhood' && data && data.nodes.length === 0 && !busy && <div className="repository-graph-start"><Network size={26} /><h3>No matching nodes</h3><p>Try another file or symbol name, or broaden the active filters.</p></div>}
        {scope === 'full' && !fullGraph && fullGraphBusy && <div className="repository-graph-loading" role="status"><LoaderCircle className="is-spinning" size={22} />Loading every file, function and relationship…</div>}
        {scope === 'full' && fullGraph && fullGraph.files.length + fullGraph.symbols.length === 0 && <div className="repository-graph-start"><Waypoints size={26} /><h3>No indexed code found</h3><p>This immutable snapshot does not contain any files or symbols.</p></div>}

        {scope === 'full' && fullGraph && fullGraph.files.length + fullGraph.symbols.length > 0 && <RepositoryFullGraphCanvas graph={fullGraph} selectedNodeId={selectedNodeId} onSelect={selectNode} />}
        {scope !== 'full' && activeNodes.length > 0 && (viewerMode === 'graph'
          ? <RepositoryGraphCanvas nodes={activeNodes} edges={activeEdges} selectedNodeId={selectedNodeId} focusNodeId={scope === 'architecture' ? architectureFocusId : neighborhoodFocusId} onSelect={selectNode} onActivate={explore} />
          : <RepositoryGraphListFallback nodes={activeNodes} edges={activeEdges} selectedNodeId={selectedNodeId} onSelect={selectNode} />)}

        {scope === 'architecture' && overview && <footer className="repository-graph-status">
          <span>{overviewBusy ? <LoaderCircle className="is-spinning" size={13} /> : <CheckCircle2 size={13} />}{architectureFocusId ? `${architectureVisible.nodes.length} visible modules · ${architectureVisible.edges.length} direct ${architectureVisible.edges.length === 1 ? 'dependency' : 'dependencies'}` : `${architecture.moduleCount} modules · ${architectureVisible.edges.filter(edge => edge.type !== 'contains').length} of ${architecture.dependencies.length} strongest dependencies`} · {overview.appliedLimits.elapsedMs} ms</span>
          <button type="button" onClick={showRepositoryCodeSearch}><SearchCode size={12} />Search repository code</button>
        </footer>}
        {scope === 'neighborhood' && data && <footer className="repository-graph-status">
          <span>{busy ? <LoaderCircle className="is-spinning" size={13} /> : <CheckCircle2 size={13} />}{neighborhoodFocusId ? `${neighborhoodVisible.nodes.length} visible of ${data.nodes.length} loaded nodes · ${neighborhoodVisible.edges.length} direct ${neighborhoodVisible.edges.length === 1 ? 'relation' : 'relations'}` : `${data.nodes.length} nodes · ${data.edges.length} relations`} · {data.appliedLimits.elapsedMs} ms</span>
          {neighborhoodFocusId && <button type="button" onClick={clearNeighborhoodFocus}>Show loaded neighborhood</button>}
          {data.nextCursor && <button type="button" disabled={busy || data.nodes.length >= CLIENT_NODE_LIMIT} onClick={loadMore}>Load next bounded page</button>}
          {data.authorizedLinks.map(link => <a key={`${link.kind}:${link.href}`} href={link.href}>{link.label}</a>)}
        </footer>}
        {scope === 'full' && fullGraph && <footer className="repository-graph-status">
          <span><CheckCircle2 size={13} />{(fullGraph.files.length + fullGraph.symbols.length).toLocaleString()} nodes · {(fullGraph.symbols.length + fullGraph.edges.length).toLocaleString()} relations · {fullGraph.appliedLimits.elapsedMs} ms</span>
          <button type="button" onClick={showFullArchitecture}>Module overview</button>
        </footer>}
      </main>

      {scope === 'full' && fullGraph
        ? <RepositoryFullGraphDetails graph={fullGraph} selectedNodeId={selectedNodeId} onSelect={selectNode} />
        : <RepositoryGraphDetails node={selectedNode} nodes={activeNodes} edges={activeEdges} busy={activeBusy} onSelect={selectNode} onExplore={explore} />}
    </div>
  </section>;
}
