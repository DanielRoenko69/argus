const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const text = (v: unknown, limit = 2000) => typeof v === 'string' ? v.slice(0, limit) : '';
function StackExecutionDetails({ receipt }: { receipt: Record<string, unknown> | null }) {
  const env = record(receipt?.stackEnvironment), capture = record(env?.outputCapture);
  if (!env) return null;
  return <div>
    <p>Execution: {text(env.executionStatus) || text(receipt?.status)} · Phase: {text(env.phase)} · Exit: {typeof receipt?.exitCode === 'number' ? receipt.exitCode : 'unknown'}</p>
    {env.testStarted === false && <p>Service startup stopped before tests began. This is environment evidence, not a failed application assertion.</p>}
    {(capture?.stdoutTruncated === true || capture?.stderrTruncated === true) && <p>Log excerpt shortened; not the complete output. stdout: {Number(capture.stdoutBytes) || 0} bytes · stderr: {Number(capture.stderrBytes) || 0} bytes.</p>}
    {env.executionStatus === 'output_limit' && <p>Execution stopped at the output/protocol safety limit. This is not evidence of a missing dependency or out-of-memory.</p>}
  </div>;
}
/** Evidence, not an approval control. Render all agent/test text escaped. */
export function QaAcceptanceEvidence({ evidence }: { evidence: unknown }) {
  const e = record(evidence), artifact = record(e?.artifact), receipt = record(e?.receipt);
  const history = Array.isArray(e?.history) ? e.history : [];
  const latestPlan = [...history].reverse().map(record).find(h => h?.phase === 'environment_preflight');
  const environment = record(receipt?.environment), plan = record(environment?.plan) ?? record(latestPlan?.plan);
  const workspaceSession = e?.environmentPolicyVersion === 3;
  const generalStack = e?.environmentPolicyVersion === 2 || workspaceSession;
  const stackPlan = record(e?.stackPlan), stackResult = record(e?.stackResult), stackEnvironment = record(stackResult?.stackEnvironment);
  const stackRepairPolicy = record(e?.stackRepairPolicy);
  const stackRepairLimit = Number.isSafeInteger(stackRepairPolicy?.maxRepairs) && Number(stackRepairPolicy?.maxRepairs) > 0 ? Number(stackRepairPolicy?.maxRepairs) : 2;
  const generation = record(e?.codeGeneration), generationDecision = record(generation?.decision), generationReceipt = record(generation?.receipt);
  const generationPlan = record(generationDecision?.plan);
  const generationFailure = record([...history].reverse().map(record).find(h => h?.phase === 'code_generation_rejected')?.evidence);
  if (e?.policyVersion !== 1) return null;
  const passed = receipt?.passed === true && receipt.status === 'completed' && receipt.exitCode === 0 && Number(receipt.collected) > 0;
  const status = passed ? 'Passed on recorded source' : receipt ? 'Not passed' : plan?.status === 'blocked' ? 'Environment blocked' : artifact?.status === 'blocked' ? 'Blocked' : 'Pending';
  const files = Array.isArray(artifact?.files) ? artifact.files.slice(0, 12).map(record).filter(Boolean) : [];
  return <details className="solution-approval-context" aria-label="Independent QA acceptance">
    <summary>Independent QA acceptance · {status}</summary>
    <p>Additional Python tests authored separately from the Coder. Not complete coverage or human approval. Argus rechecks the source binding before delivery.</p>
    <p>{generalStack ? 'Disposable source copy · local subprocesses/services permitted · offline tests · 10 min / 2 CPUs / 4 GiB · no host mounts, Docker socket or Argus credentials.' : 'Read-only source snapshot · no network or subprocesses · 30 s wall / 20 s CPU · 512 MiB.'}</p>
    {generalStack && <details aria-label="Automatic stack environment"><summary>Automatic stack environment · {stackResult?.passed === true ? 'Repository tests passed' : stackResult ? 'Not passed' : 'Pending'}</summary>
      <p>The existing agent selects and installs the required runtimes, tools, libraries and local test services in an isolated container. Installation is not an approval or evidence of passing tests.</p>
      {workspaceSession && <p>Run-private workspace reused across corrections. No test-image build or snapshot. Source is refreshed and processes stop between phases; tests establish their own fixtures. This is not a pristine filesystem rollback.</p>}
      <p>{text(stackPlan?.summary)} · Environment repairs: {Number(e?.stackRepairs) || 0} / {stackRepairLimit}. Frozen QA tests are retained.</p>
      {stackRepairPolicy?.policyVersion === 1 && <p>Repair-start window: {Number(stackRepairPolicy.windowMinutes)} minutes from the first repair reservation. Running calls retain their existing deadlines; failed recipes are checked before reuse. This does not retry failed assertions.</p>}
      {stackRepairPolicy?.policyVersion === 1 && Boolean(stackRepairPolicy.deadlineAt) && <small>No new repair calls after: {text(stackRepairPolicy.deadlineAt, 40)}</small>}
      {stackPlan && <details><summary>Environment recipe</summary><pre>{text(stackPlan.setup, 24000)}</pre><pre>{text(stackPlan.start, 24000)}</pre><pre>{text(stackPlan.test, 24000)}</pre></details>}
      <StackExecutionDetails receipt={stackResult} />
      {stackResult && <details><summary>Repository test / setup output (untrusted)</summary><pre>{text(stackResult.stdout, 32768)}</pre><pre>{text(stackResult.stderr, 32768)}</pre></details>}
      <small>{workspaceSession ? <>Workspace session: {text(stackEnvironment?.sessionId, 64)}<br />Prepared execution: {text(stackEnvironment?.preparedSession, 64)}</> : <>Prepared image: {text(stackEnvironment?.preparedImage, 71)}</>}<br />Plan SHA-256: {text(stackEnvironment?.planSha256, 64)}</small>
      {record(stackEnvironment?.workspaceDatabase)?.engine === 'postgresql' && <p>Run-private PostgreSQL {String(record(stackEnvironment?.workspaceDatabase)?.serverMajor)} · fresh database before each phase · access revoked after execution.</p>}
    </details>}
    {artifact && <p>{text(artifact.summary)}</p>}
    {generation?.policyVersion === 1 && <details aria-label="Isolated code generation"><summary>Code generation · {generationReceipt?.applied === true ? 'Outputs imported; not an approval' : generationDecision?.status === 'not_needed' ? 'Not required' : 'Pending or blocked'}</summary>
      <p>{text(generationPlan?.summary) || text(generationDecision?.summary)}</p>
      <p>Tools are installed in {workspaceSession ? 'the run-private reusable workspace' : 'a disposable environment'}. Only the declared generated files can be imported. Tests, review and human approvals still follow.</p>
      {generation.repairPolicyVersion === 1 && <p>Generator recipe corrections: {Number(generation.repairs) || 0} / 2. Source, exact output paths and QA expectations are retained. No replay after uncertain execution.</p>}
      {generationFailure && <details><summary>{generationReceipt?.applied === true ? 'Prior generator failure output (untrusted)' : 'Generator failure output (untrusted)'}</summary><p>{text(generationFailure.phase)} · {text(generationFailure.status)}</p><pre>{text(generationFailure.stdout, 32768)}</pre><pre>{text(generationFailure.stderr, 32768)}</pre></details>}
      {generationPlan && <details><summary>Generator recipe</summary><pre>{text(generationPlan.setup, 24000)}</pre><pre>{text(generationPlan.start, 24000)}</pre><pre>{text(generationPlan.generate, 24000)}</pre></details>}
      {Array.isArray(generationPlan?.outputPaths) && <ul>{generationPlan.outputPaths.slice(0, 64).map((p, i) => <li key={i}>{text(p, 240)}</li>)}</ul>}
      {generationReceipt && <small>Source before: {text(generationReceipt.sourceSha256, 64)}<br />Source after: {text(generationReceipt.resultSourceSha256, 64)}<br />Recipe SHA-256: {text(generationReceipt.planSha256, 64)}</small>}
    </details>}
    {Array.isArray(artifact?.blockers) && artifact.blockers.map((b, i) => <p key={i}>{text(b)}</p>)}
    {plan && <details aria-label="Project test environment"><summary>Project test environment · {environment?.status === 'ready' ? 'Prepared' : environment?.status === 'blocked' || plan.status === 'blocked' ? 'Blocked' : 'Profile reviewed; not yet installed'}</summary>
      <p>Profile: {text(plan?.profileId, 64) || 'No matching profile'} · Runtime: {text(plan?.runtime, 128)}</p>
      <p>{plan.profileId === 'python-public-wheels-v1' ? 'Dependencies resolved under the public-PyPI wheel policy and locked for this run.' : 'Operator-reviewed packages.'} Isolated offline installation, then read-only test execution. No repository or shared-environment changes.</p>
      {Array.isArray(e.environmentRequirements) && e.environmentRequirements.length > 0 && <ul>{e.environmentRequirements.slice(0, 12).map(record).filter(Boolean).map((r, i) => <li key={i}>{text(r!.requirement, 256)} — {text(r!.reason, 1000)}</li>)}</ul>}
      {Number(e.environmentRepairs) > 0 && <p>Dependency repair: {Number(e.environmentRepairs)} / 1. Original QA test artifacts remain frozen.</p>}
      {Boolean(environment?.reason) && <p role="status">Preparation stopped: {text(environment?.reason, 128)}. Independent tests were not started.</p>}
      {!environment && Array.isArray(plan.reasons) && plan.reasons.length > 0 && <p>Profile preflight: {plan.reasons.map(r => text(r, 128)).join(', ')}. No installation has been performed.</p>}
      {Array.isArray(environment?.packages) && <ul>{environment.packages.slice(0, 128).map(record).filter(Boolean).map((p, i) =>
        <li key={i}>{text(p!.name, 128)} · {text(p!.version, 64)}</li>)}</ul>}
      <small>Plan SHA-256: {text(plan?.planSha256, 64)}<br />Manifest SHA-256: {text(plan?.manifestSha256, 64)}</small>
      {record(environment?.resolution) && <small>Resolution lock SHA-256: {text(record(environment?.resolution)?.lockSha256, 64)}</small>}
    </details>}
    {files.map(f => <details key={text(f!.id)}><summary>QA test: {text(f!.id)}</summary>
      <p>Expected: {text(f!.expected)}</p><p>Reference: {text(f!.oracle)}</p>
      <p>QA cases: {Array.isArray(f!.qaCaseIds) ? f!.qaCaseIds.map(id => text(id, 64)).join(', ') : ''}</p>
      <pre>{text(f!.content, 16000)}</pre></details>)}
    {receipt && <><p>{Number(receipt.collected) || 0} collected tests · {Number(receipt.durationMs) || 0} ms · {text(receipt.status)}</p>
      <StackExecutionDetails receipt={receipt} />
      <details><summary>Execution output (untrusted)</summary><pre>{text(receipt.stdout, 32768)}</pre><pre>{text(receipt.stderr, 32768)}</pre></details>
      <small>Source SHA-256: {text(receipt.sourceSha256, 64)}<br />Tests SHA-256: {text(receipt.testSha256, 64)}</small></>}
    {history.length > 0 && <details><summary>Prior QA evidence ({history.length} entries)</summary><pre>{JSON.stringify(history, null, 2)}</pre></details>}
    <p>Independent QA test artifacts are retained with the run, not written into the repository. Jenkins runs the repository suite separately.</p>
  </details>;
}
