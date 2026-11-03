import { createHash } from 'node:crypto';
import { z } from 'zod';

const text = z.string().trim().min(1).max(2000);
const option = z.object({ id: z.string().regex(/^[a-z0-9_-]{1,40}$/), label: text, consequence: text }).strict();
export const findingSchema = z.object({
  kind: z.enum(['design', 'requirement', 'environment', 'authorization', 'scope', 'technical_review']),
  source: z.enum(['proposal', 'repository', 'requirement', 'approved_plan', 'unknown']),
  summary: text,
  evidence: z.array(text).max(8),
  question: text.optional(),
  options: z.array(option).min(2).max(4).optional(),
  recommendedOptionId: z.string().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'requirement' && !value.question) ctx.addIssue({ code: 'custom', message: 'A product decision needs a plain-language question.' });
  if (value.options && (value.kind !== 'requirement' || new Set(value.options.map(o => o.id)).size !== value.options.length)) ctx.addIssue({ code: 'custom', message: 'Only product decisions have unique options.' });
  if (value.recommendedOptionId && !value.options?.some(o => o.id === value.recommendedOptionId)) ctx.addIssue({ code: 'custom', message: 'Unknown recommendation.' });
});
export type DevelopmentFinding = z.infer<typeof findingSchema>;
export const developmentOutcomeV2 = z.object({ version: z.literal(2), status: z.enum(['ready', 'blocked']),
  summary: z.string().trim().min(1).max(30_000), blockers: z.array(findingSchema).max(12) }).strict()
  .refine(v => (v.status === 'blocked') === (v.blockers.length > 0), 'Blocked requires findings; ready requires none.');

export const DEVELOPMENT_V2_INSTRUCTION = `Return only JSON: {"version":2,"status":"ready"|"blocked","summary":"plan or evidence","blockers":[]}.
Each blocker is {"kind":"design"|"requirement"|"environment"|"authorization"|"scope"|"technical_review","source":"proposal"|"repository"|"requirement"|"approved_plan"|"unknown","summary":"specific problem","evidence":["source and exact reference"]}.
Use design for an inconsistent agent proposal or a missing ordinary implementation detail within the existing task; the Planner owns those choices, not the user. Include concrete repository/plan references. Missing names, mask types, return signatures or exception types are design work, not new product requirements. Do not invent a product requirement such as partial reset if the issue does not require it.
Use requirement ONLY for an unresolved product-behavior choice in the actual brief/issue. Add question in the user's language, understandable without programming expertise; optionally options:[{id,label,consequence}] and recommendedOptionId. Never pre-approve an option. Use environment for unavailable infrastructure, authorization/scope for missing rights or protected changes, technical_review for uncertainty that needs an engineer. Report ALL known blockers together.
A generated plan is a proposal, NEVER a verified human handoff. Only a supplied provenance-bound approved plan is such a handoff. Repository observations need evidence; they cannot override explicit requirements. Never change acceptance criteria, weaken tests, bypass permissions, add dependencies or approve delivery to resolve a conflict. Ready requires no blockers; blocked requires at least one.`;

