import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { MappedOp, MappedSecurity } from './map.js';

export interface OpenApiSafeAuth {
  type: 'none' | 'bearer' | 'basic' | 'header';
  headerName: string | null;
}

export interface OpenApiManifestOperation {
  key: string;
  name: string;
  method: MappedOp['method'];
  path: string;
  isWrite: boolean;
  supported: boolean;
  signature: string;
}

export interface OpenApiCapabilityManifest {
  prefix: string;
  sourceKind: 'url' | 'text';
  sourceUrl: string | null;
  title: string;
  openapiVersion: string;
  baseUrl: string;
  baseUrlOverride: string | null;
  auth: OpenApiSafeAuth;
  authSignature: string;
  specDigest: string;
  manifestDigest: string;
  operations: OpenApiManifestOperation[];
}

export interface BuildOpenApiManifestInput {
  prefix: string;
  sourceKind: 'url' | 'text';
  specUrl?: unknown;
  title: string;
  openapiVersion: string;
  baseUrl: string;
  baseUrlOverridden: boolean;
  security: MappedSecurity;
  specDigest: string;
  operations: MappedOp[];
}

export function openApiDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function signature(domain: 'auth' | 'operation' | 'manifest', value: unknown): string {
  return openApiDigest(`argus:openapi:${domain}:v1\0${JSON.stringify(value)}`);
}

export function safeOpenApiAuth(security: MappedSecurity): OpenApiSafeAuth {
  return {
    type: security.auth_type,
    headerName: security.auth_type === 'header' && typeof security.headerName === 'string'
      ? security.headerName.slice(0, 128)
      : null,
  };
}

export function isOpenApiSafeAuth(value: unknown): value is OpenApiSafeAuth {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const auth = value as Record<string, unknown>;
  if (Object.keys(auth).some(key => !['type', 'headerName'].includes(key))
    || !['none', 'bearer', 'basic', 'header'].includes(String(auth.type))) return false;
  return auth.type === 'header'
    ? typeof auth.headerName === 'string' && auth.headerName.length > 0 && auth.headerName.length <= 128
    : auth.headerName === null;
}

function trackedSource(kind: 'url' | 'text', rawSpecUrl: unknown): { kind: 'url' | 'text'; url: string | null } {
  if (kind !== 'url' || typeof rawSpecUrl !== 'string') return { kind: 'text', url: null };
  try {
    const url = new URL(rawSpecUrl.trim());
    // Query strings often carry signed credentials. They are never persisted;
    // such imports remain manually checkable via a newly pasted specification.
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return { kind: 'text', url: null };
    }
    return { kind: 'url', url: url.toString() };
  } catch {
    return { kind: 'text', url: null };
  }
}

export function openApiOperationSignature(operation: MappedOp): string {
  return signature('operation', {
    name: operation.name,
    description: operation.description,
    method: operation.method,
    path: operation.path,
    queryTemplate: operation.queryTemplate,
    parameters: operation.parameters,
    isWrite: operation.isWrite,
    supported: operation.supported,
    tags: operation.tags,
    warnings: operation.warnings,
  });
}

export function buildOpenApiCapabilityManifest(input: BuildOpenApiManifestInput): OpenApiCapabilityManifest {
  const source = trackedSource(input.sourceKind, input.specUrl);
  const sourceDegradedToManual = input.sourceKind === 'url' && source.kind === 'text';
  const auth = safeOpenApiAuth(input.security);
  const operations = input.operations.map(operation => ({
    key: `${operation.method} ${operation.path}`,
    name: operation.name,
    method: operation.method,
    path: operation.path,
    isWrite: operation.isWrite,
    supported: operation.supported,
    signature: openApiOperationSignature(operation),
  })).sort((left, right) => left.key.localeCompare(right.key));
  const keys = new Set(operations.map(operation => operation.key));
  if (keys.size !== operations.length) throw new Error('OpenAPI manifest contains duplicate operation keys');
  const canonicalAuth: OpenApiSafeAuth = auth.type === 'header'
    ? { type: 'header', headerName: auth.headerName?.toLowerCase() ?? null }
    : auth;
  const authSignature = signature('auth', canonicalAuth);
  const manifestDigest = signature('manifest', {
    baseUrl: input.baseUrl,
    auth: canonicalAuth,
    operations: operations.map(operation => ({
      key: operation.key,
      signature: operation.signature,
    })),
  });
  return {
    prefix: input.prefix,
    sourceKind: source.kind,
    sourceUrl: source.url,
    title: input.title.slice(0, 200),
    openapiVersion: input.openapiVersion.slice(0, 32),
    baseUrl: input.baseUrl,
    // When a signed/query-bearing URL cannot be stored, future checks receive
    // pasted text without that URL as a relative-server resolution context.
    // Pin the already normalized effective base URL to keep them deterministic.
    baseUrlOverride: input.baseUrlOverridden || sourceDegradedToManual ? input.baseUrl : null,
    auth,
    authSignature,
    specDigest: input.specDigest,
    manifestDigest,
    operations,
  };
}

