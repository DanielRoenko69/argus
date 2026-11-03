import { assertSsrfSafe } from '../backends/customBackends.js';
import type pg from 'pg';

export type CapabilityParameterType = 'string' | 'number' | 'boolean';
export type CapabilityRiskLevel = 'low' | 'medium' | 'high';
export type CapabilityAuthMode = 'service-account' | 'permissive' | 'strict';

export interface CapabilityMutationInput {
  name?: unknown;
  description?: unknown;
  backend?: unknown;
  queryTemplate?: unknown;
  parameters?: unknown;
  category?: unknown;
  enabled?: unknown;
  bundleIds?: unknown;
  allowUnscoped?: unknown;
  riskLevel?: unknown;
  requiredAuthMode?: unknown;
}

export interface NormalizedCapabilityMutation {
  name: string;
  description: string;
  backend: string;
  queryTemplate: string;
  parameters: Array<{
    name: string;
    type: CapabilityParameterType;
    description: string;
    required: boolean;
    default?: string;
  }>;
  category: string | null;
  enabled: boolean;
  bundleIds: number[];
  allowUnscoped: boolean;
  isWrite: boolean;
  riskLevel: CapabilityRiskLevel;
  requiredAuthMode: CapabilityAuthMode | null;
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HTTP_METHOD_PATTERN = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i;
const READ_SQL_PATTERN = /^(SELECT|WITH|EXPLAIN|VALUES)\b/i;
const CUSTOM_BACKEND_PATTERN = /^custom:[a-z0-9][a-z0-9_-]{0,63}$/;
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function normalizedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new Error(`${label} fehlt`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} darf maximal ${maxLength} Zeichen enthalten`);
  return normalized;
}

function normalizeBundleIds(value: unknown): number[] {
  if (value != null && !Array.isArray(value)) throw new Error('Bundle-Zuordnungen müssen als Liste übergeben werden');
  const ids = [...new Set(((value as unknown[] | undefined) ?? []).map(Number))];
  if (ids.length > 500 || ids.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Bundle-Zuordnungen enthalten eine ungültige ID');
  }
  return ids;
}

function normalizeParameters(value: unknown): NormalizedCapabilityMutation['parameters'] {
  if (value != null && !Array.isArray(value)) throw new Error('Parameter müssen als Liste übergeben werden');
  const raw = (value as Array<Record<string, unknown>> | undefined) ?? [];
  if (raw.length > 50) throw new Error('Eine Capability darf maximal 50 Parameter besitzen');
  const names = new Set<string>();
  return raw.map((parameter, index) => {
    if (!parameter || typeof parameter !== 'object') throw new Error(`Parameter ${index + 1} ist ungültig`);
    const name = normalizedString(parameter.name, `Name von Parameter ${index + 1}`, 64);
    if (!PARAMETER_NAME_PATTERN.test(name)) {
      throw new Error(`Parameter ${name || index + 1} hat einen ungültigen Namen`);
    }
    if (names.has(name)) throw new Error(`Parameter ${name} ist doppelt vorhanden`);
    names.add(name);
    const type = parameter.type;
    if (!['string', 'number', 'boolean'].includes(String(type))) {
      throw new Error(`Parameter ${name} hat einen ungültigen Typ`);
    }
    const description = normalizedString(parameter.description ?? '', `Beschreibung von Parameter ${name}`, 200);
    if (typeof parameter.required !== 'boolean') throw new Error(`Required-Status von Parameter ${name} ist ungültig`);
    const defaultValue = parameter.default == null ? '' : String(parameter.default).trim();
    if (defaultValue.length > 1000) throw new Error(`Default von Parameter ${name} ist zu lang`);
    return {
      name,
      type: type as CapabilityParameterType,
      description,
      required: parameter.required,
      ...(defaultValue ? { default: defaultValue } : {}),
    };
  });
}

function validateTemplate(backend: string, template: string): { method: string | null; target: string | null } {
  if (backend === 'postgresql') {
    if (!READ_SQL_PATTERN.test(template)) {
      throw new Error('PostgreSQL-Capabilities müssen mit SELECT, WITH, EXPLAIN oder VALUES beginnen');
    }
    const withoutFinalTerminator = template.trim().replace(/;\s*$/, '');
    if (withoutFinalTerminator.includes(';')) throw new Error('PostgreSQL-Capabilities dürfen nur ein Statement enthalten');
    return { method: null, target: null };
  }

  const firstLine = template.split('\n', 1)[0]?.trim() ?? '';
  const match = firstLine.match(HTTP_METHOD_PATTERN);
  if (!match) throw new Error('HTTP-Capabilities benötigen in der ersten Zeile METHOD und Ziel');
  const method = match[1]?.toUpperCase() ?? '';
  const target = match[2] ?? '';
  if (backend === 'http') {
    const validationTarget = target.replace(/\{\{[A-Za-z][A-Za-z0-9_]*\}\}/g, 'value');
    let parsed: URL;
    try {
      parsed = new URL(validationTarget);
    } catch {
      throw new Error('Direkte HTTP-Capabilities benötigen eine vollständige http(s)-URL');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HTTP-Ziel muss http oder https verwenden');
    assertSsrfSafe(validationTarget);
  } else if (!target.startsWith('/') || target.startsWith('//')) {
    throw new Error('Connected-System-Capabilities benötigen einen relativen Pfad, der mit / beginnt');
  }
  return { method, target };
}

export function inferCapabilityIsWrite(backend: string, queryTemplate: string): boolean {
  if (backend === 'postgresql') return false;
  const firstLine = queryTemplate.trim().split('\n', 1)[0]?.trim() ?? '';
  const method = firstLine.match(HTTP_METHOD_PATTERN)?.[1]?.toUpperCase();
  return method != null && WRITE_METHODS.has(method);
}

export function normalizeCapabilityMutation(value: CapabilityMutationInput): NormalizedCapabilityMutation {
  if (!value || typeof value !== 'object') throw new Error('Capability-Daten fehlen');
  const name = normalizedString(value.name, 'Capability-Name', 64);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error('Capability-Name muss mit einem Kleinbuchstaben beginnen und darf nur a-z, 0-9, _ und - enthalten');
  }
  const description = normalizedString(value.description ?? '', 'Beschreibung', 500);
  const backend = normalizedString(value.backend, 'Backend', 128);
  if (backend !== 'postgresql' && backend !== 'http' && !CUSTOM_BACKEND_PATTERN.test(backend)) {
    throw new Error('Backend muss PostgreSQL, Direct HTTP oder ein Connected System sein');
  }
  const queryTemplate = normalizedString(value.queryTemplate, 'Implementierung', 50_000);
  if (!queryTemplate) throw new Error('Implementierung darf nicht leer sein');
  const { method } = validateTemplate(backend, queryTemplate);
  const parameters = normalizeParameters(value.parameters);
  const declaredParameters = new Set(parameters.map(parameter => parameter.name));
  const placeholders = [...queryTemplate.matchAll(/\{\{([^{}]+)\}\}/g)].map(match => match[1]?.trim() ?? '');
  const unknownPlaceholder = placeholders.find(placeholder => !declaredParameters.has(placeholder));
  if (unknownPlaceholder) throw new Error(`Template-Parameter {{${unknownPlaceholder}}} ist nicht definiert`);
  const category = normalizedString(value.category ?? '', 'Kategorie', 64) || null;
  if (typeof value.enabled !== 'boolean') throw new Error('Capability-Status ist ungültig');
  const bundleIds = normalizeBundleIds(value.bundleIds);
  if (typeof value.allowUnscoped !== 'boolean') throw new Error('Unscoped-Bestätigung ist ungültig');
  if (bundleIds.length === 0 && !value.allowUnscoped) {
    throw new Error('Mindestens ein Bundle ist erforderlich oder Unscoped-Zugriff muss explizit bestätigt werden');
  }
  const isWrite = method != null && WRITE_METHODS.has(method);
  const riskLevel = String(value.riskLevel ?? (isWrite ? 'high' : 'low')) as CapabilityRiskLevel;
  if (!['low', 'medium', 'high'].includes(riskLevel)) throw new Error('Risiko-Einstufung ist ungültig');
  if (isWrite && riskLevel === 'low') throw new Error('Schreibende Capabilities benötigen mindestens ein mittleres Risiko');
  const requiredAuthMode = value.requiredAuthMode == null || value.requiredAuthMode === ''
    ? null
    : String(value.requiredAuthMode) as CapabilityAuthMode;
  if (requiredAuthMode != null && !['service-account', 'permissive', 'strict'].includes(requiredAuthMode)) {
    throw new Error('Upstream-Auth-Modus ist ungültig');
  }
  return {
    name,
    description,
    backend,
    queryTemplate,
    parameters,
    category,
    enabled: value.enabled,
    bundleIds,
    allowUnscoped: value.allowUnscoped,
    isWrite,
    riskLevel,
    requiredAuthMode,
  };
}

interface CapabilityBundleSyncInput {
  toolId: number;
  name: string;
  backend: string;
  bundleIds: number[];
}

/**
 * Persist the exact effective bundle scope for a managed capability.
 *
 * Direct SQL/HTTP capabilities use mcp_tool_bundles. Capabilities backed by a
 * connected system follow the newer Bundle × Connection policy model, so the
 * backend assignment and selected-tool policies must be reconciled atomically.
 */
export async function syncCapabilityBundleAssignments(
  client: pg.PoolClient,
  input: CapabilityBundleSyncInput,
): Promise<{ backendId: number | null }> {
  await client.query('DELETE FROM mcp_tool_bundles WHERE tool_id = $1', [input.toolId]);
  if (input.bundleIds.length > 0) {
    await client.query(
      `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
       SELECT $1::int, unnest($2::int[])`,
      [input.toolId, input.bundleIds],
    );
  }

  if (!input.backend.startsWith('custom:')) return { backendId: null };
  const backendName = input.backend.slice('custom:'.length);
  const backend = (await client.query<{ id: number; backend_type: string }>(
    `SELECT id, backend_type
       FROM mcp_backends
      WHERE name = $1
      FOR UPDATE`,
    [backendName],
  )).rows[0];
  if (!backend) throw new Error('Connected System nicht gefunden');
  if (backend.backend_type !== 'http') {
    throw new Error('Manuelle Connected-System-Capabilities benötigen eine HTTP-Connection');
  }

  const existingBundleRows = await client.query<{ bundle_id: number }>(
    `SELECT bundle_id
       FROM mcp_backend_bundles
      WHERE backend_id = $1
      FOR UPDATE`,
    [backend.id],
  );
  const scopeBundleIds = [...new Set([
    ...existingBundleRows.rows.map(row => row.bundle_id),
    ...input.bundleIds,
  ])];
  if (input.bundleIds.length > 0) {
    await client.query(
      `INSERT INTO mcp_backend_bundles (backend_id, bundle_id)
       SELECT $1::int, unnest($2::int[])
       ON CONFLICT DO NOTHING`,
      [backend.id, input.bundleIds],
    );
  }
  if (scopeBundleIds.length === 0) return { backendId: backend.id };

  const catalog = await client.query<{ name: string }>(
    `SELECT name
       FROM mcp_tools
      WHERE backend = $1
     UNION
     SELECT prefixed_name AS name
       FROM mcp_remote_tools
      WHERE backend_id = $2`,
    [input.backend, backend.id],
  );
  const allNames = [...new Set(catalog.rows.map(row => row.name))].sort();
  const policies = await client.query<{
    bundle_id: number;
    mode: 'all' | 'selected';
    allowed_tool_names: string[];
  }>(
    `SELECT bundle_id, mode, allowed_tool_names
       FROM mcp_bundle_backend_tool_policies
      WHERE backend_id = $1 AND bundle_id = ANY($2::int[])
      FOR UPDATE`,
    [backend.id, scopeBundleIds],
  );
  const policyByBundle = new Map(policies.rows.map(policy => [policy.bundle_id, policy]));
  const desiredBundles = new Set(input.bundleIds);

  for (const bundleId of scopeBundleIds) {
    const policy = policyByBundle.get(bundleId);
    const allowed = new Set(policy?.mode === 'selected' ? policy.allowed_tool_names : allNames);
    if (desiredBundles.has(bundleId)) allowed.add(input.name);
    else allowed.delete(input.name);
    const nextNames = [...allowed].filter(name => allNames.includes(name)).sort();
    if (nextNames.length === allNames.length) {
      await client.query(
        `DELETE FROM mcp_bundle_backend_tool_policies
          WHERE backend_id = $1 AND bundle_id = $2`,
        [backend.id, bundleId],
      );
    } else {
      await client.query(
        `INSERT INTO mcp_bundle_backend_tool_policies (
           backend_id, bundle_id, mode, allowed_tool_names
         ) VALUES ($1, $2, 'selected', $3)
         ON CONFLICT (backend_id, bundle_id) DO UPDATE SET
           mode = 'selected',
           allowed_tool_names = EXCLUDED.allowed_tool_names,
           updated_at = now()`,
        [backend.id, bundleId, nextNames],
      );
    }
  }
  return { backendId: backend.id };
}

/** Remove an obsolete capability name from selected backend policies after deletion. */
export async function cleanDeletedCapabilityPolicies(
  client: pg.PoolClient,
  backend: string,
  name: string,
): Promise<void> {
  if (!backend.startsWith('custom:')) return;
  const backendName = backend.slice('custom:'.length);
  const backendRow = (await client.query<{ id: number }>(
    'SELECT id FROM mcp_backends WHERE name = $1 FOR UPDATE',
    [backendName],
  )).rows[0];
  if (!backendRow) return;
  await client.query(
    `UPDATE mcp_bundle_backend_tool_policies
        SET allowed_tool_names = array_remove(allowed_tool_names, $2),
            updated_at = now()
      WHERE backend_id = $1 AND mode = 'selected' AND $2 = ANY(allowed_tool_names)`,
    [backendRow.id, name],
  );
  await client.query(
    `DELETE FROM mcp_bundle_backend_tool_policies policy
      WHERE policy.backend_id = $1
        AND policy.mode = 'selected'
        AND NOT EXISTS (
          SELECT 1
            FROM (
              SELECT tool.name
                FROM mcp_tools tool
               WHERE tool.backend = $2
              UNION
              SELECT remote.prefixed_name AS name
                FROM mcp_remote_tools remote
               WHERE remote.backend_id = $1
            ) remaining
           WHERE NOT (remaining.name = ANY(policy.allowed_tool_names))
        )`,
    [backendRow.id, backend],
  );
}
