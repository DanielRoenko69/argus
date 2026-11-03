import { createHash } from 'node:crypto';
import type { RepositoryGraphDataSource } from './repositoryGraphStore.js';
import type {
  RepositoryGraphEdge,
  RepositoryGraphNeighborhood,
  RepositoryGraphNode,
  RepositoryGraphOverview,
  RepositoryGraphQuery,
  RepositoryFullGraph,
} from './repositoryGraphTypes.js';
import { REPOSITORY_GRAPH_LIMITS, RepositoryGraphValidationError } from './repositoryGraphValidation.js';

type CursorPayload = { v: 1; offset: number; fingerprint: string };

function stableFingerprint(snapshotId: number, query: RepositoryGraphQuery): string {
  return createHash('sha256').update(JSON.stringify({
    snapshotId,
    seed: query.seed,
    q: query.search,
    nodeTypes: query.nodeTypes,
    edgeTypes: query.edgeTypes,
    direction: query.direction,
    depth: query.depth,
    limit: query.limit,
  })).digest('base64url').slice(0, 24);
}

function decodeCursor(cursor: string | null, fingerprint: string): number {
  if (cursor == null) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>;
    if (parsed.v !== 1 || parsed.fingerprint !== fingerprint
      || !Number.isSafeInteger(parsed.offset) || Number(parsed.offset) < 1) {
      throw new Error('invalid cursor payload');
    }
    return Number(parsed.offset);
  } catch {
    throw new RepositoryGraphValidationError('cursor is invalid for this snapshot and query');
  }
}

function encodeCursor(offset: number, fingerprint: string): string {
  const payload: CursorPayload = { v: 1, offset, fingerprint };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function assertActive(signal: AbortSignal | undefined, deadline: number): void {
  if (signal?.aborted) throw new RepositoryGraphValidationError('repository graph request was cancelled', 499);
  if (Date.now() > deadline) throw new RepositoryGraphValidationError('repository graph query exceeded its time budget', 504);
}

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  if (seen.has(value)) return;
  seen.add(value);
  target.push(value);
}

function responseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export interface RepositoryGraphReadContext {
  allowedBundleIds: number[] | null;
  signal?: AbortSignal;
}

