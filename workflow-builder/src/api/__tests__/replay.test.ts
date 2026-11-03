import { describe, expect, it } from 'vitest';
import { normalizeWorkflowReplay } from '../replay';

describe('normalizeWorkflowReplay', () => {
  it('retains visual routing and skipped-branch evidence from the correlated thread', () => {
    const replay = normalizeWorkflowReplay('927d3c7a-4b82-4693-bf67-9e96159990c1', {
      status: 'idle',
      values: {
        current_stage: 'response',
        visual_completed: true,
        step_results: {
          route: {
            status: 'completed', label: 'Intent route', type: 'logic.router',
            result: 'plan', durationMs: 2, selectedTarget: 'planner',
          },
          planner: {
            status: 'completed', label: 'Planner', type: 'argus.agent',
            result: 'Plan result', durationMs: 1200, agentRole: 'planner', agentId: 7,
            agentName: 'delivery-planner', traceId: '33333333-3333-4333-8333-333333333333',
            sessionId: 'session-1', runtimeRunId: 'runtime-1', telemetryStatus: 'completed',
            model: 'gpt-5.6-terra', provider: 'codex-subscription', runtimeType: 'codex',
            runtimeProfile: 'codex-terra', reasoningEffort: 'xhigh',
          },
          reviewer: {
            status: 'skipped', label: 'Reviewer', type: 'argus.agent',
            result: "Route selected 'planner'", durationMs: 0,
          },
        },
      },
    });

    expect(replay).toMatchObject({
      status: 'completed', currentStage: 'response', completed: true, canCancel: false, approval: null,
    });
    expect(replay.steps.route).toMatchObject({ selectedTarget: 'planner', result: 'plan' });
    expect(replay.steps.planner).toMatchObject({
      agentRole: 'planner', agentId: 7, agentName: 'delivery-planner',
      traceId: '33333333-3333-4333-8333-333333333333', sessionId: 'session-1', runtimeRunId: 'runtime-1',
      model: 'gpt-5.6-terra', provider: 'codex-subscription', runtimeType: 'codex',
      runtimeProfile: 'codex-terra', reasoningEffort: 'xhigh',
    });
    expect(replay.steps.reviewer.status).toBe('skipped');
  });

  it('normalizes a resumable approval checkpoint without exposing raw interrupts', () => {
    const replay = normalizeWorkflowReplay('927d3c7a-4b82-4693-bf67-9e96159990c1', {
      status: 'interrupted',
      can_cancel: true,
      approval: { stage: 'release_approval', message: 'Approve this release?' },
      values: { current_stage: 'release_approval', visual_completed: false, step_results: {} },
    });

    expect(replay).toMatchObject({
      status: 'interrupted', completed: false, canCancel: true,
      approval: { stage: 'release_approval', message: 'Approve this release?' },
    });
  });
});
