import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { downloadEvaluationComparison } from '../api';

export function EvaluationExportButtons({ id,complete }:{ id:number;complete:boolean }) {
  // A network retry uses the same key. Each format is its own audit operation.
  const [keys]=useState(() => ({ json:crypto.randomUUID(),csv:crypto.randomUUID(),pdf:crypto.randomUUID() }));
  const download=useMutation({ mutationFn:async(format:'json'|'csv'|'pdf') => {
    const artifact=await downloadEvaluationComparison(id,format,keys[format]);
    const url=URL.createObjectURL(artifact.blob),anchor=document.createElement('a');
    anchor.href=url; anchor.download=artifact.filename; document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url),10000);
  } });
  const needsMfa=(download.error as { code?:string } | null)?.code==='MFA_STEP_UP_REQUIRED';
  return <section aria-label="Comparison exports" className="evaluation-export-controls">
    <div className="panel-heading"><h4>Export comparison</h4><div className="evaluation-export-actions">
      {(['pdf','json','csv'] as const).map(format => <button key={format} className="button button-secondary" disabled={!complete || download.isPending}
        onClick={() => download.mutate(format)}>Download {format.toUpperCase()}</button>)}
    </div></div>
    <p>{complete ? 'PDF: readable A/B report with results, measurement gaps and provenance. JSON: full redacted evidence. CSV: every recorded attempt. No new model calls. Fresh SSO MFA is required; each export is audited.' : 'Exports unlock after all planned experiments have completed, including failed quality assertions.'}</p>
    <small>Result export, not a Compliance Report or certification. Unknown costs remain unknown. Hash verification does not provide a signature or WORM storage.</small>
    {download.isPending && <p role="status">Preparing and verifying export…</p>}
    {download.isSuccess && <p role="status">Export verified; download requested.</p>}
    {download.error && <p role="alert">{download.error.message}</p>}
    {needsMfa && <a className="button button-secondary" href={`/auth/oidc/step-up?returnTo=${encodeURIComponent(`/build/evaluations?comparison=${id}`)}`}>Confirm MFA and return to comparison</a>}
  </section>;
}