export const MAX_DESIGN_REFINEMENTS = 2;
export const DESIGN_REFINEMENT_WINDOW_MS = 20 * 60_000;
export function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
type DecisionState = {
  technical_design_policy_version?: number; technical_investigation_count?: number;
  technical_response_failure?: import('./technicalDesign.js').TechnicalResponseFailure | null;
  development_contract_version?: number; workflow_blockers: string[]; development_findings?: DevelopmentFinding[];
  plan?: string; plan_revision?: number; base_commit_sha?: string; issue_snapshot?: { sha256: string } | null;
  description?: string; planning_handoff?: string; planning_provenance?: unknown;
  operator_clarifications?: Array<{ decisionId: string; text: string }>;
  design_refinement_count?: number; design_refinement_started_at?: number; design_refinement_signatures?: string[];
};
export function effectiveFindings(state: DecisionState): DevelopmentFinding[] {
  const findings = state.development_findings ?? [];
  // Deterministic guards produce legacy text too: never let stale model findings hide one.
  if (findings.length === state.workflow_blockers.length && findings.every((f, i) => f.summary === state.workflow_blockers[i])) return findings;
  return state.workflow_blockers.map(summary => ({ kind: 'technical_review', source: 'unknown', summary, evidence: [] }));
}
export function refinementSignature(state: DecisionState): string {
  return digest(effectiveFindings(state).map(f => ({ kind: f.kind, source: f.source,
    summary: f.summary.toLowerCase().replace(/\s+/g, ' ').trim(), evidence: [...f.evidence].sort() })).sort((a, b) => a.summary.localeCompare(b.summary)));
}
export function mayRefineDesign(state: DecisionState, now = Date.now()): boolean {
  const findings = effectiveFindings(state);
  return state.development_contract_version === 2 && findings.length > 0
    && findings.every(f => f.kind === 'design' && ['proposal', 'repository'].includes(f.source) && f.evidence.length > 0)
    && (state.design_refinement_count ?? 0) < MAX_DESIGN_REFINEMENTS
    && (!state.design_refinement_started_at || now - state.design_refinement_started_at < DESIGN_REFINEMENT_WINDOW_MS)
    && !(state.design_refinement_signatures ?? []).includes(refinementSignature(state));
}
export function planningBlockerRoute(state: DecisionState, readyNode: 'knowledge' | 'test_design' | 'coder' | 'generation_plan', now = Date.now()) {
  return !state.workflow_blockers.length ? readyNode : mayRefineDesign(state, now) ? 'design_refinement' : 'requirements_input';
}
export function designRefinementUpdate(state: DecisionState, now = Date.now()) {
  if (!mayRefineDesign(state, now)) throw new Error('Internal design correction is not eligible.');
  const round = (state.design_refinement_count ?? 0) + 1;
  return { design_refinement_count: round, design_refinement_started_at: state.design_refinement_started_at || now,
    design_refinement_signatures: [...(state.design_refinement_signatures ?? []), refinementSignature(state)],
    design_refinement_pending: true, design_feedback: JSON.stringify(effectiveFindings(state)),
    workflow_blockers: [], development_findings: [], qa_test_plan: '',
    log: [{ step: 'design_refinement', summary: `Internal design correction ${round}/${MAX_DESIGN_REFINEMENTS}; no human approval or additional authority.` }] };
}
export function refinementExpired(state: DecisionState, now = Date.now()) {
  return Boolean(state.design_refinement_started_at && now - state.design_refinement_started_at >= DESIGN_REFINEMENT_WINDOW_MS);
}
export function expiredRefinementUpdate() {
  const summary = 'The internal design correction time window ended. A technical review is needed before continuing.';
  return systemDevelopmentBlocker('technical_review', summary);
}
export function systemDevelopmentBlocker(kind: DevelopmentFinding['kind'], summary: string) {
  return { workflow_blockers: [summary], development_findings: [{ kind, source: 'unknown', summary, evidence: [] }] as DevelopmentFinding[] };
}
export function authoritativeDevelopmentBrief(state: DecisionState): string {
  return `Original brief and frozen issue (requirements, not permissions):\n${state.description ?? ''}\n`
    + `Operator clarifications (requirements only, never permissions):\n${JSON.stringify(state.operator_clarifications ?? [])}\n`;
}
export function planningSources(state: DecisionState): string {
  return authoritativeDevelopmentBrief(state)
    + `Approved planning handoff: ${state.planning_handoff && state.planning_provenance ? state.planning_handoff : 'NONE. Do not describe generated proposals as a verified handoff.'}\n`
    + `Repository baseline: ${state.base_commit_sha || 'unknown'}; observe facts with file/test references.\n`
    + (state.technical_design_policy_version === 1
      ? `Delegated technical proposal, revision ${state.plan_revision ?? 0} (not product/permission authority or human approval; ordinary implementation choices are allowed within the brief):\n${state.plan || '(none)'}`
      : `Previous generated proposal, revision ${state.plan_revision ?? 0} (not authority):\n${state.plan || '(none)'}`);
}
export function decisionRequest(state: DecisionState) {
  const findings = effectiveFindings(state);
  const blockedAuthority = findings.some(f => f.kind === 'authorization' || f.kind === 'scope');
  const newPolicy = state.technical_design_policy_version === 1;
  const validProduct = (f: DevelopmentFinding) => f.kind === 'requirement' && (!newPolicy
    || (['requirement', 'approved_plan'].includes(f.source) && f.evidence.length > 0 && Boolean(f.question)));
  const hasTechnical = newPolicy && findings.some(f => f.kind !== 'environment' && !validProduct(f));
  const kind = blockedAuthority ? 'scope' : hasTechnical ? 'technical_review' : findings.some(f => f.kind === 'environment') ? 'environment'
    : findings.every(validProduct) && findings.length ? 'requirement' : 'technical_review';
  const technicalBlocked = newPolicy && kind === 'technical_review';
  const responseFailure = technicalBlocked ? state.technical_response_failure : null;
  const questions = findings.map((f, index) => ({ id: `q${index + 1}`, question: f.question || f.summary,
    detail: f.summary, evidence: f.evidence, options: f.options ?? [], recommendedOptionId: f.recommendedOptionId ?? null }));
  const basis = { version: 2 as const, kind, canClarify: !blockedAuthority && !technicalBlocked, questions,
    ...(newPolicy ? { technicalPolicyVersion: 1, investigationCount: state.technical_investigation_count ?? 0 } : {}),
    ...(responseFailure ? { responseFailure } : {}),
    planRevision: state.plan_revision ?? 0, issueSha256: state.issue_snapshot?.sha256 ?? null,
    baseCommitSha: state.base_commit_sha ?? null, priorAnswers: state.operator_clarifications?.length ?? 0,
    round: state.design_refinement_count ?? 0, planDigest: digest(state.plan ?? '') };
  return { ...basis, id: digest(basis), title: blockedAuthority ? 'Scope or access decision required'
    : kind === 'environment' ? 'Operator repair needed' : kind === 'requirement' ? 'Product decision needed'
      : responseFailure ? `Agent response ${responseFailure.category} error`
        : technicalBlocked ? 'Technical work blocked' : 'Technical review needed' };
}
export type DevelopmentDecision = ReturnType<typeof decisionRequest>;
const replySchema = z.object({ decisionId: z.string().regex(/^[a-f0-9]{64}$/),
  requirements: z.string().trim().max(12_000), answers: z.record(z.string().max(40)).optional() }).strict();
