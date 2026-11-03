import type pg from 'pg';
import type {
  RepositoryGraphDirection,
  RepositoryGraphEdge,
  RepositoryGraphExpansion,
  RepositoryGraphNode,
  RepositoryGraphNodeType,
  RepositoryGraphOverviewData,
  RepositoryGraphSnapshot,
  RepositoryFullGraphData,
} from './repositoryGraphTypes.js';
import { REPOSITORY_GRAPH_LIMITS, RepositoryGraphValidationError } from './repositoryGraphValidation.js';

type SnapshotRow = {
  id: string | number;
  repository_key: string;
  branch_name: string;
  commit_sha: string;
  source_graph_digest: string;
  provider: string;
  parser_version: string | null;
  graph_schema_version: string;
  status: RepositoryGraphSnapshot['status'];
};

type NodeRow = {
  node_type: RepositoryGraphNodeType;
  id: string | number;
  label: string;
  file_path: string;
  language: string | null;
  qualified_name: string | null;
  kind: string | null;
  start_line: string | number | null;
  end_line: string | number | null;
};

type EdgeRow = {
  id: string | number;
  source_id: string | number;
  source_label: string;
  source_file_path: string;
  source_language: string | null;
  source_qualified_name: string;
  source_kind: string;
  source_start_line: string | number;
  source_end_line: string | number;
  target_id: string | number;
  target_label: string;
  target_file_path: string;
  target_language: string | null;
  target_qualified_name: string;
  target_kind: string;
  target_start_line: string | number;
  target_end_line: string | number;
  relation: string;
  provenance: string;
  confidence: string | number;
};

type DeclaresRow = {
  file_id: string | number;
  file_path: string;
  language: string | null;
  symbol_id: string | number;
  symbol_label: string;
  qualified_name: string;
  kind: string;
  start_line: string | number;
  end_line: string | number;
};

type OverviewModuleRow = {
  module_path: string;
  file_count: string | number;
  symbol_count: string | number;
  document_count: string | number;
  test_file_count: string | number;
  total_module_count: string | number;
  total_file_count: string | number;
  total_symbol_count: string | number;
  total_edge_count: string | number;
  total_document_count: string | number;
  total_test_file_count: string | number;
};

type OverviewLanguageRow = {
  module_path: string;
  language: string;
  file_count: string | number;
};

type OverviewDependencyRow = {
  source_module: string;
  target_module: string;
  relation_count: string | number;
  relations: string[];
  total_dependency_count: string | number;
};

type FullGraphFileRow = { id: string | number; path: string; language: string | null };
type FullGraphSymbolRow = {
  id: string | number;
  file_id: string | number;
  name: string;
  kind: string;
  start_line: string | number;
  end_line: string | number;
};
type FullGraphEdgeRow = {
  source_symbol_id: string | number;
  target_symbol_id: string | number;
  relation: string;
};

const QUERY_TIMEOUT_MS = REPOSITORY_GRAPH_LIMITS.queryBudgetMs;

function queryWithTimeout<Row extends pg.QueryResultRow>(
  pool: pg.Pool,
  text: string,
  values: unknown[],
  timeoutMs: number = QUERY_TIMEOUT_MS,
): Promise<pg.QueryResult<Row>> {
  // node-postgres supports per-query timeouts at runtime; @types/pg 8.16
  // removed the field from QueryConfig, so keep the extension isolated here.
  return pool.query<Row>({ text, values, query_timeout: timeoutMs } as pg.QueryConfig);
}

