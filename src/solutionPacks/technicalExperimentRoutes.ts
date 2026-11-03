import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExecutionGrantRequestState } from '../auth/executionGrantMiddleware.js';
import { executionGrantWorkspaceScope, type ExecutionGrantClaims } from './executionGrant.js';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import { AGENT_WORKSPACE_URL, WORKSPACE_SECRET } from '../config/env.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.object({ baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/), basisSha256: digest,
  requestSha256: digest, script: z.string().min(1).max(24_000) }).strict();
const fixedLimits = { wallMs: z.literal(30000), cpuSeconds: z.literal(20), memoryBytes: z.literal(536870912),
  outputBytes: z.literal(32768), scriptBytes: z.literal(24000), snapshotFiles: z.literal(3000) };
const snapshotLimitsSchema = z.union([
  // Historical receipts remain valid; never rewrite old recorded limits.
  z.object({ ...fixedLimits, snapshotBytes: z.literal(67108864) }).strict(),
  z.object({ ...fixedLimits, snapshotFileBytes: z.number().int().min(1048576).max(33554432),
    snapshotBytes: z.number().int().min(1048576).max(268435456) }).strict()
    .refine(v => v.snapshotFileBytes <= v.snapshotBytes && v.snapshotFileBytes % 1048576 === 0 && v.snapshotBytes % 1048576 === 0),
]);
const preparationReceiptSchema = z.object({ version: z.literal(1), threadId: z.string().uuid(),
  baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/), basisSha256: digest, requestSha256: digest, scriptSha256: digest,
  status: z.literal('preparation_failed'), executionStarted: z.literal(false),
  reason: z.enum(['snapshot_file_size_limit', 'snapshot_total_size_limit', 'snapshot_file_count_limit']),
  actual: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), limit: z.number().int().positive(),
  filePath: z.string().min(1).max(400).refine(p => [...p].every(c => c.charCodeAt(0) > 31 && ![92, 127].includes(c.charCodeAt(0)))
    && p.split('/').every(part => part && !part.startsWith('.'))).optional(),
  limits: snapshotLimitsSchema,
}).strict().refine(r => r.actual > r.limit
  && (r.reason === 'snapshot_file_size_limit'
    ? Boolean(r.filePath) && 'snapshotFileBytes' in r.limits && r.limit === r.limits.snapshotFileBytes
    : r.filePath === undefined && r.limit === (r.reason === 'snapshot_total_size_limit' ? r.limits.snapshotBytes : r.limits.snapshotFiles)));
const executionReceiptSchema = z.object({ version: z.literal(1), threadId: z.string().uuid(), baseCommitSha: z.string(),
  basisSha256: digest, requestSha256: digest, scriptSha256: digest, snapshotSha256: digest,
  profile: z.literal('python-bwrap-v1'), status: z.enum(['completed', 'failed', 'timeout', 'output_limit', 'canceled']),
  exitCode: z.number().int().nullable(), stdout: z.string().max(32_768), stderr: z.string().max(32_768), outputSha256: digest,
  startedAt: z.string().datetime(), finishedAt: z.string().datetime(), durationMs: z.number().nonnegative(),
  files: z.number().int().nonnegative(), excludedFiles: z.number().int().nonnegative(), pythonVersion: z.string().regex(/^3\.\d+\.\d+$/),
  limits: snapshotLimitsSchema,
}).strict();
const receiptSchema = z.union([executionReceiptSchema, preparationReceiptSchema]);
type AuditDetails = { requestSha256: string; basisSha256: string; baseCommitSha: string; scriptSha256: string; outputSha256?: string; status?: string; reason?: string; executionStarted?: false };
async function audit(pool: pg.Pool, grant: ExecutionGrantClaims, phase: 'requested' | 'result', details: AuditDetails) {
  const scope = { ...executionGrantWorkspaceScope(grant), environment: process.env['ARGUS_ENVIRONMENT'] || 'local' };
  const producer = { name: 'argus.dev.technical-experiment', eventId: `${grant.rootTraceId}:${phase}:${details.requestSha256}` };
  await executeCanonicalAuditedMutation(pool, producer, scope, async () => details, () => ({
    ...scope, solution: 'argus.dev', actor: { type: grant.principalKind === 'user' ? 'human' : 'service',
      id: grant.principalId, authMethod: 'execution_grant', effectiveRoles: [] },
    action: `technical_experiment.${phase}`, outcome: phase === 'result' && details.status !== 'completed' ? 'failure' : 'success',
    risk: 'medium', resource: { type: 'technical_experiment', id: grant.rootTraceId, revision: details.requestSha256 },
    policy: { id: 'argus.dev.technical-experiment', version: '1', decision: 'allow' },
    correlation: { rootRunId: grant.rootTraceId, traceId: grant.rootTraceId }, payload: { after: details },
  }));
}

