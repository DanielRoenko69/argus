import { useState } from 'react';
import type { CodingThreadSummary } from '../types';

export type DevelopmentDecision = {
  version: 2; id: string; title: string; kind: 'requirement' | 'environment' | 'scope' | 'technical_review'; canClarify: boolean;
  planRevision: number; round: number;
  technicalPolicyVersion?: number; investigationCount?: number;
  responseFailure?: { phase: 'planner' | 'qa'; category: 'format' | 'integrity'; diagnostics: string[] };
  questions: Array<{ id: string; question: string; detail: string; evidence: string[];
    options: Array<{ id: string; label: string; consequence: string }>; recommendedOptionId: string | null }>;
};
export type DecisionReply = { requirements: string; decisionId: string; answers: Record<string, string> };

/** Reject unsupported/malformed payloads rather than offering a legacy approval. */
export function readDevelopmentDecision(value: unknown): DevelopmentDecision | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as DevelopmentDecision;
  if (d.version !== 2 || typeof d.id !== 'string' || !/^[a-f0-9]{64}$/.test(d.id) || typeof d.title !== 'string'
    || !['requirement', 'environment', 'scope', 'technical_review'].includes(d.kind) || typeof d.canClarify !== 'boolean'
    || !Array.isArray(d.questions) || !d.questions.length || d.questions.length > 12
    || !d.questions.every(q => typeof q?.id === 'string' && typeof q.question === 'string' && typeof q.detail === 'string'
      && Array.isArray(q.evidence) && q.evidence.every(e => typeof e === 'string') && Array.isArray(q.options)
      && q.options.every(o => typeof o?.id === 'string' && typeof o.label === 'string' && typeof o.consequence === 'string'))) return null;
  if (d.responseFailure !== undefined && (!d.responseFailure || d.kind !== 'technical_review' || d.canClarify
    || !['planner', 'qa'].includes(d.responseFailure.phase) || !['format', 'integrity'].includes(d.responseFailure.category)
    || !Array.isArray(d.responseFailure.diagnostics) || d.responseFailure.diagnostics.length > 6
    || !d.responseFailure.diagnostics.every(item => typeof item === 'string' && item.length <= 2000))) return null;
  return d;
}

export function developmentInputLabel(thread: CodingThreadSummary): string | null {
  if (thread.status !== 'interrupted') return null;
  const interrupt = thread.interrupts?.find(item => item.value?.['stage'] === 'requirements_input');
  if (!interrupt && !thread.next?.includes('requirements_input')) return null;
  const decision = readDevelopmentDecision(interrupt?.value?.['decision']);
  return decision?.title ?? 'Clarification needed';
}

export function isTechnicalWorkBlocked(thread: CodingThreadSummary): boolean {
  return thread.status === 'interrupted' && Boolean(thread.interrupts?.some(item => {
    const decision = readDevelopmentDecision(item.value?.['decision']);
    return decision?.kind === 'technical_review' && !decision.canClarify;
  }));
}

export function DevelopmentDecisionCard({ decision, pending, error, onSubmit }: {
  decision: DevelopmentDecision; pending: boolean; error?: string; onSubmit: (reply: DecisionReply) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [text, setText] = useState('');
  const canClarify = decision.canClarify && decision.kind !== 'scope';
  const technicalBlocked = decision.kind === 'technical_review' && !canClarify;
  const responseFailure = technicalBlocked ? decision.responseFailure : undefined;
  const allAnswered = decision.kind === 'requirement' && decision.questions.every(q => answers[q.id]);
  const meaningfulText = text.trim() && !/^(yes|ja|ok|okay|approve|approved|weiter)[.!\s]*$/i.test(text.trim());
  return <section className="solution-approval-gate solution-agent-approval" aria-label={decision.title}>
    <div><span><small>{responseFailure ? 'AGENT RESPONSE ERROR — NO USER INPUT REQUIRED' : technicalBlocked ? 'TECHNICALLY BLOCKED — NO PRODUCT DECISION REQUIRED' : 'INPUT REQUIRED — NOT AN APPROVAL'}</small><b>{decision.title}</b>
      <p>{decision.kind === 'requirement' ? 'Choose the intended behavior. The agents remain responsible for implementation details.'
        : decision.kind === 'environment' ? 'An operator needs to repair the environment. Describe what was repaired before re-evaluation.'
          : decision.kind === 'scope' ? 'Clarification cannot grant access or expand file scope. Cancel and configure a separately authorized run.'
            : responseFailure ? 'Argus could not validate the agent response. This is a response-processing problem, not a technical question for you or an implementation verdict. Your checkpoint is saved. No implementation was started. An operator must inspect the diagnostics; this stop cannot be resolved by an answer or approval.'
              : technicalBlocked ? 'Argus could not establish sufficient technical evidence. Your checkpoint is saved. You do not need to supply implementation details or approve an uncertain result. A technical review is required before this work can continue; team assignment is not available yet.'
              : 'The agents could not safely resolve this technical conflict. An engineer must review the evidence; a generic approval cannot resolve it.'}</p>
      <p>Bundles, allowed paths and human code/PR approvals remain unchanged. Internal design corrections: {decision.round ?? 0}/2.</p>
      {decision.technicalPolicyVersion === 1 && <p>Additional technical investigations: {decision.investigationCount ?? 0}/1. No automatic retry after this stop.</p>}
    </span></div>
    {technicalBlocked ? <details><summary>{responseFailure ? 'Response validation diagnostics' : 'Technical findings and evidence'}</summary>
      {decision.questions.map(q => <article key={q.id}><h4>{q.question}</h4><p>{q.detail}</p>
        <ul>{q.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></article>)}
    </details> : <>
    {decision.questions.map(q => <fieldset className="solution-decision-question" key={q.id} disabled={pending || !canClarify}>
      <legend>{q.question}</legend>
      {q.options.map(option => <label className="solution-decision-option" key={option.id}>
        <input type="radio" name={`${decision.id}-${q.id}`} value={option.id} checked={answers[q.id] === option.id}
          onChange={() => setAnswers(previous => ({ ...previous, [q.id]: option.id }))} />
        <span><b>{option.label}{q.recommendedOptionId === option.id ? ' · Recommended' : ''}</b><small>{option.consequence}</small></span>
      </label>)}
      <details><summary>Technical context and sources</summary><p>{q.detail}</p><ul>{q.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul></details>
    </fieldset>)}
    </>}
    {canClarify && <><label className="editor-field"><span>{decision.kind === 'requirement' ? 'Additional clarification / alternative answer' : 'Resolution and supporting evidence'}</span>
      <textarea rows={4} maxLength={12000} value={text} disabled={pending} onChange={event => setText(event.target.value)} /></label>
      <footer><button type="button" className="button button-primary" disabled={pending || (!allAnswered && !meaningfulText)}
        onClick={() => onSubmit({ decisionId: decision.id, requirements: text.trim(), answers })}>Submit answer & re-evaluate</button></footer></>}
    <small>{technicalBlocked ? 'Checkpoint' : 'Question'} version {decision.id.slice(0, 12)} · plan revision {decision.planRevision ?? 0}.{!technicalBlocked && ' No option is selected automatically.'}</small>
    {error && <div className="editor-error" role="alert">{error}</div>}
  </section>;
}
