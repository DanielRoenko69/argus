import { createHash } from 'node:crypto';
import type pg from 'pg';
import { logger } from '../lib/logger.js';
import type {
  CodeEdgeProvenance,
  CodeIndexSnapshot,
  PersistCodeIndexInput,
} from './types.js';

const MAX_FILES = 50_000;
const MAX_SYMBOLS = 500_000;
const MAX_EDGES = 2_000_000;
const MAX_DOCUMENTS = 500_000;
const MAX_METADATA_BYTES = 65_536;
const MAX_DOCUMENT_BYTES = 1_048_576;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROVIDER = /^[a-z][a-z0-9_-]{0,63}$/;
const TOKEN = /^[a-z][a-z0-9_.:-]{0,63}$/i;
const RELATION = /^[A-Z][A-Z0-9_]{0,63}$/;

type SnapshotRow = {
  id: number | string;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  provider: string;
  source_graph_digest: string;
  parser_version: string | null;
  graph_schema_version: string | null;
  embedding_model: string | null;
  status: CodeIndexSnapshot['status'];
  file_count: number | string;
  symbol_count: number | string;
  edge_count: number | string;
  document_count: number | string;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string | Date;
  finished_at: string | Date | null;
};

type CatalogSnapshotRow = SnapshotRow & {
  bundle_names: unknown;
  languages: unknown;
};

export interface CodeIndexCatalogSnapshot extends CodeIndexSnapshot {
  bundleNames: string[];
  languages: Record<string, number>;
}

export class CodeIndexValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeIndexValidationError';
  }
}

export class CodeIndexConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeIndexConflictError';
  }
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function fromRow(row: SnapshotRow): CodeIndexSnapshot {
  return {
    id: Number(row.id),
    repositoryKey: row.repository_key,
    branchName: row.branch_name,
    commitSha: row.commit_sha,
    provider: row.provider,
    sourceGraphDigest: row.source_graph_digest,
    parserVersion: row.parser_version,
    graphSchemaVersion: row.graph_schema_version,
    embeddingModel: row.embedding_model,
    status: row.status,
    fileCount: Number(row.file_count),
    symbolCount: Number(row.symbol_count),
    edgeCount: Number(row.edge_count),
    documentCount: Number(row.document_count),
    errorMessage: row.error_message,
    metadata: row.metadata ?? {},
    createdAt: iso(row.created_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, 64)
    : [];
}

function countRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    .slice(0, 64));
}

/** Admin-facing bounded catalog; source documents and embeddings never leave this query. */
export async function listCodeIndexSnapshots(
  pool: pg.Pool,
  limit = 25,
): Promise<CodeIndexCatalogSnapshot[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new CodeIndexValidationError('limit must be an integer from 1 to 100');
  }
  const { rows } = await pool.query<CatalogSnapshotRow>(
    `SELECT s.*,
            COALESCE((
              SELECT jsonb_agg(bundle.name ORDER BY bundle.name)
                FROM mcp_code_index_snapshot_bundles scope
                JOIN mcp_service_bundles bundle ON bundle.id=scope.bundle_id
               WHERE scope.index_id=s.id
            ), '[]'::jsonb) AS bundle_names,
            COALESCE((
              SELECT jsonb_object_agg(language_counts.language, language_counts.file_count)
                FROM (
                  SELECT COALESCE(file.language, 'unknown') AS language, count(*)::int AS file_count
                    FROM mcp_code_index_files file
                   WHERE file.index_id=s.id
                   GROUP BY COALESCE(file.language, 'unknown')
                   ORDER BY COALESCE(file.language, 'unknown')
                ) language_counts
            ), '{}'::jsonb) AS languages
       FROM mcp_code_index_snapshots s
      ORDER BY COALESCE(s.finished_at, s.created_at) DESC, s.id DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map(row => ({
    ...fromRow(row),
    bundleNames: stringArray(row.bundle_names),
    languages: countRecord(row.languages),
  }));
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new CodeIndexValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)) {
    throw new CodeIndexValidationError(`${field} is empty, too long, or contains control characters`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value == null || value === '') return null;
  return boundedText(value, field, max);
}

function hash(value: unknown, field: string): string {
  const normalized = boundedText(value, field, 64).toLowerCase();
  if (!SHA256.test(normalized)) throw new CodeIndexValidationError(`${field} must be a SHA-256 digest`);
  return normalized;
}

function integer(value: unknown, field: string, minimum: number, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new CodeIndexValidationError(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function metadata(value: Record<string, unknown> | undefined, field: string): Record<string, unknown> {
  const normalized = value ?? {};
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
    throw new CodeIndexValidationError(`${field} must be an object`);
  }
  let encoded: string;
  try { encoded = JSON.stringify(normalized); }
  catch { throw new CodeIndexValidationError(`${field} must be JSON serializable`); }
  if (Buffer.byteLength(encoded, 'utf8') > MAX_METADATA_BYTES) {
    throw new CodeIndexValidationError(`${field} exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return normalized;
}

