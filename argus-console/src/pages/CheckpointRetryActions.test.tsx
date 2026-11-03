import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { CheckpointRetryActions } from './CheckpointRetryActions';
const api = vi.hoisted(() => ({ getCodingCheckpointRetry: vi.fn(), continueCodingCheckpoint: vi.fn() }));
vi.mock('../api', () => api);
const configure = vi.fn(); const onContinued = vi.fn(async () => {});
beforeEach(() => { vi.clearAllMocks(); api.getCodingCheckpointRetry.mockResolvedValue({ available: true, node: 'coder', checkpointId: 'cp', workspaceDigest: 'sha' }); });
function mount() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><CheckpointRetryActions threadId="thread" canConfigure configure={configure} onContinued={onContinued} /></QueryClientProvider>); }
function mountRecovery() { return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><CheckpointRetryActions threadId="thread" recoveryOnly canConfigure={false} configure={configure} onContinued={onContinued} /></QueryClientProvider>); }
it('offers both actions; opening or choosing does not dispatch a run', async () => {
  mount(); fireEvent.click(screen.getByRole('button', { name: 'Configure retry' })); expect(configure).toHaveBeenCalledOnce();
  expect(api.getCodingCheckpointRetry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('radio', { name: /Continue from failed step/ }));
  await screen.findByText('Coder'); expect(api.continueCodingCheckpoint).not.toHaveBeenCalled();
});
it('sends only the reviewed checkpoint and hash, disables duplicate submissions', async () => {
  api.continueCodingCheckpoint.mockResolvedValue({ status: 'queued' }); mount();
  fireEvent.click(screen.getByRole('radio', { name: /Continue from failed step/ })); await screen.findByText('Coder');
  fireEvent.click(screen.getByRole('button', { name: 'Continue from checkpoint' }));
  await waitFor(() => expect(onContinued).toHaveBeenCalledOnce());
  expect(api.continueCodingCheckpoint).toHaveBeenCalledOnce();
  expect(api.continueCodingCheckpoint).toHaveBeenCalledWith('thread', { checkpointId: 'cp', workspaceDigest: 'sha' });
  expect(screen.getByRole('button', { name: 'Continuation queued' })).toBeDisabled();
});
it('explains an unavailable continuation but leaves new attempts usable', async () => {
  api.getCodingCheckpointRetry.mockResolvedValue({ available: false, reason: 'Worker is still running' }); mount();
  fireEvent.click(screen.getByRole('radio', { name: /Continue from failed step/ }));
  await screen.findByText(/Worker is still running/); expect(screen.getByRole('button', { name: 'Continue from checkpoint' })).toBeDisabled();
  fireEvent.click(screen.getByRole('radio', { name: /Reconfigure and start over/ }));
  expect(screen.getByRole('button', { name: 'Configure retry' })).toBeEnabled();
});
it('does not auto-retry an ambiguous network failure', async () => {
  api.continueCodingCheckpoint.mockRejectedValue(new Error('Connection lost')); mount();
  fireEvent.click(screen.getByRole('radio', { name: /Continue from failed step/ })); await screen.findByText('Coder');
  fireEvent.click(screen.getByRole('button', { name: 'Continue from checkpoint' }));
  await screen.findByText(/No automatic retry will be sent/); expect(api.continueCodingCheckpoint).toHaveBeenCalledOnce();
});
it('previews import recovery without dispatch and never offers a full restart', async () => {
  api.getCodingCheckpointRetry.mockResolvedValue({ available: true, node: 'code_generation', checkpointId: 'cp', workspaceDigest: 'sha' });
  mountRecovery();
  expect(await screen.findByText(/without repeating generation, planning or Coder/)).toBeInTheDocument();
  expect(api.continueCodingCheckpoint).not.toHaveBeenCalled();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Configure retry' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Continue from checkpoint' }));
  await waitFor(() => expect(api.continueCodingCheckpoint).toHaveBeenCalledOnce());
});
