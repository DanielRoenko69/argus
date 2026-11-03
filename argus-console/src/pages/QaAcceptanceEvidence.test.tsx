import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QaAcceptanceEvidence } from './QaAcceptanceEvidence';
afterEach(cleanup);
it('shows PostgreSQL version and phase reset without credentials', () => {
  render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 3,
    stackResult: { passed: true, stackEnvironment: { workspaceDatabase: { engine: 'postgresql', serverMajor: 16 } } } }} />);
  expect(screen.getByText(/Run-private PostgreSQL 16/)).toBeInTheDocument();
  expect(screen.getByText(/fresh database before each phase/)).toBeInTheDocument();
  expect(screen.getByText(/access revoked after execution/)).toBeInTheDocument();
});
it('shows workspace evidence without inventing a prepared image or pristine rollback', () => {
  render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 3,
    stackResult: { passed: true, stackEnvironment: { sessionId: 'session-proof', preparedSession: 'project-proof', preparedImage: null } } }} />);
  expect(screen.getByText(/Workspace session: session-proof/)).toBeInTheDocument();
  expect(screen.getByText(/No test-image build or snapshot/)).toBeInTheDocument();
  expect(screen.getByText(/not a pristine filesystem rollback/)).toBeInTheDocument();
  expect(screen.queryByText(/Prepared image:/)).toBeNull();
});
it('identifies service startup separately from application assertions', () => {
  render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2,
    stackResult: { status: 'preparation_failed', passed: false, executionStarted: false,
      stackEnvironment: { phase: 'project', executionStatus: 'failed', testStarted: false } } }} />);
  expect(screen.getByText(/Service startup stopped before tests began/)).toBeInTheDocument();
  expect(screen.getByText(/not a failed application assertion/)).toBeInTheDocument();
});
it('distinguishes shortened logs from the actual execution stop reason', () => {
  const { rerender } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2,
    stackResult: { status: 'completed', passed: true, exitCode: 0, stackEnvironment: { phase: 'project', executionStatus: 'completed',
      outputCapture: { stdoutBytes: 4000000, stderrBytes: 12, stdoutTruncated: true, stderrTruncated: false } } } }} />);
  expect(screen.getByText(/Log excerpt shortened; not the complete output/)).toBeInTheDocument();
  expect(screen.getByText(/Execution: completed · Phase: project · Exit: 0/)).toBeInTheDocument();
  expect(screen.queryByText(/Execution stopped at/)).toBeNull();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2,
    stackResult: { status: 'preparation_failed', passed: false, exitCode: 137, stackEnvironment: { phase: 'setup', executionStatus: 'output_limit' } } }} />);
  expect(screen.getByText(/Execution: output_limit · Phase: setup · Exit: 137/)).toBeInTheDocument();
  expect(screen.getByText(/not evidence of a missing dependency or out-of-memory/)).toBeInTheDocument();
});
it('shows the frozen four-repair policy and window, while old evidence retains two', () => {
  const { rerender } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2, stackRepairs: 3,
    stackRepairPolicy: { policyVersion: 1, maxRepairs: 4, windowMinutes: 45, deadlineAt: '2026-09-29T12:00:00.000Z' } }} />);
  expect(screen.getByText(/Environment repairs: 3 \/ 4/)).toBeInTheDocument();
  expect(screen.getByText(/Repair-start window: 45 minutes/)).toBeInTheDocument();
  expect(screen.getByText(/No new repair calls after/)).toBeInTheDocument();
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2, stackRepairs: 2 }} />);
  expect(screen.getByText(/Environment repairs: 2 \/ 2/)).toBeInTheDocument();
  expect(screen.queryByText(/Repair-start window/)).toBeNull();
});
it('shows bounded recipe corrections and keeps previous failure evidence after successful import', () => {
  const { container, rerender } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1,
    codeGeneration: { policyVersion: 1, repairPolicyVersion: 1, repairs: 1, receipt: { applied: true } },
    history: [{ phase: 'code_generation_rejected', evidence: { phase: 'generate', status: 'failed', stderr: '<script>invalid fixture</script>' } }] }} />);
  expect(screen.getByText(/Generator recipe corrections: 1 \/ 2/)).toBeInTheDocument();
  expect(screen.getByText('Prior generator failure output (untrusted)')).toBeInTheDocument();
  expect(screen.getByText(/Independent QA acceptance · Pending/)).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1, codeGeneration: { policyVersion: 1, repairPolicyVersion: 0 } }} />);
  expect(screen.queryByText(/Generator recipe corrections/)).toBeNull();
});
it('shows generated output evidence without calling it passing QA or an approval', () => {
  const { container, rerender } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2,
    codeGeneration: { policyVersion: 1, decision: { status: 'ready', plan: { summary: 'Repository generator', outputPaths: ['client.ts'], generate: '<script>generator</script>' } },
      receipt: { applied: true, sourceSha256: 'before', resultSourceSha256: 'after' } } }} />);
  expect(screen.getByText(/Outputs imported; not an approval/)).toBeInTheDocument();
  expect(screen.getByText('client.ts')).toBeInTheDocument();
  expect(screen.getByText(/Independent QA acceptance · Pending/)).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1 }} />);
  expect(screen.queryByLabelText('Isolated code generation')).toBeNull();
});
it('renders the general stack boundary and retained image without legacy sandbox claims', () => {
  render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentPolicyVersion: 2, stackRepairs: 1,
    stackPlan: { summary: 'Python, Bun, PostgreSQL', setup: 'install', start: 'start', test: 'test' },
    stackResult: { passed: true, stackEnvironment: { preparedImage: 'sha256:fixture', planSha256: 'plan' } } }} />);
  expect(screen.getByText(/Automatic stack environment · Repository tests passed/)).toBeInTheDocument();
  expect(screen.getByText(/local subprocesses\/services permitted/)).toBeInTheDocument();
  expect(screen.queryByText(/no network or subprocesses/)).toBeNull();
  expect(screen.getByText(/Environment repairs: 1 \/ 2/)).toBeInTheDocument();
});
it('hides the opt-in feature for legacy/absent evidence', () => {
  const { container, rerender } = render(<QaAcceptanceEvidence evidence={null} />);
  expect(container).toBeEmptyDOMElement();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 0 }} />); expect(container).toBeEmptyDOMElement();
});
it('starts collapsed, escapes test code, and exposes evidence rather than an approval', () => {
  const code = '<script>alert(1)</script>';
  const { container } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1,
    artifact: { status: 'ready', summary: 'Additional seed case', blockers: [], files: [{ id: 'seed', content: code,
      expected: '42', oracle: 'Frozen brief', qaCaseIds: ['seed_case'] }] },
    receipt: { passed: true, status: 'completed', exitCode: 0, collected: 1, durationMs: 10 } }} />);
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText(/Independent QA acceptance · Passed on recorded source/));
  fireEvent.click(screen.getByText('QA test: seed'));
  expect(screen.getByText(code)).toBeVisible(); expect(container.querySelector('script')).toBeNull();
  expect(screen.getByText(/not written into the repository/)).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
});
it('missing, blocked, timed-out and empty executions are not passing', () => {
  const { rerender } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1 }} />);
  expect(screen.getByText(/· Pending/)).toBeInTheDocument();
  rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1, artifact: { status: 'blocked' } }} />);
  expect(screen.getByText(/· Blocked/)).toBeInTheDocument();
  for (const receipt of [{ status: 'timeout', passed: true, collected: 1 }, { status: 'completed', passed: true, exitCode: 0, collected: 0 }]) {
    rerender(<QaAcceptanceEvidence evidence={{ policyVersion: 1, receipt }} />);
    expect(screen.getByText(/· Not passed/)).toBeInTheDocument();
  }
});
it('shows prepared or blocked environments without offering install/approval controls', () => {
  const { container } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, receipt: {
    status: 'preparation_failed', passed: false, executionStarted: false, collected: 0,
    environment: { status: 'blocked', reason: 'environment_artifact_hash_mismatch', packages: [],
      plan: { profileId: 'python-reviewed', runtime: 'cpython-3.12.13-linux-aarch64', planSha256: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) } },
  } }} />);
  expect(screen.getByText(/Project test environment · Blocked/)).toBeInTheDocument();
  expect(screen.getByText(/Independent tests were not started/)).toBeInTheDocument();
  expect(container.querySelector('[aria-label="Project test environment"]')).not.toHaveAttribute('open');
  expect(screen.queryByRole('button')).toBeNull();
});
it('shows a profile block before any QA artifact or model call, without claiming installation', () => {
  render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, history: [{ phase: 'environment_preflight',
    plan: { status: 'blocked', reasons: ['environment_profile_required'] } }] }} />);
  expect(screen.getByText(/Independent QA acceptance · Environment blocked/)).toBeInTheDocument();
  expect(screen.getByText(/No installation has been performed/)).toBeInTheDocument();
});
it('shows general dependency locks and the bounded repair without presenting install controls', () => {
  const { container } = render(<QaAcceptanceEvidence evidence={{ policyVersion: 1, environmentRepairs: 1,
    environmentRequirements: [{ requirement: 'hypothesis>=6', reason: '<script>evidence</script>' }], receipt: {
      status: 'completed', passed: true, exitCode: 0, collected: 2,
      environment: { status: 'ready', packages: [{ name: 'hypothesis', version: '6.0' }],
        resolution: { lockSha256: 'a'.repeat(64) }, plan: { profileId: 'python-public-wheels-v1' } },
    } }} />);
  expect(screen.getByText(/public-PyPI wheel policy/)).toBeInTheDocument();
  expect(screen.getByText(/Dependency repair: 1 \/ 1/)).toBeInTheDocument();
  expect(screen.getByText(/Resolution lock SHA-256/)).toBeInTheDocument();
  expect(container.querySelector('script')).toBeNull(); expect(screen.queryByRole('button')).toBeNull();
});
