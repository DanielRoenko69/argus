import type pg from 'pg';
import { logger } from '../lib/logger.js';
import { createCodeQueryEmbedding } from './embeddings.js';
import { CodeIndexValidationError } from './store.js';
import type {
  CodeEvidence,
  CodeEvidenceScores,
  CodeIndexSnapshot,
  CodeRetrievalChannel,
  CodeRetrievalStrategy,
  CodeSearchInput,
  CodeSearchResult,
} from './types.js';

const MAX_QUERY_LENGTH = 2_000;
const MAX_RESULTS = 50;
const CHANNEL_CANDIDATE_LIMIT = 100;
const MAX_GRAPH_SEEDS = 20;
const RRF_K = 60;
const MAX_EXACT_TERMS = 64;
const MAX_PATH_TERMS = 32;
const MAX_LEXICAL_TERMS = 32;

type SnapshotSearchRow = {
  id: number | string;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  provider: string;
  source_graph_digest: string;
  parser_version: string | null;
  graph_schema_version: string | null;
  embedding_model: string | null;
  embedding_dimension: number | string | null;
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

export interface CodeRetrievalCandidate {
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
  channel: CodeRetrievalChannel;
  channelScore: number;
  graphRelation?: string | null;
}

type CandidateRow = {
  document_id: number | string;
  snapshot_id: number | string;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  file_path: string;
  symbol_id: number | string | null;
  symbol_name: string | null;
  qualified_name: string | null;
  symbol_kind: string | null;
  start_line: number | string | null;
  end_line: number | string | null;
  chunk_kind: string;
  content: string;
  channel_score: number | string;
  graph_relation?: string | null;
};

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function snapshot(row: SnapshotSearchRow): CodeIndexSnapshot {
  return {
    id: Number(row.id), repositoryKey: row.repository_key, branchName: row.branch_name,
    commitSha: row.commit_sha, provider: row.provider, sourceGraphDigest: row.source_graph_digest,
    parserVersion: row.parser_version, graphSchemaVersion: row.graph_schema_version,
    embeddingModel: row.embedding_model, status: row.status, fileCount: Number(row.file_count),
    symbolCount: Number(row.symbol_count), edgeCount: Number(row.edge_count),
    documentCount: Number(row.document_count), errorMessage: row.error_message,
    metadata: row.metadata ?? {}, createdAt: iso(row.created_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
  };
}

function candidate(row: CandidateRow, channel: CodeRetrievalChannel): CodeRetrievalCandidate {
  return {
    documentId: Number(row.document_id), snapshotId: Number(row.snapshot_id),
    repositoryKey: row.repository_key, branchName: row.branch_name, commitSha: row.commit_sha,
    filePath: row.file_path, symbolId: row.symbol_id == null ? null : Number(row.symbol_id),
    symbolName: row.symbol_name, qualifiedName: row.qualified_name, symbolKind: row.symbol_kind,
    startLine: row.start_line == null ? null : Number(row.start_line),
    endLine: row.end_line == null ? null : Number(row.end_line), chunkKind: row.chunk_kind,
    content: row.content, channel, channelScore: Number(row.channel_score),
    graphRelation: row.graph_relation ?? null,
  };
}

function validateInput(input: CodeSearchInput): Required<Pick<CodeSearchInput, 'snapshotId' | 'query' | 'limit' | 'includeGraph'>> & {
  embedding: number[] | null | undefined;
  allowedBundleIds: number[] | null;
  strategy: CodeRetrievalStrategy;
} {
  if (!input || typeof input !== 'object') throw new CodeIndexValidationError('code search input is required');
  if (!Number.isSafeInteger(input.snapshotId) || input.snapshotId < 1) {
    throw new CodeIndexValidationError('snapshotId must be a positive integer');
  }
  if (typeof input.query !== 'string') throw new CodeIndexValidationError('query must be a string');
  const query = input.query.trim();
  if (!query || query.length > MAX_QUERY_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(query)) {
    throw new CodeIndexValidationError(`query must contain 1-${MAX_QUERY_LENGTH} safe characters`);
  }
  const limit = input.limit ?? 10;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new CodeIndexValidationError(`limit must be an integer from 1 to ${MAX_RESULTS}`);
  }
  const embedding = input.embedding;
  if (embedding != null && (!Array.isArray(embedding) || embedding.length < 1 || embedding.length > 4096
    || embedding.some(value => !Number.isFinite(value)))) {
    throw new CodeIndexValidationError('embedding must contain 1-4096 finite numbers');
  }
  const allowedBundleIds = input.allowedBundleIds === undefined ? null : input.allowedBundleIds;
  if (allowedBundleIds !== null && (!Array.isArray(allowedBundleIds) || allowedBundleIds.length > 64
    || allowedBundleIds.some(id => !Number.isSafeInteger(id) || id < 1))) {
    throw new CodeIndexValidationError('allowedBundleIds must be null or contain up to 64 positive integers');
  }
  const strategy = input.strategy ?? (input.includeGraph === false ? 'hybrid' : 'hybrid_graph');
  if (!['lexical', 'vector', 'hybrid', 'hybrid_graph'].includes(strategy)) {
    throw new CodeIndexValidationError('strategy must be lexical, vector, hybrid or hybrid_graph');
  }
  return {
    snapshotId: input.snapshotId, query, limit, embedding,
    includeGraph: strategy === 'hybrid_graph',
    strategy,
    allowedBundleIds: allowedBundleIds === null ? null : [...new Set(allowedBundleIds)],
  };
}

const EVIDENCE_SELECT = `
  d.id AS document_id, s.id AS snapshot_id, s.repository_key, s.branch_name, s.commit_sha,
  f.path AS file_path, sy.id AS symbol_id, sy.name AS symbol_name,
  sy.qualified_name, sy.kind AS symbol_kind, sy.start_line, sy.end_line,
  d.chunk_kind, d.content`;

const EVIDENCE_JOINS = `
  JOIN mcp_code_index_snapshots s ON s.id=d.index_id AND s.status='ready'
  JOIN mcp_code_index_files f ON f.index_id=d.index_id AND f.id=d.file_id
  LEFT JOIN mcp_code_index_symbols sy ON sy.index_id=d.index_id AND sy.id=d.symbol_id`;

const CHANNEL_WEIGHT: Record<CodeRetrievalChannel, number> = {
  exact: 2,
  lexical: 1,
  // A dense result is the semantic counterpart to an exact code/path hit.
  // Giving it only the lexical weight made strong paraphrase matches unable
  // to displace broad prose/token overlap in hybrid retrieval.
  vector: 2,
  graph: 0.75,
};

/** Extract bounded symbol/path candidates from plain or websearch-style input. */
export function extractCodeLookupTerms(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"\r\n]+)"/g)].map(match => match[1]!);
  const explicit = quoted.length > 0;
  const raw = explicit ? quoted : query.split(/\s+(?:OR|AND)\s+|\s+/i);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const value of raw) {
    const source = value.trim().replace(/^\.\//, '').replace(/^[`'[{]+|[`'\],;:!?]+$/gu, '');
    const codeLike = explicit
      || /[\\/#]/u.test(source)
      || /\.[A-Za-z0-9]{1,12}$/u.test(source)
      || /[_$]/u.test(source)
      || /[a-z][A-Z]/u.test(source)
      || /\(\)$/u.test(source);
    if (!codeLike) continue;
    const term = source.toLowerCase();
    if (!term || term === 'or' || term === 'and' || term.length > 512 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_EXACT_TERMS) break;
  }
  return terms;
}

/** Extract filename stems from prose without treating them as symbol names. */
export function extractCodePathTerms(query: string): string[] {
  const ignored = new Set(['and', 'the', 'with', 'from', 'into', 'when', 'then', 'that', 'this', 'through']);
  const seen = new Set<string>();
  const terms: string[] = [];
  const add = (value: string): void => {
    if (value.length < 3 || value.length > 128 || ignored.has(value) || seen.has(value)) return;
    seen.add(value);
    terms.push(value);
  };
  for (const match of query.matchAll(/[A-Za-z0-9_./\\-]+/gu)) {
    const token = match[0].replaceAll('\\', '/').split('/').at(-1) ?? '';
    const stem = token.split('.')[0]!.toLowerCase();
    add(stem);
    // File names frequently use singular compound nouns (`multistream`) while
    // tickets use their plural form (`multiple streams`). Keep this tiny and
    // deterministic instead of applying broad fuzzy matching to code paths.
    if (stem.length >= 6 && stem.endsWith('s') && !stem.endsWith('ss')) add(stem.slice(0, -1));
    if (terms.length >= MAX_PATH_TERMS) break;
  }
  return terms.slice(0, MAX_PATH_TERMS);
}

/** Build a bounded OR-query vocabulary from ticket prose. */
export function extractCodeLexicalTerms(query: string): string[] {
  const ignored = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'every',
    'find', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on',
    'or', 'should', 'still', 'that', 'the', 'their', 'them', 'then', 'this', 'through',
    'to', 'using', 'when', 'where', 'which', 'while', 'with', 'without', 'would',
  ]);
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const match of query.matchAll(/[A-Za-z][A-Za-z0-9_$-]*/gu)) {
    const term = match[0].toLowerCase().replace(/[^a-z0-9_]+/gu, '');
    if (term.length < 3 || term.length > 128 || ignored.has(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_LEXICAL_TERMS) break;
  }
  return terms;
}

