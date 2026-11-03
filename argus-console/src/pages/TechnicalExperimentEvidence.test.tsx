import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TechnicalExperimentEvidence } from './TechnicalExperimentEvidence';
afterEach(cleanup);
const request = { purpose: 'Reference calibration', script: '<script>alert(1)</script>', hypothesis: 'Convergence',
  protocol: 'Seed 42', interpretation: 'Only fixture evidence', scriptSha256: 'a'.repeat(64) };
it('hides absent evidence for historical runs', () => {
  const { container } = render(<TechnicalExperimentEvidence evidence={null} />); expect(container).toBeEmptyDOMElement();
});
it('is collapsed, escapes source, and offers no approval or execution action', () => {
  const { container } = render(<TechnicalExperimentEvidence evidence={{ attemptCount: 1, request,
    result: { status: 'completed', stdout: '42', durationMs: 12, pythonVersion: '3.12.14' } }} />);
  expect(container.querySelector('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByText(/Technical experiment · completed/));
  expect(screen.getByText(/not a new agent, QA acceptance/)).toBeVisible();
  fireEvent.click(screen.getByText('Python source (untrusted)'));
  expect(screen.getByText(request.script)).toBeVisible(); expect(container.querySelector('script')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull(); expect(screen.queryByRole('textbox')).toBeNull();
});
it('unknown and failed outcomes do not claim acceptance', () => {
  const { rerender } = render(<TechnicalExperimentEvidence evidence={{ attemptCount: 1, request }} />);
  fireEvent.click(screen.getByText(/no terminal receipt/));
  expect(screen.getByText(/must not be automatically replayed/)).toBeVisible();
  rerender(<TechnicalExperimentEvidence evidence={{ attemptCount: 1, request, result: { status: 'timeout', stderr: 'Stopped' } }} />);
  expect(screen.getByText(/Technical experiment · timeout/)).toBeVisible();
});
it('distinguishes bound preparation failures from uncertain execution without offering a retry', () => {
  render(<TechnicalExperimentEvidence evidence={{ attemptCount: 1, request, result: { status: 'preparation_failed',
    executionStarted: false, reason: 'snapshot_file_size_limit', filePath: 'docs/banner.jpg', actual: 17 * 1048576, limit: 16 * 1048576 } }} />);
  fireEvent.click(screen.getByText(/preparation blocked — not executed/));
  expect(screen.getByText(/The Python script did not start/)).toBeVisible();
  expect(screen.getByText('File: docs/banner.jpg')).toBeVisible();
  expect(screen.getByText(/17.00 MiB \/ 16.00 MiB allowed/)).toBeVisible();
  expect(screen.queryByText(/outcome is unknown/)).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});