function assertManifest(manifest: OpenApiCapabilityManifest): void {
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(manifest.prefix)
    || !['url', 'text'].includes(manifest.sourceKind)
    || (manifest.sourceKind === 'url') !== Boolean(manifest.sourceUrl)
    || !/^[0-9a-f]{64}$/.test(manifest.specDigest)
    || !/^[0-9a-f]{64}$/.test(manifest.manifestDigest)
    || !/^[0-9a-f]{64}$/.test(manifest.authSignature)
    || !isOpenApiSafeAuth(manifest.auth)
    || manifest.operations.length > 500) {
    throw new Error('OpenAPI source manifest is invalid');
  }
  if (manifest.sourceUrl) {
    const tracked = trackedSource('url', manifest.sourceUrl);
    if (tracked.kind !== 'url' || tracked.url !== manifest.sourceUrl) throw new Error('OpenAPI source URL is not persistable');
  }
  if (manifest.operations.some(operation => operation.key !== `${operation.method} ${operation.path}`
    || !/^[0-9a-f]{64}$/.test(operation.signature))) {
    throw new Error('OpenAPI source operation manifest is invalid');
  }
}

/** Persist the complete mapped source baseline and imported-tool mapping in the caller's transaction. */
export async function syncOpenApiCapabilityManifest(
  client: pg.PoolClient,
  backendId: number,
  manifest: OpenApiCapabilityManifest,
): Promise<number> {
  assertManifest(manifest);
  const sourceId = (await client.query<{ id: number }>(
    `INSERT INTO mcp_capability_sources (
       backend_id, name_prefix, source_kind, source_url, title, openapi_version,
       base_url, base_url_override, auth_scheme, auth_signature, spec_digest,
       manifest_digest, operation_count, lifecycle_status, imported_at,
       last_checked_at, last_observed_spec_digest, last_observed_manifest_digest,
       last_check_summary, last_check_error_code, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,'current',now(),NULL,NULL,NULL,NULL,NULL,now())
     ON CONFLICT (backend_id) DO UPDATE SET
       name_prefix = EXCLUDED.name_prefix,
       source_kind = EXCLUDED.source_kind,
       source_url = EXCLUDED.source_url,
       title = EXCLUDED.title,
       openapi_version = EXCLUDED.openapi_version,
       base_url = EXCLUDED.base_url,
       base_url_override = EXCLUDED.base_url_override,
       auth_scheme = EXCLUDED.auth_scheme,
       auth_signature = EXCLUDED.auth_signature,
       spec_digest = EXCLUDED.spec_digest,
       manifest_digest = EXCLUDED.manifest_digest,
       operation_count = EXCLUDED.operation_count,
       lifecycle_status = 'current',
       imported_at = now(),
       last_checked_at = NULL,
       last_observed_spec_digest = NULL,
       last_observed_manifest_digest = NULL,
       last_check_summary = NULL,
       last_check_error_code = NULL,
       revision = mcp_capability_sources.revision + 1,
       updated_at = now()
     RETURNING id`,
    [
      backendId,
      manifest.prefix,
      manifest.sourceKind,
      manifest.sourceUrl,
      manifest.title,
      manifest.openapiVersion,
      manifest.baseUrl,
      manifest.baseUrlOverride,
      JSON.stringify(manifest.auth),
      manifest.authSignature,
      manifest.specDigest,
      manifest.manifestDigest,
      manifest.operations.length,
    ],
  )).rows[0]!.id;

  const toolRows = await client.query<{ id: number; name: string }>(
    `SELECT id, name
       FROM mcp_tools
      WHERE category = $1
        AND backend = $2`,
    [`openapi:${manifest.prefix}`, `custom:${manifest.prefix}`],
  );
  const toolIdByName = new Map(toolRows.rows.map(row => [row.name, row.id]));
  const persistedOperations = manifest.operations.map(operation => ({
    operation_key: operation.key,
    tool_id: toolIdByName.get(operation.name) ?? null,
    tool_name: operation.name,
    method: operation.method,
    path: operation.path,
    is_write: operation.isWrite,
    supported: operation.supported,
    signature: operation.signature,
  }));
  await client.query('DELETE FROM mcp_capability_source_operations WHERE source_id = $1', [sourceId]);
  if (persistedOperations.length > 0) {
    await client.query(
      `INSERT INTO mcp_capability_source_operations (
         source_id, operation_key, tool_id, tool_name, method, path, is_write, supported, signature
       )
       SELECT $1, operation.operation_key, operation.tool_id, operation.tool_name,
              operation.method, operation.path, operation.is_write, operation.supported, operation.signature
         FROM jsonb_to_recordset($2::jsonb) AS operation(
           operation_key text, tool_id int, tool_name text, method text, path text,
           is_write boolean, supported boolean, signature text
         )`,
      [sourceId, JSON.stringify(persistedOperations)],
    );
  }
  return sourceId;
}
