import { useState } from 'react';
import { Check, Loader2, OctagonX, RotateCw, X } from 'lucide-react';
import type { WorkflowReplay } from '@/api/replay';
import { useCancelWorkflowReplay, useResumeWorkflowReplay } from '@/api/replay';

interface ReplayRunControlsProps {
  workflowId: number;
  replay: WorkflowReplay;
}

export function ReplayRunControls({ workflowId, replay }: ReplayRunControlsProps) {
  const [feedback, setFeedback] = useState('');
  const cancel = useCancelWorkflowReplay(workflowId, replay.traceId);
  const resume = useResumeWorkflowReplay(workflowId, replay.traceId);
  const waitingForApproval = replay.status === 'interrupted' && replay.approval != null;
  const pending = cancel.isPending || resume.isPending;
  const error = cancel.error ?? resume.error;

  if (!waitingForApproval && !replay.canCancel) return null;

  return (
    <section className="builder-replay-controls" aria-label="Visual run controls">
      {waitingForApproval && replay.approval && (
        <>
          <div>
            <span>APPROVAL · {replay.approval.stage}</span>
            <strong>{replay.approval.message}</strong>
          </div>
          <textarea
            aria-label="Approval feedback"
            value={feedback}
            maxLength={4_000}
            placeholder="Optionales Feedback für den nächsten Schritt…"
            onChange={(event) => setFeedback(event.target.value)}
          />
          <button
            type="button"
            className="is-reject"
            disabled={pending}
            onClick={() => resume.mutate({ decision: 'rejected', feedback })}
          >
            {resume.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
            Ablehnen
          </button>
          <button
            type="button"
            className="is-approve"
            disabled={pending}
            onClick={() => resume.mutate({ decision: 'approved', feedback })}
          >
            {resume.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
            Freigeben
          </button>
        </>
      )}
      {replay.canCancel && (
        <button
          type="button"
          className="is-cancel"
          disabled={pending}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <OctagonX className="w-3.5 h-3.5" />}
          Run abbrechen
        </button>
      )}
      {resume.isSuccess && <p className="is-success"><RotateCw className="w-3.5 h-3.5" /> Fortsetzung wurde eingeplant.</p>}
      {cancel.isSuccess && <p className="is-success"><Check className="w-3.5 h-3.5" /> Run wurde abgebrochen.</p>}
      {error && <p className="is-error">{error instanceof Error ? error.message : 'Lifecycle-Aktion fehlgeschlagen'}</p>}
    </section>
  );
}