export function normalizeRepositoryPath(value: string): string {
  const candidate = boundedText(value, 'file path', 4096).replace(/\\/g, '/').replace(/^\.\//, '');
  if (candidate.startsWith('/') || /^[A-Za-z]:\//.test(candidate)) {
    throw new CodeIndexValidationError('file path must be repository-relative');
  }
  const parts = candidate.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new CodeIndexValidationError('file path contains an unsafe path segment');
  }
  return parts.join('/');
}

function validateLimit(name: string, length: number, maximum: number): void {
  if (length > maximum) throw new CodeIndexValidationError(`${name} exceeds the ${maximum} item limit`);
}

function normalizeEmbedding(value: number[] | null | undefined, expectedDimension: number | null): {
  value: number[] | null;
  dimension: number | null;
} {
  if (value == null) return { value: null, dimension: expectedDimension };
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096
    || value.some(component => !Number.isFinite(component))) {
    throw new CodeIndexValidationError('document embedding must contain 1-4096 finite numbers');
  }
  if (expectedDimension !== null && expectedDimension !== value.length) {
    throw new CodeIndexValidationError('all document embeddings in a snapshot must use one dimension');
  }
  return { value, dimension: value.length };
}

function validateInput(input: PersistCodeIndexInput): PersistCodeIndexInput {
  if (!input || typeof input !== 'object') throw new CodeIndexValidationError('code index input is required');
  validateLimit('files', input.files?.length ?? 0, MAX_FILES);
  validateLimit('symbols', input.symbols?.length ?? 0, MAX_SYMBOLS);
  validateLimit('edges', input.edges?.length ?? 0, MAX_EDGES);
  validateLimit('documents', input.documents?.length ?? 0, MAX_DOCUMENTS);
  if (!Array.isArray(input.files) || !Array.isArray(input.symbols)
    || !Array.isArray(input.edges) || !Array.isArray(input.documents)) {
    throw new CodeIndexValidationError('files, symbols, edges and documents must be arrays');
  }

  const repositoryKey = boundedText(input.repositoryKey, 'repositoryKey', 512);
  const branchName = boundedText(input.branchName, 'branchName', 255);
  const commitSha = boundedText(input.commitSha, 'commitSha', 64).toLowerCase();
  if (!GIT_SHA.test(commitSha)) throw new CodeIndexValidationError('commitSha must be a full Git SHA-1 or SHA-256');
  const provider = boundedText(input.provider, 'provider', 64).toLowerCase();
  if (!PROVIDER.test(provider)) throw new CodeIndexValidationError('provider must be a lowercase slug');
  const sourceGraphDigest = hash(input.sourceGraphDigest, 'sourceGraphDigest');
  const graphSchemaVersion = boundedText(input.graphSchemaVersion, 'graphSchemaVersion', 128);
  if (!Array.isArray(input.bundleIds) || input.bundleIds.length === 0 || input.bundleIds.length > 64
    || input.bundleIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new CodeIndexValidationError('bundleIds must contain 1-64 positive integers');
  }
  const bundleIds = [...new Set(input.bundleIds)].sort((left, right) => left - right);
  const embeddingModel = optionalText(input.embeddingModel, 'embeddingModel', 255);
  const files = input.files.map((file, position) => ({
    ...file,
    path: normalizeRepositoryPath(file.path),
    language: optionalText(file.language, `files[${position}].language`, 64),
    contentHash: hash(file.contentHash, `files[${position}].contentHash`),
    byteSize: integer(file.byteSize, `files[${position}].byteSize`, 0),
    lineCount: integer(file.lineCount, `files[${position}].lineCount`, 0),
    metadata: metadata(file.metadata, `files[${position}].metadata`),
  }));
  const filePaths = new Set(files.map(file => file.path));
  if (filePaths.size !== files.length) throw new CodeIndexValidationError('file paths must be unique within a snapshot');

  const symbols = input.symbols.map((symbol, position) => {
    const key = boundedText(symbol.key, `symbols[${position}].key`, 2048);
    const filePath = normalizeRepositoryPath(symbol.filePath);
    if (!filePaths.has(filePath)) throw new CodeIndexValidationError(`symbol ${key} references an unknown file`);
    const kind = boundedText(symbol.kind, `symbols[${position}].kind`, 64).toLowerCase();
    if (!TOKEN.test(kind)) throw new CodeIndexValidationError(`symbol ${key} has an invalid kind`);
    const startLine = integer(symbol.startLine, `symbols[${position}].startLine`, 1);
    const endLine = integer(symbol.endLine, `symbols[${position}].endLine`, startLine);
    return {
      ...symbol,
      key,
      filePath,
      name: boundedText(symbol.name, `symbols[${position}].name`, 512),
      qualifiedName: boundedText(symbol.qualifiedName, `symbols[${position}].qualifiedName`, 8192),
      kind,
      signature: optionalText(symbol.signature, `symbols[${position}].signature`, 8192),
      startLine,
      endLine,
      contentHash: symbol.contentHash == null ? null : hash(symbol.contentHash, `symbols[${position}].contentHash`),
      metadata: metadata(symbol.metadata, `symbols[${position}].metadata`),
    };
  });
  const symbolKeys = new Set(symbols.map(symbol => symbol.key));
  if (symbolKeys.size !== symbols.length) throw new CodeIndexValidationError('symbol keys must be unique within a snapshot');

  const provenances = new Set<CodeEdgeProvenance>(['extracted', 'inferred', 'ambiguous', 'runtime']);
  const edges = input.edges.map((edge, position) => {
    const sourceKey = boundedText(edge.sourceKey, `edges[${position}].sourceKey`, 2048);
    const targetKey = boundedText(edge.targetKey, `edges[${position}].targetKey`, 2048);
    if (!symbolKeys.has(sourceKey) || !symbolKeys.has(targetKey)) {
      throw new CodeIndexValidationError(`edge ${sourceKey} -> ${targetKey} references an unknown symbol`);
    }
    const relation = boundedText(edge.relation, `edges[${position}].relation`, 64).toUpperCase();
    if (!RELATION.test(relation)) throw new CodeIndexValidationError(`edge ${sourceKey} -> ${targetKey} has an invalid relation`);
    const provenance = edge.provenance ?? 'extracted';
    if (!provenances.has(provenance)) throw new CodeIndexValidationError('edge provenance is invalid');
    const confidence = edge.confidence ?? 1;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new CodeIndexValidationError('edge confidence must be between 0 and 1');
    }
    return { ...edge, sourceKey, targetKey, relation, provenance, confidence, metadata: metadata(edge.metadata, `edges[${position}].metadata`) };
  });

  let embeddingDimension: number | null = null;
  const documents = input.documents.map((document, position) => {
    const filePath = normalizeRepositoryPath(document.filePath);
    if (!filePaths.has(filePath)) throw new CodeIndexValidationError(`document ${position} references an unknown file`);
    const symbolKey = document.symbolKey == null ? null : boundedText(document.symbolKey, `documents[${position}].symbolKey`, 2048);
    if (symbolKey !== null && !symbolKeys.has(symbolKey)) {
      throw new CodeIndexValidationError(`document ${position} references an unknown symbol`);
    }
    const chunkKind = boundedText(document.chunkKind, `documents[${position}].chunkKind`, 64).toLowerCase();
    if (!TOKEN.test(chunkKind)) throw new CodeIndexValidationError(`document ${position} has an invalid chunk kind`);
    if (typeof document.content !== 'string' || !document.content.length
      || Buffer.byteLength(document.content, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new CodeIndexValidationError(`document ${position} content is empty or exceeds ${MAX_DOCUMENT_BYTES} bytes`);
    }
    const normalizedEmbedding = normalizeEmbedding(document.embedding, embeddingDimension);
    embeddingDimension = normalizedEmbedding.dimension;
    return {
      ...document,
      filePath,
      symbolKey,
      chunkKind,
      chunkOrdinal: integer(document.chunkOrdinal ?? 0, `documents[${position}].chunkOrdinal`, 0),
      contentHash: document.contentHash == null
        ? createHash('sha256').update(document.content).digest('hex')
        : hash(document.contentHash, `documents[${position}].contentHash`),
      embedding: normalizedEmbedding.value,
      metadata: metadata(document.metadata, `documents[${position}].metadata`),
    };
  });
  if (embeddingDimension !== null && embeddingModel === null) {
    throw new CodeIndexValidationError('embeddingModel is required when documents contain embeddings');
  }

  return {
    ...input,
    repositoryKey,
    branchName,
    commitSha,
    bundleIds,
    provider,
    sourceGraphDigest,
    parserVersion: optionalText(input.parserVersion, 'parserVersion', 128),
    graphSchemaVersion,
    embeddingModel,
    metadata: metadata(input.metadata, 'metadata'),
    files,
    symbols,
    edges,
    documents,
  };
}

