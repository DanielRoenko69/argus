export type CodeIndexStatus = 'building' | 'ready' | 'failed' | 'superseded';
export type CodeEdgeProvenance = 'extracted' | 'inferred' | 'ambiguous' | 'runtime';

export interface CodeIndexSnapshot {
  id: number;
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  provider: string;
  sourceGraphDigest: string;
  parserVersion: string | null;
  graphSchemaVersion: string | null;
  embeddingModel: string | null;
  status: CodeIndexStatus;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  documentCount: number;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  finishedAt: string | null;
}

export interface CodeIndexFileInput {
  path: string;
  language?: string | null;
  contentHash: string;
  byteSize: number;
  lineCount: number;
  metadata?: Record<string, unknown>;
}

export interface CodeIndexSymbolInput {
  /** Adapter-local stable key used by edges and search documents. */
  key: string;
  filePath: string;
  name: string;
  qualifiedName: string;
  kind: string;
  signature?: string | null;
  startLine: number;
  endLine: number;
  contentHash?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CodeIndexEdgeInput {
  sourceKey: string;
  targetKey: string;
  relation: string;
  provenance?: CodeEdgeProvenance;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

export interface CodeSearchDocumentInput {
  filePath: string;
  symbolKey?: string | null;
  chunkKind: string;
  chunkOrdinal?: number;
  content: string;
  contentHash?: string;
  embedding?: number[] | null;
  metadata?: Record<string, unknown>;
}

export interface PersistCodeIndexInput {
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  /** MCP Bundles whose repository authorization produced this snapshot. */
  bundleIds: number[];
  provider: string;
  sourceGraphDigest: string;
  parserVersion?: string | null;
  graphSchemaVersion: string;
  embeddingModel?: string | null;
  metadata?: Record<string, unknown>;
  files: CodeIndexFileInput[];
  symbols: CodeIndexSymbolInput[];
  edges: CodeIndexEdgeInput[];
  documents: CodeSearchDocumentInput[];
}

export type CodeRetrievalChannel = 'exact' | 'lexical' | 'vector' | 'graph';
export type CodeRetrievalStrategy = 'lexical' | 'vector' | 'hybrid' | 'hybrid_graph';

export interface CodeEvidenceScores {
  exact?: number;
  lexical?: number;
  vector?: number;
  graph?: number;
  fused: number;
}

export interface CodeEvidence {
  documentId: number;
  snapshotId: number;
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  filePath: string;
  symbolId: number | null;
  symbolName: string | null;
  qualifiedName: string | null;
  symbolKind: string | null;
  startLine: number | null;
  endLine: number | null;
  chunkKind: string;
  content: string;
  channels: CodeRetrievalChannel[];
  scores: CodeEvidenceScores;
  graphRelations: string[];
}

export interface CodeSearchInput {
  snapshotId: number;
  query: string;
  limit?: number;
  /** Explicit benchmark/runtime strategy. Defaults to hybrid_graph. */
  strategy?: CodeRetrievalStrategy;
  embedding?: number[] | null;
  includeGraph?: boolean;
  /** null is reserved for an authenticated unrestricted administrator. */
  allowedBundleIds?: number[] | null;
}

export interface CodeSearchResult {
  snapshot: CodeIndexSnapshot;
  query: string;
  evidence: CodeEvidence[];
  channelsUsed: CodeRetrievalChannel[];
}

export interface RunCodeEvidenceCitation {
  filePath: string;
  symbolName: string | null;
  startLine: number | null;
  endLine: number | null;
  chunkKind: string | null;
  channels: CodeRetrievalChannel[];
  fusedScore: number | null;
}

export interface RunCodeSnapshotEvidence {
  snapshotId: number;
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  provider: string;
  fileCount: number | null;
  symbolCount: number | null;
  edgeCount: number | null;
  documentCount: number | null;
  traceId: string;
  spanId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  observedAt: string;
}

export interface RunCodeRetrievalEvidence {
  traceId: string;
  spanId: string;
  agentId: number | null;
  agentName: string | null;
  runtimeTraceId: string | null;
  taskType: string | null;
  snapshotId: number | null;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  durationMs: number | null;
  evidenceCount: number;
  channels: CodeRetrievalChannel[];
  citations: RunCodeEvidenceCitation[];
  observedAt: string;
  error: string | null;
}

/** Source-free, trace-scoped evidence safe to expose in the operations UI. */
export interface RunCodeIntelligenceEvidence {
  mode: 'metadata_only' | 'local_retrieval';
  snapshots: RunCodeSnapshotEvidence[];
  retrievals: RunCodeRetrievalEvidence[];
}
