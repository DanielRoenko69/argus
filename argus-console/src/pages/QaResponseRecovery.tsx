import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { recheckCodingQaResponse, continueCodingQaResponse, previewCodingQaRetry, retryCodingQa } from '../api';

/** Recheck is read-only. Continuation is a second, explicit, hash-bound action. */
export function QaResponseRecovery({ threadId, onContinued, allowFreshRetry = true, failureCategory = 'format' }: {
  threadId: string; onContinued: () => Promise<void>; allowFreshRetry?: boolean; failureCategory?: 'format' | 'integrity';
}) {
  const omission = failureCategory === 'integrity';
  const [submitted, setSubmitted] = useState(false);
  const preview = useMutation({ mutationFn: async (mode: 'recheck' | 'retry') => ({
    ...await (mode === 'retry' ? previewCodingQaRetry : recheckCodingQaResponse)(threadId), mode,
  }), retry: false });
  const resume = useMutation({ mutationFn: () => {
    const { checkpointId, workspaceDigest, reviewDigest } = preview.data ?? {};
    if (!preview.data?.available || !checkpointId || !workspaceDigest || !reviewDigest) throw new Error('Recheck the saved QA response first.');
    if (omission && preview.data.retryKind !== 'missing_reviews') throw new Error('A verified missing-review correction preview is required.');
    return (preview.data.mode === 'retry' ? retryCodingQa : continueCodingQaResponse)(threadId, { checkpointId, workspaceDigest, reviewDigest });
  }, retry: false, onSuccess: async () => { setSubmitted(true); await onContinued(); },
    onError: () => { preview.reset(); } });
  const busy = submitted || preview.isPending || resume.isPending;
  return <section className="solution-approval-gate" aria-label="Saved QA response recovery">
    <h3>{omission ? 'Check for missing QA reviews' : 'Recover QA format stop'}</h3>
    {omission ? <p>Check whether only decision reviews are missing from an otherwise valid saved answer. Other integrity errors cannot be repaired here. This preview makes no model call and grants no approval.</p>
      : <p>Check the saved response without a model call.{allowFreshRetry && ' Alternatively, prepare a fresh independent QA call with the existing plan and Knowledge.'} Neither preview starts execution or grants approval.</p>}
    {!omission && !allowFreshRetry && <p>Independent executable QA is enabled. Only a validated saved response before implementation can continue here; a fresh QA retry and later checkpoint replay remain unavailable.</p>}
    {!omission && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { resume.reset(); preview.reset(); preview.mutate('recheck'); }}>
      {preview.isPending && preview.variables === 'recheck' ? 'Rechecking…' : 'Recheck QA response'}</button>}
    {(omission || allowFreshRetry) && <button type="button" className="button button-secondary" disabled={busy} onClick={() => { resume.reset(); preview.reset(); preview.mutate('retry'); }}>
      {preview.isPending && preview.variables === 'retry' ? 'Checking retry…' : omission ? 'Check targeted QA correction' : 'Prepare QA retry'}</button>}
    <div aria-live="polite">
      {preview.error && <p role="alert">{preview.error.message}</p>}
      {preview.data && !preview.data.available && <p>Cannot continue: {preview.data.reason}</p>}
      {preview.data?.available && preview.data.mode === 'recheck' && <>
        <p>The full response schema and decision references now validate. {preview.data.repairCount ?? 0} bounded format correction(s) recorded; test content and verdicts unchanged. This is not proof of scientific correctness.</p>
        <details className="solution-approval-context"><summary>Recovered independent QA test design</summary><pre>{preview.data.testPlan}</pre></details>
        {preview.data.sourceTraceId && <a href={`/runs/agent/${encodeURIComponent(preview.data.sourceTraceId)}`}>Original QA trace</a>}
        <p>Continue at Coder using the saved plan and tests. Planning, Knowledge, investigation and QA will not run again. Coder and later stages can incur model usage. Human code and PR approvals remain required.</p>
        <button type="button" className="button button-primary" disabled={busy} onClick={() => resume.mutate()}>
          {submitted ? 'Continuation queued' : resume.isPending ? 'Continuing…' : 'Continue with saved QA at Coder'}</button>
      </>}
      {preview.data?.available && preview.data.mode === 'retry' && omission && preview.data.retryKind !== 'missing_reviews' && <p role="alert">This preview does not authorize a missing-review correction. Reload the run.</p>}
      {preview.data?.available && preview.data.mode === 'retry' && (!omission || preview.data.retryKind === 'missing_reviews') && <>
        <p>Start again at QA test design. The frozen plan, Knowledge, repository, Bundles and consumed design budgets remain unchanged. The rejected response stays in its original checkpoint.</p>
        {preview.data.retryKind === 'missing_reviews' && <p>One correction attempt only. Existing reviews and test cases must remain unchanged. QA independently assesses the missing decisions: {(preview.data.missingDecisionIds ?? []).join(', ')}. A justified rejection is allowed; no decision is automatically accepted.</p>}
        <p>This makes a new model call and consumes usage. Technical findings can still lead to normal design corrections or a stop; this does not force a pass. Code and PR approvals remain required.</p>
        {preview.data.sourceTraceId && <a href={`/runs/agent/${encodeURIComponent(preview.data.sourceTraceId)}`}>Previous QA trace</a>}
        <button type="button" className="button button-primary" disabled={busy} onClick={() => resume.mutate()}>
          {submitted ? 'QA retry queued' : resume.isPending ? 'Starting QA…' : preview.data.retryKind === 'missing_reviews' ? 'Run one QA correction — keep tests & reviews' : 'Run QA again — keep plan & Knowledge'}</button>
      </>}
      {resume.error && <p role="alert">{resume.error.message} No automatic retry was sent. Check the run before trying again.</p>}
    </div>
  </section>;
}
