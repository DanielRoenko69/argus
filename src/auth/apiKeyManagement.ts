import type pg from 'pg';
import { apiKeyPrefix } from './apiKeyMiddleware.js';
import { generateApiKey, hashApiKey } from './apiKeyRbac.js';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface ManagedApiKeyRotation {
  id: number;
  label: string;
  key_prefix: string;
  key_suffix: string;
  previous_key_prefix: string;
  api_key: string;
}

/**
 * Hard-rotates a managed key in one locked SQL statement.
 * No previous hash is retained: the old credential stops authenticating as soon
 * as this function returns, while the new plaintext is returned exactly once.
 */
export async function rotateManagedApiKey(
  pool: Queryable,
  id: number | string,
  createKey: () => string = generateApiKey,
  scope: { tenantKey: string; workspaceKey: string } = { tenantKey: 'default', workspaceKey: 'default' },
): Promise<ManagedApiKeyRotation | null> {
  const fullKey = createKey();
  const keyPrefix = apiKeyPrefix(fullKey);
  const keyHash = hashApiKey(fullKey);
  const keySuffix = fullKey.slice(-4);
  const { rows } = await pool.query<Omit<ManagedApiKeyRotation, 'api_key'>>(
    `WITH previous AS (
       SELECT id, key_prefix
         FROM mcp_api_keys
        WHERE id = $1 AND tenant_key = $5 AND workspace_key = $6
          AND deleted_at IS NULL
        FOR UPDATE
     ), updated AS (
       UPDATE mcp_api_keys key
          SET key_prefix = $2,
              key_hash = $3,
              key_suffix = $4,
              previous_key_hash = NULL,
              next_rotation_at = NULL
         FROM previous
        WHERE key.id = previous.id
        RETURNING key.id, key.label, key.key_prefix, key.key_suffix
     )
     SELECT updated.*, previous.key_prefix AS previous_key_prefix
       FROM updated
       JOIN previous ON previous.id = updated.id`,
    [id, keyPrefix, keyHash, keySuffix, scope.tenantKey, scope.workspaceKey],
  );
  return rows[0] ? { ...rows[0], api_key: fullKey } : null;
}