function text(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function modulePath(path: string): string {
  const normalized = path.replace(/^\.\//u, '');
  const separator = normalized.indexOf('/');
  return separator < 0 ? '(root)' : normalized.slice(0, separator);
}

function fileNode(id: string | number, path: string, language: string | null): RepositoryGraphNode {
  return {
    id: `file:${id}`,
    type: 'file',
    label: text(path.split('/').at(-1) ?? path, 512),
    href: null,
    metadata: { path: text(path, 2_048), language },
  };
}

function symbolNode(row: {
  id: string | number;
  label: string;
  filePath: string;
  language: string | null;
  qualifiedName: string;
  kind: string;
  startLine: string | number;
  endLine: string | number;
}): RepositoryGraphNode {
  return {
    id: `symbol:${row.id}`,
    type: 'symbol',
    label: text(row.label, 512),
    href: null,
    metadata: {
      filePath: text(row.filePath, 2_048),
      language: row.language,
      qualifiedName: text(row.qualifiedName, 2_048),
      kind: text(row.kind, 64),
      startLine: Number(row.startLine),
      endLine: Number(row.endLine),
    },
  };
}

function fromNodeRow(row: NodeRow): RepositoryGraphNode {
  return row.node_type === 'file'
    ? fileNode(row.id, row.file_path, row.language)
    : symbolNode({
      id: row.id,
      label: row.label,
      filePath: row.file_path,
      language: row.language,
      qualifiedName: row.qualified_name ?? row.label,
      kind: row.kind ?? 'symbol',
      startLine: row.start_line ?? 1,
      endLine: row.end_line ?? row.start_line ?? 1,
    });
}

function ids(nodes: string[], type: RepositoryGraphNodeType): number[] {
  return nodes
    .filter(node => node.startsWith(`${type}:`))
    .map(node => Number(node.slice(type.length + 1)))
    .filter(id => Number.isSafeInteger(id) && id > 0);
}

function normalizedBundles(value: number[] | null): number[] | null {
  if (value == null) return null;
  if (value.length > 500 || value.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new RepositoryGraphValidationError('caller bundle scope is invalid', 403);
  }
  return [...new Set(value)];
}

export interface RepositoryGraphDataSource {
  loadAuthorizedSnapshot(snapshotId: number, allowedBundleIds: number[] | null): Promise<RepositoryGraphSnapshot | null>;
  resolveKnownEdgeTypes(snapshotId: number, requested: string[]): Promise<string[]>;
  resolveSeedNodes(
    snapshotId: number,
    input: { seed: string | null; search: string | null; nodeTypes: RepositoryGraphNodeType[] },
  ): Promise<RepositoryGraphNode[]>;
  expand(
    snapshotId: number,
    frontier: string[],
    input: {
      direction: RepositoryGraphDirection;
      nodeTypes: RepositoryGraphNodeType[];
      edgeTypes: string[];
      limit: number;
    },
  ): Promise<RepositoryGraphExpansion>;
  loadArchitectureOverview(snapshotId: number): Promise<RepositoryGraphOverviewData>;
  loadFullGraph(snapshotId: number, limits: { maxNodes: number; maxEdges: number }): Promise<RepositoryFullGraphData>;
}

export class PostgresRepositoryGraphDataSource implements RepositoryGraphDataSource {
  constructor(private readonly pool: pg.Pool) {}

  async loadAuthorizedSnapshot(snapshotId: number, allowedBundleIds: number[] | null): Promise<RepositoryGraphSnapshot | null> {
    const bundles = normalizedBundles(allowedBundleIds);
    const result = await queryWithTimeout<SnapshotRow>(this.pool,
      `SELECT s.id, s.repository_key, s.branch_name, s.commit_sha,
                    s.source_graph_digest, s.provider, s.parser_version,
                    s.graph_schema_version, s.status
               FROM mcp_code_index_snapshots s
              WHERE s.id=$1
                AND ($2::int[] IS NULL OR EXISTS (
                  SELECT 1 FROM mcp_code_index_snapshot_bundles scope
                   WHERE scope.index_id=s.id AND scope.bundle_id=ANY($2::int[])
                ))`,
      [snapshotId, bundles],
    );
    const row = result.rows[0];
    return row ? {
      id: String(row.id),
      repository: row.repository_key,
      branch: row.branch_name,
      commitSha: row.commit_sha,
      graphDigest: `sha256:${row.source_graph_digest}`,
      provider: row.provider,
      parserVersion: row.parser_version,
      schemaVersion: row.graph_schema_version,
      status: row.status,
      immutable: true,
    } : null;
  }

  async resolveKnownEdgeTypes(snapshotId: number, requested: string[]): Promise<string[]> {
    const providerTypes = requested.filter(type => type !== 'declares');
    if (providerTypes.length === 0) return requested.includes('declares') ? ['declares'] : [];
    const result = await queryWithTimeout<{ relation: string }>(this.pool,
      `SELECT DISTINCT lower(relation) AS relation
               FROM mcp_code_index_edges
              WHERE index_id=$1 AND lower(relation)=ANY($2::text[])
              ORDER BY lower(relation)`,
      [snapshotId, providerTypes],
    );
    return [
      ...(requested.includes('declares') ? ['declares'] : []),
      ...result.rows.map(row => row.relation).filter(relation => relation !== 'declares'),
    ];
  }

  async resolveSeedNodes(
    snapshotId: number,
    input: { seed: string | null; search: string | null; nodeTypes: RepositoryGraphNodeType[] },
  ): Promise<RepositoryGraphNode[]> {
    const selected = new Set(input.nodeTypes);
    if (input.seed != null) {
      const [type, id] = input.seed.split(':') as [RepositoryGraphNodeType, string];
      if (!selected.has(type)) return [];
      const result = await queryWithTimeout<NodeRow>(this.pool,
        `SELECT 'file'::text AS node_type, f.id, f.path AS label,
                      f.path AS file_path, f.language, NULL::text AS qualified_name,
                      NULL::text AS kind, NULL::int AS start_line, NULL::int AS end_line
                 FROM mcp_code_index_files f
                WHERE $2='file' AND f.index_id=$1 AND f.id=$3
                UNION ALL
               SELECT 'symbol'::text AS node_type, sy.id, sy.name AS label,
                      f.path AS file_path, f.language, sy.qualified_name,
                      sy.kind, sy.start_line, sy.end_line
                 FROM mcp_code_index_symbols sy
                 JOIN mcp_code_index_files f ON f.index_id=sy.index_id AND f.id=sy.file_id
                WHERE $2='symbol' AND sy.index_id=$1 AND sy.id=$3`,
        [snapshotId, type, Number(id)],
      );
      return result.rows.map(fromNodeRow);
    }

    const allNodes = input.search === '*';
    const result = await queryWithTimeout<NodeRow>(this.pool,
      `SELECT candidate.node_type, candidate.id, candidate.label, candidate.file_path,
                    candidate.language, candidate.qualified_name, candidate.kind,
                    candidate.start_line, candidate.end_line
               FROM (
                 SELECT 'file'::text AS node_type, f.id, f.path AS label,
                        f.path AS file_path, f.language, NULL::text AS qualified_name,
                        NULL::text AS kind, NULL::int AS start_line, NULL::int AS end_line,
                        CASE WHEN lower(f.path)=lower($2) THEN 0
                             WHEN lower(f.path) LIKE lower($2) || '%' THEN 1 ELSE 2 END AS rank
                   FROM mcp_code_index_files f
                  WHERE f.index_id=$1 AND 'file'=ANY($3::text[])
                    AND ($5::boolean OR lower(f.path) LIKE '%' || lower($2) || '%')
                 UNION ALL
                 SELECT 'symbol'::text AS node_type, sy.id, sy.name AS label,
                        f.path AS file_path, f.language, sy.qualified_name,
                        sy.kind, sy.start_line, sy.end_line,
                        CASE WHEN lower(sy.qualified_name)=lower($2) OR lower(sy.name)=lower($2) THEN 0
                             WHEN lower(sy.name) LIKE lower($2) || '%' THEN 1 ELSE 2 END AS rank
                   FROM mcp_code_index_symbols sy
                   JOIN mcp_code_index_files f ON f.index_id=sy.index_id AND f.id=sy.file_id
                  WHERE sy.index_id=$1 AND 'symbol'=ANY($3::text[])
                    AND ($5::boolean OR lower(sy.name) LIKE '%' || lower($2) || '%'
                      OR lower(sy.qualified_name) LIKE '%' || lower($2) || '%')
               ) candidate
              ORDER BY candidate.rank, lower(candidate.label), candidate.node_type, candidate.id
              LIMIT $4`,
      [snapshotId, input.search, input.nodeTypes, REPOSITORY_GRAPH_LIMITS.maxSeedMatches, allNodes],
    );
    return result.rows.map(fromNodeRow);
  }

  async loadArchitectureOverview(snapshotId: number): Promise<RepositoryGraphOverviewData> {
    const moduleLimit = REPOSITORY_GRAPH_LIMITS.maxOverviewModules;
    const dependencyLimit = REPOSITORY_GRAPH_LIMITS.maxOverviewDependencies;
    const languageLimit = REPOSITORY_GRAPH_LIMITS.maxLanguagesPerModule;
    const modulesResult = await queryWithTimeout<OverviewModuleRow>(this.pool,
      `WITH files AS (
         SELECT f.id, f.language,
                CASE WHEN strpos(regexp_replace(f.path, '^\\./', ''), '/') > 0
                     THEN split_part(regexp_replace(f.path, '^\\./', ''), '/', 1)
                     ELSE '(root)' END AS module_path,
                (lower(f.path) ~ '(^|/)(__tests__|test|tests|spec|specs)(/|$)'
                  OR lower(f.path) ~ '(test|spec)\\.[^/]+$') AS is_test
           FROM mcp_code_index_files f
          WHERE f.index_id=$1
       ), symbol_counts AS (
         SELECT sy.file_id, count(*) AS symbol_count
           FROM mcp_code_index_symbols sy
          WHERE sy.index_id=$1
          GROUP BY sy.file_id
       ), document_counts AS (
         SELECT d.file_id, count(*) AS document_count
           FROM mcp_code_search_documents d
          WHERE d.index_id=$1
          GROUP BY d.file_id
       ), module_stats AS (
         SELECT f.module_path,
                count(*) AS file_count,
                sum(COALESCE(s.symbol_count, 0)) AS symbol_count,
                sum(COALESCE(d.document_count, 0)) AS document_count,
                count(*) FILTER (WHERE f.is_test) AS test_file_count
           FROM files f
           LEFT JOIN symbol_counts s ON s.file_id=f.id
           LEFT JOIN document_counts d ON d.file_id=f.id
          GROUP BY f.module_path
       ), snapshot_totals AS (
         SELECT file_count, symbol_count, edge_count, document_count
           FROM mcp_code_index_snapshots
          WHERE id=$1
       )
       SELECT m.*,
              count(*) OVER () AS total_module_count,
              t.file_count AS total_file_count,
              t.symbol_count AS total_symbol_count,
              t.edge_count AS total_edge_count,
              t.document_count AS total_document_count,
              sum(m.test_file_count) OVER () AS total_test_file_count
         FROM module_stats m
         CROSS JOIN snapshot_totals t
        ORDER BY m.file_count DESC, lower(m.module_path)
        LIMIT $2`,
      [snapshotId, moduleLimit + 1],
    );
    const returnedRows = modulesResult.rows.slice(0, moduleLimit);
    const modulePaths = returnedRows.map(row => row.module_path);

    const [languagesResult, dependenciesResult] = await Promise.all([
      modulePaths.length === 0 ? Promise.resolve({ rows: [] as OverviewLanguageRow[] }) : queryWithTimeout<OverviewLanguageRow>(this.pool,
        `WITH files AS (
           SELECT CASE WHEN strpos(regexp_replace(f.path, '^\\./', ''), '/') > 0
                       THEN split_part(regexp_replace(f.path, '^\\./', ''), '/', 1)
                       ELSE '(root)' END AS module_path,
                  COALESCE(NULLIF(lower(f.language), ''), 'unknown') AS language
             FROM mcp_code_index_files f
            WHERE f.index_id=$1
         ), ranked AS (
           SELECT module_path, language, count(*) AS file_count,
                  row_number() OVER (PARTITION BY module_path ORDER BY count(*) DESC, language) AS language_rank
             FROM files
            WHERE module_path=ANY($2::text[])
            GROUP BY module_path, language
         )
         SELECT module_path, language, file_count
           FROM ranked
          WHERE language_rank <= $3
          ORDER BY module_path, file_count DESC, language`,
        [snapshotId, modulePaths, languageLimit],
      ),
      modulePaths.length === 0 ? Promise.resolve({ rows: [] as OverviewDependencyRow[] }) : queryWithTimeout<OverviewDependencyRow>(this.pool,
        `WITH symbol_modules AS (
           SELECT sy.id,
                  CASE WHEN strpos(regexp_replace(f.path, '^\\./', ''), '/') > 0
                       THEN split_part(regexp_replace(f.path, '^\\./', ''), '/', 1)
                       ELSE '(root)' END AS module_path
             FROM mcp_code_index_symbols sy
             JOIN mcp_code_index_files f ON f.index_id=sy.index_id AND f.id=sy.file_id
            WHERE sy.index_id=$1
         ), grouped AS (
           SELECT source.module_path AS source_module,
                  target.module_path AS target_module,
                  count(*) AS relation_count,
                  array_agg(DISTINCT lower(e.relation) ORDER BY lower(e.relation)) AS relations
             FROM mcp_code_index_edges e
             JOIN symbol_modules source ON source.id=e.source_symbol_id
             JOIN symbol_modules target ON target.id=e.target_symbol_id
            WHERE e.index_id=$1
              AND source.module_path=ANY($2::text[])
              AND target.module_path=ANY($2::text[])
              AND source.module_path<>target.module_path
            GROUP BY source.module_path, target.module_path
         )
         SELECT grouped.*, count(*) OVER () AS total_dependency_count
           FROM grouped
          ORDER BY relation_count DESC, lower(source_module), lower(target_module)
          LIMIT $3`,
        [snapshotId, modulePaths, dependencyLimit + 1],
      ),
    ]);

    const languages = new Map<string, Record<string, number>>();
    for (const row of languagesResult.rows) {
      languages.set(row.module_path, {
        ...(languages.get(row.module_path) ?? {}),
        [row.language]: Number(row.file_count),
      });
    }
    const moduleId = (path: string): string => `module:${Buffer.from(path, 'utf8').toString('base64url')}`;
    const modules = returnedRows.map(row => ({
      id: moduleId(row.module_path),
      path: row.module_path,
      fileCount: Number(row.file_count),
      symbolCount: Number(row.symbol_count),
      documentCount: Number(row.document_count),
      testFileCount: Number(row.test_file_count),
      languages: languages.get(row.module_path) ?? {},
    }));
    const dependencyRows = dependenciesResult.rows.slice(0, dependencyLimit);
    const dependencies = dependencyRows.map(row => ({
      id: `module-edge:${moduleId(row.source_module).slice(7)}:${moduleId(row.target_module).slice(7)}`,
      source: moduleId(row.source_module),
      target: moduleId(row.target_module),
      relationCount: Number(row.relation_count),
      relations: row.relations,
    }));
    const firstModule = modulesResult.rows[0];
    const totalModules = Number(firstModule?.total_module_count ?? 0);
    const totalDependencies = Number(dependenciesResult.rows[0]?.total_dependency_count ?? 0);
    return {
      totals: {
        files: Number(firstModule?.total_file_count ?? 0),
        symbols: Number(firstModule?.total_symbol_count ?? 0),
        edges: Number(firstModule?.total_edge_count ?? 0),
        documents: Number(firstModule?.total_document_count ?? 0),
        testFiles: Number(firstModule?.total_test_file_count ?? 0),
        modules: totalModules,
        dependencies: totalDependencies,
      },
      modules,
      dependencies,
      truncated: totalModules > modules.length || totalDependencies > dependencies.length,
    };
  }

  async loadFullGraph(
    snapshotId: number,
    limits: { maxNodes: number; maxEdges: number },
  ): Promise<RepositoryFullGraphData> {
    const timeout = REPOSITORY_GRAPH_LIMITS.fullGraphQueryBudgetMs;
    const fileResult = await queryWithTimeout<FullGraphFileRow>(this.pool,
      `SELECT f.id, f.path, f.language
         FROM mcp_code_index_files f
        WHERE f.index_id=$1
        ORDER BY f.id
        LIMIT $2`,
      [snapshotId, limits.maxNodes + 1],
      timeout,
    );
    const selectedFileRows = fileResult.rows.slice(0, limits.maxNodes);
    const fileIds = selectedFileRows.map(row => String(row.id));
    const remainingNodes = Math.max(0, limits.maxNodes - selectedFileRows.length);
    const symbolResult = remainingNodes === 0 || fileIds.length === 0
      ? { rows: [] as FullGraphSymbolRow[] }
      : await queryWithTimeout<FullGraphSymbolRow>(this.pool,
        `SELECT sy.id, sy.file_id, sy.name, sy.kind, sy.start_line, sy.end_line
           FROM mcp_code_index_symbols sy
          WHERE sy.index_id=$1 AND sy.file_id=ANY($2::bigint[])
          ORDER BY sy.id
          LIMIT $3`,
        [snapshotId, fileIds, remainingNodes + 1],
        timeout,
      );
    const selectedSymbolRows = symbolResult.rows.slice(0, remainingNodes);
    const providerEdgeLimit = Math.max(0, limits.maxEdges - selectedSymbolRows.length);
    const edgeResult = providerEdgeLimit === 0 || selectedSymbolRows.length === 0
      ? { rows: [] as FullGraphEdgeRow[] }
      : await queryWithTimeout<FullGraphEdgeRow>(this.pool,
        `WITH selected_symbols AS (
           SELECT sy.id
             FROM mcp_code_index_symbols sy
            WHERE sy.index_id=$1 AND sy.file_id=ANY($2::bigint[])
            ORDER BY sy.id
            LIMIT $3
         )
         SELECT e.source_symbol_id, e.target_symbol_id, lower(e.relation) AS relation
           FROM mcp_code_index_edges e
           JOIN selected_symbols source ON source.id=e.source_symbol_id
           JOIN selected_symbols target ON target.id=e.target_symbol_id
          WHERE e.index_id=$1
          ORDER BY e.id
          LIMIT $4`,
        [snapshotId, fileIds, remainingNodes, providerEdgeLimit + 1],
        timeout,
      );

    const truncationReasons: RepositoryFullGraphData['truncationReasons'] = [];
    if (fileResult.rows.length > limits.maxNodes || symbolResult.rows.length > remainingNodes) {
      truncationReasons.push('node_limit');
    }
    if (edgeResult.rows.length > providerEdgeLimit) truncationReasons.push('edge_limit');

    return {
      files: selectedFileRows.map(row => ({
        id: String(row.id),
        path: text(row.path, 2_048),
        language: row.language,
        module: modulePath(row.path),
      })),
      symbols: selectedSymbolRows.map(row => ({
        id: String(row.id),
        fileId: String(row.file_id),
        label: text(row.name, 512),
        kind: text(row.kind, 64),
        startLine: Number(row.start_line),
        endLine: Number(row.end_line),
      })),
      edges: edgeResult.rows.slice(0, providerEdgeLimit).map(row => ({
        sourceSymbolId: String(row.source_symbol_id),
        targetSymbolId: String(row.target_symbol_id),
        type: text(row.relation.toLowerCase(), 64),
      })),
      truncated: truncationReasons.length > 0,
      truncationReasons,
    };
  }

  async expand(
    snapshotId: number,
    frontier: string[],
    input: {
      direction: RepositoryGraphDirection;
      nodeTypes: RepositoryGraphNodeType[];
      edgeTypes: string[];
      limit: number;
    },
  ): Promise<RepositoryGraphExpansion> {
    const fileIds = ids(frontier, 'file');
    const symbolIds = ids(frontier, 'symbol');
    const nodeTypes = new Set(input.nodeTypes);
    const edgeTypes = new Set(input.edgeTypes);
    const allowAllEdges = edgeTypes.size === 0;
    const includeDeclares = allowAllEdges || edgeTypes.has('declares');
    const canUseSymbols = nodeTypes.has('symbol');
    const canUseFiles = nodeTypes.has('file');
    const rawLimit = Math.max(1, input.limit) + 1;
    const edges: RepositoryGraphEdge[] = [];
    const nodes = new Map<string, RepositoryGraphNode>();
    let truncated = false;

    if (includeDeclares && canUseFiles && canUseSymbols && (fileIds.length > 0 || symbolIds.length > 0)) {
      const declarations = await queryWithTimeout<DeclaresRow>(this.pool,
        `SELECT f.id AS file_id, f.path AS file_path, f.language,
                      sy.id AS symbol_id, sy.name AS symbol_label, sy.qualified_name,
                      sy.kind, sy.start_line, sy.end_line
                 FROM mcp_code_index_symbols sy
                 JOIN mcp_code_index_files f ON f.index_id=sy.index_id AND f.id=sy.file_id
                WHERE sy.index_id=$1 AND (
                  ($2::boolean AND f.id=ANY($4::bigint[])) OR
                  ($3::boolean AND sy.id=ANY($5::bigint[]))
                )
                ORDER BY f.id, sy.id
                LIMIT $6`,
        [
          snapshotId,
          input.direction !== 'inbound',
          input.direction !== 'outbound',
          fileIds,
          symbolIds,
          rawLimit,
        ],
      );
      if (declarations.rows.length >= rawLimit) truncated = true;
      for (const row of declarations.rows.slice(0, input.limit)) {
        const source = fileNode(row.file_id, row.file_path, row.language);
        const target = symbolNode({
          id: row.symbol_id,
          label: row.symbol_label,
          filePath: row.file_path,
          language: row.language,
          qualifiedName: row.qualified_name,
          kind: row.kind,
          startLine: row.start_line,
          endLine: row.end_line,
        });
        nodes.set(source.id, source);
        nodes.set(target.id, target);
        edges.push({ id: `declares:${row.file_id}:${row.symbol_id}`, source: source.id, target: target.id, type: 'declares' });
      }
    }

    const remaining = Math.max(0, input.limit - edges.length);
    if (canUseSymbols && symbolIds.length > 0 && remaining > 0) {
      const relations = input.edgeTypes.filter(type => type !== 'declares').map(type => type.toUpperCase());
      if (allowAllEdges || relations.length > 0) {
        const graphEdges = await queryWithTimeout<EdgeRow>(this.pool,
          `SELECT e.id,
                        source.id AS source_id, source.name AS source_label,
                        source_file.path AS source_file_path, source_file.language AS source_language,
                        source.qualified_name AS source_qualified_name, source.kind AS source_kind,
                        source.start_line AS source_start_line, source.end_line AS source_end_line,
                        target.id AS target_id, target.name AS target_label,
                        target_file.path AS target_file_path, target_file.language AS target_language,
                        target.qualified_name AS target_qualified_name, target.kind AS target_kind,
                        target.start_line AS target_start_line, target.end_line AS target_end_line,
                        e.relation, e.provenance, e.confidence
                   FROM mcp_code_index_edges e
                   JOIN mcp_code_index_symbols source ON source.index_id=e.index_id AND source.id=e.source_symbol_id
                   JOIN mcp_code_index_files source_file ON source_file.index_id=source.index_id AND source_file.id=source.file_id
                   JOIN mcp_code_index_symbols target ON target.index_id=e.index_id AND target.id=e.target_symbol_id
                   JOIN mcp_code_index_files target_file ON target_file.index_id=target.index_id AND target_file.id=target.file_id
                  WHERE e.index_id=$1
                    AND (($2::boolean AND e.source_symbol_id=ANY($4::bigint[]))
                      OR ($3::boolean AND e.target_symbol_id=ANY($4::bigint[])))
                    AND ($5::text[] IS NULL OR e.relation=ANY($5::text[]))
                  ORDER BY e.id
                  LIMIT $6`,
          [
            snapshotId,
            input.direction !== 'inbound',
            input.direction !== 'outbound',
            symbolIds,
            allowAllEdges ? null : relations,
            remaining + 1,
          ],
        );
        if (graphEdges.rows.length > remaining) truncated = true;
        for (const row of graphEdges.rows.slice(0, remaining)) {
          const source = symbolNode({
            id: row.source_id, label: row.source_label, filePath: row.source_file_path,
            language: row.source_language, qualifiedName: row.source_qualified_name,
            kind: row.source_kind, startLine: row.source_start_line, endLine: row.source_end_line,
          });
          const target = symbolNode({
            id: row.target_id, label: row.target_label, filePath: row.target_file_path,
            language: row.target_language, qualifiedName: row.target_qualified_name,
            kind: row.target_kind, startLine: row.target_start_line, endLine: row.target_end_line,
          });
          nodes.set(source.id, source);
          nodes.set(target.id, target);
          edges.push({
            id: `edge:${row.id}`,
            source: source.id,
            target: target.id,
            type: row.relation.toLowerCase(),
            metadata: { provenance: row.provenance, confidence: Number(row.confidence) },
          });
        }
      }
    }

    return { edges, nodes: [...nodes.values()], truncated };
  }
}
