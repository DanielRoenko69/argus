import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { continueCodingCheckpoint, getCodingCheckpointRetry } from '../api';

const labels: Record<string, string> = { planner: 'Plan', knowledge: 'Knowledge', test_design: 'QA design', coder: 'Coder', tests: 'Tests', reviewer: 'Review', code_generation: 'Generated-file import' };

/** Mounted per thread: a stale preview can never be submitted for another run. */
export function CheckpointRetryActions({ threadId, canConfigure, configure, onContinued, recoveryOnly = false }: {
  threadId: string; canConfigure: boolean; configure: () => void; onContinued: () => Promise<void>; recoveryOnly?: boolean;
}) {
  const [mode, setMode] = useState<'continue' | 'new'>(recoveryOnly ? 'continue' : 'new');
  const [submitted, setSubmitted] = useState(false);
  const preview = useQuery({ queryKey: ['coding-checkpoint-retry', threadId],
    queryFn: () => getCodingCheckpointRetry(threadId), enabled: mode === 'continue', retry: false, staleTime: 0 });
  const resume = useMutation({ mutationFn: () => {
    const { checkpointId, workspaceDigest } = preview.data ?? {};
    if (!checkpointId || !workspaceDigest || !preview.data?.available) throw new Error('Reload retry options first.');
    return continueCodingCheckpoint(threadId, { checkpointId, workspaceDigest });
  }, onSuccess: async () => { setSubmitted(true); await onContinued(); },
  onError: () => { void preview.refetch(); } });
  const busy = resume.isPending || submitted;
  return <>
    {!recoveryOnly && <fieldset className="solution-retry-choices" disabled={busy}>
      <legend>Choose retry action</legend>
      <label><input type="radio" name={`retry-mode-${threadId}`} checked={mode === 'continue'} onChange={() => { setMode('continue'); resume.reset(); }} />
        <span><strong>Continue from failed step</strong><small>Keep completed steps, the frozen issue, Bundles and existing workspace. No clone/reset; human approvals still apply.</small></span></label>
      <label><input type="radio" name={`retry-mode-${threadId}`} checked={mode === 'new'} onChange={() => { setMode('new'); resume.reset(); }} />
        <span><strong>Reconfigure and start over</strong><small>Change inputs, Bundles or runtime and start the full workflow in a fresh workspace.</small></span></label>
    </fieldset>}
    {mode === 'continue' && <div aria-live="polite">
      {preview.isFetching ? <p>Checking checkpoint, workspace and worker termination…</p>
        : preview.error ? <p role="alert">{preview.error.message}</p>
        : preview.data?.available ? <p>Continue at <strong>{labels[preview.data.node ?? ''] ?? preview.data.node}</strong>. {preview.data.node === 'code_generation'
          ? 'Use the verified saved generator output without repeating generation, planning or Coder. Tests, QA, review and human approvals still follow.'
          : 'Earlier successful steps will not run again. The failed step makes a new model call where needed; partial edits are retained.'}</p>
        : <p>Continuation unavailable: {preview.data?.reason ?? 'No verified checkpoint is available.'}</p>}
      <button type="button" className="button button-secondary" disabled={busy || preview.isFetching} onClick={() => void preview.refetch()}>Check again</button>
    </div>}
    {resume.error && <p role="alert">{resume.error.message} No automatic retry will be sent. Check the run before trying again.</p>}
    <footer>{mode === 'new'
      ? <button className="button button-primary" type="button" disabled={!canConfigure || busy} onClick={configure}>Configure retry</button>
      : <button className="button button-primary" type="button" disabled={busy || preview.isFetching || !preview.data?.available || Boolean(preview.error)} onClick={() => resume.mutate()}>
        {submitted ? 'Continuation queued' : resume.isPending ? 'Continuing…' : 'Continue from checkpoint'}</button>}
    </footer>
  </>;
}