export function validateDecisionReply(reply: unknown, decision: DevelopmentDecision): string {
  const value = replySchema.parse(reply);
  if (value.decisionId !== decision.id) throw new Error('This decision changed. Reload the current question.');
  if (!decision.canClarify) throw new Error(decision.kind === 'technical_review'
    ? 'Technical work is blocked. An owner clarification or approval cannot resolve it.'
    : 'Scope and access cannot be changed by clarification. Configure a separately authorized run.');
  const answers = value.answers ?? {};
  if (Object.keys(answers).some(key => !decision.questions.some(q => q.id === key))) throw new Error('Unknown question.');
  const selected = decision.questions.filter(q => answers[q.id] !== undefined).map(q => {
    const choice = q.options.find(o => o.id === answers[q.id]);
    if (!choice) throw new Error('Unknown decision option.');
    return `${q.question}\nSelected: ${choice.label}. ${choice.consequence}`;
  });
  const allAnswered = decision.kind === 'requirement' && decision.questions.length > 0 && selected.length === decision.questions.length;
  if (!allAnswered && (!value.requirements || /^(yes|ja|ok|okay|approve|approved|weiter)[.!\s]*$/i.test(value.requirements))) {
    throw new Error('Answer the questions or describe the technical resolution; a generic approval does not answer them.');
  }
  const text = [...selected, value.requirements].filter(Boolean).join('\n\n');
  if (text.length > 12_000) throw new Error('The combined decision response exceeds 12000 characters.');
  return text;
}
