import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import { executionGrantWorkspaceScope, type ExecutionGrantClaims } from './executionGrant.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';
import { environmentPlanSchema, environmentReceiptSchema, environmentRequirementsSchema } from './projectEnvironment.js';
import { Agent } from 'undici';
const environmentDispatcher = new Agent({ headersTimeout: 510000, bodyTimeout: 510000 });

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const common = { baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/), basisSha256: digest, environmentPolicyVersion: z.literal(1).optional(), environmentRequirements: environmentRequirementsSchema.optional() };
export const qaRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), ...common }).strict(),
  z.object({ action: z.literal('run'), ...common, sourceSha256: digest, environmentPlanSha256: digest.optional(),
    files: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), content: z.string().min(1).max(16000) }).strict()).min(1).max(12) }).strict(),
]);
const snapshotSchema = z.object({ sourceSha256: digest, files: z.number().int().nonnegative(), excludedFiles: z.number().int().nonnegative(), python: z.boolean(), environment: environmentPlanSchema.optional() }).strict();
const resultSchema = z.object({ version: z.literal(1), threadId: z.string().uuid(), basisSha256: digest, sourceSha256: digest,
  testSha256: digest, requestSha256: digest, profile: z.literal('python-bwrap-v1'),
  status: z.enum(['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'preparation_failed']), exitCode: z.number().int().nullable(),
  environment: environmentReceiptSchema.optional(), executionStarted: z.boolean().optional(),
  missingModules: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/)).max(12).optional(),
  stdout: z.string().max(32768), stderr: z.string().max(32768), durationMs: z.number().nonnegative(),
  passed: z.boolean(), assertionFailed: z.boolean(), collected: z.number().int().min(0).max(256),
  nodes: z.array(z.string().max(512)).max(256), outputSha256: digest, finishedAt: z.string().datetime() }).strict();

