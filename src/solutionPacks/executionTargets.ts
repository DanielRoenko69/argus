import type pg from 'pg';

const TARGET_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const NAMESPACE_PATTERN = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;

export const KUBERNETES_PLATFORMS = ['kubernetes', 'aks', 'eks', 'gke', 'openshift'] as const;
export type KubernetesPlatform = typeof KUBERNETES_PLATFORMS[number];

export interface ExecutionResourceScopeRequest {
  kind: 'kubernetes';
  backendId: number;
  targetId: string;
  namespace: string;
}

export interface ExecutionResourceScope extends ExecutionResourceScopeRequest {
  cluster: string;
  environment: string;
}

export interface ExecutionTarget extends ExecutionResourceScope {
  platform: KubernetesPlatform;
  label: string;
  targetLabel: string;
  backendName: string;
  bundleIds: number[];
}

export interface KubernetesExecutionTargetMutation {
  kind: 'kubernetes';
  platform?: KubernetesPlatform;
  targetId: string;
  label: string;
  cluster: string;
  environment: string;
  namespaces: string[];
}

export interface KubernetesExecutionTargetConfig {
  scope_kind: 'kubernetes';
  platform: KubernetesPlatform;
  target_id: string;
  target_label: string;
  cluster: string;
  environment: string;
  execution_namespaces: string[];
}

interface BackendTargetSource {
  id: number;
  name: string;
  description: string;
  enabled: boolean;
  config: Record<string, unknown> | null;
  bundle_ids: number[];
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function positiveIds(values: unknown): number[] {
  return Array.isArray(values)
    ? [...new Set(values.filter(value => Number.isInteger(value) && Number(value) > 0).map(Number))]
    : [];
}

function requiredText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be text`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${label} is required and must not exceed ${max} characters`);
  return normalized;
}

function kubernetesPlatform(value: unknown): KubernetesPlatform {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'kubernetes';
  if (!KUBERNETES_PLATFORMS.includes(normalized as KubernetesPlatform)) {
    throw new Error(`Kubernetes platform must be one of ${KUBERNETES_PLATFORMS.join(', ')}`);
  }
  return normalized as KubernetesPlatform;
}

export function normalizeKubernetesExecutionTargetMutation(value: unknown): KubernetesExecutionTargetConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Kubernetes execution target must be an object');
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(['kind', 'platform', 'targetId', 'label', 'cluster', 'environment', 'namespaces']);
  const unknown = Object.keys(input).find(key => !allowed.has(key));
  if (unknown) throw new Error(`Kubernetes execution target contains unknown field '${unknown}'`);
  if (input['kind'] !== 'kubernetes') throw new Error('Execution target kind must be kubernetes');
  const targetId = requiredText(input['targetId'], 128, 'Target ID');
  if (!TARGET_ID_PATTERN.test(targetId)) throw new Error('Target ID must be a lowercase slug');
  const label = requiredText(input['label'], 200, 'Target label');
  const cluster = requiredText(input['cluster'], 200, 'Cluster');
  const environment = requiredText(input['environment'], 120, 'Environment');
  if (!TARGET_ID_PATTERN.test(environment)) throw new Error('Environment must be a lowercase slug');
  if (!Array.isArray(input['namespaces'])) throw new Error('Namespaces must be a list');
  const namespaces = [...new Set(input['namespaces'].map(namespace =>
    requiredText(namespace, 63, 'Namespace')))].slice(0, 65);
  if (namespaces.length < 1 || namespaces.length > 64 || namespaces.some(namespace => !NAMESPACE_PATTERN.test(namespace))) {
    throw new Error('Provide between 1 and 64 valid Kubernetes namespaces');
  }
  return {
    scope_kind: 'kubernetes',
    platform: kubernetesPlatform(input['platform']),
    target_id: targetId,
    target_label: label,
    cluster,
    environment,
    execution_namespaces: namespaces,
  };
}

const EXECUTION_TARGET_CONFIG_KEYS = [
  'scope_kind', 'platform', 'target_id', 'target_label', 'cluster', 'environment', 'execution_namespaces',
] as const;

export function mergeExecutionTargetConfig(
  current: Record<string, unknown> | null | undefined,
  target: KubernetesExecutionTargetConfig | null,
): Record<string, unknown> {
  const merged = { ...(current ?? {}) };
  for (const key of EXECUTION_TARGET_CONFIG_KEYS) delete merged[key];
  return target ? { ...merged, ...target } : merged;
}

/**
 * Convert private backend configuration into a deliberately small, safe UI
 * contract. Credentials, endpoints and arbitrary provider config never leave
 * Core through this function.
 */
export function executionTargetsFromBackend(source: BackendTargetSource): ExecutionTarget[] {
  const config = source.config ?? {};
  if (!source.enabled || config['scope_kind'] !== 'kubernetes') return [];
  const targetId = text(config['target_id'], 128);
  let platform: KubernetesPlatform;
  try {
    platform = kubernetesPlatform(config['platform']);
  } catch {
    return [];
  }
  const cluster = text(config['cluster'], 200);
  const environment = text(config['environment'], 120) || 'production';
  const targetLabel = text(config['target_label'], 200) || source.description || source.name;
  const namespaces = Array.isArray(config['execution_namespaces'])
    ? [...new Set(config['execution_namespaces']
        .flatMap(value => typeof value === 'string' ? [value.trim()] : [])
        .filter(value => value.length <= 63 && NAMESPACE_PATTERN.test(value)))]
    : [];
  if (!TARGET_ID_PATTERN.test(targetId) || !cluster || namespaces.length === 0) return [];
  const bundleIds = positiveIds(source.bundle_ids);
  return namespaces.slice(0, 64).map(namespace => ({
    kind: 'kubernetes',
    platform,
    backendId: source.id,
    backendName: source.name,
    targetId,
    label: `${targetLabel} · ${namespace}`,
    targetLabel,
    cluster,
    namespace,
    environment,
    bundleIds,
  }));
}

export async function resolveExecutionResourceScope(
  pool: pg.Pool,
  bundleIds: number[],
  request: ExecutionResourceScopeRequest,
): Promise<ExecutionResourceScope> {
  if (request.kind !== 'kubernetes'
    || !Number.isInteger(request.backendId) || request.backendId <= 0
    || !TARGET_ID_PATTERN.test(request.targetId)
    || request.namespace.length > 63 || !NAMESPACE_PATTERN.test(request.namespace)) {
    throw new Error('requested execution target is malformed');
  }
  const result = await pool.query<BackendTargetSource>(
    `SELECT backend.id, backend.name, backend.description, backend.enabled, backend.config,
            COALESCE(array_agg(DISTINCT membership.bundle_id)
              FILTER (WHERE membership.bundle_id IS NOT NULL), '{}')::int[] AS bundle_ids
       FROM mcp_backends backend
       LEFT JOIN mcp_backend_bundles membership ON membership.backend_id=backend.id
      WHERE backend.id=$1
      GROUP BY backend.id`,
    [request.backendId],
  );
  const target = result.rows.flatMap(executionTargetsFromBackend).find(candidate =>
    candidate.kind === request.kind
    && candidate.targetId === request.targetId
    && candidate.namespace === request.namespace
    && candidate.bundleIds.some(bundleId => bundleIds.includes(bundleId)));
  if (!target) throw new Error('requested execution target is not enabled in the selected MCP bundle scope');
  return {
    kind: target.kind,
    backendId: target.backendId,
    targetId: target.targetId,
    cluster: target.cluster,
    namespace: target.namespace,
    environment: target.environment,
  };
}
