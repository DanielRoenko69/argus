export type RepositoryGraphNodeType = 'file' | 'symbol';
export type RepositoryGraphVisualNodeType = RepositoryGraphNodeType | 'repository' | 'module';
export type RepositoryGraphDirection = 'inbound' | 'outbound' | 'both';
export type RepositoryGraphEntry = { kind: 'seed' | 'search'; value: string };

export interface RepositoryGraphSnapshot {
  id: string;
  repository: string;
  branch: string;
  commitSha: string;
  graphDigest: string;
  provider: string;
  parserVersion: string | null;
  schemaVersion: string;
  status: string;
  immutable: true;
}

export interface RepositoryGraphNode {
  id: string;
  type: RepositoryGraphVisualNodeType;
  label: string;
  href: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface RepositoryGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface RepositoryGraphNeighborhood {
  schemaVersion: 1;
  snapshot: RepositoryGraphSnapshot;
  query: {
    seed: string | null;
    q: string | null;
    nodeTypes: RepositoryGraphNodeType[];
    edgeTypes: string[];
    direction: RepositoryGraphDirection;
    depth: number;
    limit: number;
  };
  nodes: RepositoryGraphNode[];
  edges: RepositoryGraphEdge[];
  truncated: boolean;
  truncationReasons: Array<'page_limit' | 'graph_limit' | 'response_bytes'>;
  nextCursor: string | null;
  appliedLimits: {
    maxDepth: number;
    maxNodes: number;
    maxEdges: number;
    maxResponseBytes: number;
    requestedDepth: number;
    requestedLimit: number;
    returnedNodes: number;
    returnedEdges: number;
    elapsedMs: number;
  };
  authorizedLinks: Array<{ kind: string; label: string; href: string }>;
}

export interface RepositoryGraphRequest {
  snapshotId: string;
  entry: RepositoryGraphEntry;
  nodeTypes: RepositoryGraphNodeType[];
  edgeTypes: string[];
  direction: RepositoryGraphDirection;
  depth: number;
  limit: number;
  cursor?: string;
}

export type RepositoryGraphLoader = (
  request: RepositoryGraphRequest,
  signal: AbortSignal,
) => Promise<RepositoryGraphNeighborhood>;

export interface RepositoryGraphFiltersState {
  nodeTypes: RepositoryGraphNodeType[];
  edgeTypes: string[];
  direction: RepositoryGraphDirection;
  depth: number;
}

export interface RepositoryGraphOverviewModule {
  id: string;
  path: string;
  fileCount: number;
  symbolCount: number;
  documentCount: number;
  testFileCount: number;
  languages: Record<string, number>;
}

export interface RepositoryGraphOverviewDependency {
  id: string;
  source: string;
  target: string;
  relationCount: number;
  relations: string[];
}

export interface RepositoryGraphOverview {
  schemaVersion: 1;
  snapshot: RepositoryGraphSnapshot;
  totals: {
    files: number;
    symbols: number;
    edges: number;
    documents: number;
    testFiles: number;
    modules: number;
    dependencies: number;
  };
  modules: RepositoryGraphOverviewModule[];
  dependencies: RepositoryGraphOverviewDependency[];
  truncated: boolean;
  appliedLimits: {
    maxModules: number;
    maxDependencies: number;
    maxLanguagesPerModule: number;
    returnedModules: number;
    returnedDependencies: number;
    elapsedMs: number;
  };
}

export type RepositoryGraphOverviewLoader = (
  snapshotId: string,
  signal: AbortSignal,
) => Promise<RepositoryGraphOverview>;

export interface RepositoryFullGraph {
  schemaVersion: 1;
  snapshot: RepositoryGraphSnapshot;
  files: Array<[id: string, path: string, language: string | null, module: string]>;
  symbols: Array<[
    id: string,
    label: string,
    kind: string,
    fileIndex: number,
    startLine: number,
    endLine: number,
  ]>;
  relationTypes: string[];
  edges: Array<[sourceSymbolIndex: number, targetSymbolIndex: number, relationTypeIndex: number]>;
  truncated: boolean;
  truncationReasons: Array<'node_limit' | 'edge_limit'>;
  appliedLimits: {
    maxNodes: number;
    maxEdges: number;
    maxResponseBytes: number;
    returnedNodes: number;
    returnedEdges: number;
    elapsedMs: number;
  };
}

export type RepositoryFullGraphLoader = (
  snapshotId: string,
  signal: AbortSignal,
) => Promise<RepositoryFullGraph>;
