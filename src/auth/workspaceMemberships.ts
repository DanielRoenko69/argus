import type pg from 'pg';
import type { User } from './userAuth.js';

export interface WorkspaceMembership {
  tenant_key: string;
  workspace_key: string;
  is_default: boolean;
}

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function loadUserWorkspaceMemberships(
  queryable: Queryable,
  userId: number,
): Promise<WorkspaceMembership[]> {
  const { rows } = await queryable.query<WorkspaceMembership>(
    `SELECT tenant_key, workspace_key, is_default
       FROM mcp_workspace_memberships
      WHERE user_id = $1
      ORDER BY is_default DESC, tenant_key, workspace_key`,
    [userId],
  );
  return rows.map(row => ({
    tenant_key: row.tenant_key,
    workspace_key: row.workspace_key,
    is_default: Boolean(row.is_default),
  }));
}

export async function replaceUserWorkspaceMemberships(
  client: pg.PoolClient,
  userId: number,
  memberships: WorkspaceMembership[],
): Promise<void> {
  await client.query('DELETE FROM mcp_workspace_memberships WHERE user_id = $1', [userId]);
  await client.query(
    `INSERT INTO mcp_workspace_memberships (user_id, tenant_key, workspace_key, is_default)
     SELECT $1, membership.tenant_key, membership.workspace_key, membership.is_default
       FROM jsonb_to_recordset($2::jsonb)
         AS membership(tenant_key text, workspace_key text, is_default boolean)`,
    [userId, JSON.stringify(memberships)],
  );
}

export async function withUserWorkspaceMemberships<T extends User>(
  queryable: Queryable,
  user: T,
): Promise<T & { workspace_scopes: WorkspaceMembership[] }> {
  return {
    ...user,
    workspace_scopes: await loadUserWorkspaceMemberships(queryable, user.id),
  };
}
