import type { CodeIndexStatus } from './types.js';

export type RepositoryGraphNodeType = 'file' | 'symbol';
export type RepositoryGraphDirection = 'inbound' | 'outbound' | 'both';

export interface RepositoryGraphQuery {
  seed: string | null;
  search: string | null;
  nodeTypes: RepositoryGraphNodeType[];
  edgeTypes: string[];
  direction: RepositoryGraphDirection;
  depth: number;
  limit: number;
  cursor: string | null;
}

export interface RepositoryGraphSnapshot {
  id: string;
  repository: string;
  branch: string;
  commitSha: string;
  graphDigest: string;
  provider: string;
  parserVersion: string | null;
  schemaVersion: string;
  status: CodeIndexStatus;
  immutable: true;
}

export interface RepositoryGraphNode {
  id: string;
  type: RepositoryGraphNodeType;
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

export interface RepositoryGraphAppliedLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxResponseBytes: number;
  requestedDepth: number;
  requestedLimit: number;
  returnedNodes: number;
  returnedEdges: number;
  elapsedMs: number;
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
  appliedLimits: RepositoryGraphAppliedLimits;
  authorizedLinks: Array<{ kind: string; label: string; href: string }>;
}

export interface RepositoryGraphExpansion {
  edges: RepositoryGraphEdge[];
  nodes: RepositoryGraphNode[];
  truncated: boolean;
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

export interface RepositoryGraphOverviewData {
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
}

export interface RepositoryGraphOverview {
  schemaVersion: 1;
  snapshot: RepositoryGraphSnapshot;
  totals: RepositoryGraphOverviewData['totals'];
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

export interface RepositoryFullGraphData {
  files: Array<{ id: string; path: string; language: string | null; module: string }>;
  symbols: Array<{
    id: string;
    fileId: string;
    label: string;
    kind: string;
    startLine: number;
    endLine: number;
  }>;
  edges: Array<{ sourceSymbolId: string; targetSymbolId: string; type: string }>;
  truncated: boolean;
  truncationReasons: Array<'node_limit' | 'edge_limit'>;
}

/** Compact full-graph wire format with index-based relationships. */
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
  truncationReasons: RepositoryFullGraphData['truncationReasons'];
  appliedLimits: {
    maxNodes: number;
    maxEdges: number;
    maxResponseBytes: number;
    returnedNodes: number;
    returnedEdges: number;
    elapsedMs: number;
  };
}
