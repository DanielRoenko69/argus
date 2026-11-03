import { describe, expect, it, vi } from 'vitest';
import { requestWorkflowRun, requestedWorkflowId, WORKFLOW_RUN_REQUEST_EVENT } from './builderEvents';

describe('workflow builder run requests', () => {
  it('carries the workflow id from keyboard handling to the governed TopBar path', () => {
    const listener = vi.fn((event: Event) => requestedWorkflowId(event));
    window.addEventListener(WORKFLOW_RUN_REQUEST_EVENT, listener);

    requestWorkflowRun(145);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.results[0]?.value).toBe(145);
    window.removeEventListener(WORKFLOW_RUN_REQUEST_EVENT, listener);
  });

  it('rejects malformed workflow ids', () => {
    expect(requestedWorkflowId(new CustomEvent(WORKFLOW_RUN_REQUEST_EVENT, { detail: { workflowId: 'nope' } }))).toBeNull();
  });
});
