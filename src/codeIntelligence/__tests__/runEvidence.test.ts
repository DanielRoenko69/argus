import { describe, expect, it } from '@jest/globals';
import type { TelemetrySpanRow, TelemetryTraceFamilyRow } from '../../observability/telemetryStore.js';
import { buildRunCodeIntelligenceEvidence } from '../runEvidence.js';

function span(overrides: Partial<TelemetrySpanRow>): TelemetrySpanRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    trace_id: '22222222-2222-4222-8222-222222222222',
    parent_span_id: null,
    name: 'code_intelligence.index',
    kind: 'rag',
    status: 'completed',
    model: null,
    provider: null,
    tool_name: null,
    started_at: '2026-08-14T10:00:00.000Z',
    ended_at: '2026-08-14T10:00:00.020Z',
    duration_ms: 20,
    input_preview: null,
    output_preview: { snapshotId: 7, commitSha: 'a'.repeat(40) },
    error_message: null,
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
    metadata: {
      snapshot_id: 7, repository_key: 'argus/sample', branch_name: 'main',
      commit_sha: 'a'.repeat(40), provider: 'graphify', files: 5, symbols: 24,
      edges: 24, documents: 29,
    },
    ...overrides,
  };
}

function trace(overrides: Partial<TelemetryTraceFamilyRow> = {}): TelemetryTraceFamilyRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    external_trace_id: null,
    root_trace_id: '22222222-2222-4222-8222-222222222222',
    parent_trace_id: '22222222-2222-4222-8222-222222222222',
    parent_span_id: null,
    name: 'agent.codex',
    kind: 'agent',
    status: 'completed',
    session_id: null,
    user_id: null,
    agent_id: 6,
    workflow_execution_id: null,
    model: 'gpt-5.6-terra',
    provider: 'codex-subscription',
    started_at: '2026-08-14T10:00:00.025Z',
    ended_at: '2026-08-14T10:00:01.000Z',
    duration_ms: 975,
    input_preview: null,
    output_preview: null,
    error_message: null,
    input_tokens: 0,
    output_tokens: 0,
    total_cost_usd: 0,
    metadata: { task_type: 'plan' },
    agent_name: 'planner',
    workflow_id: null,
    workflow_name: null,
    ...overrides,
  };
}

describe('run code intelligence evidence', () => {
  it('projects source-free snapshot and citation metadata from authorized spans', () => {
    const result = buildRunCodeIntelligenceEvidence([
      span({}),
      span({
        id: '33333333-3333-4333-8333-333333333333',
        name: 'code_intelligence.context',
        duration_ms: 31,
        output_preview: { snapshotId: 7, evidenceCount: 1 },
        metadata: {
          snapshot_id: 7, repository_key: 'argus/sample', commit_sha: 'a'.repeat(40),
          agent_id: 6, evidence_count: 1, channels: ['exact', 'graph'],
          citations: [{ file_path: 'src/app.ts', symbol_name: 'createApp', start_line: 17, end_line: 35, chunk_kind: 'symbol', channels: ['exact', 'graph'], fused_score: 1.25 }],
        },
      }),
    ], [trace()]);

    expect(result).toMatchObject({
      mode: 'local_retrieval',
      snapshots: [{ snapshotId: 7, repositoryKey: 'argus/sample', fileCount: 5 }],
      retrievals: [{
        agentId: 6,
        agentName: 'planner',
        runtimeTraceId: '44444444-4444-4444-8444-444444444444',
        taskType: 'plan',
        evidenceCount: 1,
        citations: [{ filePath: 'src/app.ts', symbolName: 'createApp', startLine: 17 }],
      }],
    });
    expect(JSON.stringify(result)).not.toContain('export function');
  });

  it('returns null when the visible trace family contains no native code spans', () => {
    expect(buildRunCodeIntelligenceEvidence([span({ name: 'rag.context' })])).toBeNull();
  });
});
