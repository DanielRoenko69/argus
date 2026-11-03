import { createHash } from 'node:crypto';
import { z } from 'zod';

const choice = z.object({ id: z.string().max(40), label: z.string().max(2000), consequence: z.string().max(2000) });
const decisionSchema = z.object({ version: z.literal(2), id: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(['requirement', 'environment', 'scope', 'technical_review']), canClarify: z.boolean(),
  questions: z.array(z.object({ id: z.string().max(40), question: z.string().max(2000), options: z.array(choice).max(4) })).max(12) });
const replySchema = z.object({ decisionId: z.string().regex(/^[a-f0-9]{64}$/),
  requirements: z.string().trim().max(12000), answers: z.record(z.string().max(40)).optional() }).strict();

function versionedSubmission(body: unknown, rawDecision: unknown) {
  const decision = decisionSchema.parse(rawDecision);
  const value = replySchema.parse(body);
  if (decision.id !== value.decisionId) throw Object.assign(new Error('This decision changed. Reload the current question.'), { status: 409 });
  if (!decision.canClarify || decision.kind === 'scope') throw Object.assign(new Error(decision.kind === 'technical_review'
    ? 'Technical work is blocked. Owner clarification or approval cannot resolve this checkpoint.'
    : 'Scope and access require a separately authorized run, not clarification.'), { status: 409 });
  const answers = value.answers ?? {};
  if (Object.keys(answers).some(key => !decision.questions.some(q => q.id === key))) throw Object.assign(new Error('Unknown question.'), { status: 400 });
  const selected = decision.questions.filter(q => answers[q.id] !== undefined).map(q => {
    const option = q.options.find(o => o.id === answers[q.id]);
    if (!option) throw Object.assign(new Error('Unknown option.'), { status: 400 });
    return `${q.question}\nSelected: ${option.label}. ${option.consequence}`;
  });
  const complete = decision.kind === 'requirement' && decision.questions.length > 0 && selected.length === decision.questions.length;
  if (!complete && (!value.requirements || /^(yes|ja|ok|okay|approve|approved|weiter)[.!\s]*$/i.test(value.requirements))) {
    throw Object.assign(new Error('Answer the questions or describe the resolution; a generic approval is not sufficient.'), { status: 400 });
  }
  const requirements = [...selected, value.requirements].filter(Boolean).join('\n\n');
  if (requirements.length > 12_000) throw Object.assign(new Error('The combined decision response exceeds 12000 characters.'), { status: 400 });
  return { requirements, resume: value, digest: createHash('sha256').update(JSON.stringify(value)).digest('hex') };
}

/** A clarification neither grants capabilities nor substitutes a human approval. */
export function requirementsSubmission(body: unknown, thread: Record<string, any>, userId: number | null) {
  if (!userId || thread.metadata?.execution_principal !== `user:${userId}`) {
    throw Object.assign(new Error('Only the execution owner can clarify this run.'), { status: 403 });
  }
  const interrupts = Array.isArray(thread.interrupts) ? thread.interrupts : Object.values(thread.interrupts ?? {}).flat();
  if (thread.status !== 'interrupted' || !interrupts.some((item: any) => item?.value?.stage === 'requirements_input')) {
    throw Object.assign(new Error('This run is not waiting for requirements.'), { status: 409 });
  }
  const decision = interrupts.find((item: any) => item?.value?.stage === 'requirements_input')?.value?.decision;
  if (thread.values?.development_contract_version === 2 && decision === undefined) {
    throw Object.assign(new Error('The current decision is unavailable. Reload before answering.'), { status: 409 });
  }
  if (decision !== undefined) {
    try { return versionedSubmission(body, decision); }
    catch (error) {
      if (error instanceof z.ZodError) throw Object.assign(new Error('Invalid decision or clarification contract. Reload the current question.'), { status: 400 });
      throw error;
    }
  }
  const data = body as Record<string, unknown> | null;
  if (!data || Array.isArray(data) || Object.keys(data).some(key => key !== 'requirements')
    || typeof data.requirements !== 'string' || !data.requirements.trim() || data.requirements.length > 12_000) {
    throw Object.assign(new Error('Supply 1–12000 characters of requirements, not an approval or configuration change.'), { status: 400 });
  }
  const requirements = data.requirements.trim();
  return { requirements, resume: { requirements }, digest: createHash('sha256').update(requirements).digest('hex') };
}
