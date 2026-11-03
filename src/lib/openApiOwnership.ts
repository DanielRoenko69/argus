import type pg from 'pg';
import type { CustomBackendRow } from '../backends/customBackends.js';

export const OPENAPI_CAPABILITY_STUDIO_HREF = '/mcp-fabric/capabilities';

export class OpenApiOwnershipError extends Error {
  readonly href = OPENAPI_CAPABILITY_STUDIO_HREF;

  constructor(message: string) {
    super(message);
    this.name = 'OpenApiOwnershipError';
  }
}

export function isOpenApiCategory(category: unknown): boolean {
  return typeof category === 'string'
    && category.trim().toLowerCase().startsWith('openapi:');
}

export function isOpenApiManagedConfig(config: unknown): boolean {
  return config !== null
    && typeof config === 'object'
    && !Array.isArray(config)
    && (config as Record<string, unknown>)['managed_by'] === 'openapi';
}

export interface LockedCapabilityOwnership {
  id: number;
  name: string;
  category: string | null;
  sourceControlled: boolean;
}

/**
 * Lock a capability before a generic edit/delete and determine whether its
 * implementation belongs to an OpenAPI source. The tool row is also the row
 * locked by the importer before it materializes or removes source operations,
 * so the ownership decision and the following generic mutation are atomic.
 */
export async function lockCapabilityOpenApiOwnership(
  client: pg.PoolClient,
  toolId: number | string,
): Promise<LockedCapabilityOwnership | null> {
  const result = await client.query<{
    id: number;
    name: string;
    category: string | null;
    source_controlled: boolean;
  }>(
    `SELECT tool.id,
            tool.name,
            tool.category,
            EXISTS (
              SELECT 1
                FROM mcp_capability_source_operations operation
               WHERE operation.tool_id = tool.id
            ) AS source_controlled
       FROM mcp_tools tool
      WHERE tool.id = $1
      FOR UPDATE OF tool`,
    [toolId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    sourceControlled: row.source_controlled || isOpenApiCategory(row.category),
  };
}

export interface LockedBackendOwnership {
  backend: CustomBackendRow;
  sourceControlled: boolean;
}

/**
 * Follow the importer's advisory/backend/source lock order. Looking up the
 * name first is only a lock-key hint; all authoritative state is read again
 * from locked rows before a caller may mutate the backend.
 */
export async function lockBackendOpenApiOwnership(
  client: pg.PoolClient,
  backendId: number | string,
): Promise<LockedBackendOwnership | null> {
  const hint = (await client.query<{ name: string }>(
    'SELECT name FROM mcp_backends WHERE id = $1',
    [backendId],
  )).rows[0];
  if (!hint) return null;

  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`openapi:${hint.name}`]);
  const backend = (await client.query<CustomBackendRow>(
    `SELECT backend.*
       FROM mcp_backends backend
      WHERE backend.id = $1
      FOR UPDATE OF backend`,
    [backendId],
  )).rows[0];
  if (!backend) return null;

  const sourceControlled = (await client.query<{ id: number }>(
    `SELECT source.id
       FROM mcp_capability_sources source
      WHERE source.backend_id = $1
      FOR UPDATE OF source`,
    [backend.id],
  )).rows.length > 0 || isOpenApiManagedConfig(backend.config);

  return { backend, sourceControlled };
}

export function openApiConflictBody(error: OpenApiOwnershipError): {
  error: string;
  href: string;
} {
  return { error: error.message, href: error.href };
}