async function audit(pool: pg.Pool, grant: ExecutionGrantClaims, phase: string, details: Record<string, unknown>) {
  const scope = { ...executionGrantWorkspaceScope(grant), environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
  await executeCanonicalAuditedMutation(pool, { name: 'argus.dev.qa-tests', eventId: `${grant.rootTraceId}:${phase}:${details['requestSha256']}` }, scope,
    async () => details, () => ({ ...scope, solution: 'argus.dev',
      actor: { type: grant.principalKind === 'user' ? 'human' : 'service', id: grant.principalId, authMethod: 'execution_grant', effectiveRoles: [] },
      action: `qa_tests.${phase}`, outcome: phase === 'result' && !details['passed'] ? 'failure' : 'success', risk: 'medium',
      resource: { type: 'qa_tests', id: grant.rootTraceId, revision: String(details['requestSha256']) },
      policy: { id: 'argus.dev.qa-tests', version: '1', decision: 'allow' },
      correlation: { rootRunId: grant.rootTraceId, traceId: grant.rootTraceId }, payload: { after: details } }));
}
export const auditQaExecution = audit;

/** Only the verified run's Reviewer can submit bounded test artifacts. No public shell/write capability. */
export function registerQaTestsRoutes(app: Express, pool: pg.Pool, auth: RequestHandler,
  options: { enabled?: () => boolean; environmentsEnabled?: () => boolean; fetchFn?: typeof fetch; auditFn?: typeof audit } = {}) {
  app.post('/api/agents/:id/qa-tests', auth, async (req, res) => {
    if (!(options.enabled?.() ?? process.env['ARGUS_DEV_QA_TESTS_ENABLED'] === 'true')) { res.status(503).json({ code: 'qa_disabled' }); return; }
    const grant = (req as typeof req & ExecutionGrantRequestState).executionGrant;
    const agentId = Number(req.params['id']);
    if (!grant || grant.aud !== 'argus.dev' || grant.agent !== 'coding-orchestrator' || !grant.workspaceRoot
      || !grant.coreAgentIds.includes(agentId) || !grant.coreAgents?.some(a => a.id === agentId && a.name === 'reviewer')) {
      res.status(403).json({ code: 'qa_grant_required' }); return;
    }
    const parsed = qaRequestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: 'qa_invalid_request' }); return; }
    const input = parsed.data;
    if (input.environmentRequirements !== undefined && input.environmentPolicyVersion !== 1) {
      res.status(400).json({ code: 'qa_invalid_request' }); return;
    }
    if (input.environmentPolicyVersion === 1 && !(options.environmentsEnabled?.() ?? process.env['ARGUS_PROJECT_ENVIRONMENTS_ENABLED'] === 'true')) {
      res.status(503).json({ code: 'environment_disabled' }); return;
    }
    if (input.action === 'run' && ((input.environmentPolicyVersion === 1) !== Boolean(input.environmentPlanSha256))) {
      res.status(400).json({ code: 'qa_invalid_request' }); return;
    }
    if (input.action === 'run' && (Buffer.byteLength(JSON.stringify(input.files)) > 72000
      || new Set(input.files.map(f => f.id)).size !== input.files.length
      || input.files.some(f => !f.content.trim() || f.content.includes('\0') || Buffer.byteLength(f.content) > 16000))) {
      res.status(400).json({ code: 'qa_invalid_request' }); return;
    }
    const request = { ...input, threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot };
    const details = { basisSha256: input.basisSha256, baseCommitSha: input.baseCommitSha,
      requestSha256: hash(request), ...(input.action === 'run' ? { sourceSha256: input.sourceSha256, testSha256: hash(input.files),
        ...(input.environmentPlanSha256 ? { environmentPlanSha256: input.environmentPlanSha256 } : {}) } : {}) };
    try {
      if (input.action === 'run') await (options.auditFn ?? audit)(pool, grant, 'requested', details);
      const response = await (options.fetchFn ?? fetch)(`${AGENT_WORKSPACE_URL}/qa-tests`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify(request), ...(input.environmentPolicyVersion === 1 ? { dispatcher: environmentDispatcher } : {}),
        signal: AbortSignal.timeout(input.environmentPolicyVersion === 1 ? 480000 : 120000) });
      if (!response.ok) { res.status(409).json({ code: 'qa_unavailable_or_changed' }); return; }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 128000) throw new Error('qa_receipt_limit');
      if (input.action === 'inspect') {
        const snapshot = snapshotSchema.parse(JSON.parse(raw));
        if ((input.environmentPolicyVersion === 1) !== Boolean(snapshot.environment)) throw new Error('environment_policy_mismatch');
        res.json(snapshot); return;
      }
      const result = resultSchema.parse(JSON.parse(raw));
      if (result.threadId !== grant.rootTraceId || result.basisSha256 !== input.basisSha256 || result.sourceSha256 !== input.sourceSha256
        || result.requestSha256 !== details.requestSha256 || result.testSha256 !== details.testSha256
        || result.outputSha256 !== hash([result.stdout, result.stderr])
        || result.nodes.length !== result.collected || new Set(result.nodes).size !== result.nodes.length
        || (result.passed && (result.status !== 'completed' || result.exitCode !== 0 || !result.collected || result.assertionFailed || result.missingModules?.length))
        || (result.assertionFailed && (result.status !== 'failed' || result.exitCode !== 1 || result.missingModules?.length))
        || (input.environmentPolicyVersion === 1 ? !result.environment || result.environment.plan.planSha256 !== input.environmentPlanSha256
          || result.executionStarted !== (result.environment.status === 'ready')
          || (result.environment.status === 'blocked' && (result.status !== 'preparation_failed' || result.passed || result.assertionFailed || result.collected !== 0 || result.exitCode !== null))
          || (result.environment.status === 'ready' && result.status === 'preparation_failed')
          : result.environment !== undefined || result.executionStarted !== undefined || result.status === 'preparation_failed')) throw new Error('qa_receipt_binding');
      await (options.auditFn ?? audit)(pool, grant, 'result', { ...details, outputSha256: result.outputSha256, passed: result.passed,
        ...(result.environment ? { environmentStatus: result.environment.status, environmentReason: result.environment.reason,
          environmentReceiptSha256: hash(result.environment), executionStarted: result.executionStarted } : {}) });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(result);
    } catch { res.status(503).json({ code: 'qa_evidence_unavailable', error: 'QA evidence unavailable; do not replay an uncertain attempt.' }); }
  });
}
