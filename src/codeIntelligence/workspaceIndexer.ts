import type pg from 'pg';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { loadBundleCapabilities } from '../solutionPacks/bundleCapabilities.js';
import { codeEmbeddingConfig, embedCodeIndexDocuments } from './embeddings.js';
import { normalizeGraphifyGraph } from './graphifyAdapter.js';
import { searchCodeIndex } from './retrieval.js';
import {
  authorizeCodeIndexSnapshot,
  CodeIndexValidationError,
  findReadyCodeIndexByCommit,
  isCodeIndexSnapshotAuthorized,
  persistCodeIndexSnapshot,
} from './store.js';
import type { CodeIndexSnapshot } from './types.js';
import type { CodeEvidence, CodeRetrievalChannel } from './types.js';

const EXACT_WORKSPACE = /^\/workspace\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_METADATA_RESPONSE = 64 * 1024;
const MAX_GRAPH_RESPONSE = 72 * 1024 * 1024;
const MAX_SOURCE_RESPONSE = 15 * 1024 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;

interface WorkspaceMetadata {
  commit_sha: string;
  branch_name: string;
  repository_key: string | null;
}

interface WorkspaceGraphifyExport extends WorkspaceMetadata {
  parser_version: string | null;
  graph: unknown;
}

interface WorkspaceSource {
  content: string;
  encoding: 'base64';
  size_bytes: number;
}

export interface NativeWorkspaceIndexInput {
  workspaceRoot: string;
  /** Optional expected identity; Git remote.origin remains authoritative. */
  repositoryKey?: string | null;
  branchHint?: string | null;
  executionBundleIds: number[];
}

export interface NativeWorkspaceCodeContextInput extends NativeWorkspaceIndexInput {
  query: string;
  limit?: number;
  maxBytes?: number;
  /** Signed run policy: baseline disables only the vector channel. */
  retrievalVariant?: 'baseline' | 'candidate';
}

export interface NativeWorkspaceCodeContextEvidence {
  citation: string;
  filePath: string;
  symbol: string | null;
  kind: string | null;
  startLine: number | null;
  endLine: number | null;
  channels: CodeRetrievalChannel[];
  graphRelations: string[];
  content: string;
  truncated: boolean;
}

export interface NativeWorkspaceCodeContext {
  snapshot: Pick<CodeIndexSnapshot,
    'id' | 'repositoryKey' | 'branchName' | 'commitSha' | 'provider'
    | 'fileCount' | 'symbolCount' | 'edgeCount' | 'documentCount'>;
  query: string;
  channelsUsed: CodeRetrievalChannel[];
  evidence: NativeWorkspaceCodeContextEvidence[];
}

export interface NativeCodeBundleAccess {
  canRead: boolean;
  canIndex: boolean;
  repositoryBundleIds: number[];
}

/**
 * Resolve the two independent Code Intelligence permissions carried by an
 * execution grant. Read permits retrieval from an already-authorized,
 * immutable snapshot. Index permits Core to inspect the workspace and create
 * (or authorize) a new snapshot. Keeping these bits separate prevents a Read
 * bundle from accidentally triggering an indexing attempt.
 */
export async function resolveNativeCodeBundleAccess(
  pool: pg.Pool,
  bundleIds: number[],
): Promise<NativeCodeBundleAccess> {
  const capabilities = await loadBundleCapabilities(pool, bundleIds);
  return {
    canRead: capabilities.some(bundle => bundle.bundleName === 'argus-code-intelligence-read'),
    canIndex: capabilities.some(bundle => bundle.bundleName === 'argus-code-intelligence-index'),
    repositoryBundleIds: capabilities
      .filter(bundle => bundle.bundleName !== 'argus-code-intelligence-read'
        && bundle.bundleName !== 'argus-code-intelligence-index'
        && bundle.categories.includes('repository'))
      .map(bundle => bundle.bundleId),
  };
}

/** Expected absence is not an execution failure: a Read-only run may have no
 * exact-commit snapshot yet because only an Index-authorized run can create it. */
export class NativeCodeIndexUnavailableError extends CodeIndexValidationError {}