function diversifyRankedCandidates<T extends { candidate: CodeRetrievalCandidate }>(
  ranked: T[],
  limit: number,
): T[] {
  if (ranked.length <= 1 || limit <= 1) return ranked.slice(0, limit);
  const distinctFiles = new Set(ranked.map(item => item.candidate.filePath)).size;
  const diverseTarget = Math.min(distinctFiles, limit, Math.max(1, Math.ceil(limit * 0.75)));
  const selected: T[] = [];
  const selectedDocuments = new Set<number>();
  const selectedFiles = new Set<string>();

  // First reserve most of the result budget for the best hit from different
  // files. The remaining budget still follows the original RRF ordering.
  for (const item of ranked) {
    if (selectedFiles.has(item.candidate.filePath)) continue;
    selected.push(item);
    selectedFiles.add(item.candidate.filePath);
    selectedDocuments.add(item.candidate.documentId);
    if (selected.length >= diverseTarget) break;
  }
  for (const item of ranked) {
    if (selected.length >= limit) break;
    if (selectedDocuments.has(item.candidate.documentId)) continue;
    selected.push(item);
    selectedDocuments.add(item.candidate.documentId);
  }
  return selected;
}

/** Deterministic reciprocal-rank fusion; exported so ranking can be evaluated independently. */
export function fuseCodeRetrievalCandidates(
  channelResults: Partial<Record<CodeRetrievalChannel, CodeRetrievalCandidate[]>>,
  limit: number,
): CodeEvidence[] {
  const accumulated = new Map<number, {
    candidate: CodeRetrievalCandidate;
    channels: Set<CodeRetrievalChannel>;
    scores: Partial<Record<CodeRetrievalChannel, number>>;
    fused: number;
    baseFused: number;
    relations: Set<string>;
  }>();
  const channelOrder: CodeRetrievalChannel[] = ['exact', 'lexical', 'vector', 'graph'];
  for (const channel of channelOrder) {
    const candidates = channelResults[channel] ?? [];
    candidates.forEach((item, index) => {
      const current = accumulated.get(item.documentId) ?? {
        candidate: item, channels: new Set<CodeRetrievalChannel>(),
        scores: {}, fused: 0, baseFused: 0, relations: new Set<string>(),
      };
      current.channels.add(channel);
      current.scores[channel] = Math.max(current.scores[channel] ?? Number.NEGATIVE_INFINITY, item.channelScore);
      current.fused += CHANNEL_WEIGHT[channel] / (RRF_K + index + 1);
      if (channel !== 'graph') current.baseFused += CHANNEL_WEIGHT[channel] / (RRF_K + index + 1);
      if (item.graphRelation) current.relations.add(item.graphRelation);
      accumulated.set(item.documentId, current);
    });
  }
  const ranked = [...accumulated.values()]
    .sort((left, right) => right.fused - left.fused
      || left.candidate.filePath.localeCompare(right.candidate.filePath)
      || left.candidate.documentId - right.candidate.documentId);
  let selected = diversifyRankedCandidates(ranked, limit);
  if ((channelResults.graph?.length ?? 0) > 0) {
    // Graph expansion is additive: reserve a majority using only direct
    // evidence, then reserve the remaining budget for new graph-connected
    // files. Letting all direct hits compete for those final positions made
    // the graph channel observationally inert even for strong relations.
    const directTarget = Math.min(limit, Math.max(1, Math.ceil(limit * 0.6)));
    const direct = [...accumulated.values()]
      .filter(item => item.baseFused > 0)
      .sort((left, right) => right.baseFused - left.baseFused
        || left.candidate.filePath.localeCompare(right.candidate.filePath)
        || left.candidate.documentId - right.candidate.documentId);
    const reserved = diversifyRankedCandidates(direct, directTarget);
    const reservedIds = new Set(reserved.map(item => item.candidate.documentId));
    const reservedFiles = new Set(reserved.map(item => item.candidate.filePath));
    selected = [...reserved];
    const graphBudget = limit - selected.length;
    const graphCandidates = ranked.filter(item => item.channels.has('graph')
      && !reservedIds.has(item.candidate.documentId)
      && !reservedFiles.has(item.candidate.filePath));
    for (const item of diversifyRankedCandidates(graphCandidates, graphBudget)) {
      selected.push(item);
      reservedIds.add(item.candidate.documentId);
      reservedFiles.add(item.candidate.filePath);
    }
    for (const item of ranked) {
      if (selected.length >= limit) break;
      if (reservedIds.has(item.candidate.documentId)) continue;
      selected.push(item);
      reservedIds.add(item.candidate.documentId);
    }
  }
  return selected
    .map(({ candidate: item, channels, scores, fused, relations }) => ({
      documentId: item.documentId, snapshotId: item.snapshotId,
      repositoryKey: item.repositoryKey, branchName: item.branchName, commitSha: item.commitSha,
      filePath: item.filePath, symbolId: item.symbolId, symbolName: item.symbolName,
      qualifiedName: item.qualifiedName, symbolKind: item.symbolKind,
      startLine: item.startLine, endLine: item.endLine, chunkKind: item.chunkKind,
      content: item.content,
      channels: [...channels].sort((left, right) => channelOrder.indexOf(left) - channelOrder.indexOf(right)),
      scores: { ...scores, fused } as CodeEvidenceScores,
      graphRelations: [...relations].sort(),
    }));
}

