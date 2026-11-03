import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { QaResponseRecovery } from './QaResponseRecovery';
const api = vi.hoisted(() => ({ recheckCodingQaResponse: vi.fn(), continueCodingQaResponse: vi.fn(), previewCodingQaRetry: vi.fn(), retryCodingQa: vi.fn() }));
vi.mock('../api', () => api);
const onContinued = vi.fn(async () => {});
beforeEach(() => { vi.clearAllMocks(); api.recheckCodingQaResponse.mockResolvedValue({ available: true, checkpointId: 'cp', workspaceDigest: 'ws', reviewDigest: 'qa', testPlan: 'Independent expectations', repairCount: 1 }); });
function mount(threadId = 'thread') { return render(<QueryClientProvider client={new QueryClient()}><QaResponseRecovery key={threadId} threadId={threadId} onContinued={onContinued} /></QueryClientProvider>); }
it('does nothing on mount; recheck alone makes no continuation request', async () => {
  mount(); expect(api.recheckCodingQaResponse).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' })); await screen.findByText('Independent expectations');
  expect(api.continueCodingQaResponse).not.toHaveBeenCalled(); expect(screen.getByText(/not proof of scientific correctness/)).toBeVisible();
  expect(screen.getByText(/bounded format correction\(s\) recorded/)).toBeVisible();
  expect(screen.queryByText(/test-case labels normalized/)).not.toBeInTheDocument();
});
it('policy-1 offers saved-response recheck but no fresh QA call or automatic dispatch', async () => {
  render(<QueryClientProvider client={new QueryClient()}><QaResponseRecovery threadId="qa-policy-1" allowFreshRetry={false} onContinued={onContinued} /></QueryClientProvider>);
  expect(screen.queryByRole('button', { name: 'Prepare QA retry' })).not.toBeInTheDocument();
  expect(screen.getByText(/Only a validated saved response before implementation/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' }));
  await screen.findByRole('button', { name: 'Continue with saved QA at Coder' });
  expect(api.continueCodingQaResponse).not.toHaveBeenCalled(); expect(api.retryCodingQa).not.toHaveBeenCalled();
});
it('continues explicitly with only reviewed fingerprints, then prevents repeat submits', async () => {
  api.continueCodingQaResponse.mockResolvedValue({}); mount(); fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with saved QA at Coder' }));
  await waitFor(() => expect(onContinued).toHaveBeenCalledOnce());
  expect(api.continueCodingQaResponse).toHaveBeenCalledWith('thread', { checkpointId: 'cp', workspaceDigest: 'ws', reviewDigest: 'qa' });
  expect(screen.getByRole('button', { name: 'Continuation queued' })).toBeDisabled();
});
it('explains missing legacy evidence without offering a resume/approval', async () => {
  api.recheckCodingQaResponse.mockResolvedValue({ available: false, reason: 'No complete original response retained.' }); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' })); await screen.findByText(/No complete original/);
  expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
});
it('drops stale preview and never retries an ambiguous dispatch', async () => {
  api.continueCodingQaResponse.mockRejectedValue(new Error('Connection lost')); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Continue with saved QA at Coder' }));
  await screen.findByRole('alert'); expect(api.continueCodingQaResponse).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: /Continue with/ })).not.toBeInTheDocument();
});
it('QA retry needs a separate preview and explicit start, preserving user control over model usage', async () => {
  api.previewCodingQaRetry.mockResolvedValue({ available: true, checkpointId: 'cp2', workspaceDigest: 'ws2', reviewDigest: 'qa2', node: 'test_design' });
  api.retryCodingQa.mockResolvedValue({}); mount();
  expect(api.previewCodingQaRetry).not.toHaveBeenCalled(); expect(api.retryCodingQa).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare QA retry' }));
  const start = await screen.findByRole('button', { name: 'Run QA again — keep plan & Knowledge' });
  expect(screen.getByText(/new model call and consumes usage/)).toBeVisible();
  expect(api.retryCodingQa).not.toHaveBeenCalled();
  fireEvent.click(start); await waitFor(() => expect(onContinued).toHaveBeenCalledOnce());
  expect(api.retryCodingQa).toHaveBeenCalledWith('thread', { checkpointId: 'cp2', workspaceDigest: 'ws2', reviewDigest: 'qa2' });
  expect(api.continueCodingQaResponse).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'QA retry queued' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Recheck QA response' })).toBeDisabled();
});
it('switching action replaces the preview; an uncertain QA dispatch is never retried automatically', async () => {
  api.previewCodingQaRetry.mockResolvedValue({ available: true, checkpointId: 'cp2', workspaceDigest: 'ws2', reviewDigest: 'qa2' });
  api.retryCodingQa.mockRejectedValue(new Error('Connection lost')); mount();
  fireEvent.click(screen.getByRole('button', { name: 'Recheck QA response' }));
  await screen.findByRole('button', { name: 'Continue with saved QA at Coder' });
  fireEvent.click(screen.getByRole('button', { name: 'Prepare QA retry' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Run QA again — keep plan & Knowledge' }));
  await screen.findByRole('alert');
  expect(api.retryCodingQa).toHaveBeenCalledOnce(); expect(api.continueCodingQaResponse).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /Continue with|Run QA again/ })).not.toBeInTheDocument();
});

