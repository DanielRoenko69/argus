import { logger } from '../lib/logger.js';

export type RuntimeApprovalDecision = 'approved' | 'rejected';
export type RuntimeApprovalDecisionHandler = (
  approvalId: number,
  decision: RuntimeApprovalDecision,
) => Promise<void>;

let handler: RuntimeApprovalDecisionHandler | null = null;

export function registerRuntimeApprovalDecisionHandler(next: RuntimeApprovalDecisionHandler): void {
  handler = next;
}

export function dispatchRuntimeApprovalDecision(
  approvalId: number,
  decision: RuntimeApprovalDecision,
): boolean {
  if (!handler) return false;
  void handler(approvalId, decision).catch(error => {
    logger.error({ err: error, approvalId, decision }, 'Runtime approval resume handler failed');
  });
  return true;
}
