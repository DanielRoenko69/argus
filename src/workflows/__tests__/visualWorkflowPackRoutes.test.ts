import { afterEach, describe, expect, it, jest } from '@jest/globals';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type pg from 'pg';
import { registerBuilderRoutes, type VisualWorkflowPackGateway } from '../builderRoutes.js';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    server.close(() => resolve());
  })));
});

function workflowRow() {
  return {
    id: 9,
    name: 'governed_delivery',
    description: 'Visual delivery',
    updated_at: '2026-08-20T10:00:00.000Z',
    input_params: [{ name: 'task', type: 'string', description: 'Task', required: true }],
    agent_requirements: [],
    bundle_ids: [3],
    steps: [
      { id: 'start', label: 'Start', type: 'trigger.manual', args: {} },
      { id: 'plan', label: 'Plan', type: 'argus.agent', agent_role: 'planner', args: { prompt: '{{ input.task }}' }, depends_on: ['start'] },
      { id: 'approval', label: 'Approve', type: 'argus.approval', args: { message: 'Approve?' }, depends_on: ['plan'] },
      { id: 'response', label: 'Result', type: 'logic.response', args: { value: '{{ steps.plan.result }}' }, depends_on: ['approval'] },
    ],
  };
}

async function serve(gateway: VisualWorkflowPackGateway): Promise<string> {
  const app = express();
  app.use(express.json());
  const pool = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM mcp_workflows w')) return { rows: [workflowRow()] };
      if (sql.includes('FROM mcp_observability_traces trace')) return { rows: [{
        id: '33333333-3333-4333-8333-333333333333',
        status: 'completed',
        agent_id: 12,
        agent_name: 'release-planner',
        model: 'gpt-5.6-terra',
        provider: 'codex-subscription',
        session_id: 'session-plan',
        duration_ms: 1250,
        metadata: {
          agent_role: 'planner', runtime_type: 'codex', runtime_profile_name: 'codex-terra',
          reasoning_effort: 'xhigh',
        },
      }] };
      return { rows: [] };
    }),
  } as unknown as pg.Pool;
  registerBuilderRoutes(app, pool, (req: Request, _res: Response, next: () => void) => {
    Object.assign(req, { user: { id: 7, username: 'alex', role: 'developer', allowed_bundles: [3] } });
    next();
  }, gateway);
  const server = await new Promise<Server>(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('visual workflow Pack bridge', () => {
  it('exposes a fresh identity-scoped resource preflight for the saved graph', async () => {
    const gateway: VisualWorkflowPackGateway = {
      async publish() { return {}; },
      async start() { throw new Error('not used'); },
    };
    const baseUrl = await serve(gateway);
    const response = await fetch(`${baseUrl}/api/workflows/9/preflight`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workflowId: 9,
      workflowName: 'governed_delivery',
      ready: true,
      blockers: [],
      tools: [],
    });
  });

  it('publishes the saved revision before starting a scoped A2A task', async () => {
    const calls: string[] = [];
    const gateway: VisualWorkflowPackGateway = {
      async publish(spec) {
        calls.push(`publish:${spec.id}`);
        return { ok: true, revision: spec.revision };
      },
      async start(spec, input, execution) {
        calls.push(`start:${spec.id}`);
        expect(input).toEqual({ task: 'Prepare the release' });
        expect(execution).toMatchObject({
          principalKind: 'user', principalId: '7',
          principalAllowedBundleIds: [3], requestedBundleIds: [3],
        });
        return {
          rootTraceId: '11111111-1111-4111-8111-111111111111',
          agentCard: {} as never,
          task: { id: '22222222-2222-4222-8222-222222222222', status: { state: 'TASK_STATE_WORKING' } } as never,
        };
      },
    };
    const baseUrl = await serve(gateway);
    const response = await fetch(`${baseUrl}/api/workflows/9/pack-run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: { task: 'Prepare the release' } }),
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(calls).toEqual(['publish:visual-9-governed-delivery', 'start:visual-9-governed-delivery']);
    expect(body['rootTraceId']).toBe('11111111-1111-4111-8111-111111111111');
    expect(body['workflowThreadId']).toBe('11111111-1111-4111-8111-111111111111');
    expect(body['taskId']).toBe('22222222-2222-4222-8222-222222222222');
    expect(body['status']).toBe('TASK_STATE_WORKING');
    expect(body['task']).toMatchObject({
      id: '22222222-2222-4222-8222-222222222222',
      status: { state: 'TASK_STATE_WORKING' },
    });
  });

  it('multiplexes a correlated Pack thread into a scoped read-only replay payload', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    const gateway: VisualWorkflowPackGateway = {
      async publish() { return {}; },
      async start() { throw new Error('not used'); },
      async loadReplay(spec, requestedTraceId) {
        expect(spec).toMatchObject({ id: 'visual-9-governed-delivery', graphId: 'visual_workflow_9' });
        expect(requestedTraceId).toBe(traceId);
        return {
          graph_id: 'visual_workflow_9',
          status: 'completed',
          metadata: { workflow_id: 'visual-9-governed-delivery' },
          values: {
            current_stage: 'response',
            visual_completed: true,
            step_results: {
              route: { status: 'completed', result: 'plan', selectedTarget: 'plan' },
              plan: {
                status: 'completed', label: 'Plan', type: 'argus.agent', result: 'Ship in two phases.',
                traceId: '33333333-3333-4333-8333-333333333333', runtimeRunId: 'runtime-plan-1',
              },
              review: { status: 'skipped', result: 'not selected' },
            },
            agent_outputs: [{ output: 'must not be included in the canvas response' }],
          },
        };
      },
    };
    const baseUrl = await serve(gateway);
    const response = await fetch(`${baseUrl}/api/workflows/9/replay/${traceId}`);
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      thread_id: traceId,
      graph_id: 'visual_workflow_9',
      status: 'completed',
      values: {
        current_stage: 'response',
        visual_completed: true,
        step_results: {
          route: { status: 'completed', result: 'plan', selectedTarget: 'plan' },
          plan: {
            status: 'completed', result: 'Ship in two phases.',
            traceId: '33333333-3333-4333-8333-333333333333',
            runtimeRunId: 'runtime-plan-1', agentRole: 'planner', agentId: 12,
            agentName: 'release-planner', model: 'gpt-5.6-terra', provider: 'codex-subscription',
            runtimeType: 'codex', runtimeProfile: 'codex-terra', reasoningEffort: 'xhigh',
          },
          review: { status: 'skipped' },
        },
      },
    });
    expect((body['values'] as Record<string, unknown>)['agent_outputs']).toBeUndefined();
  });

  it('projects workflow-scoped Pack threads into a sanitized visual run history', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    const gateway: VisualWorkflowPackGateway = {
      async publish() { return {}; },
      async start() { throw new Error('not used'); },
      async listReplays(spec, limit) {
        expect(spec).toMatchObject({ id: 'visual-9-governed-delivery', graphId: 'visual_workflow_9' });
        expect(limit).toBe(10);
        return [{
          thread_id: traceId,
          graph_id: 'visual_workflow_9',
          status: 'completed',
          error: null,
          created_at: '2026-08-21T10:00:00.000Z',
          updated_at: '2026-08-21T10:01:15.000Z',
          metadata: {
            workflow_id: 'visual-9-governed-delivery',
            run_title: 'Governed release',
            a2a_task_id: '22222222-2222-4222-8222-222222222222',
          },
          values: {
            current_stage: 'response', visual_completed: true,
            step_results: {
              plan: { type: 'argus.agent', result: 'private full output is not listed here' },
              response: { type: 'logic.response', result: 'done' },
            },
            agent_outputs: [{ output: 'must not be exposed by history' }],
          },
        }, {
          thread_id: '44444444-4444-4444-8444-444444444444',
          graph_id: 'different_graph', metadata: { workflow_id: 'some-other-workflow' }, values: {},
        }];
      },
    };
    const baseUrl = await serve(gateway);
    const response = await fetch(`${baseUrl}/api/workflows/9/pack-runs?limit=10`);
    const body = await response.json() as { runs: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.runs).toEqual([expect.objectContaining({
      traceId,
      taskId: '22222222-2222-4222-8222-222222222222',
      title: 'Governed release', status: 'completed', currentStage: 'response', completed: true,
      stepCount: 2, agentStepCount: 1, durationMs: 75_000,
      canCancel: false, canResume: false, approvalStage: null,
      replayHref: `/build/workflows/studio/9?replay=${traceId}`,
    })]);
    expect(JSON.stringify(body)).not.toContain('private full output');
    expect(JSON.stringify(body)).not.toContain('must not be exposed');
  });

  it('controls only the scoped Pack task at a durable approval checkpoint', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    const taskId = '22222222-2222-4222-8222-222222222222';
    const calls: Array<Record<string, unknown>> = [];
    const gateway: VisualWorkflowPackGateway = {
      async publish() { return {}; },
      async start() { throw new Error('not used'); },
      async loadReplay() {
        return {
          thread_id: traceId,
          graph_id: 'visual_workflow_9',
          status: 'interrupted',
          metadata: { workflow_id: 'visual-9-governed-delivery', a2a_task_id: taskId },
          interrupts: [{ value: { stage: 'approval', message: 'Approve the governed delivery?' } }],
          values: { current_stage: 'approval', visual_completed: false, step_results: {} },
        };
      },
      async cancelReplay(spec, requestedTraceId, requestedTaskId) {
        calls.push({ operation: 'cancel', workflowId: spec.id, traceId: requestedTraceId, taskId: requestedTaskId });
        return { id: requestedTaskId, status: { state: 'TASK_STATE_CANCELED' } };
      },
      async resumeReplay(spec, requestedTraceId, decision) {
        calls.push({ operation: 'resume', workflowId: spec.id, traceId: requestedTraceId, decision });
        return { run_id: '55555555-5555-4555-8555-555555555555', status: 'queued' };
      },
    };
    const baseUrl = await serve(gateway);

    const replayResponse = await fetch(`${baseUrl}/api/workflows/9/replay/${traceId}`);
    const replay = await replayResponse.json() as Record<string, unknown>;
    expect(replayResponse.status).toBe(200);
    expect(replay).toMatchObject({
      status: 'interrupted', can_cancel: true,
      approval: { stage: 'approval', message: 'Approve the governed delivery?' },
    });

    const resumeResponse = await fetch(`${baseUrl}/api/workflows/9/replay/${traceId}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approved', feedback: 'Evidence accepted.' }),
    });
    expect(resumeResponse.status).toBe(200);
    expect(await resumeResponse.json()).toMatchObject({
      ok: true, traceId, decision: 'approved', approvalStage: 'approval',
      run: { status: 'queued' },
    });

    const cancelResponse = await fetch(`${baseUrl}/api/workflows/9/replay/${traceId}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(cancelResponse.status).toBe(200);
    expect(calls).toEqual([
      {
        operation: 'resume', workflowId: 'visual-9-governed-delivery', traceId,
        decision: { approved: true, feedback: 'Evidence accepted.' },
      },
      { operation: 'cancel', workflowId: 'visual-9-governed-delivery', traceId, taskId },
    ]);
  });

  it('rejects unsafe cancellation while an Agent node is active', async () => {
    const traceId = '927d3c7a-4b82-4693-bf67-9e96159990c1';
    const gateway: VisualWorkflowPackGateway = {
      async publish() { return {}; },
      async start() { throw new Error('not used'); },
      async loadReplay() {
        return {
          graph_id: 'visual_workflow_9', status: 'running',
          metadata: {
            workflow_id: 'visual-9-governed-delivery',
            a2a_task_id: '22222222-2222-4222-8222-222222222222',
          }, values: {},
        };
      },
      async cancelReplay() { throw new Error('must not be called'); },
    };
    const baseUrl = await serve(gateway);
    const response = await fetch(`${baseUrl}/api/workflows/9/replay/${traceId}/cancel`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'the active Agent step must settle before this run can be cancelled safely',
    });
  });
});