async function queryChannel(
  pool: pg.Pool,
  sql: string,
  parameters: unknown[],
  channel: CodeRetrievalChannel,
): Promise<CodeRetrievalCandidate[]> {
  const { rows } = await pool.query<CandidateRow>(sql, parameters);
  return rows.map(row => candidate(row, channel));
}

export async function searchCodeIndex(pool: pg.Pool, rawInput: CodeSearchInput): Promise<CodeSearchResult> {
  const input = validateInput(rawInput);
  const exactTerms = extractCodeLookupTerms(input.query);
  const pathTerms = extractCodePathTerms(input.query);
  const lexicalTerms = extractCodeLexicalTerms(input.query);
  const snapshotResult = await pool.query<SnapshotSearchRow>(
    `SELECT s.*,
       (SELECT vector_dims(d.embedding) FROM mcp_code_search_documents d
         WHERE d.index_id=s.id AND d.embedding IS NOT NULL LIMIT 1) AS embedding_dimension
       FROM mcp_code_index_snapshots s
      WHERE s.id=$1 AND s.status='ready'
        AND ($2::int[] IS NULL OR EXISTS (
          SELECT 1 FROM mcp_code_index_snapshot_bundles scope
           WHERE scope.index_id=s.id AND scope.bundle_id=ANY($2::int[])
        ))`,
    [input.snapshotId, input.allowedBundleIds],
  );
  const snapshotRow = snapshotResult.rows[0];
  if (!snapshotRow) throw new CodeIndexValidationError('ready code index snapshot not found');
  const embeddingDimension = snapshotRow.embedding_dimension == null ? null : Number(snapshotRow.embedding_dimension);
  let queryEmbedding = input.embedding;
  if (queryEmbedding === undefined && input.strategy !== 'lexical'
    && snapshotRow.embedding_model !== null && embeddingDimension !== null) {
    try {
      queryEmbedding = await createCodeQueryEmbedding(snapshotRow.embedding_model, input.query);
    } catch (error) {
      queryEmbedding = null;
      logger.warn({ err: error, snapshotId: input.snapshotId, embeddingModel: snapshotRow.embedding_model },
        'Code query embedding failed; continuing with exact, lexical and graph retrieval');
    }
  }
  if (queryEmbedding != null && embeddingDimension !== null && queryEmbedding.length !== embeddingDimension) {
    throw new CodeIndexValidationError(`embedding dimension ${queryEmbedding.length} does not match snapshot dimension ${embeddingDimension}`);
  }

  const candidateLimit = Math.min(CHANNEL_CANDIDATE_LIMIT, Math.max(input.limit * 4, 20));
  const channels: Partial<Record<CodeRetrievalChannel, CodeRetrievalCandidate[]>> = {};
  if (input.strategy === 'hybrid' || input.strategy === 'hybrid_graph') {
    channels.exact = await queryChannel(pool,
      `WITH identifier_matches AS (
         SELECT d.id, 0 AS match_kind, 0 AS match_quality, 0 AS role_rank, 0 AS term_rank
           FROM mcp_code_search_documents d ${EVIDENCE_JOINS}
          WHERE d.index_id=$1
            AND (lower(sy.name)=ANY($2::text[]) OR lower(sy.qualified_name)=ANY($2::text[]))
       ), file_matches AS (
         SELECT DISTINCT ON (f.id) d.id, 1 AS match_kind,
                CASE WHEN lower(f.path)=ANY($2::text[]) THEN 0
                     WHEN lower(split_part(regexp_replace(f.path, '^.*/', ''), '.', 1))=ANY($3::text[]) THEN 1
                     ELSE 2 END AS match_quality,
                CASE WHEN f.path ~ '^(src|lib|app|packages)/' THEN 0
                     WHEN f.path ~ '(^|/)(test|tests|__tests__)/'
                       OR f.path ~ '(\\.|^)(test|spec)\\.[^/]+$' THEN 1
                     WHEN f.path ~ '^(docs?|benchmarks?|examples?)/' THEN 3
                     ELSE 2 END AS role_rank,
                LEAST(
                  coalesce(array_position($2::text[], lower(f.path)), 2147483647),
                  coalesce((
                    SELECT min(path_term.term_rank)::int
                      FROM unnest($3::text[]) WITH ORDINALITY AS path_term(term, term_rank)
                     WHERE lower(split_part(regexp_replace(f.path, '^.*/', ''), '.', 1))=path_term.term
                        OR (length(path_term.term) >= 4
                            AND lower(split_part(regexp_replace(f.path, '^.*/', ''), '.', 1))
                                LIKE '%' || path_term.term || '%')
                  ), 2147483647)
                ) AS term_rank
           FROM mcp_code_search_documents d ${EVIDENCE_JOINS}
          WHERE d.index_id=$1
            AND (lower(f.path)=ANY($2::text[])
              OR EXISTS (
                SELECT 1 FROM unnest($3::text[]) AS path_term(term)
                 WHERE lower(split_part(regexp_replace(f.path, '^.*/', ''), '.', 1))=path_term.term
                    OR (length(path_term.term) >= 4
                        AND lower(split_part(regexp_replace(f.path, '^.*/', ''), '.', 1))
                            LIKE '%' || path_term.term || '%')
              ))
          ORDER BY f.id, CASE WHEN d.chunk_kind='file' THEN 0 ELSE 1 END,
                   sy.start_line NULLS FIRST, d.id
       ), raw_matches AS (
         SELECT * FROM identifier_matches
         UNION ALL
         SELECT * FROM file_matches
       ), ranked_matches AS (
         SELECT DISTINCT ON (id) id, match_kind, match_quality, role_rank, term_rank
           FROM raw_matches
          ORDER BY id, match_kind, match_quality, role_rank, term_rank
       )
       SELECT ${EVIDENCE_SELECT}, 1.0::real AS channel_score
         FROM ranked_matches m
         JOIN mcp_code_search_documents d ON d.id=m.id AND d.index_id=$1
         ${EVIDENCE_JOINS}
        ORDER BY m.match_kind, m.match_quality, m.role_rank, m.term_rank,
                 f.path, sy.start_line NULLS FIRST, d.id
        LIMIT $4`,
      [input.snapshotId, exactTerms, pathTerms, candidateLimit], 'exact');
  }

  if (input.strategy !== 'vector') {
    channels.lexical = lexicalTerms.length === 0 ? [] : await queryChannel(pool,
      `WITH lexical_query AS (
         SELECT to_tsquery('simple', array_to_string($2::text[], ' | ')) AS query
       )
       SELECT ${EVIDENCE_SELECT}, ts_rank_cd(d.search_vector, q.query)::real AS channel_score
         FROM mcp_code_search_documents d ${EVIDENCE_JOINS}
         CROSS JOIN lexical_query q
        WHERE d.index_id=$1 AND d.search_vector @@ q.query
        ORDER BY channel_score DESC, f.path, sy.start_line NULLS FIRST, d.id
        LIMIT $3`,
      [input.snapshotId, lexicalTerms, candidateLimit], 'lexical');
  }

  if (input.strategy !== 'lexical' && queryEmbedding != null && embeddingDimension !== null) {
    channels.vector = await queryChannel(pool,
      `SELECT ${EVIDENCE_SELECT},
         (1 - (d.embedding <=> $2::halfvec))::real AS channel_score
         FROM mcp_code_search_documents d ${EVIDENCE_JOINS}
        WHERE d.index_id=$1 AND d.embedding IS NOT NULL
        ORDER BY d.embedding <=> $2::halfvec, f.path, d.id
        LIMIT $3`,
      [input.snapshotId, `[${queryEmbedding.join(',')}]`, candidateLimit], 'vector');
  }

  if (input.includeGraph) {
    const directEvidence = fuseCodeRetrievalCandidates({
      exact: channels.exact,
      lexical: channels.lexical,
      vector: channels.vector,
    }, MAX_GRAPH_SEEDS);
    const seedFiles = [...new Set(directEvidence
      .filter(item => item.symbolId === null)
      .map(item => item.filePath))].slice(0, MAX_GRAPH_SEEDS);
    const rootByFile = new Map<string, number>();
    if (seedFiles.length > 0) {
      const roots = await pool.query<{ file_path: string; symbol_id: number | string }>(
        `SELECT DISTINCT ON (f.path) f.path AS file_path, sy.id AS symbol_id
           FROM mcp_code_index_files f
           JOIN mcp_code_index_symbols sy ON sy.index_id=f.index_id AND sy.file_id=f.id
          WHERE f.index_id=$1 AND f.path=ANY($2::text[])
          ORDER BY f.path,
                   CASE WHEN sy.kind='file' THEN 0
                        WHEN sy.name=f.path THEN 1
                        WHEN sy.start_line=1 THEN 2 ELSE 3 END,
                   sy.start_line, sy.id`,
        [input.snapshotId, seedFiles],
      );
      for (const row of roots.rows) rootByFile.set(row.file_path, Number(row.symbol_id));
    }
    // Preserve the fused direct-evidence order when file documents are bridged
    // to their root symbols. Partitioning symbol and file seeds caused a weak
    // symbol hit to outrank the strongest file-level retrieval result.
    const seedSymbolIds: number[] = [];
    for (const item of directEvidence) {
      const symbolId = item.symbolId ?? rootByFile.get(item.filePath);
      if (symbolId === undefined || seedSymbolIds.includes(symbolId)) continue;
      seedSymbolIds.push(symbolId);
      if (seedSymbolIds.length >= MAX_GRAPH_SEEDS) break;
    }
    if (seedSymbolIds.length > 0) {
      channels.graph = await queryChannel(pool,
        `WITH seeds(symbol_id, seed_rank) AS (
           SELECT symbol_id, seed_rank
             FROM unnest($2::bigint[]) WITH ORDINALITY AS seed(symbol_id, seed_rank)
         ), adjacent AS (
           SELECT e.target_symbol_id AS symbol_id, e.relation, e.confidence,
                  seed.seed_rank, 'outbound'::text AS direction
             FROM seeds seed
             JOIN mcp_code_index_edges e
               ON e.index_id=$1 AND e.source_symbol_id=seed.symbol_id
           UNION ALL
           SELECT e.source_symbol_id AS symbol_id, e.relation, e.confidence,
                  seed.seed_rank, 'inbound'::text AS direction
             FROM seeds seed
             JOIN mcp_code_index_edges e
               ON e.index_id=$1 AND e.target_symbol_id=seed.symbol_id
         )
         SELECT ${EVIDENCE_SELECT},
                max(
                  a.confidence
                  * CASE upper(a.relation)
                      WHEN 'TESTS' THEN 4.0
                      WHEN 'IMPORTS' THEN 2.0
                      WHEN 'REFERENCES' THEN 1.5
                      WHEN 'CALLS' THEN 1.25
                      WHEN 'EXTENDS' THEN 1.25
                      WHEN 'IMPLEMENTS' THEN 1.25
                      WHEN 'DEFINES' THEN 0.75
                      ELSE 1.0
                    END
                  / sqrt(GREATEST(a.seed_rank, 1)::double precision)
                )::real AS channel_score,
                string_agg(DISTINCT a.direction || ':' || a.relation, ',') AS graph_relation
           FROM adjacent a
           JOIN mcp_code_search_documents d ON d.index_id=$1 AND d.symbol_id=a.symbol_id
           ${EVIDENCE_JOINS}
          WHERE d.index_id=$1
          GROUP BY d.id, s.id, s.repository_key, s.branch_name, s.commit_sha,
                   f.path, sy.id, sy.name, sy.qualified_name, sy.kind,
                   sy.start_line, sy.end_line, d.chunk_kind, d.content
          ORDER BY channel_score DESC, f.path, sy.start_line NULLS FIRST, d.id
          LIMIT $3`,
        [input.snapshotId, seedSymbolIds, candidateLimit], 'graph');
    }
  }

  const channelsUsed = (['exact', 'lexical', 'vector', 'graph'] as CodeRetrievalChannel[])
    .filter(channel => channels[channel] !== undefined);
  return {
    snapshot: snapshot(snapshotRow),
    query: input.query,
    evidence: fuseCodeRetrievalCandidates(channels, input.limit),
    channelsUsed,
  };
}
