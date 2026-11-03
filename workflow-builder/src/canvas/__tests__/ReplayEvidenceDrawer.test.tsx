import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReplayEvidenceDrawer } from '../ReplayEvidenceDrawer';

const step = {
  id: 'plan', label: 'Delivery plan', type: 'argus.agent' as const, status: 'completed' as const,
  result: '1. Inspect the repository\n2. Implement the scoped change\n3. Verify the tests',
  durationMs: 72_500, selectedTarget: null, agentRole: 'planner', agentId: 7,
  agentName: 'delivery-planner', traceId: '33333333-3333-4333-8333-333333333333',
  sessionId: 'session-plan', runtimeRunId: 'runtime-plan', telemetryStatus: 'completed',
  model: 'gpt-5.6-terra', provider: 'codex-subscription', runtimeType: 'codex',
  runtimeProfile: 'codex-terra', reasoningEffort: 'xhigh',
};

describe('ReplayEvidenceDrawer', () => {
  it('shows complete agent runtime evidence, full output and correlated links', () => {
    render(<ReplayEvidenceDrawer
      nodeId="plan"
      nodeLabel="Delivery plan"
      nodeType="argus.agent"
      rootTraceId="11111111-1111-4111-8111-111111111111"
      step={step}
      onClose={vi.fn()}
    />);

    expect(screen.getByRole('heading', { name: 'Delivery plan' })).toBeInTheDocument();
    expect(screen.getByText('1 min 13 s')).toBeInTheDocument();
    expect(screen.getByText('gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.getByText('codex-terra')).toBeInTheDocument();
    expect(screen.getByText(/Implement the scoped change/).textContent).toBe(step.result);
    expect(screen.getByRole('link', { name: /Agent trace/ })).toHaveAttribute(
      'href', '/runs/agent/33333333-3333-4333-8333-333333333333',
    );
    expect(screen.getByRole('link', { name: /Correlated logs/ })).toHaveAttribute(
      'href', '/observe/logs?root_trace=11111111-1111-4111-8111-111111111111&trace=33333333-3333-4333-8333-333333333333',
    );
  });

  it('explains an untraversed branch and closes with Escape', () => {
    const onClose = vi.fn();
    render(<ReplayEvidenceDrawer
      nodeId="review"
      nodeLabel="Review"
      nodeType="argus.agent"
      rootTraceId="11111111-1111-4111-8111-111111111111"
      step={null}
      onClose={onClose}
    />);

    expect(screen.getByText('Dieser Block wurde nicht ausgeführt.')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
