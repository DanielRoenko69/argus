import type pg from 'pg';
import { assertEgressAllowed, assertSsrfSafeResolved } from '../../backends/customBackends.js';
import { encrypt } from '../../lib/encryption.js';
import type { MappedOp } from './map.js';
import {
  openApiOperationSignature,
  isOpenApiSafeAuth,
  syncOpenApiCapabilityManifest,
  type OpenApiCapabilityManifest,
} from './manifest.js';
import { storedOpenApiCredentialReadable, storedOpenApiHeaderMatches } from './credential.js';

export interface ImportInput {
  backendName: string;
  baseUrl: string;
  authType: 'none' | 'bearer' | 'basic' | 'header';
  authValue: string | null;
  credentialMode?: 'preserve' | 'replace' | 'clear';
  namePrefix: string;
  operations: MappedOp[];
  sourceOperationNames?: string[];
  bundleIds?: number[];
  createDefaultBundle?: boolean;
  enabled?: boolean;
  allowReimport?: boolean;
  allowRemoval?: boolean;
  expectedRemovalNames?: string[];
  expectedRemovalImpacts?: Array<{ name: string; workflowCount: number }>;
  sourceManifest: OpenApiCapabilityManifest;
  expectedSourceRevision: string | null;
  expectedSourceManifestDigest: string | null;
  expectedExistingBundleIds: number[];
}

export interface ImportResult {
  backendId: number;
  bundleId: number;
  bundleIds: number[];
  created: { read: number; write: number };
  inserted: { read: number; write: number };
  updated: { read: number; write: number };
  removed: string[];
  skipped: string[];
  sourceId: number;
}

interface ExistingBackendRow {
  id: number;
  description: string;
  base_url: string;
  auth_type: string;
  auth_value: string | null;
  enabled: boolean;
  backend_type: string;
  managed_by: string | null;
}

interface ExistingSourceRow {
  id: number;
  backend_id: number;
  revision: string;
  manifest_digest: string | null;
  auth_scheme: unknown;
}

interface MaterializedSourceOperationRow {
  name: string;
  baseline_signature: string | null;
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('OpenAPI base URL must be an absolute http(s) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('OpenAPI base URL must be an absolute http(s) URL without embedded credentials');
  }
  if (url.search || url.hash) throw new Error('OpenAPI base URL cannot contain a query or fragment');
  return url.toString().replace(/\/$/, '');
}

/**
 * Atomically upsert one OpenAPI-owned HTTP connection and its generated capabilities.
 * Stable tool names keep their IDs/history/governance on re-import; removed source
 * operations are deleted only after every selected operation has passed preflight.
 */