const SNAPSHOT_COLUMNS = `id, repository_key, branch_name, commit_sha, provider,
  source_graph_digest, parser_version, graph_schema_version, embedding_model,
  status, file_count, symbol_count, edge_count, document_count, error_message,
  metadata, created_at, finished_at`;

/**
 * Persist one complete immutable snapshot atomically. Repeating the exact same
 * provider output is idempotent; trying to overwrite the same repo/branch/SHA
 * identity with another graph digest is rejected.
 */
export async function persistCodeIndexSnapshot(
  pool: pg.Pool,
  rawInput: PersistCodeIndexInput,
): Promise<CodeIndexSnapshot> {
  const input = validateInput(rawInput);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<SnapshotRow>(
      `INSERT INTO mcp_code_index_snapshots
        (repository_key, branch_name, commit_sha, provider, source_graph_digest,
         parser_version, graph_schema_version, embedding_model, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (repository_key, branch_name, commit_sha, provider, graph_schema_version, embedding_model) DO NOTHING
       RETURNING ${SNAPSHOT_COLUMNS}`,
      [input.repositoryKey, input.branchName, input.commitSha, input.provider,
        input.sourceGraphDigest, input.parserVersion, input.graphSchemaVersion,
        input.embeddingModel, input.metadata],
    );

    if (!inserted.rows[0]) {
      const existing = await client.query<SnapshotRow>(
        `SELECT ${SNAPSHOT_COLUMNS} FROM mcp_code_index_snapshots
          WHERE repository_key=$1 AND branch_name=$2 AND commit_sha=$3 AND provider=$4
            AND graph_schema_version=$5 AND embedding_model IS NOT DISTINCT FROM $6
          FOR SHARE`,
        [input.repositoryKey, input.branchName, input.commitSha, input.provider,
          input.graphSchemaVersion, input.embeddingModel],
      );
      const row = existing.rows[0];
      if (row?.status === 'ready' && row.source_graph_digest === input.sourceGraphDigest) {
        for (const bundleId of input.bundleIds) {
          await client.query(
            `INSERT INTO mcp_code_index_snapshot_bundles (index_id, bundle_id)
             VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [Number(row.id), bundleId],
          );
        }
        await client.query('COMMIT');
        return fromRow(row);
      }
      throw new CodeIndexConflictError(
        `code index identity already exists with status ${row?.status ?? 'unknown'} or a different graph digest`,
      );
    }

    const snapshotId = Number(inserted.rows[0].id);
    for (const bundleId of input.bundleIds) {
      await client.query(
        `INSERT INTO mcp_code_index_snapshot_bundles (index_id, bundle_id) VALUES ($1,$2)`,
        [snapshotId, bundleId],
      );
    }
    const fileIds = new Map<string, number>();
    for (const file of input.files) {
      const result = await client.query<{ id: number | string }>(
        `INSERT INTO mcp_code_index_files
          (index_id, path, language, content_hash, byte_size, line_count, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [snapshotId, file.path, file.language, file.contentHash, file.byteSize, file.lineCount, file.metadata],
      );
      fileIds.set(file.path, Number(result.rows[0]!.id));
    }

    const symbolIds = new Map<string, number>();
    for (const symbol of input.symbols) {
      const result = await client.query<{ id: number | string }>(
        `INSERT INTO mcp_code_index_symbols
          (index_id, file_id, name, qualified_name, kind, signature,
           start_line, end_line, content_hash, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [snapshotId, fileIds.get(symbol.filePath), symbol.name, symbol.qualifiedName,
          symbol.kind, symbol.signature, symbol.startLine, symbol.endLine,
          symbol.contentHash, symbol.metadata],
      );
      symbolIds.set(symbol.key, Number(result.rows[0]!.id));
    }

    for (const edge of input.edges) {
      await client.query(
        `INSERT INTO mcp_code_index_edges
          (index_id, source_symbol_id, target_symbol_id, relation, provenance, confidence, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [snapshotId, symbolIds.get(edge.sourceKey), symbolIds.get(edge.targetKey),
          edge.relation, edge.provenance, edge.confidence, edge.metadata],
      );
    }

    for (const document of input.documents) {
      await client.query(
        `INSERT INTO mcp_code_search_documents
          (index_id, file_id, symbol_id, chunk_kind, chunk_ordinal, content,
           content_hash, embedding, embedding_model, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::halfvec,$9,$10)`,
        [snapshotId, fileIds.get(document.filePath),
          document.symbolKey == null ? null : symbolIds.get(document.symbolKey),
          document.chunkKind, document.chunkOrdinal, document.content,
          document.contentHash,
          document.embedding == null ? null : `[${document.embedding.join(',')}]`,
          document.embedding == null ? null : input.embeddingModel,
          document.metadata],
      );
    }

    const completed = await client.query<SnapshotRow>(
      `UPDATE mcp_code_index_snapshots
          SET status='ready', file_count=$2, symbol_count=$3, edge_count=$4,
              document_count=$5, finished_at=now()
        WHERE id=$1 AND status='building'
        RETURNING ${SNAPSHOT_COLUMNS}`,
      [snapshotId, input.files.length, input.symbols.length, input.edges.length, input.documents.length],
    );
    if (!completed.rows[0]) throw new Error('code index snapshot disappeared while it was being persisted');
    await client.query('COMMIT');
    for (const table of [
      'mcp_code_index_files',
      'mcp_code_index_symbols',
      'mcp_code_index_edges',
      'mcp_code_search_documents',
    ]) {
      await client.query(`ANALYZE ${table}`).catch(error => {
        logger.warn({ err: error, snapshotId, table }, 'Code index committed but planner statistics refresh failed');
      });
    }
    return fromRow(completed.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getCodeIndexSnapshot(pool: pg.Pool, id: number): Promise<CodeIndexSnapshot | null> {
  if (!Number.isSafeInteger(id) || id < 1) throw new CodeIndexValidationError('snapshot id must be a positive integer');
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM mcp_code_index_snapshots WHERE id=$1`,
    [id],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function findLatestReadyCodeIndex(
  pool: pg.Pool,
  repositoryKey: string,
  branchName: string,
): Promise<CodeIndexSnapshot | null> {
  const repository = boundedText(repositoryKey, 'repositoryKey', 512);
  const branch = boundedText(branchName, 'branchName', 255);
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM mcp_code_index_snapshots
      WHERE repository_key=$1 AND branch_name=$2 AND status='ready'
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [repository, branch],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function findReadyCodeIndexByCommit(
  pool: pg.Pool,
  repositoryKey: string,
  branchName: string,
  commitSha: string,
  provider = 'graphify',
  graphSchemaVersion?: string,
  embeddingModel?: string | null,
): Promise<CodeIndexSnapshot | null> {
  const repository = boundedText(repositoryKey, 'repositoryKey', 512);
  const branch = boundedText(branchName, 'branchName', 255);
  const commit = boundedText(commitSha, 'commitSha', 64).toLowerCase();
  if (!GIT_SHA.test(commit)) throw new CodeIndexValidationError('commitSha must be a full Git SHA-1 or SHA-256');
  const normalizedProvider = boundedText(provider, 'provider', 64).toLowerCase();
  if (!PROVIDER.test(normalizedProvider)) throw new CodeIndexValidationError('provider must be a lowercase slug');
  const schema = graphSchemaVersion == null ? null : boundedText(graphSchemaVersion, 'graphSchemaVersion', 128);
  const normalizedEmbeddingModel = embeddingModel == null
    ? null
    : boundedText(embeddingModel, 'embeddingModel', 255);
  const filterEmbeddingModel = embeddingModel !== undefined;
  const { rows } = await pool.query<SnapshotRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM mcp_code_index_snapshots
      WHERE repository_key=$1 AND branch_name=$2 AND commit_sha=$3
        AND provider=$4 AND ($5::text IS NULL OR graph_schema_version=$5)
        AND ($6::boolean=false OR embedding_model IS NOT DISTINCT FROM $7)
        AND status='ready'
      ORDER BY finished_at DESC, id DESC LIMIT 1`,
    [repository, branch, commit, normalizedProvider, schema, filterEmbeddingModel, normalizedEmbeddingModel],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Add an authorization scope after a separately authorized bundle reuses an identical ready snapshot. */
export async function authorizeCodeIndexSnapshot(
  pool: pg.Pool,
  snapshotId: number,
  bundleIds: number[],
): Promise<void> {
  if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) {
    throw new CodeIndexValidationError('snapshot id must be a positive integer');
  }
  if (!Array.isArray(bundleIds) || bundleIds.length === 0 || bundleIds.length > 64
    || bundleIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new CodeIndexValidationError('bundleIds must contain 1-64 positive integers');
  }
  const ids = [...new Set(bundleIds)].sort((left, right) => left - right);
  const existing = await pool.query<{ id: number }>(
    `SELECT id FROM mcp_code_index_snapshots WHERE id=$1 AND status='ready'`,
    [snapshotId],
  );
  if (!existing.rows[0]) throw new CodeIndexValidationError('ready code index snapshot not found');
  await pool.query(
    `INSERT INTO mcp_code_index_snapshot_bundles (index_id, bundle_id)
     SELECT $1, bundle_id FROM unnest($2::int[]) AS bundle_id
     ON CONFLICT DO NOTHING`,
    [snapshotId, ids],
  );
}

/** Read-only callers may use a snapshot only when one of their repository
 * Bundles was explicitly attached during an Index-authorized run. */
export async function isCodeIndexSnapshotAuthorized(
  pool: pg.Pool,
  snapshotId: number,
  bundleIds: number[],
): Promise<boolean> {
  if (!Number.isSafeInteger(snapshotId) || snapshotId < 1) {
    throw new CodeIndexValidationError('snapshot id must be a positive integer');
  }
  if (!Array.isArray(bundleIds) || bundleIds.length === 0 || bundleIds.length > 64
    || bundleIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new CodeIndexValidationError('bundleIds must contain 1-64 positive integers');
  }
  const ids = [...new Set(bundleIds)].sort((left, right) => left - right);
  const result = await pool.query<{ authorized: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM mcp_code_index_snapshot_bundles
        WHERE index_id=$1 AND bundle_id=ANY($2::int[])
     ) AS authorized`,
    [snapshotId, ids],
  );
  return result.rows[0]?.authorized === true;
}