function workspaceBaseUrl(): string {
  return AGENT_WORKSPACE_URL.replace(/\/+$/, '');
}

async function postJson<T>(path: string, body: Record<string, unknown>, timeoutMs: number, maximumBytes: number): Promise<T> {
  const response = await fetch(`${workspaceBaseUrl()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Secret': WORKSPACE_SECRET },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new CodeIndexValidationError(`workspace response exceeds ${maximumBytes} bytes`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maximumBytes) {
    throw new CodeIndexValidationError(`workspace response exceeds ${maximumBytes} bytes`);
  }
  let payload: unknown;
  try { payload = JSON.parse(text); }
  catch { throw new CodeIndexValidationError('workspace returned invalid JSON'); }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && typeof (payload as { error?: unknown }).error === 'string'
      ? (payload as { error: string }).error.slice(0, 500)
      : `HTTP ${response.status}`;
    throw new CodeIndexValidationError(`workspace code index request failed: ${message}`);
  }
  return payload as T;
}

function assertWorkspaceRoot(value: string): string {
  if (!EXACT_WORKSPACE.test(value)) {
    throw new CodeIndexValidationError('workspaceRoot must be one exact child of /workspace');
  }
  return value;
}

function assertRepositoryKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new CodeIndexValidationError('repositoryKey is invalid');
  }
  return normalized;
}

export async function fetchWorkspaceCodeMetadata(
  workspaceRoot: string,
  branchHint?: string | null,
): Promise<WorkspaceMetadata> {
  return postJson<WorkspaceMetadata>('/code-index/metadata', {
    workspace_root: assertWorkspaceRoot(workspaceRoot),
    ...(branchHint ? { branch_hint: branchHint } : {}),
  }, 20_000, MAX_METADATA_RESPONSE);
}

export async function fetchWorkspaceGraphifyExport(
  workspaceRoot: string,
  branchHint?: string | null,
): Promise<WorkspaceGraphifyExport> {
  return postJson<WorkspaceGraphifyExport>('/code-index/graphify', {
    workspace_root: assertWorkspaceRoot(workspaceRoot),
    ...(branchHint ? { branch_hint: branchHint } : {}),
  }, 330_000, MAX_GRAPH_RESPONSE);
}

export async function fetchWorkspaceSource(workspaceRoot: string, filePath: string): Promise<Buffer> {
  const payload = await postJson<WorkspaceSource>('/code-index/source', {
    workspace_root: assertWorkspaceRoot(workspaceRoot),
    path: filePath,
  }, 30_000, MAX_SOURCE_RESPONSE);
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string'
    || !Number.isSafeInteger(payload.size_bytes) || payload.size_bytes < 0 || payload.size_bytes > MAX_SOURCE_BYTES) {
    throw new CodeIndexValidationError('workspace returned an invalid source envelope');
  }
  const content = Buffer.from(payload.content, 'base64');
  if (content.byteLength !== payload.size_bytes) {
    throw new CodeIndexValidationError('workspace source size does not match its envelope');
  }
  return content;
}

function authorizedIndexScope(access: NativeCodeBundleAccess): { repositoryBundleIds: number[] } {
  if (!access.canIndex) {
    throw new CodeIndexValidationError('native code indexing requires the argus-code-intelligence-index MCP Bundle');
  }
  return { repositoryBundleIds: access.repositoryBundleIds };
}

async function authorizedReadScope(pool: pg.Pool, bundleIds: number[]): Promise<NativeCodeBundleAccess> {
  const access = await resolveNativeCodeBundleAccess(pool, bundleIds);
  if (!access.canRead) {
    throw new CodeIndexValidationError('native code context requires the argus-code-intelligence-read MCP Bundle');
  }
  if (access.repositoryBundleIds.length === 0) {
    throw new CodeIndexValidationError('no repository-capable MCP Bundle is authorized for native code context');
  }
  return access;
}

async function exactWorkspaceIdentity(
  workspaceRoot: string,
  repositoryKey: string | null | undefined,
  branchHint: string | null | undefined,
): Promise<{ repositoryKey: string; branchName: string; commitSha: string }> {
  const metadata = await fetchWorkspaceCodeMetadata(workspaceRoot, branchHint);
  const resolvedRepositoryKey = assertRepositoryKey(metadata.repository_key ?? repositoryKey ?? '');
  if (metadata.repository_key && repositoryKey
    && assertRepositoryKey(repositoryKey).toLowerCase() !== resolvedRepositoryKey.toLowerCase()) {
    throw new CodeIndexValidationError('workspace Git remote does not match the requested repository identity');
  }
  return {
    repositoryKey: resolvedRepositoryKey,
    branchName: metadata.branch_name,
    commitSha: metadata.commit_sha,
  };
}

function boundedEvidence(item: CodeEvidence, contentBudgetBytes: number): NativeWorkspaceCodeContextEvidence | null {
  if (contentBudgetBytes < 64) return null;
  const maximumContentBytes = Math.min(4_000, contentBudgetBytes);
  const source = Buffer.from(item.content, 'utf8');
  const truncated = source.byteLength > maximumContentBytes;
  const content = truncated
    ? `${source.subarray(0, Math.max(0, maximumContentBytes - 32)).toString('utf8')}\n... [TRUNCATED]`
    : item.content;
  return {
    citation: `${item.repositoryKey}@${item.commitSha}:${item.filePath}${item.startLine == null ? '' : `#L${item.startLine}-L${item.endLine}`}`,
    filePath: item.filePath,
    symbol: item.qualifiedName,
    kind: item.symbolKind,
    startLine: item.startLine,
    endLine: item.endLine,
    channels: item.channels,
    graphRelations: item.graphRelations,
    content,
    truncated,
  };
}

/**
 * Give every ranked result an equal source budget. A large first file chunk
 * must not hide a lower-ranked implementation/test relation from the Agent.
 */
export function boundNativeCodeEvidence(
  items: readonly CodeEvidence[],
  requestedBytes: number,
): NativeWorkspaceCodeContextEvidence[] {
  if (items.length === 0) return [];
  const perResultBytes = Math.floor(requestedBytes / items.length);
  return items
    .map(item => boundedEvidence(item, perResultBytes))
    .filter((item): item is NativeWorkspaceCodeContextEvidence => item !== null);
}

/**
 * Build or reuse the Graphify snapshot for one signed Dev workspace. Indexing
 * is Core-owned; no model can select another workspace root or widen Bundles.
 */
export async function ensureNativeWorkspaceCodeIndex(
  pool: pg.Pool,
  input: NativeWorkspaceIndexInput,
  resolvedAccess?: NativeCodeBundleAccess,
): Promise<CodeIndexSnapshot> {
  const workspaceRoot = assertWorkspaceRoot(input.workspaceRoot);
  const access = resolvedAccess ?? await resolveNativeCodeBundleAccess(pool, input.executionBundleIds);
  const { repositoryBundleIds: authorizedBundleIds } = authorizedIndexScope(access);
  if (authorizedBundleIds.length === 0) {
    throw new CodeIndexValidationError('no repository-capable MCP Bundle is authorized for native code indexing');
  }

  const identity = await exactWorkspaceIdentity(workspaceRoot, input.repositoryKey, input.branchHint);
  const { repositoryKey } = identity;
  const embedding = codeEmbeddingConfig();
  const existing = await findReadyCodeIndexByCommit(
    pool, repositoryKey, identity.branchName, identity.commitSha, 'graphify', 'argus-graphify-v3', embedding.identity,
  );
  if (existing) {
    await authorizeCodeIndexSnapshot(pool, existing.id, authorizedBundleIds);
    logger.info({ snapshotId: existing.id, repositoryKey, commitSha: existing.commitSha },
      'Native code index reused for exact workspace commit');
    return existing;
  }

  const exported = await fetchWorkspaceGraphifyExport(workspaceRoot, input.branchHint);
  const exportedRepositoryKey = assertRepositoryKey(exported.repository_key ?? input.repositoryKey ?? '');
  if (exported.commit_sha !== identity.commitSha || exported.branch_name !== identity.branchName
    || exportedRepositoryKey.toLowerCase() !== repositoryKey.toLowerCase()) {
    throw new CodeIndexValidationError('workspace Git identity changed while Graphify was indexing');
  }
  const normalized = await normalizeGraphifyGraph(JSON.stringify(exported.graph), {
    repositoryKey,
    branchName: exported.branch_name,
    commitSha: exported.commit_sha,
    bundleIds: authorizedBundleIds,
    parserVersion: exported.parser_version,
    readFile: filePath => fetchWorkspaceSource(workspaceRoot, filePath),
  });
  const enriched = await embedCodeIndexDocuments(normalized, embedding);
  const snapshot = await persistCodeIndexSnapshot(pool, enriched);
  logger.info({
    snapshotId: snapshot.id, repositoryKey, branchName: snapshot.branchName,
    commitSha: snapshot.commitSha, files: snapshot.fileCount, symbols: snapshot.symbolCount,
    edges: snapshot.edgeCount, embeddingModel: snapshot.embeddingModel,
  }, 'Native code index persisted from exact workspace commit');
  return snapshot;
}

/**
 * Return bounded, commit-cited code evidence for a direct subscription
 * runtime. Read-only grants can reuse an exact-commit snapshot, but only a
 * grant carrying the Index bundle may create or authorize one.
 */
export async function buildNativeWorkspaceCodeContext(
  pool: pg.Pool,
  input: NativeWorkspaceCodeContextInput,
): Promise<NativeWorkspaceCodeContext> {
  const requestedBytes = input.maxBytes ?? 24_000;
  if (!Number.isSafeInteger(requestedBytes) || requestedBytes < 1_024 || requestedBytes > 24_000) {
    throw new CodeIndexValidationError('native code context maxBytes must be an integer from 1024 to 24000');
  }
  const access = await authorizedReadScope(pool, input.executionBundleIds);
  let snapshot: CodeIndexSnapshot | null;
  if (access.canIndex) {
    snapshot = await ensureNativeWorkspaceCodeIndex(pool, input, access);
  } else {
    const workspaceRoot = assertWorkspaceRoot(input.workspaceRoot);
    const identity = await exactWorkspaceIdentity(workspaceRoot, input.repositoryKey, input.branchHint);
    const embedding = codeEmbeddingConfig();
    snapshot = await findReadyCodeIndexByCommit(
      pool,
      identity.repositoryKey,
      identity.branchName,
      identity.commitSha,
      'graphify',
      'argus-graphify-v3',
      embedding.identity,
    );
    if (!snapshot) {
      throw new NativeCodeIndexUnavailableError(
        'no ready native code index exists for the exact workspace commit; an Index-authorized run must create it first',
      );
    }
    if (!await isCodeIndexSnapshotAuthorized(pool, snapshot.id, access.repositoryBundleIds)) {
      throw new NativeCodeIndexUnavailableError(
        'no ready native code index is authorized for the selected repository Bundle',
      );
    }
  }
  const result = await searchCodeIndex(pool, {
    snapshotId: snapshot.id,
    query: input.query,
    limit: Math.min(8, Math.max(1, input.limit ?? 6)),
    strategy: 'hybrid_graph',
    // An explicit null suppresses automatic query embedding while retaining
    // exact, lexical and graph retrieval over the identical candidate index.
    ...(input.retrievalVariant === 'baseline' ? { embedding: null } : {}),
    allowedBundleIds: input.executionBundleIds,
  });
  const evidence = boundNativeCodeEvidence(result.evidence, requestedBytes);
  return {
    snapshot: {
      id: snapshot.id,
      repositoryKey: snapshot.repositoryKey,
      branchName: snapshot.branchName,
      commitSha: snapshot.commitSha,
      provider: snapshot.provider,
      fileCount: snapshot.fileCount,
      symbolCount: snapshot.symbolCount,
      edgeCount: snapshot.edgeCount,
      documentCount: snapshot.documentCount,
    },
    query: result.query,
    channelsUsed: result.channelsUsed,
    evidence,
  };
}
