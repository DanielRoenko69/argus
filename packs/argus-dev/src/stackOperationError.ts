const reasons = new Set([
  'stack_disabled', 'stack_grant_required', 'stack_invalid_request', 'stack_unavailable_no_replay',
  'stack_evidence_unavailable', 'stack_workspace_timeout', 'stack_workspace_transport_error',
  'stack_workspace_http_error', 'stack_invalid_evidence', 'stack_audit_unavailable',
  'stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped',
  'stack_snapshot_reconciliation_required',
  'stack_policy_mismatch', 'stack_session_disabled', 'stack_session_capacity', 'stack_session_missing', 'stack_session_binding_changed',
  'stack_session_evidence_stale', 'stack_session_still_running', 'stack_session_sync_failed', 'stack_session_marker_invalid',
  'stack_interrupted_no_replay', 'stack_session_stop_unconfirmed',
  'stack_database_policy_required', 'stack_database_binding_changed', 'stack_database_unavailable',
  'stack_database_stop_unconfirmed', 'stack_database_secret_in_output',
  'invalid_execution_grant', 'execution_grant_expired', 'execution_grant_revoked',
  'execution_grant_not_allowed', 'execution_trace_required', 'execution_grant_scope_mismatch',
  'execution_grant_inactive', 'execution_grants_unavailable',
]);
type Action = 'inspect' | 'project' | 'run';
export class StackOperationError extends Error {
  readonly details;
  constructor(action: Action, threadId: string, reason: string, status?: number, upstreamStatus?: number) {
    const safeReason = reasons.has(reason) || ['stack_http_error', 'stack_transport_error', 'stack_transport_timeout', 'stack_response_limit'].includes(reason)
      ? reason : 'stack_http_error';
    const httpStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    const workspaceStatus = Number.isInteger(upstreamStatus) && upstreamStatus! >= 100 && upstreamStatus! <= 599 ? upstreamStatus : undefined;
    const rootTraceId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(threadId) ? threadId : undefined;
    const hint = safeReason === 'stack_snapshot_timeout_no_replay' ? ' Docker environment snapshot exceeded its deadline; the stopped worker is retained for operator reconciliation.'
      : safeReason === 'stack_snapshot_unavailable_no_replay' ? ' Docker environment snapshot could not be confirmed; the stopped worker is retained for operator reconciliation.'
      : safeReason === 'stack_snapshot_reconciliation_required' ? ' A retained Docker snapshot requires operator reconciliation before another stack can start.'
      : safeReason === 'stack_session_capacity' ? ' The retained workspace limit is reached. An operator must review unused run workspaces; no evidence was evicted.'
      : safeReason === 'stack_database_policy_required' ? ' The Workspace DB must use the reviewed run-scoped access policy before a worker can connect.'
      : safeReason === 'stack_database_stop_unconfirmed' ? ' Database access revocation could not be confirmed; operator repair is required.'
      : safeReason === 'stack_interrupted_no_replay' ? ' This workspace has an unconfirmed operation. Its files were retained; operator reconciliation is required.' : '';
    super(`Stack ${action}: ${safeReason}${httpStatus ? `; HTTP ${httpStatus}` : ''}${workspaceStatus ? `; Workspace HTTP ${workspaceStatus}` : ''}${rootTraceId ? `; root trace ${rootTraceId}` : ''}.${hint} No automatic replay.`);
    this.details = { action, reason: safeReason, httpStatus, upstreamStatus: workspaceStatus, rootTraceId };
  }
}
export function stackTransportReason(error: unknown): string {
  const e = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  return e?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(e?.code ?? e?.cause?.code ?? '')
    ? 'stack_transport_timeout' : 'stack_transport_error';
}
/** Read only bounded data; never retain server prose, arbitrary codes or bodies. */
export async function readStackResponse(response: Response, action: Action, threadId: string): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 128000) { await reader.cancel(); throw new StackOperationError(action, threadId, 'stack_response_limit', response.status); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof StackOperationError) throw error;
    throw new StackOperationError(action, threadId, stackTransportReason(error), response.status);
  } finally { reader?.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new StackOperationError(action, threadId, response.ok ? 'stack_invalid_evidence' : 'stack_http_error', response.status); }
  if (!response.ok) {
    const data = value as { code?: unknown; upstreamStatus?: unknown } | null;
    throw new StackOperationError(action, threadId, typeof data?.code === 'string' && reasons.has(data.code) ? data.code : 'stack_http_error',
      response.status, typeof data?.code === 'string' && (data.code === 'stack_workspace_http_error' || data.code.startsWith('stack_snapshot_'))
        && reasons.has(data.code) && typeof data.upstreamStatus === 'number' ? data.upstreamStatus : undefined);
  }
  return value;
}
