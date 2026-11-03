import { z } from 'zod';
import type pg from 'pg';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../lib/logger.js';
import { searchCodeIndex } from './retrieval.js';
import { CodeIndexValidationError } from './store.js';
import { ensureNativeWorkspaceCodeIndex } from './workspaceIndexer.js';

export const ARGUS_CODE_INTELLIGENCE_TOOL_NAMES = [
  'argus_code_index_status',
  'argus_code_search',
  'argus_code_request_reindex',
] as const;
export type ArgusCodeIntelligenceToolName = typeof ARGUS_CODE_INTELLIGENCE_TOOL_NAMES[number];

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const StatusInput = z.object({
  snapshot_id: z.number().int().positive().optional(),
  repository_key: z.string().trim().min(1).max(512).optional(),
  branch_name: z.string().trim().min(1).max(255).optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
const SearchInput = z.object({
  snapshot_id: z.number().int().positive(),
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(20).default(8),
  include_graph: z.boolean().default(true),
});
const ReindexInput = z.object({}).strict();

export interface ArgusCodeIntelligenceRuntimeContext {
  allowedBundleIds: number[] | null;
  workspaceRoot?: string;
  repositoryKey?: string;
  branchHint?: string | null;
}

function success(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function boundedSnippet(value: string, maximum = 12_000): { text: string; truncated: boolean } {
  if (value.length <= maximum) return { text: value, truncated: false };
  return { text: `${value.slice(0, maximum)}\n… [TRUNCATED]`, truncated: true };
}

async function status(
  pool: pg.Pool,
  args: z.infer<typeof StatusInput>,
  allowedBundleIds: number[] | null,
): Promise<ToolResult> {
  const result = await pool.query<{
    id: number | string;
    repository_key: string;
    branch_name: string;
    commit_sha: string;
    provider: string;
    parser_version: string | null;
    embedding_model: string | null;
    status: string;
    file_count: number | string;
    symbol_count: number | string;
    edge_count: number | string;
    document_count: number | string;
    created_at: Date | string;
    finished_at: Date | string | null;
  }>(
    `SELECT s.id, s.repository_key, s.branch_name, s.commit_sha, s.provider,
            s.parser_version, s.embedding_model, s.status, s.file_count, s.symbol_count,
            s.edge_count, s.document_count, s.created_at, s.finished_at
       FROM mcp_code_index_snapshots s
      WHERE s.status='ready'
        AND ($1::int[] IS NULL OR EXISTS (
          SELECT 1 FROM mcp_code_index_snapshot_bundles scope
           WHERE scope.index_id=s.id AND scope.bundle_id=ANY($1::int[])
        ))
        AND ($2::bigint IS NULL OR s.id=$2)
        AND ($3::text IS NULL OR s.repository_key=$3)
        AND ($4::text IS NULL OR s.branch_name=$4)
      ORDER BY s.finished_at DESC, s.id DESC LIMIT $5`,
    [allowedBundleIds, args.snapshot_id ?? null, args.repository_key ?? null, args.branch_name ?? null, args.limit],
  );
  return success({
    count: result.rows.length,
    indexes: result.rows.map(row => ({
      snapshotId: Number(row.id), repositoryKey: row.repository_key,
      branchName: row.branch_name, commitSha: row.commit_sha, provider: row.provider,
      parserVersion: row.parser_version, embeddingModel: row.embedding_model, status: row.status,
      files: Number(row.file_count), symbols: Number(row.symbol_count),
      edges: Number(row.edge_count), documents: Number(row.document_count),
      createdAt: new Date(row.created_at).toISOString(),
      finishedAt: row.finished_at == null ? null : new Date(row.finished_at).toISOString(),
    })),
  });
}

async function search(
  pool: pg.Pool,
  args: z.infer<typeof SearchInput>,
  allowedBundleIds: number[] | null,
): Promise<ToolResult> {
  const result = await searchCodeIndex(pool, {
    snapshotId: args.snapshot_id,
    query: args.query,
    limit: args.limit,
    includeGraph: args.include_graph,
    allowedBundleIds,
  });
  return success({
    snapshot: {
      id: result.snapshot.id, repositoryKey: result.snapshot.repositoryKey,
      branchName: result.snapshot.branchName, commitSha: result.snapshot.commitSha,
      provider: result.snapshot.provider,
    },
    query: result.query,
    channelsUsed: result.channelsUsed,
    evidence: result.evidence.map(item => {
      const snippet = boundedSnippet(item.content);
      return {
        citation: `${item.repositoryKey}@${item.commitSha}:${item.filePath}${item.startLine == null ? '' : `#L${item.startLine}-L${item.endLine}`}`,
        filePath: item.filePath, symbol: item.qualifiedName, kind: item.symbolKind,
        startLine: item.startLine, endLine: item.endLine, channels: item.channels,
        scores: item.scores, graphRelations: item.graphRelations,
        content: snippet.text, truncated: snippet.truncated,
      };
    }),
  });
}

async function reindex(
  pool: pg.Pool,
  _args: z.infer<typeof ReindexInput>,
  runtime: ArgusCodeIntelligenceRuntimeContext,
): Promise<ToolResult> {
  if (!runtime.workspaceRoot || runtime.allowedBundleIds == null) {
    return failure('Reindex requires an exact signed Dev workspace, repository identity and MCP Bundle scope.');
  }
  const snapshot = await ensureNativeWorkspaceCodeIndex(pool, {
    workspaceRoot: runtime.workspaceRoot,
    repositoryKey: runtime.repositoryKey,
    branchHint: runtime.branchHint,
    executionBundleIds: runtime.allowedBundleIds,
  });
  return success({
    snapshotId: snapshot.id, repositoryKey: snapshot.repositoryKey,
    branchName: snapshot.branchName, commitSha: snapshot.commitSha,
    provider: snapshot.provider, status: snapshot.status,
    files: snapshot.fileCount, symbols: snapshot.symbolCount,
    edges: snapshot.edgeCount, documents: snapshot.documentCount,
  });
}

export function isArgusCodeIntelligenceTool(name: string): name is ArgusCodeIntelligenceToolName {
  return (ARGUS_CODE_INTELLIGENCE_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeArgusCodeIntelligenceTool(
  pool: pg.Pool,
  name: ArgusCodeIntelligenceToolName,
  rawArgs: Record<string, unknown>,
  allowedBundleIds: number[] | null,
  runtimeContext: Omit<ArgusCodeIntelligenceRuntimeContext, 'allowedBundleIds'> = {},
): Promise<ToolResult> {
  try {
    if (name === 'argus_code_index_status') {
      return await status(pool, StatusInput.parse(rawArgs), allowedBundleIds);
    }
    if (name === 'argus_code_search') return await search(pool, SearchInput.parse(rawArgs), allowedBundleIds);
    return await reindex(pool, ReindexInput.parse(rawArgs), { ...runtimeContext, allowedBundleIds });
  } catch (error) {
    if (!(error instanceof z.ZodError) && !(error instanceof CodeIndexValidationError)) {
      logger.warn({ err: error, tool: name }, 'Native code intelligence tool failed');
    }
    const message = error instanceof z.ZodError
      ? `Invalid arguments: ${error.issues.map(issue => issue.message).join('; ')}`
      : error instanceof CodeIndexValidationError
        ? error.message
        : 'Code intelligence query failed. Inspect Argus server logs for details.';
    return failure(message);
  }
}

export async function registerArgusCodeIntelligenceTools(
  server: McpServer,
  pool: pg.Pool,
  allowedToolNames: Set<string> | null,
  allowedBundleIds: number[] | null,
): Promise<void> {
  const result = await pool.query<{ name: string }>(
    `SELECT name FROM mcp_tools
      WHERE enabled=true AND tool_type='builtin'
        AND backend IN ('argus-code-intelligence', 'argus-code-indexer')
        AND name=ANY($1::text[])`,
    [[...ARGUS_CODE_INTELLIGENCE_TOOL_NAMES]],
  );
  const enabled = new Set(result.rows.map(row => row.name));
  const available = (name: ArgusCodeIntelligenceToolName) =>
    enabled.has(name) && (allowedToolNames == null || allowedToolNames.has(name));

  if (available('argus_code_index_status')) server.tool(
    'argus_code_index_status',
    'List immutable native code indexes accessible through the current MCP Bundle scope. Returns exact repository commits and coverage counts.',
    StatusInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusCodeIntelligenceTool(pool, 'argus_code_index_status', args, allowedBundleIds),
  );
  if (available('argus_code_search')) server.tool(
    'argus_code_search',
    'Search one exact immutable code snapshot using symbol names, source text and a bounded dependency-graph expansion. Every result includes a repository@commit:path#line citation.',
    SearchInput.shape,
    READ_ONLY_ANNOTATIONS,
    args => executeArgusCodeIntelligenceTool(pool, 'argus_code_search', args, allowedBundleIds),
  );
  if (available('argus_code_request_reindex')) server.tool(
    'argus_code_request_reindex',
    'Build or reuse the native code index for the exact execution-grant-bound Dev workspace. The caller cannot choose a filesystem root, repository or commit.',
    ReindexInput.shape,
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    args => executeArgusCodeIntelligenceTool(pool, 'argus_code_request_reindex', args, allowedBundleIds),
  );
}
