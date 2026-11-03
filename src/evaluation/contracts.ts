import { createHash } from 'node:crypto';
import { z } from 'zod';

export class EvaluationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export function stableJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export function evaluationDigest(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

const value = z.union([z.string().max(8192), z.number().finite(), z.boolean(), z.null()]);
const fieldPath = z.array(z.string().min(1).max(120).refine(key =>
  !['__proto__', 'prototype', 'constructor'].includes(key))).min(1).max(12);
export const evaluationAssertionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text_equals'), value: z.string().max(8192) }).strict(),
  z.object({ type: z.literal('text_includes'), value: z.string().min(1).max(8192) }).strict(),
  z.object({ type: z.literal('text_excludes'), value: z.string().min(1).max(8192) }).strict(),
  z.object({ type: z.literal('json_field_equals'), path: fieldPath, value }).strict(),
  z.object({ type: z.literal('json_object'), required: z.array(z.string().min(1).max(120)).max(64) }).strict(),
]);
// Declarative, bounded assertions only. No JS, regex, URLs or remote schema refs.
export const evaluationRulesSchema = z.object({
  version: z.literal('argus.deterministic.v1'),
  assertions: z.array(evaluationAssertionSchema).min(1).max(32),
}).strict();
export type EvaluationRules = z.infer<typeof evaluationRulesSchema>;

const id = z.number().int().positive().safe();
export const retryEvaluationSchema = z.object({
  case_ids:z.array(id).min(1).max(200),
  acknowledge_possible_duplicate_cost:z.literal(true),
}).strict();
const text = z.string().trim().min(1).max(240);
export const createDatasetSchema = z.object({
  dataset_key: text.max(160), version: id.default(1), name: text,
  description: z.string().max(2000).default(''), bundle_ids: z.array(id).max(100).default([]),
  agent_id: id.nullable().optional(),
}).strict();
export const createCaseSchema = z.object({
  case_key: text.max(160), input: z.unknown().refine(v => v !== undefined, 'input is required'),
  expected_output: z.unknown().optional(), context: z.unknown().optional(),
  source_trace_id: z.string().uuid().nullable().optional(),
  source_span_id: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).default({}), rules: evaluationRulesSchema,
}).strict();
export const createExperimentSchema = z.object({
  dataset_id: id, agent_id: id.nullable().optional(), model_ref: text,
  credential_ref: text.nullable().optional(), baseline_experiment_id: id.nullable().optional(),
  evaluator_config: z.object({ version: z.literal('argus.deterministic.v1').default('argus.deterministic.v1') }).strict().default({}),
}).strict();

const comparisonTarget = createExperimentSchema.pick({ agent_id:true,model_ref:true,credential_ref:true });
export const createComparisonSchema = z.object({
  name:text, dataset_id:id, baseline:comparisonTarget, candidate:comparisonTarget.extend({ prompt_revision_id:id.optional(),skill_revision_id:id.optional() })
    .refine(v=>!(v.prompt_revision_id && v.skill_revision_id),'Compare either a prompt or a Skill revision, not both'),
  repetitions:z.number().int().min(1).max(10).default(1),
  order_mode:z.enum(['alternating','baseline_first']).default('alternating'),
  reviewed_preflight_sha256:z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export type CreateComparisonInput = z.infer<typeof createComparisonSchema>;
export const runComparisonSchema = z.object({ acknowledge_cost:z.literal(true) }).strict();

export function evaluationReadiness(evidenceKind: string, snapshot?: Record<string, unknown> | null, status = 'queued'): { startable: boolean; code: string; reason: string } {
  const execution = snapshot?.['execution'] as Record<string, unknown> | undefined;
  if (evidenceKind==='frozen_v1' && execution?.['type']==='codex' && execution['executor_version']==='argus.codex-reference.v1'
    && execution['isolation_verified']===true) {
    return status==='queued'
      ? { startable:true,code:'EVALUATION_READY',reason:'Isolated Codex subscription evaluation. At most one model request per case; no tools, RAG, memory, API fallback or automatic retries. Uses subscription quota; monetary cost is unknown.' }
      : { startable:false,code:'EVALUATION_ALREADY_STARTED',reason:'This experiment has already been claimed. Automatic restart is disabled.' };
  }
  if (evidenceKind === 'frozen_v1' && execution?.['executor_version'] === 'argus.native-reference.v1'
      && execution['isolation_verified'] === true && execution['type'] === 'argus') {
    return status === 'queued'
      ? { startable:true,code:'EVALUATION_READY',reason:'Isolated native API evaluation. Starting sends one paid/provider request per case; no tools, RAG, memory or automatic retries. Access and routing are rechecked before dispatch.' }
      : { startable:false,code:'EVALUATION_ALREADY_STARTED',reason:'This experiment has already been claimed. Results are append-only; automatic restart is disabled.' };
  }
  return evidenceKind === 'frozen_v1'
    ? { startable: false, code: 'EVALUATION_EXECUTOR_NOT_READY', reason: 'This snapshot lacks a verified executor. Create a new snapshot with an available isolated API or Codex target; historical snapshots cannot be upgraded in place.' }
    : { startable: false, code: 'EVALUATION_LEGACY_SMOKE', reason: 'Historical smoke evidence is read-only, not a quality comparison. Create a new dataset version.' };
}
