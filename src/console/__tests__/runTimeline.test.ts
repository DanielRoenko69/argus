import { buildWorkflowTimeline, visualWorkflowIdFromTraceMetadata } from '../consoleApi.js';

type TimelineRun = Parameters<typeof buildWorkflowTimeline>[0];
type TimelineApproval = Parameters<typeof buildWorkflowTimeline>[1][number];

function run(overrides: Partial<TimelineRun> = {}): TimelineRun {
  return {
    id: '44',
    workflow_id: 8,
    workflow_name: 'release_workflow',
    description: '',
    status: 'completed',
    started_at: '2026-07-29T08:00:00.000Z',
    completed_at: '2026-07-29T08:00:06.000Z',
    duration_ms: 6000,
    triggered_by: 'builder:alex',
    error_message: null,
    workflow_steps: [
      { id: 'inspect', label: 'Inspect target', type: 'argus.tool', tool: 'inspect', args: {} },
      { id: 'deploy', label: 'Deploy release', type: 'argus.tool', tool: 'deploy', args: {}, depends_on: ['inspect'] },
    ],
    input_args: {},
    execution_snapshot: {},
    step_results: {
      inspect: {
        status: 'completed',
        result: 'ready',
        duration_ms: 1000,
        started_at: '2026-07-29T08:00:00.000Z',
        completed_at: '2026-07-29T08:00:01.000Z',
      },
      deploy: {
        status: 'completed',
        result: 'release-42',
        duration_ms: 900,
        started_at: '2026-07-29T08:00:04.000Z',
        completed_at: '2026-07-29T08:00:05.000Z',
      },
    },
    waiting_approval_id: null,
    waiting_step_id: null,
    resume_count: 1,
    resumed_at: '2026-07-29T08:00:03.500Z',
    lifecycle_status: 'production',
    human_oversight_required: true,
    tags: ['release'],
    ...overrides,
  };
}

describe('console workflow run timeline', () => {
  it('resolves a visual workflow id from persisted Pack trace metadata', () => {
    expect(visualWorkflowIdFromTraceMetadata({
      workflow_id: 'visual-149-visual-router-prototype',
      workflow_type: 'visual_workflow_149',
    })).toBe(149);
    expect(visualWorkflowIdFromTraceMetadata({ workflow_type: 'visual_workflow_23' })).toBe(23);
    expect(visualWorkflowIdFromTraceMetadata({ workflow_id: '../../admin' })).toBeNull();
  });

  it('merges step, approval, resume, and terminal events chronologically', () => {
    const approval: TimelineApproval = {
      id: 71,
      status: 'consumed',
      tool_name: 'deploy',
      workflow_step_id: 'deploy',
      requested_at: '2026-07-29T08:00:02.000Z',
      decided_at: '2026-07-29T08:00:03.000Z',
      consumed_at: '2026-07-29T08:00:04.000Z',
      decided_by_username: 'reviewer',
      decision_comment: 'Looks safe',
      risk_level: 'critical',
      risk_score: 95,
      risk_factors: [{
        id: 'production-target',
        label: 'Production target',
        category: 'environment',
        weight: 30,
        evidence: 'Production environment.',
      }],
      risk_model: 'argus-risk-v1',
    };

    const timeline = buildWorkflowTimeline(run(), [approval]);

    expect(timeline.map(event => event.kind)).toEqual([
      'run_started',
      'step_completed',
      'approval_requested',
      'approval_approved',
      'run_resumed',
      'step_completed',
      'run_completed',
    ]);
    expect(timeline.find(event => event.kind === 'approval_requested')).toMatchObject({
      approvalId: 71,
      stepId: 'deploy',
      toolName: 'deploy',
    });
    expect(timeline.find(event => event.kind === 'approval_approved')?.comment).toBe('Looks safe');
    expect(timeline.find(event => event.kind === 'approval_requested')).toMatchObject({
      riskLevel: 'critical',
      riskScore: 95,
    });
  });

  it('shows a rejected approval before a cancelled execution', () => {
    const timeline = buildWorkflowTimeline(run({
      status: 'cancelled',
      error_message: 'Runtime approval #72 was rejected: maintenance freeze',
      step_results: {
        deploy: {
          status: 'waiting',
          duration_ms: 20,
          started_at: '2026-07-29T08:00:01.000Z',
          completed_at: '2026-07-29T08:00:01.020Z',
          approval_request_id: 72,
        },
      },
      resume_count: 0,
      resumed_at: null,
    }), [{
      id: 72,
      status: 'rejected',
      tool_name: 'deploy',
      workflow_step_id: 'deploy',
      requested_at: '2026-07-29T08:00:01.020Z',
      decided_at: '2026-07-29T08:00:05.000Z',
      consumed_at: null,
      decided_by_username: 'reviewer',
      decision_comment: 'maintenance freeze',
      risk_level: 'high',
      risk_score: 70,
      risk_factors: [],
      risk_model: 'argus-risk-v1',
    }]);

    expect(timeline.at(-2)?.kind).toBe('approval_rejected');
    expect(timeline.at(-1)?.kind).toBe('run_cancelled');
  });

  it('adds redacted span input without exposing credential fields', () => {
    const timeline = buildWorkflowTimeline(run({
      workflow_steps: [{
        id: 'inspect',
        label: 'Inspect target',
        type: 'argus.tool',
        tool: 'inspect',
        args: { namespace: 'platform', api_token: 'never-show-this' },
      }],
      step_results: {
        inspect: {
          status: 'completed', result: { healthy: true }, duration_ms: 1000,
          started_at: '2026-07-29T08:00:00.000Z', completed_at: '2026-07-29T08:00:01.000Z',
        },
      },
    }), []);
    const span = timeline.find(event => event.kind === 'step_completed');
    expect(span?.inputPreview).toContain('platform');
    expect(span?.inputPreview).toContain('[REDACTED]');
    expect(span?.inputPreview).not.toContain('never-show-this');
  });
});
