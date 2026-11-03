import { createHash } from 'node:crypto';
import type pg from 'pg';
import { CodeIndexValidationError, normalizeRepositoryPath, persistCodeIndexSnapshot } from './store.js';
import type {
  CodeEdgeProvenance,
  CodeIndexEdgeInput,
  CodeIndexFileInput,
  CodeIndexSnapshot,
  CodeIndexSymbolInput,
  CodeSearchDocumentInput,
  PersistCodeIndexInput,
} from './types.js';

const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_DOCUMENT_BYTES = 1024 * 1024;
const MAX_NODES = 500_000;
const MAX_LINKS = 2_000_000;
const MAX_STRING_LENGTH = 8_192;
const CONTEXT_LINES = 12;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type JsonObject = Record<string, unknown>;

interface GraphifyNode {
  id: string;
  label: string;
  sourceFile: string | null;
  sourceLocation: string | null;
  raw: JsonObject;
}

interface GraphifyLink {
  source: string;
  target: string;
  relation: string;
  raw: JsonObject;
}

interface LoadedFile {
  path: string;
  bytes: Buffer;
  content: string;
  lines: string[];
  contentHash: string;
}

export interface GraphifyAdapterContext {
  repositoryKey: string;
  branchName: string;
  commitSha: string;
  bundleIds: number[];
  parserVersion?: string | null;
  /** Reads a repository-relative file from the exact checked-out commit. */
  readFile(path: string): Promise<Buffer | Uint8Array | string>;
}

function object(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodeIndexValidationError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string, maximum = MAX_STRING_LENGTH): string {
  if (typeof value !== 'string') throw new CodeIndexValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new CodeIndexValidationError(`${field} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function graphifyLabel(value: unknown, field: string, maximum = 512): string {
  if (typeof value !== 'string') throw new CodeIndexValidationError(`${field} must be a string`);
  // Graphify labels may be source-shaped destructuring/import expressions.
  // Collapse formatting whitespace, but keep rejecting non-whitespace control
  // characters and unbounded provider content.
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > maximum || /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new CodeIndexValidationError(`${field} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function optionalString(value: unknown, maximum = MAX_STRING_LENGTH): string | null {
  if (value == null || value === '') return null;
  return requiredString(value, 'Graphify field', maximum);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseRoot(raw: Buffer | Uint8Array | string): JsonObject {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (bytes === 0 || bytes > MAX_GRAPH_BYTES) {
    throw new CodeIndexValidationError(`Graphify graph must contain 1-${MAX_GRAPH_BYTES} bytes`);
  }
  try {
    return object(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')), 'Graphify graph');
  } catch (error) {
    if (error instanceof CodeIndexValidationError) throw error;
    throw new CodeIndexValidationError('Graphify graph is not valid JSON');
  }
}

function parseNodes(root: JsonObject): GraphifyNode[] {
  if (!Array.isArray(root.nodes)) throw new CodeIndexValidationError('Graphify graph.nodes must be an array');
  if (root.nodes.length > MAX_NODES) throw new CodeIndexValidationError(`Graphify graph exceeds ${MAX_NODES} nodes`);
  const seen = new Set<string>();
  return root.nodes.map((value, position) => {
    const raw = object(value, `Graphify nodes[${position}]`);
    const id = requiredString(raw.id, `Graphify nodes[${position}].id`, 2_048);
    if (seen.has(id)) throw new CodeIndexValidationError(`Graphify node id is duplicated: ${id}`);
    seen.add(id);
    return {
      id,
      label: graphifyLabel(raw.label ?? raw.name ?? id, `Graphify nodes[${position}].label`),
      sourceFile: optionalString(raw.source_file, 4_096),
      sourceLocation: optionalString(raw.source_location, 128),
      raw,
    };
  });
}

function parseLinks(root: JsonObject, nodeIds: Set<string>): GraphifyLink[] {
  if (!Array.isArray(root.links)) throw new CodeIndexValidationError('Graphify graph.links must be an array');
  if (root.links.length > MAX_LINKS) throw new CodeIndexValidationError(`Graphify graph exceeds ${MAX_LINKS} links`);
  return root.links.map((value, position) => {
    const raw = object(value, `Graphify links[${position}]`);
    const source = requiredString(raw.source, `Graphify links[${position}].source`, 2_048);
    const target = requiredString(raw.target, `Graphify links[${position}].target`, 2_048);
    if (!nodeIds.has(source) || !nodeIds.has(target)) {
      throw new CodeIndexValidationError(`Graphify link ${source} -> ${target} references an unknown node`);
    }
    return {
      source,
      target,
      relation: requiredString(raw.relation ?? raw.type ?? 'references', `Graphify links[${position}].relation`, 128),
      raw,
    };
  });
}

function normalizeRelation(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!normalized) return 'REFERENCES';
  return normalized.slice(0, 64).replace(/_+$/g, '') || 'REFERENCES';
}

function edgeProvenance(value: unknown): CodeEdgeProvenance {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'inferred') return 'inferred';
  if (normalized === 'ambiguous') return 'ambiguous';
  if (normalized === 'runtime') return 'runtime';
  return 'extracted';
}

function confidence(raw: JsonObject): number {
  const candidate = typeof raw.confidence_score === 'number'
    ? raw.confidence_score
    : typeof raw.weight === 'number' ? raw.weight : 1;
  if (!Number.isFinite(candidate)) return 1;
  return Math.max(0, Math.min(1, candidate));
}

function safeMetadata(raw: JsonObject, fields: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field];
    if (typeof value === 'string' && value.length <= 2_048 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
      result[field] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      result[field] = value;
    } else if (typeof value === 'boolean') {
      result[field] = value;
    }
  }
  return result;
}