export async function loadRepositoryGraphOverview(
  source: RepositoryGraphDataSource,
  snapshotId: number,
  context: RepositoryGraphReadContext,
): Promise<RepositoryGraphOverview> {
  const startedAt = Date.now();
  const deadline = startedAt + REPOSITORY_GRAPH_LIMITS.queryBudgetMs;
  assertActive(context.signal, deadline);
  const snapshot = await source.loadAuthorizedSnapshot(snapshotId, context.allowedBundleIds);
  assertActive(context.signal, deadline);
  if (snapshot == null) {
    throw new RepositoryGraphValidationError('repository snapshot not found', 404);
  }
  if (snapshot.status !== 'ready' && snapshot.status !== 'superseded') {
    throw new RepositoryGraphValidationError('repository snapshot graph is not available', 409);
  }
  const overview = await source.loadArchitectureOverview(snapshotId);
  assertActive(context.signal, deadline);
  const response: RepositoryGraphOverview = {
    schemaVersion: 1,
    snapshot,
    ...overview,
    appliedLimits: {
      maxModules: REPOSITORY_GRAPH_LIMITS.maxOverviewModules,
      maxDependencies: REPOSITORY_GRAPH_LIMITS.maxOverviewDependencies,
      maxLanguagesPerModule: REPOSITORY_GRAPH_LIMITS.maxLanguagesPerModule,
      returnedModules: overview.modules.length,
      returnedDependencies: overview.dependencies.length,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
  };
  if (responseBytes(response) > REPOSITORY_GRAPH_LIMITS.maxResponseBytes) {
    throw new RepositoryGraphValidationError('repository graph response exceeds the byte limit', 413);
  }
  return response;
}

export async function loadRepositoryFullGraph(
  source: RepositoryGraphDataSource,
  snapshotId: number,
  context: RepositoryGraphReadContext,
): Promise<RepositoryFullGraph> {
  const startedAt = Date.now();
  const deadline = startedAt + REPOSITORY_GRAPH_LIMITS.fullGraphQueryBudgetMs;
  assertActive(context.signal, deadline);
  const snapshot = await source.loadAuthorizedSnapshot(snapshotId, context.allowedBundleIds);
  assertActive(context.signal, deadline);
  if (snapshot == null) {
    throw new RepositoryGraphValidationError('repository snapshot not found', 404);
  }
  if (snapshot.status !== 'ready' && snapshot.status !== 'superseded') {
    throw new RepositoryGraphValidationError('repository snapshot graph is not available', 409);
  }

  const graph = await source.loadFullGraph(snapshotId, {
    maxNodes: REPOSITORY_GRAPH_LIMITS.maxFullGraphNodes,
    maxEdges: REPOSITORY_GRAPH_LIMITS.maxFullGraphEdges,
  });
  assertActive(context.signal, deadline);

  const fileIndex = new Map(graph.files.map((file, index) => [file.id, index]));
  const selectedSymbols = graph.symbols.filter(symbol => fileIndex.has(symbol.fileId));
  const symbolIndex = new Map(selectedSymbols.map((symbol, index) => [symbol.id, index]));
  const selectedEdges = graph.edges.filter(edge => symbolIndex.has(edge.sourceSymbolId) && symbolIndex.has(edge.targetSymbolId));
  const relationTypes = [...new Set(selectedEdges.map(edge => edge.type))].sort();
  const relationIndex = new Map(relationTypes.map((type, index) => [type, index]));
  const response: RepositoryFullGraph = {
    schemaVersion: 1,
    snapshot,
    files: graph.files.map(file => [file.id, file.path, file.language, file.module]),
    symbols: selectedSymbols.map(symbol => [
      symbol.id,
      symbol.label,
      symbol.kind,
      fileIndex.get(symbol.fileId)!,
      symbol.startLine,
      symbol.endLine,
    ]),
    relationTypes,
    edges: selectedEdges.map(edge => [
      symbolIndex.get(edge.sourceSymbolId)!,
      symbolIndex.get(edge.targetSymbolId)!,
      relationIndex.get(edge.type)!,
    ]),
    truncated: graph.truncated,
    truncationReasons: graph.truncationReasons,
    appliedLimits: {
      maxNodes: REPOSITORY_GRAPH_LIMITS.maxFullGraphNodes,
      maxEdges: REPOSITORY_GRAPH_LIMITS.maxFullGraphEdges,
      maxResponseBytes: REPOSITORY_GRAPH_LIMITS.maxFullGraphResponseBytes,
      returnedNodes: graph.files.length + selectedSymbols.length,
      returnedEdges: selectedSymbols.length + selectedEdges.length,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
  };
  if (responseBytes(response) > REPOSITORY_GRAPH_LIMITS.maxFullGraphResponseBytes) {
    throw new RepositoryGraphValidationError('repository full graph response exceeds the byte limit', 413);
  }
  return response;
}

export async function loadRepositoryGraphNeighborhood(
  source: RepositoryGraphDataSource,
  snapshotId: number,
  query: RepositoryGraphQuery,
  context: RepositoryGraphReadContext,
): Promise<RepositoryGraphNeighborhood> {
  const startedAt = Date.now();
  const deadline = startedAt + REPOSITORY_GRAPH_LIMITS.queryBudgetMs;
  assertActive(context.signal, deadline);

  const snapshot = await source.loadAuthorizedSnapshot(snapshotId, context.allowedBundleIds);
  assertActive(context.signal, deadline);
  if (snapshot == null) {
    // Deliberately indistinguishable from a missing snapshot: IDs are not capabilities.
    throw new RepositoryGraphValidationError('repository snapshot not found', 404);
  }
  if (snapshot.status !== 'ready' && snapshot.status !== 'superseded') {
    throw new RepositoryGraphValidationError('repository snapshot graph is not available', 409);
  }

  if (query.edgeTypes.length > 0) {
    const available = new Set(await source.resolveKnownEdgeTypes(snapshotId, query.edgeTypes));
    const unknown = query.edgeTypes.filter(type => !available.has(type));
    if (unknown.length > 0) {
      throw new RepositoryGraphValidationError(`unknown edge type: ${unknown[0]}`);
    }
  }
  assertActive(context.signal, deadline);

  const seeds = await source.resolveSeedNodes(snapshotId, query);
  assertActive(context.signal, deadline);
  if (query.seed != null && seeds.length === 0) {
    throw new RepositoryGraphValidationError('repository graph seed not found', 404);
  }

  const nodes = new Map<string, RepositoryGraphNode>();
  const nodeOrder: string[] = [];
  const edges = new Map<string, RepositoryGraphEdge>();
  for (const seed of seeds) {
    if (nodes.has(seed.id)) continue;
    nodes.set(seed.id, seed);
    nodeOrder.push(seed.id);
  }

  let frontier = seeds.map(seed => seed.id);
  let graphTruncated = false;
  for (let level = 0; level < query.depth && frontier.length > 0; level += 1) {
    assertActive(context.signal, deadline);
    const remainingEdges = REPOSITORY_GRAPH_LIMITS.maxTraversalEdges - edges.size;
    if (remainingEdges <= 0 || nodes.size >= REPOSITORY_GRAPH_LIMITS.maxTraversalNodes) {
      graphTruncated = true;
      break;
    }
    const expansion = await source.expand(snapshotId, frontier, {
      direction: query.direction,
      nodeTypes: query.nodeTypes,
      edgeTypes: query.edgeTypes,
      limit: remainingEdges,
    });
    assertActive(context.signal, deadline);
    if (expansion.truncated) graphTruncated = true;

    const candidates = new Map(expansion.nodes.map(node => [node.id, node]));
    const next: string[] = [];
    const nextSeen = new Set<string>();
    for (const edge of expansion.edges) {
      if (edges.size >= REPOSITORY_GRAPH_LIMITS.maxTraversalEdges) {
        graphTruncated = true;
        break;
      }
      const endpoints = [edge.source, edge.target];
      const missing = [...new Set(endpoints.filter(id => !nodes.has(id)))];
      if (nodes.size + missing.length > REPOSITORY_GRAPH_LIMITS.maxTraversalNodes) {
        graphTruncated = true;
        continue;
      }
      const missingNodes = missing.map(id => candidates.get(id));
      if (missingNodes.some(candidate => candidate == null)) continue;
      let complete = true;
      for (const candidate of missingNodes) {
        if (candidate == null || !query.nodeTypes.includes(candidate.type)) {
          complete = false;
          break;
        }
      }
      if (!complete) continue;
      for (const id of missing) {
        const candidate = candidates.get(id)!;
        nodes.set(id, candidate);
        nodeOrder.push(id);
        pushUnique(next, nextSeen, id);
      }
      edges.set(edge.id, edge);
    }
    frontier = next;
  }

  const fingerprint = stableFingerprint(snapshotId, query);
  const offset = decodeCursor(query.cursor, fingerprint);
  if (offset > nodeOrder.length || (offset === nodeOrder.length && nodeOrder.length > 0)) {
    throw new RepositoryGraphValidationError('cursor points past this neighborhood');
  }

  const truncationReasons: RepositoryGraphNeighborhood['truncationReasons'] = [];
  let selectedIds = nodeOrder.slice(offset, offset + query.limit);
  if (offset + selectedIds.length < nodeOrder.length) truncationReasons.push('page_limit');
  if (graphTruncated) truncationReasons.push('graph_limit');
  let selected = new Set(selectedIds);
  let pageEdges = [...edges.values()].filter(edge => selected.has(edge.source) && selected.has(edge.target));

  const build = (): RepositoryGraphNeighborhood => ({
    schemaVersion: 1,
    snapshot,
    query: {
      seed: query.seed,
      q: query.search,
      nodeTypes: query.nodeTypes,
      edgeTypes: query.edgeTypes,
      direction: query.direction,
      depth: query.depth,
      limit: query.limit,
    },
    nodes: selectedIds.map(id => nodes.get(id)!),
    edges: pageEdges,
    truncated: truncationReasons.length > 0,
    truncationReasons,
    nextCursor: offset + selectedIds.length < nodeOrder.length
      ? encodeCursor(offset + selectedIds.length, fingerprint)
      : null,
    appliedLimits: {
      maxDepth: REPOSITORY_GRAPH_LIMITS.maxDepth,
      maxNodes: REPOSITORY_GRAPH_LIMITS.maxTraversalNodes,
      maxEdges: REPOSITORY_GRAPH_LIMITS.maxTraversalEdges,
      maxResponseBytes: REPOSITORY_GRAPH_LIMITS.maxResponseBytes,
      requestedDepth: query.depth,
      requestedLimit: query.limit,
      returnedNodes: selectedIds.length,
      returnedEdges: pageEdges.length,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    },
    authorizedLinks: [],
  });

  let response = build();
  while (responseBytes(response) > REPOSITORY_GRAPH_LIMITS.maxResponseBytes && selectedIds.length > 0) {
    selectedIds = selectedIds.slice(0, -1);
    selected = new Set(selectedIds);
    pageEdges = pageEdges.filter(edge => selected.has(edge.source) && selected.has(edge.target));
    if (!truncationReasons.includes('response_bytes')) truncationReasons.push('response_bytes');
    response = build();
  }
  if (responseBytes(response) > REPOSITORY_GRAPH_LIMITS.maxResponseBytes) {
    throw new RepositoryGraphValidationError('repository graph response exceeds the byte limit', 413);
  }
  return response;
}
