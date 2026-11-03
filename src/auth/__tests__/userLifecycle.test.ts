import { describe, expect, it, jest } from '@jest/globals';
import type pg from 'pg';
import {
  deleteManagedUser,
  parseAllowedBundleIds,
  parseWorkspaceMemberships,
  updateManagedUser,
} from '../userLifecycle.js';

interface MockOptions {
  target?: {
    id: number;
    username: string;
    display_name: string;
    role: string;
    allowed_bundles: number[] | null;
    enabled: boolean;
    created_at: string;
    last_login: string | null;
  };
  otherAdmins?: number;
}

function mockPool(options: MockOptions = {}) {
  const target = options.target ?? {
    id: 2,
    username: 'alex',
    display_name: 'Alex',
    role: 'platform_admin',
    allowed_bundles: [],
    enabled: true,
    created_at: '2026-01-01',
    last_login: null,
  };
  const query = jest.fn(async (sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM mcp_users WHERE id = $1 FOR UPDATE')) return { rows: [target], rowCount: 1 };
    if (sql.includes('FROM mcp_workspace_memberships')) return {
      rows: [{ tenant_key: 'default', workspace_key: 'default', is_default: true }], rowCount: 1,
    };
    if (sql.includes('COUNT(*)::int')) return { rows: [{ count: options.otherAdmins ?? 0 }], rowCount: 1 };
    if (sql.includes('UPDATE mcp_users')) {
      return { rows: [target], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
  const client = { query, release: jest.fn() } as unknown as pg.PoolClient;
  const pool = { connect: jest.fn(async () => client) } as unknown as pg.Pool;
  return { client, pool, query };
}

describe('managed user lifecycle', () => {
  it('normalizes and validates explicit bundle scopes', () => {
    expect(parseAllowedBundleIds([3, 3, 8])).toEqual([3, 8]);
    expect(parseAllowedBundleIds(null)).toBeNull();
    expect(() => parseAllowedBundleIds(['3'])).toThrow('invalid bundle ID');
  });

  it('normalizes workspace memberships and requires exactly one default', () => {
    expect(parseWorkspaceMemberships([
      { tenant_key: 'tenant-b', workspace_key: 'shared', is_default: false },
      { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: true },
    ])).toEqual([
      { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: true },
      { tenant_key: 'tenant-b', workspace_key: 'shared', is_default: false },
    ]);
    expect(() => parseWorkspaceMemberships([])).toThrow('between 1 and 32');
    expect(() => parseWorkspaceMemberships([
      { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: false },
    ])).toThrow('exactly one default');
    expect(() => parseWorkspaceMemberships([
      { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: true },
      { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: false },
    ])).toThrow('duplicate membership');
  });

  it('prevents an administrator from disabling their own identity', async () => {
    const { pool, query } = mockPool();
    await expect(updateManagedUser(pool, 2, 2, { enabled: false })).rejects.toMatchObject({ code: 'SELF_DISABLE' });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE mcp_users'), expect.anything());
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('keeps the last active platform administrator in place', async () => {
    const { pool } = mockPool({ otherAdmins: 0 });
    await expect(updateManagedUser(pool, 1, 2, { role: 'developer' })).rejects.toMatchObject({ code: 'LAST_PLATFORM_ADMIN' });
    await expect(deleteManagedUser(pool, 1, 2)).rejects.toMatchObject({ code: 'LAST_PLATFORM_ADMIN' });
  });

  it('allows a platform administrator change when another active administrator remains', async () => {
    const { pool, query } = mockPool({ otherAdmins: 1 });
    await expect(updateManagedUser(pool, 1, 2, { role: 'operations_admin', allowed_bundles: [4] })).resolves.toMatchObject({ id: 2 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('UPDATE mcp_users'), ['operations_admin', [4], 2]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('replaces workspace memberships inside the managed-user transaction', async () => {
    const { pool, query } = mockPool({ otherAdmins: 1 });
    await expect(updateManagedUser(pool, 1, 2, {
      workspace_scopes: [
        { tenant_key: 'tenant-a', workspace_key: 'primary', is_default: true },
        { tenant_key: 'tenant-b', workspace_key: 'shared', is_default: false },
      ],
    })).resolves.toMatchObject({ id: 2 });
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM mcp_workspace_memberships WHERE user_id = $1',
      [2],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mcp_workspace_memberships'),
      [2, expect.stringContaining('tenant-a')],
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
  });
});
