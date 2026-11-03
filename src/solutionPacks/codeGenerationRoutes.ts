import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { Agent } from 'undici';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import { executionGrantWorkspaceScope, type ExecutionGrantClaims } from './executionGrant.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import { codegenHash, parseCodegenRequest, parseCodegenCancel, parseCodegenFailure, validateCodegenReceipt } from './codeGenerationContract.js';
const dispatcher = new Agent({ headersTimeout: 1800000, bodyTimeout: 1800000 });

export async function auditCodeGeneration(pool: pg.Pool, grant: ExecutionGrantClaims, phase: string, details: Record<string, unknown>) {
  const scope = { ...executionGrantWorkspaceScope(grant), environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
  await executeCanonicalAuditedMutation(pool, { name: 'argus.dev.code-generation', eventId: `${grant.rootTraceId}:${phase}:${details['requestSha256']}` }, scope,
    async () => details, () => ({ ...scope, solution: 'argus.dev',
      actor: { type: grant.principalKind === 'user' ? 'human' : 'service', id: grant.principalId, authMethod: 'execution_grant', effectiveRoles: [] },
      action: `code_generation.${phase}`, outcome: phase.endsWith('result') && !details['applied'] ? 'failure' : 'success', risk: 'medium',
      resource: { type: 'code_generation', id: grant.rootTraceId, revision: String(details['requestSha256']) },
      policy: { id: 'argus.dev.code-generation', version: '1', decision: 'allow' },
      correlation: { rootRunId: grant.rootTraceId, traceId: grant.rootTraceId }, payload: { after: details } }));
}

/** A separate signed write capability, never inferred from general stack access. */
export function registerCodeGenerationRoutes(app: Express, pool: pg.Pool, auth: RequestHandler,
  options: { enabled?: () => boolean; fetchFn?: typeof fetch; auditFn?: typeof auditCodeGeneration } = {}) {
  app.post(['/api/agents/:id/code-generation', '/api/agents/:id/code-generation/recover'], auth, async (req, res) => {
    const recovery = req.path?.endsWith('/recover') === true;
    const recoveryDigest = recovery ? req.body?.recoveryDigest : undefined;
    if (!(options.enabled?.() ?? (process.env['ARGUS_CODE_GENERATION_ENABLED'] === 'true' && process.env['ARGUS_GENERAL_STACKS_ENABLED'] === 'true'))) {
      res.status(503).json({ code: 'codegen_disabled' }); return;
    }
    const grant = (req as typeof req & ExecutionGrantRequestState).executionGrant;
    const id = Number(req.params['id']);
    if (!grant || grant.aud !== 'argus.dev' || grant.agent !== 'coding-orchestrator' || !grant.workspaceRoot
      || grant.executionSurface === 'runtime_mcp' || !['general-stack-v1', 'workspace-session-v1'].includes(grant.testEnvironmentPolicy ?? '')
      || grant.codeGeneration?.version !== 1 || !grant.coreAgentIds.includes(id)
      || !grant.coreAgents?.some(a => a.id === id && a.name === 'reviewer')) {
      res.status(403).json({ code: 'codegen_grant_required' }); return;
    }
    let input;
    try {
      const body = recovery ? (({ recoveryDigest: _, ...rest }) => rest)(req.body ?? {}) : req.body;
      if (recovery && (!/^[a-f0-9]{64}$/.test(recoveryDigest) || body.action !== 'generate'
        || body.executionMode !== 'workspace-session-v1')) throw Error('codegen_request_invalid');
      input = body?.action === 'cancel' ? parseCodegenCancel(body) : parseCodegenRequest(body, grant.codeGeneration.allowedPaths);
    }
    catch { res.status(400).json({ code: 'codegen_request_invalid' }); return; }
    if (input.action === 'generate' && (input.executionMode ?? 'general-stack-v1') !== grant.testEnvironmentPolicy) { res.status(403).json({ code: 'codegen_policy_mismatch' }); return; }
    if (grant.testEnvironmentPolicy === 'workspace-session-v1' && process.env['ARGUS_WORKSPACE_SESSIONS_ENABLED'] !== 'true') { res.status(503).json({ code: 'stack_session_disabled' }); return; }
    const request = { ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot, allowedPaths: [...grant.codeGeneration.allowedPaths].sort() };
    const details = { requestSha256: codegenHash(request), basisSha256: input.basisSha256, action: input.action,
      ...(recovery ? { recoveryDigest } : {}),
      ...(input.action === 'generate' ? { sourceSha256: input.sourceSha256, planSha256: codegenHash(input.plan), outputPaths: input.plan.outputPaths } : {}) };
    try {
      const audit = options.auditFn ?? auditCodeGeneration;
      await audit(pool, grant, recovery ? 'recovery_requested' : 'requested', details);
      const response = await (options.fetchFn ?? fetch)(`${AGENT_WORKSPACE_URL}/code-generation${recovery ? '/recover' : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify({ ...request, ...(recovery ? { recoveryDigest } : {}) }), ...{ dispatcher }, signal: AbortSignal.timeout(!recovery && input.action === 'generate' ? 1770000 : 60000) });
      const text = await response.text();
      if (Buffer.byteLength(text) > 128000) throw Error('codegen_receipt_limit');
      const raw = JSON.parse(text);
      if (!response.ok) {
        const code = typeof raw?.code === 'string' && /^codegen_[a-z_]{1,80}$/.test(raw.code) ? raw.code : 'codegen_unavailable_no_replay';
        const failure = raw.failure === undefined ? undefined : parseCodegenFailure(raw.failure);
        await audit(pool, grant, recovery ? 'recovery_result' : 'result', { ...details, applied: false, code, ...(failure ? { outputSha256: failure.outputSha256, phase: failure.phase, status: failure.status } : {}) });
        res.status(409).json({ code, ...(failure ? { failure } : {}) }); return;
      }
      res.setHeader('Cache-Control', 'private, no-store');
      if (input.action === 'cancel') {
        if (raw?.stopped !== true) throw Error('codegen_cancel_unconfirmed');
        await audit(pool, grant, 'canceled', details);
        res.json({ stopped: true }); return;
      }
      const result = validateCodegenReceipt(input, grant.rootTraceId, raw);
      if (result.requestSha256 !== details.requestSha256) throw Error('codegen_request_changed');
      await audit(pool, grant, recovery ? 'recovery_result' : 'result', { ...details, applied: true, resultSourceSha256: result.resultSourceSha256,
        outputs: result.outputs, baseImage: result.baseImage, brokerRequestSha256: result.brokerRequestSha256 });
      res.json(result);
    } catch { res.status(503).json({ code: 'codegen_evidence_unavailable_no_replay' }); }
  });
}
