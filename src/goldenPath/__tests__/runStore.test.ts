import { readFileSync } from 'node:fs';
import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import type { SessionUser } from '../../auth/userAuth.js';
import { workflowTelemetryTraceId } from '../../observability/telemetryStore.js';
import { goldenPathPreflightSchema } from '../contracts.js';
import {
  claimGoldenPathRun,
  goldenPathStartReceipt,
  goldenPathWorkflowInputs,
  loadGoldenPathRun,
} from '../runStore.js';

const preflight = goldenPathPreflightSchema.parse(JSON.parse(readFileSync(
  'docs/specs/golden-path/preflight-ready.v1.fixture.json',
  'utf8',
)));
const user: SessionUser = {
  id: 7,
  username: 'alex',
  display_name: 'Alex',
  role: 'agent_operator',
  allowed_bundles: null,
  entra_groups: [],
};

function poolWithQuery(handler: (sql: string, params: unknown[]) => unknown): pg.Pool {
  return {
    query: jest.fn(async (sql: unknown, params?: unknown[]) => handler(String(sql), params ?? [])),
  } as unknown as pg.Pool;
}

describe('Golden Path run persistence', () => {
  it('claims an idempotent run without persisting the raw key', async () => {
    const pool = poolWithQuery((_sql, params) => ({ rows: [{
      id: params[0],
      workflow_execution_id: null,
      idempotency_key_sha256: params[8],
      status: 'starting',
    }] }));

    const result = await claimGoldenPathRun(pool, user, preflight, 'golden-path-click-0001');
    const calls = (pool.query as jest.MockedFunction<pg.Pool['query']>).mock.calls;
    const serializedParameters = JSON.stringify(calls[0]?.[1]);

    expect(result.created).toBe(true);
    expect(result.row.idempotency_key_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serializedParameters).not.toContain('golden-path-click-0001');
    expect(String(calls[0]?.[0])).toContain('ON CONFLICT');
  });

  it('derives only server-scoped workflow inputs from the frozen preflight', () => {
    expect(goldenPathWorkflowInputs(preflight, '8b7b7ed1-df48-4f2e-b119-d913771f70dc')).toEqual({
      repository_owner: 'argus',
      repository_name: 'golden-path-demo',
      issue_number: 17,
      notification_channel: 'argus-demo',
      write_mode: 'guarded',
      golden_path_run_id: '8b7b7ed1-df48-4f2e-b119-d913771f70dc',
    });
  });

  it('projects a pending real workflow approval into the frozen v1 run contract', async () => {
    const runId = '8b7b7ed1-df48-4f2e-b119-d913771f70dc';
    const pool = poolWithQuery(() => ({ rows: [{
      id: runId,
      workflow_id: Number(preflight.workflow.id),
      workflow_execution_id: 240,
      created_by_user_id: user.id,
      tenant_key: preflight.scope.tenantKey,
      workspace_key: preflight.scope.workspaceKey,
      environment: preflight.scope.environment,
      mode: preflight.mode,
      write_mode: preflight.policy.writeMode,
      status: 'running',
      idempotency_key_sha256: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
      preflight,
      task_id: `golden-task:${runId}`,
      external_issue_id: 'gitea:argus/golden-path-demo:17',
      runtime_task_id: `hermes:${runId}`,
      error_code: null,
      error_message: null,
      started_at: new Date('2026-09-10T10:10:00.000Z'),
      updated_at: new Date('2026-09-10T10:10:21.000Z'),
      completed_at: null,
      execution_status: 'waiting_for_approval',
      execution_started_at: new Date('2026-09-10T10:10:00.000Z'),
      execution_updated_at: new Date('2026-09-10T10:10:21.000Z'),
      execution_completed_at: null,
      execution_error: null,
      step_results: {
        read_issue: { status: 'completed', started_at: '2026-09-10T10:10:01.000Z', completed_at: '2026-09-10T10:10:02.000Z' },
        triage: { status: 'completed', started_at: '2026-09-10T10:10:02.000Z', completed_at: '2026-09-10T10:10:20.000Z' },
      },
      waiting_approval_id: 91,
      waiting_step_id: 'approval',
      approval_id: 91,
      approval_status: 'pending',
      approval_requested_at: new Date('2026-09-10T10:10:21.000Z'),
      approval_decided_at: null,
      approval_decision_comment: null,
      approval_decided_by_user_id: null,
      approval_decided_by_username: null,
      approval_tool_args_hash: 'c'.repeat(64),
    }] }));

    const run = await loadGoldenPathRun(pool, runId, preflight.scope);

    expect(run).toMatchObject({
      kind: 'argus.golden-path-run',
      status: 'waiting_for_approval',
      approval: { id: '91', state: 'pending', payloadSha256: 'c'.repeat(64) },
      correlation: { runId: '240', traceId: workflowTelemetryTraceId(240) },
    });
    expect(run?.stages.find(stage => stage.id === 'approval')?.state).toBe('action_required');
    expect(run?.outcomes).toHaveLength(3);
  });

  it('returns a stable trace in the start receipt once the execution is attached', () => {
    const receipt = goldenPathStartReceipt({
      id: '8b7b7ed1-df48-4f2e-b119-d913771f70dc',
      workflow_execution_id: 240,
      status: 'running',
    } as never, false);
    expect(receipt).toMatchObject({
      workflowExecutionId: 240,
      traceId: workflowTelemetryTraceId(240),
      replayed: false,
    });
  });

  it('projects a rejected approval as terminal without executable or retryable writes', async () => {
    const runId = '06fb607c-a8a7-47ab-9f89-c8c16b58a9b1';
    const pool = poolWithQuery(() => ({ rows: [{
      id: runId,
      workflow_id: Number(preflight.workflow.id),
      workflow_execution_id: '241',
      created_by_user_id: user.id,
      tenant_key: preflight.scope.tenantKey,
      workspace_key: preflight.scope.workspaceKey,
      environment: preflight.scope.environment,
      mode: preflight.mode,
      write_mode: preflight.policy.writeMode,
      status: 'running',
      idempotency_key_sha256: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
      preflight,
      task_id: `golden-task:${runId}`,
      external_issue_id: 'gitea:argus/golden-path-demo:17',
      runtime_task_id: `hermes:${runId}`,
      error_code: null,
      error_message: null,
      started_at: new Date('2026-09-10T10:10:00.000Z'),
      updated_at: new Date('2026-09-10T10:10:22.000Z'),
      completed_at: null,
      execution_status: 'cancelled',
      execution_started_at: new Date('2026-09-10T10:10:00.000Z'),
      execution_updated_at: new Date('2026-09-10T10:10:22.000Z'),
      execution_completed_at: new Date('2026-09-10T10:10:22.000Z'),
      execution_error: 'Runtime approval #92 was rejected: bounded target denied',
      step_results: {
        read_issue: { status: 'completed', started_at: '2026-09-10T10:10:01.000Z', completed_at: '2026-09-10T10:10:02.000Z' },
        triage: { status: 'completed', started_at: '2026-09-10T10:10:02.000Z', completed_at: '2026-09-10T10:10:20.000Z' },
      },
      waiting_approval_id: null,
      waiting_step_id: null,
      approval_id: 92,
      approval_status: 'rejected',
      approval_requested_at: new Date('2026-09-10T10:10:21.000Z'),
      approval_decided_at: new Date('2026-09-10T10:10:22.000Z'),
      approval_decision_comment: 'Bounded target denied',
      approval_decided_by_user_id: 8,
      approval_decided_by_username: 'reviewer',
      approval_tool_args_hash: 'c'.repeat(64),
    }] }));

    const run = await loadGoldenPathRun(pool, runId, preflight.scope);

    expect(run).toMatchObject({
      status: 'rejected',
      approval: { id: '92', state: 'rejected', rationale: 'Bounded target denied' },
      allowedActions: ['open_trace'],
    });
    expect(run?.stages.find(stage => stage.id === 'external_action')).toMatchObject({
      state: 'skipped',
      detail: expect.stringContaining('no external write'),
    });
    expect(run?.outcomes).toHaveLength(3);
    expect(run?.outcomes.every(outcome => outcome.state === 'skipped'
      && outcome.attemptCount === 0
      && outcome.retryable === false)).toBe(true);
  });

  it('projects the active retry, per-provider attempts, and signed evidence without double-counting checkpoints', async () => {
    const runId = '6a859cd1-41f1-4f51-9ff7-cb844fd21a56';
    const completed = (result: unknown) => ({
      status: 'completed', result,
      started_at: '2026-09-10T10:10:23.000Z', completed_at: '2026-09-10T10:10:24.000Z',
    });
    const currentResults = {
      read_issue: completed({ issue: 17 }),
      triage: completed({ severity: 'medium' }),
      approval: completed({ approval: 93 }),
      comment_issue: completed({ commentId: 41 }),
      add_label: completed({ label: 'triaged' }),
      notify: completed({ messageId: 'slack-42' }),
      response: completed({ ok: true }),
    };
    const pool = poolWithQuery(() => ({ rows: [{
      id: runId,
      workflow_id: Number(preflight.workflow.id),
      workflow_execution_id: 242,
      active_workflow_execution_id: 243,
      created_by_user_id: user.id,
      tenant_key: preflight.scope.tenantKey,
      workspace_key: preflight.scope.workspaceKey,
      environment: preflight.scope.environment,
      mode: preflight.mode,
      write_mode: preflight.policy.writeMode,
      status: 'running',
      idempotency_key_sha256: 'a'.repeat(64),
      request_sha256: 'b'.repeat(64),
      preflight,
      task_id: `golden-task:${runId}`,
      external_issue_id: 'gitea:argus/golden-path-demo:17',
      runtime_task_id: `hermes:${runId}`,
      error_code: null,
      error_message: null,
      started_at: new Date('2026-09-10T10:10:00.000Z'),
      updated_at: new Date('2026-09-10T10:10:25.000Z'),
      completed_at: new Date('2026-09-10T10:10:25.000Z'),
      execution_status: 'completed',
      execution_started_at: new Date('2026-09-10T10:10:22.000Z'),
      execution_updated_at: new Date('2026-09-10T10:10:25.000Z'),
      execution_completed_at: new Date('2026-09-10T10:10:25.000Z'),
      execution_error: null,
      step_results: currentResults,
      retry_from_step_ids: ['notify', 'response'],
      retry_chain: [
        {
          id: 242,
          retryFromStepIds: null,
          stepResults: { ...currentResults, notify: { status: 'failed', error: 'transient provider failure' } },
        },
        { id: 243, retryFromStepIds: ['notify', 'response'], stepResults: currentResults },
      ],
      waiting_approval_id: null,
      waiting_step_id: null,
      approval_id: 93,
      approval_status: 'approved',
      approval_requested_at: new Date('2026-09-10T10:10:20.000Z'),
      approval_decided_at: new Date('2026-09-10T10:10:21.000Z'),
      approval_decision_comment: 'Bounded writes approved',
      approval_decided_by_user_id: 8,
      approval_decided_by_username: 'reviewer',
      approval_tool_args_hash: 'c'.repeat(64),
      audit_report_run_id: 'd9dc916b-c6a7-4525-bac8-475480372261',
      evidence_status: 'complete',
      report_status: 'completed',
      report_pack_id: '4105909e-344f-4264-82e5-c555a0cc67cc',
      report_pack_digest: 'd'.repeat(64),
      report_verification_state: 'valid',
      report_gap_codes: [],
    }] }));

    const run = await loadGoldenPathRun(pool, runId, preflight.scope);

    expect(run).toMatchObject({
      status: 'completed',
      correlation: { runId: '243', traceId: workflowTelemetryTraceId(243) },
      evidence: { state: 'complete', offlineVerifiable: true },
      allowedActions: ['open_trace', 'open_report', 'download_evidence'],
    });
    expect(run?.outcomes.find(outcome => outcome.operation === 'comment')).toMatchObject({ state: 'succeeded', attemptCount: 1 });
    expect(run?.outcomes.find(outcome => outcome.operation === 'add_label')).toMatchObject({ state: 'succeeded', attemptCount: 1 });
    expect(run?.outcomes.find(outcome => outcome.operation === 'post_message')).toMatchObject({ state: 'succeeded', attemptCount: 2 });
    expect(run?.resourceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({ refId: 'audit-report', sha256: 'd'.repeat(64) }),
      expect.objectContaining({ refId: 'evidence-pack', sha256: 'd'.repeat(64) }),
    ]));
  });
});
