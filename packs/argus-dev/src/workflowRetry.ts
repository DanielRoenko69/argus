export type WorkflowRetry = { sourceThreadId: string; sourceTaskId?: string; feedback: string };

export function assertRetryParent(
  parent: { status: string; metadata: Record<string, unknown> } | null,
  retry: WorkflowRetry,
  principal: string,
): void {
  // A configured restart always creates a new thread/workspace. This is not
  // checkpoint continuation; canceling is deliberately not a terminal parent.
  if (!parent || !['failed', 'canceled'].includes(parent.status) || parent.metadata['execution_principal'] !== principal
    || (retry.sourceTaskId && parent.metadata['a2a_task_id'] !== retry.sourceTaskId)) {
    throw new Error('Restart requires a failed or fully canceled run owned by the same execution principal.');
  }
}

export function retryExecutionInput(input: Record<string, unknown>, descriptionField: string | undefined, feedback: string): Record<string, unknown> {
  const result = { ...input };
  if (feedback.trim() && descriptionField) {
    result[descriptionField] = String(input[descriptionField] ?? '')
      + '\n\nAdditional operator feedback for this attempt:\n' + feedback.trim().slice(0, 12_000);
  }
  return result;
}
