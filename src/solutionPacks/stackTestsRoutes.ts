import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { Agent } from 'undici';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import { stackRequestSchema, stackSnapshotSchema, stackHash, validateStackResult } from './stackEnvironment.js';
import { auditQaExecution } from './qaTestsRoutes.js';
export const STACK_WORKSPACE_TIMEOUT_MS = 2_550_000;
const dispatcher = new Agent({ headersTimeout: 2_580_000, bodyTimeout: 2_580_000 });
const snapshotErrors = new Set(['stack_snapshot_timeout_no_replay', 'stack_snapshot_unavailable_no_replay', 'stack_snapshot_worker_not_stopped', 'stack_snapshot_reconciliation_required',
  'stack_session_disabled', 'stack_session_capacity', 'stack_session_missing', 'stack_session_binding_changed', 'stack_session_evidence_stale',
  'stack_session_still_running', 'stack_session_sync_failed', 'stack_session_marker_invalid', 'stack_interrupted_no_replay', 'stack_session_stop_unconfirmed',
  'stack_database_policy_required', 'stack_database_binding_changed', 'stack_database_unavailable', 'stack_database_stop_unconfirmed', 'stack_database_secret_in_output']);
async function workspaceErrorCode(response: Response): Promise<string> {
  const fallback = 'stack_workspace_http_error', reader = response.body?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return fallback; }
      chunks.push(value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return typeof value?.error === 'string' && snapshotErrors.has(value.error) ? value.error : fallback;
  } catch { return fallback; }
  finally { reader?.releaseLock(); }
}

export function registerStackTestsRoutes(app: Express, pool: pg.Pool, auth: RequestHandler,
  options: { enabled?: () => boolean; fetchFn?: typeof fetch; auditFn?: typeof auditQaExecution } = {}) {
  app.post('/api/agents/:id/stack-tests', auth, async (req, res) => {
    if (!(options.enabled?.() ?? process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true')) { res.status(503).json({ code: 'stack_disabled' }); return; }
    const grant = (req as typeof req & ExecutionGrantRequestState).executionGrant;
    const agentId = Number(req.params['id']);
    if (!grant || grant.aud !== 'argus.dev' || grant.agent !== 'coding-orchestrator' || !grant.workspaceRoot || !['general-stack-v1', 'workspace-session-v1'].includes(grant.testEnvironmentPolicy ?? '')
      || !grant.coreAgentIds.includes(agentId) || !grant.coreAgents?.some(a => a.id === agentId && a.name === 'reviewer')) {
      res.status(403).json({ code: 'stack_grant_required' }); return;
    }
    const parsed = stackRequestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: 'stack_invalid_request' }); return; }
    const input = parsed.data, request = { ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot };
    if ((input.executionMode ?? 'general-stack-v1') !== grant.testEnvironmentPolicy) { res.status(403).json({ code: 'stack_policy_mismatch' }); return; }
    if (input.executionMode && process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true') { res.status(503).json({ code: 'stack_session_disabled' }); return; }
    const execute = input.action === 'project' || input.action === 'run';
    const details = { requestSha256: stackHash(request), profile: input.executionMode ?? 'stack-container-v1', action: input.action,
      basisSha256: input.basisSha256, ...(execute ? { sourceSha256: input.sourceSha256, planSha256: stackHash(input.stackPlan) } : {}) };
    let stage: 'audit' | 'workspace' | 'evidence' = 'audit';
    try {
      if (execute || input.action === 'cancel') await (options.auditFn ?? auditQaExecution)(pool, grant, 'requested', details);
      stage = 'workspace';
      const response = await (options.fetchFn ?? fetch)(`${AGENT_WORKSPACE_URL}/stack-tests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify(request), ...{ dispatcher }, signal: AbortSignal.timeout(execute ? STACK_WORKSPACE_TIMEOUT_MS : 60000) });
      if (!response.ok) {
        const code = await workspaceErrorCode(response);
        res.status(409).json({ code, upstreamStatus: response.status, rootTraceId: grant.rootTraceId }); return;
      }
      const raw = await response.text();
      stage = 'evidence';
      if (Buffer.byteLength(raw) > 128000) throw new Error('stack_receipt_limit');
      const value = JSON.parse(raw);
      res.setHeader('Cache-Control', 'private, no-store');
      if (input.action === 'inspect') { res.json(stackSnapshotSchema.parse(value)); return; }
      if (input.action === 'cancel') {
        if (value?.stopped !== true) throw new Error('stack_stop_unconfirmed');
        stage = 'audit';
        await (options.auditFn ?? auditQaExecution)(pool, grant, 'result', { ...details, passed: true });
        res.json({ stopped: true }); return;
      }
      const result = validateStackResult(input, grant.rootTraceId, value);
      if (result.requestSha256 !== details.requestSha256) throw new Error('stack_request_changed');
      stage = 'audit';
      await (options.auditFn ?? auditQaExecution)(pool, grant, 'result', { ...details, passed: result.passed,
        outputSha256: result.outputSha256, environment: result.stackEnvironment });
      res.json(result);
    } catch (error) {
      const cause = error as { name?: string; code?: string; cause?: { code?: string } } | null;
      const timeout = cause?.name === 'TimeoutError' || ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']
        .includes(cause?.code ?? cause?.cause?.code ?? '');
      const code = stage === 'audit' ? 'stack_audit_unavailable' : stage === 'evidence' ? 'stack_invalid_evidence'
        : timeout ? 'stack_workspace_timeout' : 'stack_workspace_transport_error';
      res.status(503).json({ code, rootTraceId: grant.rootTraceId,
        error: 'Execution or evidence unavailable; uncertain attempts are not replayed.' });
    }
  });
}
