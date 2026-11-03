import { correlateWorkflowAgentContractRuns, mapWorkflowAgentContractEvidence } from '../consoleApi.js';

describe('workflow Agent execution evidence', () => {
  it('maps the immutable execution snapshot into bounded run evidence', () => {
    const evidence = mapWorkflowAgentContractEvidence({
      schemaVersion: 1,
      kind: 'workflow-agent-contract',
      capturedAt: '2026-08-19T10:00:00.000Z',
      contractFingerprint: 'a'.repeat(64),
      inferredLegacyContract: false,
      assignments: [{
        role: 'coder',
        label: 'Delivery Coder',
        stepIds: ['implement'],
        status: 'ready',
        agentId: 42,
        agentName: 'delivery_coder',
        agentLabel: 'Delivery Coder',
        agentMode: 'worker',
        model: 'gpt-5.6-terra',
        presetName: 'argus-dev-coder',
        installedPresetVersion: 3,
        skillNames: ['typescript'],
        bundleIds: [4, 7],
        toolNames: ['github_get_file', 'workspace_write'],
        runtime: {
          type: 'codex', profileId: 5, profileName: 'codex-terra', profileLabel: 'Codex Terra',
          model: 'gpt-5.6-terra', state: 'ready', detail: 'Authenticated',
        },
        catalogFingerprint: 'b'.repeat(64),
        blockers: [],
        warnings: [],
      }],
    });

    expect(evidence).toMatchObject({
      schemaVersion: 1,
      inferredLegacyContract: false,
      assignments: [{
        role: 'coder', agentId: 42, model: 'gpt-5.6-terra', bundleIds: [4, 7],
        runtime: { type: 'codex', profileLabel: 'Codex Terra', state: 'ready' },
      }],
    });
  });

  it('rejects unrelated snapshots and skips malformed assignments', () => {
    expect(mapWorkflowAgentContractEvidence({ kind: 'other', schemaVersion: 1 })).toBeNull();
    expect(mapWorkflowAgentContractEvidence({
      kind: 'workflow-agent-contract', schemaVersion: 1, assignments: [null, {}, { role: 'reviewer', status: 'unknown' }],
    })?.assignments).toEqual([expect.objectContaining({ role: 'reviewer', status: 'blocked' })]);
  });

  it('assigns every correlated child run to one resolved role and exposes direct trace links', () => {
    const evidence = mapWorkflowAgentContractEvidence({
      kind: 'workflow-agent-contract', schemaVersion: 1, assignments: [
        { role: 'coder', label: 'Coder', stepIds: ['implement'], agentId: 42, status: 'ready' },
        { role: 'reviewer', label: 'Reviewer', stepIds: ['review'], agentId: 42, status: 'ready' },
      ],
    });
    const correlated = correlateWorkflowAgentContractRuns(evidence, {
      rootTraceId: 'workflow-root',
      runs: [
        {
          id: 'coder-run', kind: 'agent', agentId: 42, taskType: 'implement_ticket', title: 'Coder',
          parentTraceId: 'workflow-root', status: 'completed',
          startedAt: '2026-08-19T10:01:00.000Z', durationMs: 2_000,
        },
        {
          id: 'review-run', kind: 'agent', agentId: 42, taskType: 'review', title: 'Reviewer',
          parentTraceId: 'workflow-root', status: 'failed',
          startedAt: '2026-08-19T10:02:00.000Z', durationMs: 900,
          href: '/runs/agent/custom-review-run',
        },
        {
          id: 'unrelated-run', kind: 'agent', agentId: 99, taskType: 'review', title: 'Other',
          parentTraceId: 'workflow-root', status: 'completed',
          startedAt: '2026-08-19T10:03:00.000Z', durationMs: 100,
        },
      ],
    });

    expect(correlated?.assignments[0]?.runs).toEqual([expect.objectContaining({
      traceId: 'coder-run', taskType: 'implement_ticket', runHref: '/runs/agent/coder-run',
      traceHref: '/observe/logs?trace=coder-run',
    })]);
    expect(correlated?.assignments[1]?.runs).toEqual([expect.objectContaining({
      traceId: 'review-run', status: 'failed', runHref: '/runs/agent/custom-review-run',
    })]);
  });

  it('treats explicit role metadata as authoritative and excludes nested subagent runs', () => {
    const evidence = mapWorkflowAgentContractEvidence({
      kind: 'workflow-agent-contract', schemaVersion: 1, assignments: [
        { role: 'coder', label: 'Coder', stepIds: ['implement'], agentId: 42, status: 'ready' },
        { role: 'reviewer', label: 'Reviewer', stepIds: ['review'], agentId: 42, status: 'ready' },
      ],
    });
    const correlated = correlateWorkflowAgentContractRuns(evidence, {
      rootTraceId: 'workflow-root',
      runs: [
        {
          id: 'explicit-review', kind: 'agent', agentId: 42, agentRole: 'reviewer',
          workflowStepId: 'review', taskType: 'implement_ticket', title: 'Coder',
          parentTraceId: 'workflow-root', status: 'completed',
          startedAt: '2026-08-19T10:02:00.000Z', durationMs: 500,
        },
        {
          id: 'nested-review-helper', kind: 'agent', agentId: 42, agentRole: 'reviewer',
          workflowStepId: 'review', taskType: 'review', title: 'Reviewer helper',
          parentTraceId: 'explicit-review', status: 'completed',
          startedAt: '2026-08-19T10:02:01.000Z', durationMs: 100,
        },
      ],
    });

    expect(correlated?.assignments[0]?.runs).toEqual([]);
    expect(correlated?.assignments[1]?.runs).toEqual([
      expect.objectContaining({ traceId: 'explicit-review' }),
    ]);
  });
});