export async function importOpenApi(pool: pg.Pool, input: ImportInput): Promise<ImportResult> {
  if (typeof input.backendName !== 'string' || typeof input.namePrefix !== 'string'
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.backendName) || input.namePrefix !== input.backendName) {
    throw new Error('OpenAPI import prefix is invalid');
  }
  if (!['none', 'bearer', 'basic', 'header'].includes(input.authType)
    || (input.authValue !== null && typeof input.authValue !== 'string')
    || (typeof input.authValue === 'string'
      && (input.authValue.length > 8_320 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.authValue)))) {
    throw new Error('OpenAPI authentication configuration is invalid');
  }
  if (input.authType === 'none' && input.authValue !== null) {
    throw new Error('OpenAPI imports without authentication cannot store a credential');
  }
  if ([input.createDefaultBundle, input.enabled, input.allowReimport, input.allowRemoval]
    .some(value => value !== undefined && typeof value !== 'boolean')) {
    throw new Error('OpenAPI import flags are invalid');
  }
  if (input.expectedRemovalImpacts !== undefined && (
    !Array.isArray(input.expectedRemovalImpacts)
    || input.expectedRemovalImpacts.length > 500
    || new Set(input.expectedRemovalImpacts.map(impact => impact?.name)).size !== input.expectedRemovalImpacts.length
    || input.expectedRemovalImpacts.some(impact => !impact || typeof impact.name !== 'string'
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(impact.name)
      || !Number.isSafeInteger(impact.workflowCount) || impact.workflowCount < 0)
  )) {
    throw new Error('Confirmed OpenAPI removal impacts are invalid');
  }
  if ((input.expectedSourceRevision !== null && !/^[1-9]\d*$/.test(input.expectedSourceRevision))
    || (input.expectedSourceManifestDigest !== null && !/^[0-9a-f]{64}$/.test(input.expectedSourceManifestDigest))
    || !Array.isArray(input.expectedExistingBundleIds)) {
    throw new Error('OpenAPI expected source state is invalid');
  }
  const expectedExistingBundleIds = [...new Set(input.expectedExistingBundleIds)];
  if (expectedExistingBundleIds.length !== input.expectedExistingBundleIds.length
    || expectedExistingBundleIds.length > 500
    || expectedExistingBundleIds.some(id => !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)) {
    throw new Error('OpenAPI expected bundle state is invalid');
  }
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new Error('OpenAPI import requires at least one supported operation');
  }
  const operationPrefix = `${input.backendName}__`;
  if (input.operations.length > 500 || input.operations.some(operation => {
    if (!operation || typeof operation !== 'object'
      || typeof operation.name !== 'string' || !operation.name.startsWith(operationPrefix)
      || !/^[a-z][a-z0-9_-]{0,63}$/.test(operation.name)
      || typeof operation.description !== 'string' || operation.description.length > 500
      || typeof operation.queryTemplate !== 'string' || Buffer.byteLength(operation.queryTemplate, 'utf8') > 65_536
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(operation.method)
      || typeof operation.path !== 'string' || operation.path.length > 2_048
      || !operation.path.startsWith('/') || /[\r\n\s?#\\]/.test(operation.path)
      || typeof operation.isWrite !== 'boolean' || (operation.method !== 'GET' && !operation.isWrite)
      || operation.supported !== true || !Array.isArray(operation.parameters) || operation.parameters.length > 50) return true;
    const requestLine = operation.queryTemplate.split('\n', 1)[0] ?? '';
    const requestMatch = requestLine.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)$/);
    if (!requestMatch || requestMatch[1] !== operation.method || requestMatch[2]!.startsWith('//')) return true;
    return operation.parameters.some(parameter => !parameter || typeof parameter !== 'object'
      || typeof parameter.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(parameter.name)
      || !['string', 'number', 'boolean'].includes(parameter.type)
      || typeof parameter.description !== 'string' || parameter.description.length > 200
      || typeof parameter.required !== 'boolean'
      || (parameter.default !== undefined && typeof parameter.default !== 'string'));
  })) {
    throw new Error('OpenAPI import contains unsupported operations or exceeds its limits');
  }
  const operationNames = input.operations.map(operation => operation.name);
  if (new Set(operationNames).size !== operationNames.length) throw new Error('OpenAPI operation names must be unique');
  if (input.sourceOperationNames !== undefined && (!Array.isArray(input.sourceOperationNames)
    || input.sourceOperationNames.length > 500
    || input.sourceOperationNames.some(name => typeof name !== 'string'
      || !name.startsWith(operationPrefix) || !/^[a-z][a-z0-9_-]{0,63}$/.test(name)))) {
    throw new Error('OpenAPI source operation set is invalid');
  }
  const sourceOperationNames = [...new Set(input.sourceOperationNames ?? operationNames)];
  if (operationNames.some(name => !sourceOperationNames.includes(name))) {
    throw new Error('Selected OpenAPI operations are not part of the source operation set');
  }

  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (!input.sourceManifest || input.sourceManifest.prefix !== input.backendName
    || input.sourceManifest.baseUrl !== baseUrl
    || input.sourceManifest.auth.type !== input.authType) {
    throw new Error('OpenAPI source manifest does not match the import');
  }
  const manifestByKey = new Map(input.sourceManifest.operations.map(operation => [operation.key, operation]));
  if (input.operations.some(operation => {
    const manifestOperation = manifestByKey.get(`${operation.method} ${operation.path}`);
    return !manifestOperation
      || manifestOperation.name !== operation.name
      || manifestOperation.signature !== openApiOperationSignature(operation);
  })) {
    throw new Error('OpenAPI selected operations do not match the source manifest');
  }
  await assertSsrfSafeResolved(baseUrl, undefined, { failClosedOnDnsError: true });
  assertEgressAllowed(baseUrl);
  const category = `openapi:${input.backendName}`;
  const createDefaultBundle = input.createDefaultBundle !== false;
  if (input.bundleIds !== undefined && !Array.isArray(input.bundleIds)) {
    throw new Error('OpenAPI bundle selection is invalid');
  }
  const requestedBundleIds = [...new Set(input.bundleIds ?? [])];
  if (requestedBundleIds.length > 500 || requestedBundleIds.some(id =>
    typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > 2_147_483_647)) {
    throw new Error('OpenAPI bundle selection is invalid');
  }
  const credentialMode = input.credentialMode ?? (input.authValue == null ? 'preserve' : 'replace');
  if (!['preserve', 'replace', 'clear'].includes(credentialMode)) throw new Error('OpenAPI credential mode is invalid');
  if (credentialMode === 'replace' && input.authValue == null) throw new Error('Replacement credential is missing');
  if (credentialMode !== 'replace' && input.authValue !== null) {
    throw new Error('OpenAPI credential mode and credential value are inconsistent');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`openapi:${input.backendName}`]);

    const existingBackend = (await client.query<ExistingBackendRow>(
      `SELECT id, description, base_url, auth_type, auth_value, enabled, backend_type,
              config->>'managed_by' AS managed_by
         FROM mcp_backends
        WHERE name = $1
        FOR UPDATE`,
      [input.backendName],
    )).rows[0];
    const existingSource = (await client.query<ExistingSourceRow>(
      `SELECT id, backend_id, revision::text AS revision, manifest_digest, auth_scheme
         FROM mcp_capability_sources
        WHERE name_prefix = $1
        FOR UPDATE`,
      [input.backendName],
    )).rows[0];
    if ((existingSource?.revision ?? null) !== input.expectedSourceRevision
      || (existingSource?.manifest_digest ?? null) !== input.expectedSourceManifestDigest
      || (existingSource && existingBackend && existingSource.backend_id !== existingBackend.id)
      || (existingSource && !existingBackend)) {
      throw new Error('OpenAPI source baseline changed after preview; preview again before importing');
    }
    if (existingBackend && (
      existingBackend.backend_type !== 'http'
      || (existingBackend.managed_by !== 'openapi' && existingSource?.backend_id !== existingBackend.id)
    )) {
      throw new Error(`Backend '${input.backendName}' already exists and is not owned by the OpenAPI importer`);
    }
    if (existingBackend && credentialMode === 'preserve' && existingBackend.auth_type !== input.authType) {
      throw new Error('A new credential is required when the API authentication scheme changes');
    }
    if (credentialMode === 'preserve' && input.authType !== 'none' && !existingBackend?.auth_value) {
      throw new Error('The OpenAPI credential no longer exists; provide a new credential and preview again');
    }
    if (credentialMode === 'preserve' && input.authType !== 'none'
      && !storedOpenApiCredentialReadable(existingBackend?.auth_value)) {
      throw new Error('The OpenAPI credential cannot be decrypted; provide a new credential and preview again');
    }
    if (existingBackend && credentialMode === 'preserve' && input.authType === 'header') {
      const previousAuth = existingSource?.auth_scheme;
      const previousHeaderName = isOpenApiSafeAuth(previousAuth)
        && previousAuth.type === 'header'
        && typeof previousAuth.headerName === 'string'
        ? previousAuth.headerName
        : null;
      const expectedHeaderName = input.sourceManifest.auth.type === 'header'
        && typeof input.sourceManifest.auth.headerName === 'string'
        ? input.sourceManifest.auth.headerName
        : null;
      if (previousHeaderName === null || expectedHeaderName === null
        || previousHeaderName.toLowerCase() !== expectedHeaderName.toLowerCase()
        || !storedOpenApiHeaderMatches(existingBackend.auth_value, expectedHeaderName)) {
        throw new Error('A new credential is required when the API key header changes');
      }
    }
    if (existingBackend && existingBackend.auth_value && credentialMode === 'preserve') {
      const oldOrigin = new URL(existingBackend.base_url).origin;
      const newOrigin = new URL(baseUrl).origin;
      if (oldOrigin !== newOrigin) {
        throw new Error('A new credential or explicit credential removal is required when the API origin changes');
      }
    }

    const existingBundleIds = existingBackend
      ? (await client.query<{ bundle_id: number }>(
        `SELECT bundle_id
           FROM mcp_backend_bundles
          WHERE backend_id = $1
          ORDER BY bundle_id
          FOR UPDATE`,
        [existingBackend.id],
      )).rows.map(row => row.bundle_id)
      : [];
    const expectedBundleIds = [...expectedExistingBundleIds].sort((left, right) => left - right);
    if (existingBundleIds.length !== expectedBundleIds.length
      || existingBundleIds.some((id, index) => id !== expectedBundleIds[index])) {
      throw new Error('OpenAPI bundle assignments changed after preview; preview again before importing');
    }

    // A partial re-import may leave unchanged materialized tools alone, but it
    // must never record a new source signature over an old implementation.
    // Legacy backfills have no trustworthy operation baseline, so every retained
    // materialized tool must be selected once to establish that baseline.
    const materialized = existingBackend
      ? (await client.query<MaterializedSourceOperationRow>(
        `SELECT tool.name, baseline.signature AS baseline_signature
           FROM mcp_tools tool
           LEFT JOIN mcp_capability_source_operations baseline
             ON baseline.source_id = $3
            AND baseline.tool_id = tool.id
          WHERE tool.category = $1
            AND tool.backend = $2
          FOR UPDATE OF tool`,
        [category, `custom:${input.backendName}`, existingSource?.id ?? null],
      )).rows
      : [];
    const selectedNames = new Set(operationNames);
    const retainedNames = new Set(sourceOperationNames);
    const observedSignatureByName = new Map(input.sourceManifest.operations
      .map(operation => [operation.name, operation.signature] as const));
    const staleUnselected = materialized.find(row => {
      if (!retainedNames.has(row.name) || selectedNames.has(row.name)) return false;
      const observedSignature = observedSignatureByName.get(row.name);
      return !existingSource?.manifest_digest
        || row.baseline_signature == null
        || observedSignature == null
        || row.baseline_signature !== observedSignature;
    });
    if (staleUnselected) {
      throw new Error(
        `Capability '${staleUnselected.name}' changed since the applied baseline and must be selected for re-import`,
      );
    }

    let backendId: number;
    if (existingBackend) {
      backendId = existingBackend.id;
      const nextAuthValue = credentialMode === 'replace'
        ? encrypt(input.authValue)
        : credentialMode === 'clear' ? null : existingBackend.auth_value;
      const nextAuthType = credentialMode === 'preserve' ? existingBackend.auth_type : input.authType;
      await client.query(
        `UPDATE mcp_backends
            SET description = 'Imported from OpenAPI', base_url = $1, auth_type = $2,
                auth_value = $3, backend_type = 'http',
                config = COALESCE(config, '{}'::jsonb) || '{"managed_by":"openapi"}'::jsonb
          WHERE id = $4`,
        [baseUrl, nextAuthType, nextAuthValue, backendId],
      );
    } else {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO mcp_backends (
           name, description, base_url, auth_type, auth_value, health_path,
           default_headers, timeout_ms, tls_skip_verify, enabled, backend_type,
           auth_mode, config
         ) VALUES ($1,'Imported from OpenAPI',$2,$3,$4,NULL,'{}',10000,false,true,'http','service-account',$5)
         RETURNING id`,
        [
          input.backendName,
          baseUrl,
          input.authType,
          credentialMode === 'clear' ? null : encrypt(input.authValue),
          JSON.stringify({ managed_by: 'openapi' }),
        ],
      );
      backendId = inserted.rows[0]!.id;
    }

    const desiredBundleIds = [...requestedBundleIds];
    let defaultBundleId: number | null = null;
    if (createDefaultBundle) {
      const existingBundle = (await client.query<{ id: number; description: string }>(
        'SELECT id, description FROM mcp_service_bundles WHERE name = $1 FOR UPDATE',
        [input.backendName],
      )).rows[0];
      if (existingBundle && (!existingBackend || !existingBundleIds.includes(existingBundle.id))) {
        throw new Error(`Bundle '${input.backendName}' already exists and is not owned by the OpenAPI importer`);
      }
      if (existingBundle) defaultBundleId = existingBundle.id;
      else {
        defaultBundleId = (await client.query<{ id: number }>(
          `INSERT INTO mcp_service_bundles (name, label, description, icon, system_prompt, agent_role)
           VALUES ($1,$1,$2,'','',NULL) RETURNING id`,
          [input.backendName, `OpenAPI: ${input.backendName}`],
        )).rows[0]!.id;
      }
      desiredBundleIds.push(defaultBundleId);
    }
    const bundleIds = [...new Set(desiredBundleIds)].sort((left, right) => left - right);
    if (bundleIds.length === 0) throw new Error('OpenAPI imports require at least one bundle boundary');
    const validBundles = await client.query<{ id: number }>(
      'SELECT id FROM mcp_service_bundles WHERE id = ANY($1::int[]) FOR UPDATE',
      [bundleIds],
    );
    if (validBundles.rows.length !== bundleIds.length) throw new Error('At least one selected OpenAPI bundle no longer exists');

    const collisions = await client.query<{ name: string; category: string | null; backend: string }>(
      'SELECT name, category, backend FROM mcp_tools WHERE name = ANY($1::text[]) FOR UPDATE',
      [operationNames],
    );
    const foreignCollision = collisions.rows.find(row => row.category !== category || row.backend !== `custom:${input.backendName}`);
    if (foreignCollision) throw new Error(`Capability name '${foreignCollision.name}' is already owned by another source`);

    const previous = await client.query<{ id: number; name: string }>(
      'SELECT id, name FROM mcp_tools WHERE category = $1 AND backend = $2 FOR UPDATE',
      [category, `custom:${input.backendName}`],
    );
    if (previous.rows.length > 0 && input.allowReimport !== true) {
      throw new Error('OpenAPI import state changed after preview; reimport requires explicit confirmation');
    }
    const previousNames = new Set(previous.rows.map(row => row.name));
    const removed = previous.rows.filter(row => !sourceOperationNames.includes(row.name)).map(row => row.name);
    if (input.expectedRemovalNames !== undefined) {
      if (!Array.isArray(input.expectedRemovalNames)
        || new Set(input.expectedRemovalNames).size !== input.expectedRemovalNames.length) {
        throw new Error('Confirmed OpenAPI capability removals are invalid');
      }
      const actual = [...removed].sort();
      const expected = [...input.expectedRemovalNames].sort();
      if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
        throw new Error('OpenAPI capability removals changed after preview; review and confirm the new diff');
      }
    }
    if (removed.length > 0 && input.allowRemoval !== true) {
      throw new Error(`Re-import would remove ${removed.length} existing capabilities and requires explicit confirmation`);
    }
    if (removed.length > 0) {
      if (input.expectedRemovalImpacts === undefined) {
        throw new Error('OpenAPI capability removal impact changed after preview; review and confirm the new diff');
      }
      // Block concurrent workflow INSERT/UPDATE/DELETE until this transaction
      // commits, so the impact count cannot change between validation and tool
      // deletion. Normal reads remain available under SHARE mode.
      await client.query('LOCK TABLE mcp_workflows IN SHARE MODE');
      const actualImpacts = (await client.query<{ name: string; workflow_count: number }>(
        `SELECT candidate.name,
                count(workflow.id)::int AS workflow_count
           FROM unnest($1::text[]) AS candidate(name)
           LEFT JOIN mcp_workflows workflow
             ON EXISTS (
               SELECT 1
                 FROM jsonb_array_elements(workflow.steps) step
                WHERE step->>'tool' = candidate.name
             )
          GROUP BY candidate.name
          ORDER BY candidate.name`,
        [removed],
      )).rows;
      const expectedImpacts = [...input.expectedRemovalImpacts]
        .sort((left, right) => left.name.localeCompare(right.name));
      if (actualImpacts.length !== expectedImpacts.length
        || actualImpacts.some((impact, index) => impact.name !== expectedImpacts[index]!.name
          || impact.workflow_count !== expectedImpacts[index]!.workflowCount)) {
        throw new Error('OpenAPI capability removal impact changed after preview; review and confirm the new diff');
      }
    }

    let insertedRead = 0;
    let insertedWrite = 0;
    let updatedRead = 0;
    let updatedWrite = 0;
    for (const operation of input.operations) {
      const existed = previousNames.has(operation.name);
      const upserted = await client.query<{ id: number }>(
        `INSERT INTO mcp_tools (
           name, description, backend, query_template, parameters, category,
           enabled, tool_type, is_write, risk_level, required_auth_mode
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'dynamic',$8,$9,'service-account')
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           backend = EXCLUDED.backend,
           query_template = EXCLUDED.query_template,
           parameters = EXCLUDED.parameters,
           category = EXCLUDED.category,
           is_write = EXCLUDED.is_write,
           enabled = CASE
             WHEN EXCLUDED.enabled = false THEN false
             ELSE mcp_tools.enabled
           END,
           risk_level = CASE
             WHEN EXCLUDED.is_write AND mcp_tools.risk_level = 'low' THEN 'high'
             ELSE mcp_tools.risk_level
           END
         WHERE mcp_tools.category = EXCLUDED.category
           AND mcp_tools.backend = EXCLUDED.backend
         RETURNING id`,
        [
          operation.name,
          operation.description,
          `custom:${input.backendName}`,
          operation.queryTemplate,
          JSON.stringify(operation.parameters),
          category,
          input.enabled !== false,
          operation.isWrite,
          operation.isWrite ? 'high' : 'low',
        ],
      );
      // The preflight SELECT cannot predicate-lock a name that did not exist yet.
      // A concurrent import for a different backend may therefore win the UNIQUE
      // race after preflight. The guarded ON CONFLICT must not overwrite that
      // foreign capability; PostgreSQL returns no row when its WHERE is false.
      if (upserted.rows.length !== 1) {
        throw new Error(`Capability name '${operation.name}' became owned by another source during import`);
      }
      if (existed) operation.isWrite ? updatedWrite++ : updatedRead++;
      else operation.isWrite ? insertedWrite++ : insertedRead++;
    }

    if (removed.length > 0) {
      await client.query('DELETE FROM mcp_tools WHERE category = $1 AND backend = $2 AND name = ANY($3::text[])', [
        category,
        `custom:${input.backendName}`,
        removed,
      ]);
      // A removed source operation must not remain implicitly allowlisted in a
      // selected-tool policy: otherwise reintroducing the same name later would
      // silently inherit stale access. Keep unrelated policy entries and order.
      await client.query(
        `UPDATE mcp_bundle_backend_tool_policies policy
            SET allowed_tool_names = COALESCE((
                  SELECT array_agg(entry.name ORDER BY entry.ordinality)
                    FROM unnest(policy.allowed_tool_names) WITH ORDINALITY AS entry(name, ordinality)
                   WHERE NOT (entry.name = ANY($2::text[]))
                ), '{}'::text[]),
                updated_at = now()
          WHERE policy.backend_id = $1
            AND policy.mode = 'selected'
            AND policy.allowed_tool_names && $2::text[]`,
        [backendId, removed],
      );
    }

    // Staging is connection-wide from a capability-safety perspective: even an
    // operation that was not selected for definition updates would otherwise keep
    // running against a changed base URL/auth configuration. Enabling an import,
    // on the other hand, deliberately preserves explicit administrator disables.
    if (input.enabled === false) {
      await client.query(
        `UPDATE mcp_tools
            SET enabled = false
          WHERE category = $1
            AND backend = $2
            AND enabled = true`,
        [category, `custom:${input.backendName}`],
      );
    }

    const currentToolIds = (await client.query<{ id: number }>(
      'SELECT id FROM mcp_tools WHERE category = $1 AND backend = $2 FOR UPDATE',
      [category, `custom:${input.backendName}`],
    )).rows.map(row => row.id);
    // Reconcile assignments instead of delete-and-recreate. A retained
    // mcp_backend_bundles row may be referenced by a selected-tool policy with
    // ON DELETE CASCADE; deleting it during an idempotent re-import would erase
    // that governance policy even if the effective bundle scope did not change.
    await client.query(
      `DELETE FROM mcp_backend_bundles
        WHERE backend_id = $1
          AND NOT (bundle_id = ANY($2::int[]))`,
      [backendId, bundleIds],
    );
    await client.query(
      `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
       SELECT $1::int, desired.bundle_id
         FROM unnest($2::int[]) AS desired(bundle_id)
       ON CONFLICT DO NOTHING`,
      [backendId, bundleIds],
    );
    await client.query(
      `DELETE FROM mcp_tool_bundles
        WHERE tool_id = ANY($1::int[])
          AND NOT (bundle_id = ANY($2::int[]))`,
      [currentToolIds, bundleIds],
    );
    await client.query(
      `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
       SELECT tools.tool_id, bundles.bundle_id
         FROM unnest($1::int[]) AS tools(tool_id)
        CROSS JOIN unnest($2::int[]) AS bundles(bundle_id)
       ON CONFLICT DO NOTHING`,
      [currentToolIds, bundleIds],
    );

    const sourceId = await syncOpenApiCapabilityManifest(client, backendId, input.sourceManifest);

    await client.query('COMMIT');
    const read = input.operations.filter(operation => !operation.isWrite).length;
    const write = input.operations.length - read;
    return {
      backendId,
      bundleId: defaultBundleId ?? bundleIds[0]!,
      bundleIds,
      created: { read, write },
      inserted: { read: insertedRead, write: insertedWrite },
      updated: { read: updatedRead, write: updatedWrite },
      removed,
      skipped: [],
      sourceId,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
