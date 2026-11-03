import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkflowReplay } from '@/api/replay';
import { ReplayRunControls } from '../ReplayRunControls';

const mutations = vi.hoisted(() => ({
  cancel: vi.fn(),
  resume: vi.fn(),
}));

vi.mock('@/api/replay', () => ({
  useCancelWorkflowReplay: () => ({
    mutate: mutations.cancel, isPending: false, isSuccess: false, error: null,
  }),
  useResumeWorkflowReplay: () => ({
    mutate: mutations.resume, isPending: false, isSuccess: false, error: null,
  }),
}));

const replay: WorkflowReplay = {
  traceId: '927d3c7a-4b82-4693-bf67-9e96159990c1',
  status: 'interrupted',
  currentStage: 'approval',
  completed: false,
  canCancel: true,
  approval: { stage: 'approval', message: 'Approve the governed delivery?' },
  steps: {},
};

describe('ReplayRunControls', () => {
  it('submits checkpoint-bound approval feedback and supports safe cancellation', () => {
    render(<ReplayRunControls workflowId={9} replay={replay} />);

    expect(screen.getByText('Approve the governed delivery?')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Approval feedback'), { target: { value: 'Evidence accepted.' } });
    fireEvent.click(screen.getByRole('button', { name: /Freigeben/ }));
    expect(mutations.resume).toHaveBeenCalledWith({ decision: 'approved', feedback: 'Evidence accepted.' });

    fireEvent.click(screen.getByRole('button', { name: /Run abbrechen/ }));
    expect(mutations.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not offer controls for terminal evidence', () => {
    const { container } = render(<ReplayRunControls workflowId={9} replay={{
      ...replay, status: 'completed', completed: true, canCancel: false, approval: null,
    }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