/** Normal grant middleware verifies signature, expiry, revocation and exact Agent/Bundle scope first.
 * This is not a generic shell tool and is not exposed to the Planner's tool catalog. */
export function registerTechnicalExperimentRoute(app: Express, pool: pg.Pool, auth: RequestHandler,
  options: { enabled?: () => boolean; fetchFn?: typeof fetch; auditFn?: typeof audit } = {}) {
  const fetchFn = options.fetchFn ?? fetch;
  const auditFn = options.auditFn ?? audit;
  app.post('/api/agents/:id/technical-experiment', auth, async (req, res) => {
    if (!(options.enabled?.() ?? process.env['ARGUS_TECHNICAL_EXPERIMENTS_ENABLED'] === 'true')) {
      res.status(503).json({ error: 'Technical experiments are disabled', code: 'experiments_disabled' }); return;
    }
    const grant = (req as typeof req & ExecutionGrantRequestState).executionGrant;
    const agentId = Number(req.params['id']);
    if (!grant || grant.aud !== 'argus.dev' || grant.agent !== 'coding-orchestrator'
      || !grant.workspaceRoot || !grant.coreAgentIds.includes(agentId)
      || !grant.coreAgents?.some(agent => agent.id === agentId && agent.name === 'planner')) {
      res.status(403).json({ error: 'A workspace-bound Argus.Dev Planner grant is required', code: 'experiment_grant_required' }); return;
    }
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success || Buffer.byteLength(parsed.data.script) > 24_000 || parsed.data.script.includes('\0')) {
      res.status(400).json({ error: 'Invalid bounded experiment request', code: 'invalid_experiment_request' }); return;
    }
    const input = parsed.data;
    const details = { requestSha256: input.requestSha256, basisSha256: input.basisSha256,
      baseCommitSha: input.baseCommitSha, scriptSha256: hash(input.script) };
    // Keep cooperative cancellation: the bounded request settles before Pack
    // can mark its node canceled. No HTTP or experiment retry is automatic.
    try {
      await auditFn(pool, grant, 'requested', details);
      const response = await fetchFn(`${AGENT_WORKSPACE_URL}/technical-experiments/run`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-secret': WORKSPACE_SECRET },
        body: JSON.stringify({ threadId: grant.rootTraceId, workspaceRoot: grant.workspaceRoot, ...input }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!response.ok) { res.status(409).json({ error: 'Experiment unavailable or already attempted; no automatic replay', code: 'experiment_unavailable' }); return; }
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 256_000) throw new Error('receipt_limit');
      const result = receiptSchema.parse(JSON.parse(raw));
      if (result.threadId !== grant.rootTraceId || result.baseCommitSha !== input.baseCommitSha
        || result.basisSha256 !== input.basisSha256 || result.requestSha256 !== input.requestSha256
        || result.scriptSha256 !== details.scriptSha256) throw new Error('receipt_binding');
      if (result.status !== 'preparation_failed' && (result.outputSha256 !== hash(JSON.stringify([result.stdout, result.stderr]))
        || Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > 32_780
        || (result.status === 'completed' && result.exitCode !== 0))) throw new Error('receipt_binding');
      await auditFn(pool, grant, 'result', { ...details, status: result.status,
        ...(result.status === 'preparation_failed' ? { reason: result.reason, executionStarted: false as const } : { outputSha256: result.outputSha256 }) });
      res.setHeader('Cache-Control', 'private, no-store');
      res.json(result);
    } catch {
      res.status(503).json({ error: 'Experiment evidence unavailable. Do not replay an uncertain attempt.', code: 'experiment_evidence_unavailable' });
    }
  });
}
