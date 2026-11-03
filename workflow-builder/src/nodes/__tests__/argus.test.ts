import { describe, expect, it } from 'vitest';
import { formatAgentTarget } from '@/lib/agentBinding';
import type { WorkflowAgentPreflight } from '@/api/workflows';
import { describeAgentNodePreflight } from '../argus';
import { getNodeDefinition } from '../registry';

const agent = {
  id: 7,
  name: 'platform-engineer',
  label: 'Platform Engineer',
  agent_mode: 'worker',
  model: 'gpt-5.1',
  agent_role: 'planner',
};

describe('Argus Agent node target label', () => {
  it('prefers a concrete Agent assignment', () => {
    expect(formatAgentTarget(agent, { agent_id: 7 })).toBe('Platform Engineer');
  });

  it('shows the workflow role when no concrete Agent is pinned', () => {
    expect(formatAgentTarget(agent, { agent_role: ' planner ' })).toBe('Role: planner');
  });

  it('keeps the empty-state label for an unconfigured new block', () => {
    expect(formatAgentTarget(undefined, {})).toBe('(no agent)');
  });
});

const preflight: WorkflowAgentPreflight = {
  workflowId: 145,
  workflowName: 'agent_contract_trace_smoke',
  checkedAt: '2026-08-20T10:00:00.000Z',
  ready: true,
  inferredLegacyContract: false,
  blockers: [],
  warnings: [],
  assignments: [{
    role: 'planner', label: 'Planner', stepIds: ['plan'], status: 'ready',
    agentId: 7, agentName: 'platform-engineer', agentLabel: 'Platform Engineer',
    agentMode: 'worker', model: 'gpt-5.6-terra', presetName: null,
    installedPresetVersion: null, requiredPresetVersion: null, skillNames: [],
    bundleIds: [], toolNames: [], runtime: { type: 'codex', profileLabel: 'Codex Terra', state: 'ready', detail: 'Ready' },
    blockers: [], warnings: [],
  }],
};

describe('Argus Agent node preflight presentation', () => {
  it('maps resolved evidence to the exact workflow step', () => {
    expect(describeAgentNodePreflight(preflight, 'plan')).toEqual({
      tone: 'ready', label: 'Verifiziert', detail: 'Platform Engineer',
    });
  });

  it('marks unsaved and unresolved Agent nodes as not runnable', () => {
    expect(describeAgentNodePreflight(preflight, 'plan', { dirty: true }).tone).toBe('stale');
    expect(describeAgentNodePreflight(preflight, 'missing').tone).toBe('blocked');
    expect(describeAgentNodePreflight(undefined, 'plan', { error: true }).tone).toBe('blocked');
  });
});

describe('Argus approval node', () => {
  it('is available as an explicit governed Pack gate', () => {
    expect(getNodeDefinition('argus.approval')).toMatchObject({
      label: 'Human Approval',
      category: 'argus',
    });
  });
});
