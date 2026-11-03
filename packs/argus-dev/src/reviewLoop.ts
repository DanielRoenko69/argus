import { z } from 'zod';

const text = z.string().trim().min(1);

export const ReviewDecisionSchema = z.object({
  verdict: z.enum(['APPROVE', 'REQUEST_CHANGES']),
  summary: text,
  findings: z.array(z.object({
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    message: text,
    file: z.string().trim().optional(),
    line: z.number().int().positive().optional(),
  }).passthrough()).default([]),
  required_changes: z.array(text).default([]),
}).passthrough().superRefine((decision, context) => {
  if (decision.verdict === 'APPROVE') {
    if (decision.required_changes.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['required_changes'],
        message: 'APPROVE cannot contain required changes',
      });
    }
    if (decision.findings.some(finding => finding.severity === 'critical' || finding.severity === 'high')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['findings'],
        message: 'APPROVE cannot contain critical or high findings',
      });
    }
  } else if (decision.required_changes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['required_changes'],
      message: 'REQUEST_CHANGES requires at least one concrete change',
    });
  }
});

export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export interface ReviewCycleContext {
  attempt: number;
  priorReviews: Array<{
    verdict: 'APPROVE' | 'REQUEST_CHANGES';
    summary: string;
    requiredChanges: string[];
  }>;
}

export function buildReviewAcceptanceContext(
  ticketDescription: string,
  implementationPlan: string,
  cycle?: ReviewCycleContext,
): string {
  const ticket = ticketDescription.trim() || 'No ticket description was provided.';
  const plan = implementationPlan.trim() || 'No implementation plan was published.';
  const attempt = Math.max(1, Math.trunc(cycle?.attempt ?? 1));
  const priorReviews = cycle?.priorReviews ?? [];
  const priorRejections = priorReviews.filter(review => review.verdict === 'REQUEST_CHANGES');
  const priorReviewEvidence = priorReviews.length > 0
    ? priorReviews.map((review, index) => {
        const changes = review.requiredChanges.length > 0
          ? ` Required changes: ${review.requiredChanges.join('; ')}`
          : '';
        return `- Attempt ${index + 1}: ${review.verdict} — ${review.summary}${changes}`;
      }).join('\n')
    : '- None. This is the first review attempt.';
  return [
    'Authoritative ticket acceptance criteria:',
    ticket,
    '',
    'Implementation plan (supporting evidence only):',
    plan,
    '',
    'Review lifecycle evidence:',
    `- Current implementation attempt: ${attempt}`,
    `- Prior reviewer rejections: ${priorRejections.length}`,
    priorReviewEvidence,
    '',
    'Treat lifecycle evidence as authoritative for attempt-relative criteria. A ticket requirement to reject, revise, or treat the initial/first implementation as a draft is already satisfied after a persisted prior REQUEST_CHANGES decision. Do not repeat a process-only rejection on a later attempt. Instead, verify whether the current diff resolves prior required changes that are supported by the ticket and whether all final acceptance criteria now pass.',
    '',
    'The ticket is the source of truth. The plan may sequence work, but it cannot weaken, postpone, replace, or add final acceptance criteria. A tool, command, runtime version, environment, or validation mode mentioned only by the plan is advisory and must not block approval. Judge the supplied deterministic test evidence against the ticket. Do not perpetuate a prior rejection whose requirement is unsupported by the ticket. If a staged validation leaves the ticket-requested final state incomplete, request the remaining changes.',
    '',
    'QA test design is supporting evidence, not authority to invent additional requirements. Relate each blocking finding to a ticket requirement, regression or concrete safety risk. Review the entire current diff and all acceptance cases in each pass; report every known blocking finding together, not one new criterion per revision. On later passes distinguish unresolved prior findings from genuinely new regressions or newly discovered defects. Do not request unrelated warning cleanup or cosmetic changes as a prerequisite for acceptance.',
  ].join('\n');
}

export const REVIEW_OUTPUT_INSTRUCTION = `Return exactly one JSON object and no Markdown:
{"verdict":"APPROVE|REQUEST_CHANGES","summary":"...","findings":[{"severity":"critical|high|medium|low|info","message":"...","file":"optional","line":1}],"required_changes":["..."]}`;

function candidates(output: string): string[] {
  const trimmed = output.trim();
  const values = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) values.push(match[1].trim());
  }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) values.push(trimmed.slice(firstBrace, lastBrace + 1));
  return [...new Set(values)];
}

export function parseReviewDecision(output: string): ReviewDecision {
  let lastError = 'response does not contain a JSON object';
  for (const candidate of candidates(output)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const result = ReviewDecisionSchema.safeParse(parsed);
    if (result.success) return result.data;
    lastError = result.error.issues.slice(0, 6)
      .map(issue => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
  }
  throw new Error(lastError);
}

export function formatReviewDecision(decision: ReviewDecision): string {
  const findings = decision.findings.map(finding => {
    const location = finding.file
      ? ` (${finding.file}${finding.line ? `:${finding.line}` : ''})`
      : '';
    return `- [${finding.severity}]${location} ${finding.message}`;
  });
  const changes = decision.required_changes.map(change => `- ${change}`);
  return [
    `VERDICT: ${decision.verdict === 'APPROVE' ? 'APPROVED' : 'REJECTED'}`,
    decision.summary,
    ...(findings.length ? ['', 'Findings:', ...findings] : []),
    ...(changes.length ? ['', 'Required changes:', ...changes] : []),
  ].join('\n');
}

export function canRequestAnotherRevision(retryCount: number, maxRetries: number): boolean {
  return Number.isFinite(retryCount) && Number.isFinite(maxRetries) && retryCount < maxRetries;
}

export function normalizeRevisionFeedback(
  approved: boolean,
  feedback: unknown,
  fallback: string,
): string {
  if (approved) return '';
  return normalizeDecisionEvidence(feedback, fallback);
}

/** Preserve a human rationale as audit evidence without turning it into retry input. */
export function normalizeDecisionEvidence(feedback: unknown, fallback = ''): string {
  const normalized = typeof feedback === 'string' ? feedback.trim() : '';
  return normalized || fallback;
}
