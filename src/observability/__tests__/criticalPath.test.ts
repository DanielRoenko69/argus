import { describe, expect, it } from '@jest/globals';
import { analyzeTelemetryTraceFamily } from '../criticalPath.js';

describe('native critical path analysis', () => {
  it('uses exclusive self time to find the real nested bottleneck', () => {
    const analysis = analyzeTelemetryTraceFamily([
      {
        id: 'root', parent_trace_id: null, parent_span_id: null, name: 'workflow.release', kind: 'workflow',
        status: 'completed', started_at: '2026-08-01T10:00:00.000Z', ended_at: '2026-08-01T10:00:06.000Z', duration_ms: 6000,
      },
      {
        id: 'agent', parent_trace_id: 'root', parent_span_id: 'step', name: 'agent.planner', kind: 'agent',
        status: 'completed', started_at: '2026-08-01T10:00:00.500Z', ended_at: '2026-08-01T10:00:05.000Z', duration_ms: 4500,
      },
    ], [
      {
        id: 'step', trace_id: 'root', parent_span_id: null, name: 'workflow.step.plan', kind: 'workflow',
        status: 'completed', started_at: '2026-08-01T10:00:00.250Z', ended_at: '2026-08-01T10:00:05.250Z', duration_ms: 5000, tool_name: null,
      },
      {
        id: 'llm', trace_id: 'agent', parent_span_id: null, name: 'llm.iteration.1', kind: 'llm',
        status: 'completed', started_at: '2026-08-01T10:00:01.000Z', ended_at: '2026-08-01T10:00:04.000Z', duration_ms: 3000, tool_name: null,
      },
      {
        id: 'tool', trace_id: 'agent', parent_span_id: null, name: 'tool.lookup', kind: 'tool',
        status: 'completed', started_at: '2026-08-01T10:00:04.000Z', ended_at: '2026-08-01T10:00:05.000Z', duration_ms: 1000, tool_name: 'lookup',
      },
    ]);

    expect(analysis.bottleneck).toMatchObject({ key: 'span:llm', selfTimeMs: 3000, durationMs: 3000 });
    expect(analysis.criticalPath).toEqual(['run:root', 'span:step', 'run:agent', 'span:llm']);
    expect(analysis.totalDurationMs).toBe(6000);
    expect(analysis.maxConcurrency).toBe(2);
    expect(analysis.failedNodes).toBe(0);
  });

  it('returns an empty analysis when a trace family has no observable nodes', () => {
    expect(analyzeTelemetryTraceFamily([], [])).toEqual({
      criticalPath: [], bottleneck: null, totalDurationMs: 0, maxConcurrency: 0, failedNodes: 0,
    });
  });
});
