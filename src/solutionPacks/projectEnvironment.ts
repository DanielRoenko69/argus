import { createHash } from 'node:crypto';
import { z } from 'zod';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const environmentRequirementsSchema = z.array(z.object({
  requirement: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.\[\],<>=!~; '"()-]{0,255}$/),
  reason: z.string().trim().min(1).max(1000),
}).strict()).max(12).refine(v => new Set(v.map(r => r.requirement)).size === v.length);
export const environmentPlanSchema = z.object({
  version: z.literal(1), status: z.enum(['ready', 'blocked']),
  languages: z.array(z.enum(['python', 'node', 'java', 'dotnet', 'go', 'rust'])).max(6),
  manifestSha256: digest, profileId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).nullable(), profileSha256: digest.nullable(),
  runtime: z.string().max(128), reasons: z.array(z.string().regex(/^environment_[a-z_]+$/)).max(8), planSha256: digest,
}).strict().superRefine((p, ctx) => {
  if (hash([p.version, p.status, p.languages, p.manifestSha256, p.profileId, p.profileSha256, p.runtime, p.reasons]) !== p.planSha256 || new Set(p.languages).size !== p.languages.length
    || (p.status === 'ready' && (p.reasons.length || !p.profileId || !p.profileSha256 || p.languages.join(',') !== 'python'
      || !/^cpython-3\.\d+\.\d+-linux-[A-Za-z0-9_]+$/.test(p.runtime)))
    || (p.status === 'blocked' && !p.reasons.length)) ctx.addIssue({ code: 'custom', message: 'Invalid environment plan binding' });
});
export const environmentReceiptSchema = z.object({ version: z.literal(1), plan: environmentPlanSchema,
  status: z.enum(['ready', 'blocked']), reason: z.string().regex(/^environment_[a-z_]+$/).nullable(),
  packages: z.array(z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    version: z.string().regex(/^[0-9][a-zA-Z0-9.!+_-]{0,63}$/), sha256: digest }).strict()).max(128),
  installationOutputSha256: digest.nullable(), preflightOutputSha256: digest.nullable(),
  resolution: z.object({ requestSha256: digest, requirementsSha256: digest, lockSha256: digest, policySha256: digest }).strict().optional(),
}).strict().superRefine((r, ctx) => {
  if (new Set(r.packages.map(p => p.name)).size !== r.packages.length
    || (r.status === 'ready' && (r.reason !== null || r.plan.status !== 'ready' || !r.installationOutputSha256 || !r.preflightOutputSha256 || !r.packages.length))
    || (r.status === 'blocked' && !r.reason)) ctx.addIssue({ code: 'custom', message: 'Invalid environment receipt' });
});
