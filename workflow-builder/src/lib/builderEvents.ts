export const WORKFLOW_RUN_REQUEST_EVENT = 'argus:workflow-run-request';

export function requestWorkflowRun(workflowId: number): void {
  window.dispatchEvent(new CustomEvent(WORKFLOW_RUN_REQUEST_EVENT, { detail: { workflowId } }));
}

export function requestedWorkflowId(event: Event): number | null {
  const workflowId = Number((event as CustomEvent<{ workflowId?: unknown }>).detail?.workflowId);
  return Number.isSafeInteger(workflowId) && workflowId > 0 ? workflowId : null;
}
