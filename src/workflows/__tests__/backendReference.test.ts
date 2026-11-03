import type pg from 'pg';
import { resolveBundleBackendReference, getBundleGitBackend, getWorkflowBackendCreds, resolveBundleBackendCreds } from '../backendCredsStore.js';

describe('workflow backend references', () => {
  it('resolves metadata only in the exact Bundle', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ id: 42 }] });
    expect(await resolveBundleBackendReference({ query } as unknown as pg.Pool, 50, 42)).toBe(42);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('bb.bundle_id = $1'), [50, 42]);
    expect(query.mock.calls[0]![0]).not.toContain('auth_value');
  });
  it.each([{ rows: [] }, { rows: [{ id: 42 }, { id: 43 }] }])('rejects missing or ambiguous references: %p', async ({ rows }) => {
    const query = jest.fn().mockResolvedValue({ rows });
    await expect(resolveBundleBackendReference({ query } as unknown as pg.Pool, 50)).rejects.toThrow('exactly one');
  });
  it.each(['strict', 'permissive'])('never exports a service token through legacy adapters for %s', async auth_mode => {
    const query = jest.fn().mockResolvedValue({ rows: [{ backend_id: 42, backend_name: 'gitea', auth_mode, auth_value: 'private-service-token', config: { kind: 'gitea' } }] });
    const pool = { query } as unknown as pg.Pool;
    await expect(getBundleGitBackend(pool, 50)).rejects.toMatchObject({ code: 'delegation_adapter_required' });
    await expect(getWorkflowBackendCreds(pool, 1, 'gitea')).rejects.toMatchObject({ code: 'delegation_adapter_required' });
    await expect(resolveBundleBackendCreds(pool, 50, 42)).rejects.toMatchObject({ code: 'delegation_adapter_required' });
  });
});