function mountOmission() {
  return render(<QueryClientProvider client={new QueryClient()}><QaResponseRecovery threadId="omission" allowFreshRetry={false} failureCategory="integrity" onContinued={onContinued} /></QueryClientProvider>);
}
it('policy-1 omission correction needs a read-only eligibility preview and a separate explicit model call', async () => {
  api.previewCodingQaRetry.mockResolvedValue({ available: true, checkpointId: 'cp', workspaceDigest: 'ws', reviewDigest: 'qa', retryKind: 'missing_reviews', missingDecisionIds: ['verification_delivery_boundary'] });
  api.retryCodingQa.mockResolvedValue({}); mountOmission();
  expect(api.previewCodingQaRetry).not.toHaveBeenCalled(); expect(api.retryCodingQa).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Recheck QA response' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Check targeted QA correction' }));
  const start = await screen.findByRole('button', { name: 'Run one QA correction — keep tests & reviews' });
  expect(screen.getByText(/verification_delivery_boundary/)).toHaveTextContent('One correction attempt only');
  expect(api.retryCodingQa).not.toHaveBeenCalled();
  fireEvent.click(start); await waitFor(() => expect(onContinued).toHaveBeenCalledOnce());
  expect(api.retryCodingQa).toHaveBeenCalledTimes(1);
  expect(api.retryCodingQa).toHaveBeenCalledWith('omission', { checkpointId: 'cp', workspaceDigest: 'ws', reviewDigest: 'qa' });
  expect(screen.getByRole('button', { name: 'QA retry queued' })).toBeDisabled();
  expect(api.continueCodingQaResponse).not.toHaveBeenCalled();
});
it('other integrity errors and exhausted correction budgets never expose a start action', async () => {
  api.previewCodingQaRetry.mockResolvedValue({ available: false, reason: 'Correction already consumed or not eligible.' }); mountOmission();
  fireEvent.click(screen.getByRole('button', { name: 'Check targeted QA correction' }));
  await screen.findByText(/Correction already consumed/);
  expect(screen.queryByRole('button', { name: /Run one QA/ })).not.toBeInTheDocument();
  expect(api.retryCodingQa).not.toHaveBeenCalled();
});
it('omission UI rejects mismatched previews and does not offer the unrestricted format retry', async () => {
  api.previewCodingQaRetry.mockResolvedValue({ available: true, checkpointId: 'cp', workspaceDigest: 'ws', reviewDigest: 'qa', retryKind: 'format' }); mountOmission();
  fireEvent.click(screen.getByRole('button', { name: 'Check targeted QA correction' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: /Run QA again/ })).not.toBeInTheDocument();
  expect(api.retryCodingQa).not.toHaveBeenCalled();
});