function parseLocation(value: string | null): { startLine: number; endLine: number } {
  if (value == null) return { startLine: 1, endLine: 1 };
  const match = /^L?(\d+)(?:\s*[-:]\s*L?(\d+))?$/i.exec(value.trim());
  if (!match) return { startLine: 1, endLine: 1 };
  const startLine = Math.max(1, Number(match[1]));
  const endLine = Math.max(startLine, Number(match[2] ?? match[1]));
  return { startLine, endLine };
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'c', cc: 'cpp', cpp: 'cpp', cs: 'csharp', css: 'css',
  go: 'go', h: 'c', hpp: 'cpp', html: 'html', java: 'java',
  js: 'javascript', json: 'json', jsx: 'javascript', kt: 'kotlin',
  md: 'markdown', mjs: 'javascript', php: 'php', py: 'python',
  rb: 'ruby', rs: 'rust', sh: 'shell', sql: 'sql', swift: 'swift',
  ts: 'typescript', tsx: 'typescript', vue: 'vue', yaml: 'yaml', yml: 'yaml',
};

function languageFor(path: string): string | null {
  const extension = path.includes('.') ? path.split('.').at(-1)!.toLowerCase() : '';
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

function fileStem(path: string): string {
  return (path.split('/').at(-1) ?? '').split('.')[0]!.toLowerCase();
}

function isTestFile(path: string): boolean {
  return /(^|\/)(?:test|tests|__tests__)(?:\/|$)/iu.test(path)
    || /\.(?:test|spec)\.[^/]+$/iu.test(path);
}

function isProductionFile(path: string): boolean {
  return /^(?:src|lib|app|packages)\//u.test(path) && !isTestFile(path);
}

function fileRootSymbol(symbols: CodeIndexSymbolInput[], path: string): CodeIndexSymbolInput | null {
  const candidates = symbols.filter(symbol => symbol.filePath === path);
  candidates.sort((left, right) => {
    const score = (symbol: CodeIndexSymbolInput): number => {
      if (symbol.kind === 'file') return 0;
      if (symbol.name === path) return 1;
      if (symbol.startLine === 1) return 2;
      return 3;
    };
    return score(left) - score(right) || left.startLine - right.startLine || left.key.localeCompare(right.key);
  });
  return candidates[0] ?? null;
}

function symbolKind(node: GraphifyNode): string {
  for (const field of ['kind', 'node_type', 'type']) {
    const value = node.raw[field];
    if (typeof value === 'string') {
      const normalized = value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_').replace(/^_+|_+$/g, '');
      if (normalized) return normalized.slice(0, 64).replace(/_+$/g, '') || 'symbol';
    }
  }
  const baseName = node.sourceFile?.split('/').at(-1)?.toLowerCase();
  if (baseName === node.label.toLowerCase()) return 'file';
  if (/\(.*\)$/.test(node.label)) return 'function';
  if (node.raw.file_type === 'document') return 'document';
  if (node.raw.file_type === 'config') return 'property';
  return 'symbol';
}

function trimUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value;
  let bytes = Buffer.from(value, 'utf8').subarray(0, maximumBytes);
  let decoded = bytes.toString('utf8');
  while (decoded.endsWith('\uFFFD') && bytes.length > 0) {
    bytes = bytes.subarray(0, bytes.length - 1);
    decoded = bytes.toString('utf8');
  }
  return decoded;
}

