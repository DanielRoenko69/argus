type RecordValue = Record<string, unknown>;
const record = (v: unknown): RecordValue | null => v && typeof v === 'object' && !Array.isArray(v) ? v as RecordValue : null;
const text = (v: unknown, max = 2000) => typeof v === 'string' ? v.slice(0, max) : '';
/** Read-only projection. Text is escaped by React, never rendered as HTML. */
export function TechnicalExperimentEvidence({ evidence }: { evidence: unknown }) {
  const e = record(evidence), request = record(e?.request), result = record(e?.result);
  if (e?.attemptCount !== 1 || !request || !text(request.purpose) || !text(request.script)) return null;
  const preparationFailed = result?.status === 'preparation_failed' && result.executionStarted === false;
  const status = preparationFailed ? 'preparation blocked — not executed' : ['completed', 'failed', 'timeout', 'output_limit', 'canceled'].includes(String(result?.status)) ? String(result!.status) : 'no terminal receipt';
  const limits = record(result?.limits);
  return <details className="solution-approval-context" aria-label="Technical experiment evidence">
    <summary>Technical experiment · {status} · 1/1 attempt</summary>
    <p>Optional measurement within the existing Planner investigation — not a new agent, QA acceptance or human approval.</p>
    <p>{text(request.purpose)}</p>
    <dl><dt>Hypothesis</dt><dd>{text(request.hypothesis)}</dd><dt>Protocol</dt><dd>{text(request.protocol)}</dd>
      <dt>Interpretation and limitations proposed before execution</dt><dd>{text(request.interpretation)}</dd></dl>
    <details><summary>Python source (untrusted)</summary><pre>{text(request.script, 24000)}</pre></details>
    {preparationFailed ? <>
      <p>The Python script did not start. Snapshot preparation exceeded a configured limit; this is not a failed measurement or a question about product requirements.</p>
      {text(result.filePath, 400) && <p>File: {text(result.filePath, 400)}</p>}
      <p>{result.reason === 'snapshot_file_count_limit'
        ? `${Number(result.actual)} files / ${Number(result.limit)} allowed`
        : `${(Number(result.actual) / 1048576).toFixed(2)} MiB / ${(Number(result.limit) / 1048576).toFixed(2)} MiB allowed (${result.reason === 'snapshot_file_size_limit' ? 'per file' : 'total'})`}</p>
      <p>An operator must review the server-owned limits. No automatic retry, limit increase or approval is granted here.</p>
    </> : result ? <>
      <p>Read-only snapshot · network disabled · {text(result.pythonVersion)} · {Number(result.durationMs) || 0} ms</p>
      <p>Limits: 30 s wall / 20 s CPU · 512 MiB · 32 KiB output</p>
      {limits && <p>Snapshot limits: {Number(limits.snapshotFileBytes ?? 2097152) / 1048576} MiB per file / {Number(limits.snapshotBytes) / 1048576} MiB total</p>}
      <pre>{text(result.stdout, 32768) || '(no stdout)'}</pre>
      {text(result.stderr) && <pre>{text(result.stderr, 32768)}</pre>}
      <small>Commit: {text(result.baseCommitSha, 40)}<br />Snapshot SHA-256: {text(result.snapshotSha256, 64)}<br />
        Output SHA-256: {text(result.outputSha256, 64)}</small>
    </> : <p>The attempt is reserved. Without a terminal receipt, its outcome is unknown; it must not be automatically replayed.</p>}
    <p>Printed output is untrusted evidence. QA must independently assess the reference, measured cases and limitations.</p>
    <small>Script SHA-256: {text(request.scriptSha256, 64)}<br />Request SHA-256: {text(request.requestSha256, 64)}<br />
      Planner trace: {text(request.proposalTraceId, 36)}</small>
  </details>;
}
