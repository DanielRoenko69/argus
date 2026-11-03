import type { TelemetrySpanRow, TelemetryTraceFamilyRow } from '../observability/telemetryStore.js';
import type {
  CodeRetrievalChannel,
  RunCodeEvidenceCitation,
  RunCodeIntelligenceEvidence,
  RunCodeRetrievalEvidence,
  RunCodeSnapshotEvidence,
} from './types.js';

const CHANNELS = new Set<CodeRetrievalChannel>(['exact', 'lexical', 'vector', 'graph']);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function integer(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function finite(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function channels(value: unknown): CodeRetrievalChannel[] {
  return Array.isArray(value)
    ? value.filter((item): item is CodeRetrievalChannel => typeof item === 'string' && CHANNELS.has(item as CodeRetrievalChannel)).slice(0, 4)
    : [];
}

function citation(value: unknown): RunCodeEvidenceCitation | null {
  const item = record(value);
  const filePath = text(item['file_path'] ?? item['filePath']);
  if (!filePath) return null;
  return {
    filePath,
    symbolName: text(item['symbol_name'] ?? item['symbolName']) || null,
    startLine: integer(item['start_line'] ?? item['startLine']),
    endLine: integer(item['end_line'] ?? item['endLine']),
    chunkKind: text(item['chunk_kind'] ?? item['chunkKind']) || null,
    channels: channels(item['channels']),
    fusedScore: finite(item['fused_score'] ?? item['fusedScore']),
  };
}

function snapshotFromSpan(span: TelemetrySpanRow): RunCodeSnapshotEvidence | null {
  const metadata = record(span.metadata);
  const output = record(span.output_preview);
  const snapshotId = integer(metadata['snapshot_id'] ?? output['snapshotId']);
  const repositoryKey = text(metadata['repository_key']);
  const commitSha = text(metadata['commit_sha'] ?? output['commitSha']);
  if (snapshotId == null || !repositoryKey || !commitSha) return null;
  return {
    snapshotId,
    repositoryKey,
    branchName: text(metadata['branch_name'], 'unknown'),
    commitSha,
    provider: text(metadata['provider'], 'native'),
    fileCount: integer(metadata['files']),
    symbolCount: integer(metadata['symbols']),
    edgeCount: integer(metadata['edges']),
    documentCount: integer(metadata['documents']),
    traceId: span.trace_id,
    spanId: span.id,
    status: span.status,
    observedAt: new Date(span.ended_at ?? span.started_at).toISOString(),
  };
}

function closestAgentRuntime(
  span: TelemetrySpanRow,
  traces: readonly TelemetryTraceFamilyRow[],
  agentId: number | null,
): TelemetryTraceFamilyRow | null {
  if (agentId == null) return null;
  const observedAt = Date.parse(String(span.ended_at ?? span.started_at));
  return traces
    .filter(trace => trace.kind === 'agent' && trace.agent_id === agentId)
    .sort((left, right) => {
      const leftDistance = Math.abs(Date.parse(String(left.started_at)) - observedAt);
      const rightDistance = Math.abs(Date.parse(String(right.started_at)) - observedAt);
      return leftDistance - rightDistance;
    })[0] ?? null;
}

function retrievalFromSpan(
  span: TelemetrySpanRow,
  traces: readonly TelemetryTraceFamilyRow[],
): RunCodeRetrievalEvidence {
  const metadata = record(span.metadata);
  const output = record(span.output_preview);
  const agentId = integer(metadata['agent_id']);
  const runtime = closestAgentRuntime(span, traces, agentId);
  const runtimeMetadata = record(runtime?.metadata);
  const parsedCitations = Array.isArray(metadata['citations'])
    ? metadata['citations'].map(citation).filter((item): item is RunCodeEvidenceCitation => item !== null).slice(0, 8)
    : [];
  return {
    traceId: span.trace_id,
    spanId: span.id,
    agentId,
    agentName: text(runtime?.agent_name ?? runtimeMetadata['agent_name']) || null,
    runtimeTraceId: runtime?.id ?? null,
    taskType: text(runtimeMetadata['task_type']) || null,
    snapshotId: integer(metadata['snapshot_id'] ?? output['snapshotId']),
    status: span.status,
    durationMs: span.duration_ms == null ? null : Math.max(0, Number(span.duration_ms)),
    evidenceCount: integer(metadata['evidence_count'] ?? output['evidenceCount']) ?? parsedCitations.length,
    channels: channels(metadata['channels']),
    citations: parsedCitations,
    observedAt: new Date(span.ended_at ?? span.started_at).toISOString(),
    error: span.error_message,
  };
}

/**
 * Build UI evidence only from spans already authorized by the caller's trace
 * family. Raw repository chunks and embeddings are intentionally excluded.
 */
export function buildRunCodeIntelligenceEvidence(
  spans: readonly TelemetrySpanRow[],
  traces: readonly TelemetryTraceFamilyRow[] = [],
): RunCodeIntelligenceEvidence | null {
  const relevant = spans
    .filter(span => span.name === 'code_intelligence.index' || span.name === 'code_intelligence.context')
    .sort((left, right) => Date.parse(String(left.started_at)) - Date.parse(String(right.started_at)));
  if (relevant.length === 0) return null;

  const snapshots = new Map<number, RunCodeSnapshotEvidence>();
  const retrievals: RunCodeRetrievalEvidence[] = [];
  for (const span of relevant) {
    const snapshot = snapshotFromSpan(span);
    // The index span is normally observed before context retrieval and carries
    // the complete counters. Do not let a later, deliberately smaller context
    // span replace that canonical observation.
    if (snapshot && !snapshots.has(snapshot.snapshotId)) snapshots.set(snapshot.snapshotId, snapshot);
    if (span.name === 'code_intelligence.context') retrievals.push(retrievalFromSpan(span, traces));
  }

  return {
    mode: retrievals.some(item => item.status === 'completed' && item.evidenceCount > 0)
      ? 'local_retrieval'
      : 'metadata_only',
    snapshots: [...snapshots.values()],
    retrievals,
  };
}
