import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const post = vi.fn();
vi.mock('@/api/client', () => ({
  api: { post: (...a: unknown[]) => post(...a) },
}));

import { useCreateWorkflow } from '../workflows';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useCreateWorkflow', () => {
  beforeEach(() => {
    post.mockReset();
  });

  it('POSTs name+description with enabled:true to /api/admin/workflows and returns the new workflow', async () => {
    post.mockResolvedValue({ id: 42, name: 'My WF', description: 'desc', enabled: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateWorkflow(), { wrapper: wrapper(qc) });

    const created = await result.current.mutateAsync({ name: 'My WF', description: 'desc' });

    expect(post).toHaveBeenCalledWith('/api/admin/workflows', {
      name: 'My WF',
      description: 'desc',
      enabled: true,
    });
    expect(created).toEqual({ id: 42, name: 'My WF', description: 'desc', enabled: true });
  });

  it('invalidates the admin-workflows query on success', async () => {
    post.mockResolvedValue({ id: 7, name: 'X', description: '', enabled: true });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useCreateWorkflow(), { wrapper: wrapper(qc) });

    await result.current.mutateAsync({ name: 'X', description: '' });

    await waitFor(() =>
      expect(spy).toHaveBeenCalledWith({ queryKey: ['admin-workflows'] }),
    );
  });
});