function sourceContext(file: LoadedFile, startLine: number, endLine: number): string {
  const from = Math.max(0, startLine - 1 - CONTEXT_LINES);
  const to = Math.min(file.lines.length, endLine + CONTEXT_LINES);
  return file.lines.slice(from, to).map((line, index) => `${from + index + 1}: ${line}`).join('\n');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalDigest(input: Omit<PersistCodeIndexInput, 'sourceGraphDigest'>): string {
  return sha256(stableJson({
    repositoryKey: input.repositoryKey,
    branchName: input.branchName,
    commitSha: input.commitSha,
    provider: input.provider,
    graphSchemaVersion: input.graphSchemaVersion,
    files: [...input.files].sort((a, b) => a.path.localeCompare(b.path))
      .map(file => ({ path: file.path, contentHash: file.contentHash })),
    symbols: [...input.symbols].sort((a, b) => a.key.localeCompare(b.key))
      .map(symbol => ({ key: symbol.key, filePath: symbol.filePath, name: symbol.name,
        qualifiedName: symbol.qualifiedName, kind: symbol.kind, startLine: symbol.startLine, endLine: symbol.endLine })),
    edges: [...input.edges].sort((a, b) =>
      `${a.sourceKey}\u0000${a.targetKey}\u0000${a.relation}\u0000${a.provenance}`
        .localeCompare(`${b.sourceKey}\u0000${b.targetKey}\u0000${b.relation}\u0000${b.provenance}`))
      .map(edge => ({ sourceKey: edge.sourceKey, targetKey: edge.targetKey,
        relation: edge.relation, provenance: edge.provenance, confidence: edge.confidence })),
  }));
}

async function loadFiles(paths: string[], readFile: GraphifyAdapterContext['readFile']): Promise<Map<string, LoadedFile>> {
  const result = new Map<string, LoadedFile>();
  for (const path of [...paths].sort()) {
    let raw: Buffer | Uint8Array | string;
    try {
      raw = await readFile(path);
    } catch (error) {
      throw new CodeIndexValidationError(`Unable to read indexed source file ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
    const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new CodeIndexValidationError(`Indexed source file ${path} exceeds ${MAX_SOURCE_BYTES} bytes`);
    }
    const content = bytes.toString('utf8');
    result.set(path, { path, bytes, content, lines: content.split(/\r?\n/), contentHash: sha256(bytes) });
  }
  return result;
}

/**
 * Converts untrusted Graphify node-link JSON into the immutable Argus model.
 * Source content is read through a caller-supplied commit-bound workspace API.
 */
export async function normalizeGraphifyGraph(
  rawGraph: Buffer | Uint8Array | string,
  context: GraphifyAdapterContext,
): Promise<PersistCodeIndexInput> {
  const root = parseRoot(rawGraph);
  const commitSha = requiredString(context.commitSha, 'commitSha', 64).toLowerCase();
  if (!GIT_SHA.test(commitSha)) throw new CodeIndexValidationError('commitSha must be a full Git SHA-1 or SHA-256');
  const builtAtCommit = requiredString(root.built_at_commit, 'Graphify built_at_commit', 64).toLowerCase();
  if (builtAtCommit !== commitSha) {
    throw new CodeIndexValidationError(`Graphify commit ${builtAtCommit} does not match requested commit ${commitSha}`);
  }

  const nodes = parseNodes(root);
  const rawNodeIds = new Set(nodes.map(node => node.id));
  const links = parseLinks(root, rawNodeIds);
  const includedNodes = nodes.filter(node => node.sourceFile != null);
  if (includedNodes.length === 0) throw new CodeIndexValidationError('Graphify graph contains no repository-backed nodes');

  const normalizedPaths = new Map<string, string>();
  for (const node of includedNodes) {
    normalizedPaths.set(node.id, normalizeRepositoryPath(node.sourceFile!));
  }
  const loadedFiles = await loadFiles([...new Set(normalizedPaths.values())], context.readFile);

  const files: CodeIndexFileInput[] = [...loadedFiles.values()].map(file => ({
    path: file.path,
    language: languageFor(file.path),
    contentHash: file.contentHash,
    byteSize: file.bytes.byteLength,
    lineCount: file.content.length === 0 ? 0 : file.lines.length,
    metadata: { provider: 'graphify' },
  }));

  const symbols: CodeIndexSymbolInput[] = includedNodes.map(node => {
    const filePath = normalizedPaths.get(node.id)!;
    const location = parseLocation(node.sourceLocation);
    const kind = symbolKind({ ...node, sourceFile: filePath });
    const key = `graphify:${node.id}`;
    return {
      key,
      filePath,
      name: node.label.replace(/\(\)$/u, '') || node.label,
      qualifiedName: `${filePath}#${node.id}`,
      kind,
      signature: /\(.*\)$/u.test(node.label) ? node.label : null,
      startLine: location.startLine,
      endLine: location.endLine,
      metadata: safeMetadata(node.raw, ['file_type', '_origin', 'community', 'community_name', 'norm_label']),
    };
  });
  const includedIds = new Set(includedNodes.map(node => node.id));
  const edgeIdentities = new Set<string>();
  const edges: CodeIndexEdgeInput[] = [];
  const pushEdge = (edge: CodeIndexEdgeInput): boolean => {
    const identity = `${edge.sourceKey}\u0000${edge.targetKey}\u0000${edge.relation}\u0000${edge.provenance}`;
    if (edgeIdentities.has(identity)) return false;
    edgeIdentities.add(identity);
    edges.push(edge);
    return true;
  };
  for (const link of links) {
    if (!includedIds.has(link.source) || !includedIds.has(link.target)) continue;
    const edge: CodeIndexEdgeInput = {
      sourceKey: `graphify:${link.source}`,
      targetKey: `graphify:${link.target}`,
      relation: normalizeRelation(link.relation),
      provenance: edgeProvenance(link.raw.confidence),
      confidence: confidence(link.raw),
      metadata: safeMetadata(link.raw, ['_origin', 'context', 'source_file', 'source_location']),
    };
    pushEdge(edge);
  }
  const normalizedProviderEdgeCount = edges.length;
  const productionFilesByStem = new Map<string, CodeIndexFileInput[]>();
  for (const file of files.filter(item => isProductionFile(item.path))) {
    const stem = fileStem(file.path);
    const matches = productionFilesByStem.get(stem) ?? [];
    matches.push(file);
    productionFilesByStem.set(stem, matches);
  }
  let inferredTestEdgeCount = 0;
  for (const testFile of files.filter(item => isTestFile(item.path)).sort((a, b) => a.path.localeCompare(b.path))) {
    const sourceFiles = productionFilesByStem.get(fileStem(testFile.path)) ?? [];
    if (sourceFiles.length !== 1) continue;
    const sourceFile = sourceFiles[0]!;
    const testRoot = fileRootSymbol(symbols, testFile.path);
    const sourceRoot = fileRootSymbol(symbols, sourceFile.path);
    if (testRoot === null || sourceRoot === null) continue;
    if (pushEdge({
      sourceKey: testRoot.key,
      targetKey: sourceRoot.key,
      relation: 'TESTS',
      provenance: 'inferred',
      confidence: /\.(?:test|spec)\.[^/]+$/iu.test(testFile.path) ? 0.95 : 0.8,
      metadata: {
        inference: 'matching_file_stem',
        testFile: testFile.path,
        sourceFile: sourceFile.path,
      },
    })) inferredTestEdgeCount += 1;
  }

  const documents: CodeSearchDocumentInput[] = [];
  for (const file of loadedFiles.values()) {
    if (file.content.length > 0) {
      documents.push({
        filePath: file.path,
        chunkKind: 'file',
        content: trimUtf8(file.content, MAX_FILE_DOCUMENT_BYTES),
        metadata: { language: languageFor(file.path), truncated: file.bytes.byteLength > MAX_FILE_DOCUMENT_BYTES },
      });
    }
  }
  for (const symbol of symbols) {
    const file = loadedFiles.get(symbol.filePath)!;
    const header = `${symbol.kind} ${symbol.qualifiedName}${symbol.signature ? `\nSignature: ${symbol.signature}` : ''}`;
    const contextText = sourceContext(file, symbol.startLine, symbol.endLine);
    documents.push({
      filePath: symbol.filePath,
      symbolKey: symbol.key,
      chunkKind: 'symbol',
      content: trimUtf8(`${header}\n${contextText}`, MAX_FILE_DOCUMENT_BYTES),
      metadata: { startLine: symbol.startLine, endLine: symbol.endLine },
    });
  }

  const skippedNodeCount = nodes.length - includedNodes.length;
  const skippedLinkCount = links.length - normalizedProviderEdgeCount;
  const withoutDigest: Omit<PersistCodeIndexInput, 'sourceGraphDigest'> = {
    repositoryKey: requiredString(context.repositoryKey, 'repositoryKey', 512),
    branchName: requiredString(context.branchName, 'branchName', 255),
    commitSha,
    bundleIds: context.bundleIds,
    provider: 'graphify',
    parserVersion: context.parserVersion == null ? null : requiredString(context.parserVersion, 'parserVersion', 128),
    graphSchemaVersion: 'argus-graphify-v3',
    metadata: {
      directed: root.directed === true,
      multigraph: root.multigraph === true,
      skippedNodeCount,
      skippedLinkCount,
      inferredTestEdgeCount,
    },
    files,
    symbols,
    edges,
    documents,
  };
  return { ...withoutDigest, sourceGraphDigest: canonicalDigest(withoutDigest) };
}

export async function persistGraphifyCodeIndex(
  pool: pg.Pool,
  rawGraph: Buffer | Uint8Array | string,
  context: GraphifyAdapterContext,
): Promise<CodeIndexSnapshot> {
  return persistCodeIndexSnapshot(pool, await normalizeGraphifyGraph(rawGraph, context));
}
