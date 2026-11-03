/** Keep the wire contract byte-identical with Argus.Dev's stackEnvironment.ts. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
export const stackHash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const script = z.string().max(24000).refine(v => Buffer.byteLength(v) <= 24000 && !v.includes('\0'));
export const stackPlanSchema = z.object({ version: z.literal(1), summary: z.string().trim().min(1).max(2000),
  setup: script.refine(v => Boolean(v.trim())), start: script, test: script.refine(v => Boolean(v.trim())),
  python: z.string().regex(/^\/(?:[A-Za-z0-9_.+-]+\/)*[A-Za-z0-9_.+-]+$/).refine(v => !v.split('/').includes('..')),
}).strict();
export type StackPlan = z.infer<typeof stackPlanSchema>;
export const stackOutputCaptureSchema = z.object({ version: z.literal(1),
  stdoutBytes: z.number().int().nonnegative().safe(), stderrBytes: z.number().int().nonnegative().safe(),
  stdoutTruncated: z.boolean(), stderrTruncated: z.boolean(),
}).strict();
export const stackEnvironmentSchema = z.object({ version: z.literal(1), planSha256: digest,
  executionMode: z.literal('workspace-session-v1').optional(), sessionId: digest.optional(), preparedSession: digest.nullable().optional(),
  workspaceDatabase: z.object({ version: z.literal(1), engine: z.literal('postgresql'), serverMajor: z.number().int().min(16).max(99),
    scopeSha256: digest, reset: z.literal('before-phase') }).strict().optional(),
  baseImage: z.string().regex(/^sha256:[a-f0-9]{64}$/), preparedImage: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  phase: z.enum(['setup', 'project', 'qa']), brokerRequestSha256: digest,
  executionStatus: z.enum(['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'interrupted', 'disk_limit']).optional(),
  outputCapture: stackOutputCaptureSchema.optional(),
  testStarted: z.boolean().optional(),
}).strict();
export const stackSnapshotSchema = z.object({ sourceSha256: digest, files: z.number().int().nonnegative(),
  excludedFiles: z.number().int().nonnegative(), python: z.boolean() }).strict();
const common = { baseCommitSha: z.string().regex(/^[a-f0-9]{40}$/), basisSha256: digest,
  executionMode: z.literal('workspace-session-v1').optional() };
const execution = { ...common, sourceSha256: digest, stackPlan: stackPlanSchema };
const files = z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
  content: z.string().min(1).max(16000).refine(v => Buffer.byteLength(v) <= 16000 && !v.includes('\0')),
}).strict()).min(1).max(12).refine(v => new Set(v.map(f => f.id)).size === v.length && Buffer.byteLength(JSON.stringify(v)) <= 72000);
export const stackRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('inspect'), ...common }).strict(),
  z.object({ action: z.literal('project'), ...execution }).strict(),
  z.object({ action: z.literal('run'), ...execution, files, preparedImage: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), preparedSession: digest.optional() }).strict(),
  z.object({ action: z.literal('cancel'), ...common }).strict(),
]).superRefine((r, ctx) => {
  if (r.action === 'run' && (r.executionMode ? !r.preparedSession || r.preparedImage !== undefined : !r.preparedImage || r.preparedSession !== undefined))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'execution environment mismatch' });
});
export type StackRequest = z.infer<typeof stackRequestSchema>;
export const stackResultSchema = z.object({ version: z.literal(1), threadId: z.string().uuid(), basisSha256: digest,
  sourceSha256: digest, testSha256: digest, requestSha256: digest, profile: z.enum(['stack-container-v1', 'workspace-session-v1']),
  status: z.enum(['completed', 'failed', 'timeout', 'output_limit', 'canceled', 'preparation_failed']), exitCode: z.number().int().nullable(),
  stackEnvironment: stackEnvironmentSchema, executionStarted: z.boolean(),
  missingModules: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.]{0,127}$/)).max(12),
  stdout: z.string().max(32768), stderr: z.string().max(32768), durationMs: z.number().nonnegative(),
  passed: z.boolean(), assertionFailed: z.boolean(), collected: z.number().int().min(0).max(256),
  nodes: z.array(z.string().max(512)).max(256), outputSha256: digest, finishedAt: z.string().datetime(),
}).strict();
export type StackResult = z.infer<typeof stackResultSchema>;
export function validateStackResult(input: Extract<StackRequest, { action: 'run' | 'project' }>, threadId: string, value: unknown): StackResult {
  const r = stackResultSchema.parse(value), env = r.stackEnvironment;
  const session = input.executionMode === 'workspace-session-v1';
  if (session ? r.profile !== 'workspace-session-v1' || env.executionMode !== input.executionMode || !env.sessionId || env.preparedImage !== null
    || env.preparedSession === undefined
    : r.profile !== 'stack-container-v1' || env.executionMode !== undefined || env.sessionId !== undefined || env.preparedSession !== undefined || env.workspaceDatabase !== undefined)
    throw new Error('stack_evidence_mode');
  const started = env.phase !== 'setup' && env.testStarted !== false;
  const mapped = !started ? 'preparation_failed'
    : ['interrupted', 'disk_limit'].includes(env.executionStatus ?? '') ? 'failed' : env.executionStatus;
  if (r.threadId !== threadId || r.basisSha256 !== input.basisSha256 || r.sourceSha256 !== input.sourceSha256
    || (env.executionStatus !== undefined && (r.status !== mapped || env.phase === 'setup' && env.executionStatus === 'completed'
      || r.passed && env.executionStatus !== 'completed'))
    || (r.passed && env.phase === 'qa' && (env.outputCapture?.stdoutTruncated || env.outputCapture?.stderrTruncated))
    || env.planSha256 !== stackHash(input.stackPlan) || r.outputSha256 !== stackHash([r.stdout, r.stderr])
    || r.testSha256 !== stackHash(input.action === 'run' ? input.files : input.stackPlan.test)
    || r.nodes.length !== r.collected || new Set(r.nodes).size !== r.nodes.length
    || r.executionStarted !== started
    || (env.phase === 'setup' && env.testStarted === true)
    || (!started && (r.passed || r.assertionFailed || r.collected !== 0 || r.nodes.length !== 0))
    || (input.action === 'run' && ((session ? env.preparedSession !== input.preparedSession : env.preparedImage !== input.preparedImage) || env.phase !== 'qa'))
    || (session && input.action === 'project' && env.phase === 'project' && env.preparedSession !== env.brokerRequestSha256)
    || (input.action === 'project' && !['setup', 'project'].includes(env.phase))
    || (r.passed && (r.status !== 'completed' || r.exitCode !== 0 || !r.executionStarted || !(session ? env.preparedSession : env.preparedImage) || r.assertionFailed || r.missingModules.length || (input.action === 'run' && !r.collected)))
    || (r.assertionFailed && (input.action !== 'run' || r.status !== 'failed' || r.exitCode !== 1 || r.missingModules.length))) throw new Error('stack_evidence_binding');
  return r;
}
