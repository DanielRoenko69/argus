/** Helpers for keeping human approval rationale separate from change requests. */

export type HumanApprovalDecision = {
  approved?: boolean;
  feedback?: string;
};

/**
 * An approval comment is evidence only. A request is actionable only when the
 * human rejects the current artifact and sends it back to the coder.
 */
export function extractHumanChangeRequest(decision: HumanApprovalDecision | undefined): string {
  if (!decision || decision.approved === true) return '';
  return typeof decision.feedback === 'string' ? decision.feedback.trim() : '';
}

/** Context shown to the reviewer after a human-requested revision. */
export function formatHumanChangeRequestForReviewer(request: string): string {
  const normalized = request.trim();
  return normalized
    ? `Human change request (must be satisfied):\n${normalized}\n\n`
    : '';
}
