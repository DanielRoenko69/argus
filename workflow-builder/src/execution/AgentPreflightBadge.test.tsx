import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowAgentPreflight } from '@/api/workflows';
import { AgentPreflightBadge, summarizeAgentPreflight } from './AgentPreflightBadge';

const readyPreflight: WorkflowAgentPreflight = {
  workflowId: 9,
  workflowName: 'delivery',
  checkedAt: '2026-08-20T10:00:00.000Z',
  ready: true,
  inferredLegacyContract: false,
  blockers: [],
  warnings: [],
  assignments: [{
    role: 'planner', label: 'Planner', stepIds: ['plan'], status: 'ready',
    agentId: 4, agentName: 'planner', agentLabel: 'Delivery Planner', agentMode: 'worker',
    model: 'gpt-5.6-terra', presetName: null, installedPresetVersion: null,
    requiredPresetVersion: null, skillNames: ['planning'], bundleIds: [3], toolNames: ['github_read'],
    runtime: { type: 'codex', profileLabel: 'Codex Terra', state: 'ready', detail: 'Ready' },
    blockers: [], warnings: [],
  }],
};

describe('AgentPreflightBadge', () => {
  it('summarizes dirty, ready and blocked contracts fail-closed', () => {
    expect(summarizeAgentPreflight(readyPreflight, { dirty: true }).tone).toBe('stale');
    expect(summarizeAgentPreflight(readyPreflight).tone).toBe('ready');
    expect(summarizeAgentPreflight({ ...readyPreflight, ready: false, blockers: ['Runtime unavailable'] }).tone).toBe('blocked');
    expect(summarizeAgentPreflight(undefined, { error: true }).tone).toBe('blocked');
  });

  it('shows resolved runtime evidence and opens the governed contract', () => {
    const onOpenContract = vi.fn();
    render(
      <AgentPreflightBadge
        visible
        dirty={false}
        loading={false}
        refreshing={false}
        error={false}
        preflight={readyPreflight}
        onRefresh={() => undefined}
        onOpenContract={onOpenContract}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Agent Preflight: Agents bereit' }));
    expect(screen.getByRole('dialog', { name: 'Agent Preflight Details' })).toBeInTheDocument();
    expect(screen.getByText('Delivery Planner')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6-terra · Codex Terra')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Contract öffnen/ }));
    expect(onOpenContract).toHaveBeenCalledTimes(1);
  });

  it('renders nothing for workflows without Agent nodes', () => {
    const { container } = render(
      <AgentPreflightBadge
        visible={false}
        dirty={false}
        loading={false}
        refreshing={false}
        error={false}
        onRefresh={() => undefined}
        onOpenContract={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
