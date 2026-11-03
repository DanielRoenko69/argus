import type pg from 'pg';
import { getRemoteConnection } from '../backends/remoteMcpClients.js';

/**
 * Stable, provider-neutral capability categories used by Solution Pack
 * workflow preflight.  A bundle can provide more than one category (for
 * example Gitea is both a repository and a CI provider).
 */
export const BUNDLE_CAPABILITY_CATEGORIES = [
  'repository',
  'repository-checkout',
  'ci',
  'rag',
  'security',
  'workspace',
  'metrics',
  'logs',
  'traces',
  'topology',
  'runtime',
  'incident',
] as const;

export type BundleCapabilityCategory = typeof BUNDLE_CAPABILITY_CATEGORIES[number];

export interface BundleCapabilitySnapshot {
  bundleId: number;
  bundleName: string;
  categories: BundleCapabilityCategory[];
  signals: string[];
}

export interface BundleCapabilityCheck {
  ok: boolean;
  required: string[];
  provided: string[];
  missing: string[];
  /** Operational blockers that would make the same Bundle fail in agentRunner. */
  operationalBlockers?: string[];
  /** Machine-readable recovery targets for operator-facing preflight UX. */
  operationalIssues?: BundleOperationalIssue[];
  bundles: BundleCapabilitySnapshot[];
}

export interface BundleCapabilityCheckOptions {
  /** Restrict operational readiness to the backends that own these exact tools. */
  requiredToolNames?: string[];
}

export interface BundleOperationalIssue {
  bundleId: number;
  bundleName: string;
  backendId: number | null;
  backendName: string;
  kind: 'connection_disabled' | 'catalog_unverified' | 'catalog_changed' | 'catalog_quarantined' | 'connection_inactive';
  recovery: 'enable_connection' | 'review_catalog' | 'reconnect';
  message: string;
}

const CATEGORY_PATTERNS: Record<BundleCapabilityCategory, RegExp[]> = {
  repository: [
    /(?:^|[^a-z0-9])(?:gitea|github|gitlab|bitbucket|scm|repository|repo|git)(?:[^a-z0-9]|$)/i,
  ],
  // Added structurally by `isRepositoryCheckoutSource`. A repository MCP
  // catalog does not necessarily materialize a local Git working tree.
  'repository-checkout': [],
  ci: [
    /(?:^|[^a-z0-9])(?:jenkins|gitea|github|gitlab|ci|cd|actions|pipeline|build|runner)(?:[^a-z0-9]|$)/i,
  ],
  rag: [
    /(?:^|[^a-z0-9])(?:rag|qdrant|pgvector|vector|embedding|knowledge|retriev[a-z0-9]*|semantic|document|search)(?:[^a-z0-9]|$)/i,
  ],
  security: [
    /(?:^|[^a-z0-9])(?:security|sast|dast|trivy|snyk|dependabot|osv|vulnerabilit[a-z0-9]*|cve|scanner)(?:[^a-z0-9]|$)/i,
  ],
  workspace: [
    /(?:^|[^a-z0-9])(?:workspace|filesystem|file|shell|exec|terminal|docker)(?:[^a-z0-9]|$)/i,
  ],
  metrics: [
    /(?:^|[^a-z0-9])(?:prometheus|promql|metrics?|mimir|victoriametrics|influxdb|graphite)(?:[^a-z0-9]|$)/i,
  ],
  logs: [
    /(?:^|[^a-z0-9])(?:logs?|logging|logql|loki|opensearch|elasticsearch|kibana|splunk|graylog)(?:[^a-z0-9]|$)/i,
  ],
  traces: [
    /(?:^|[^a-z0-9])(?:traces?|tracing|traceql|tempo|jaeger|zipkin|apm|opentelemetry|otel)(?:[^a-z0-9]|$)/i,
  ],
  topology: [
    /(?:^|[^a-z0-9])(?:topology|dependency|dependencies|service.?map|service.?graph|backstage|cmdb|catalog|netbox)(?:[^a-z0-9]|$)/i,
  ],
  runtime: [
    /(?:^|[^a-z0-9])(?:kubernetes|k8s|openshift|docker|container|helm|argocd|flux|eks|aks|gke|terraform)(?:[^a-z0-9]|$)/i,
  ],
  incident: [
    /(?:^|[^a-z0-9])(?:incident|pagerduty|opsgenie|alertmanager|alerting|rootly|servicenow|on.?call)(?:[^a-z0-9]|$)/i,
  ],
};

type BundleRow = { id: number; name: string };
type SignalRow = { bundle_id: number; signal: string };
type BackendSignalRow = SignalRow & {
  backend_id?: number;
  backend_name?: string;
  backend_type?: 'http' | 'mcp' | 'builtin';
  enabled?: boolean;
  trust_status?: 'unverified' | 'trusted' | 'changed' | 'quarantined' | null;
  config?: Record<string, unknown> | null;
};

interface BundleCapabilityAssessment {
  bundles: BundleCapabilitySnapshot[];
  operationalBlockers: string[];
  operationalIssues: BundleOperationalIssue[];
}

function categorySignals(signals: string[]): BundleCapabilityCategory[] {
  const joined = signals.join(' ');
  return BUNDLE_CAPABILITY_CATEGORIES.filter(category =>
    CATEGORY_PATTERNS[category].some(pattern => pattern.test(joined)),
  );
}

function isRepositoryCheckoutSource(row: BackendSignalRow): boolean {
  const config = row.config ?? {};
  const kind = String(config['kind'] ?? '').trim().toLowerCase();
  if (!['bitbucket', 'gitea', 'github'].includes(kind)) return false;
  const repository = String(config['repo_slug'] ?? config['repo'] ?? '').trim();
  const owner = String(config['owner'] ?? config['project_key'] ?? config['user_slug'] ?? '').trim();
  return Boolean(repository && owner);
}

/**
 * Resolve capabilities from the actual MCP Fabric contents.  We deliberately
 * use backend/tool names and categories as signals instead of hard-coding
 * vendor IDs, so a self-hosted Jenkins, Gitea, Qdrant or an OpenAPI-imported
 * connection behaves the same way.
 */
async function assessBundleCapabilities(
  pool: pg.Pool,
  bundleIds: number[],
): Promise<BundleCapabilityAssessment> {
  const ids = [...new Set(bundleIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return { bundles: [], operationalBlockers: [], operationalIssues: [] };

  const bundles = await pool.query<BundleRow>(
    `SELECT id, name FROM mcp_service_bundles WHERE id = ANY($1::int[]) ORDER BY id`,
    [ids],
  );
  const signals = new Map<number, Set<string>>();
  for (const bundle of bundles.rows) signals.set(bundle.id, new Set([bundle.name]));

  // Backend names/descriptions are the strongest signal for provider
  // categories (e.g. gitea_local, jenkins-prod, qdrant).
  const backendRows = await pool.query<BackendSignalRow>(
    `SELECT bb.bundle_id,
            b.id AS backend_id,
            b.name AS backend_name,
            b.backend_type,
            b.enabled,
            registry.trust_status,
            b.config,
            lower(concat_ws(' ', b.name, b.description, b.backend_type,
                            b.base_url, b.mcp_endpoint)) AS signal
       FROM mcp_backend_bundles bb
       JOIN mcp_backends b ON b.id = bb.backend_id
       LEFT JOIN mcp_registry_entries registry ON registry.backend_id = b.id
      WHERE bb.bundle_id = ANY($1::int[])`,
    [ids],
  );
  for (const row of backendRows.rows) signals.get(row.bundle_id)?.add(row.signal);

  const bundleNames = new Map(bundles.rows.map(bundle => [bundle.id, bundle.name]));
  const operationalIssues = backendRows.rows.flatMap<BundleOperationalIssue>(row => {
    // Optional fields keep lightweight test doubles and older callers
    // backwards compatible; production SQL always supplies all of them.
    if (!row.backend_name || !row.backend_type) return [];
    const bundleName = bundleNames.get(row.bundle_id) ?? `Bundle ${row.bundle_id}`;
    const prefix = `${bundleName}: connection '${row.backend_name}'`;
    const common = {
      bundleId: row.bundle_id,
      bundleName,
      backendId: row.backend_id ?? null,
      backendName: row.backend_name,
    };
    if (row.enabled === false) return [{
      ...common,
      kind: 'connection_disabled' as const,
      recovery: 'enable_connection' as const,
      message: `${prefix} is disabled`,
    }];
    if (row.backend_type !== 'mcp') return [];
    if (row.trust_status !== 'trusted') {
      const trustStatus = row.trust_status ?? 'unverified';
      return [{
        ...common,
        kind: `catalog_${trustStatus}` as BundleOperationalIssue['kind'],
        recovery: 'review_catalog' as const,
        message: `${prefix} catalog is ${trustStatus}`,
      }];
    }
    const connection = row.backend_id == null ? undefined : getRemoteConnection(row.backend_id);
    if (!connection?.connected) return [{
      ...common,
      kind: 'connection_inactive' as const,
      recovery: 'reconnect' as const,
      message: `${prefix} is not active`,
    }];
    return [];
  });

  // Include both local/dynamic and discovered remote tool metadata.  Tool
  // categories are useful for OpenAPI imports and dedicated RAG/security
  // connectors whose backend name is generic.
  const toolRows = await pool.query<SignalRow>(
    `SELECT tb.bundle_id,
            lower(concat_ws(' ', t.name, t.description, t.backend, t.category)) AS signal
       FROM mcp_tool_bundles tb
       JOIN mcp_tools t ON t.id = tb.tool_id
      WHERE tb.bundle_id = ANY($1::int[])
     UNION ALL
     SELECT bb.bundle_id,
            lower(concat_ws(' ', rt.tool_name, rt.prefixed_name, rt.description, b.name)) AS signal
       FROM mcp_backend_bundles bb
       JOIN mcp_backends b ON b.id = bb.backend_id
       JOIN mcp_remote_tools rt ON rt.backend_id = b.id
      WHERE bb.bundle_id = ANY($1::int[])`,
    [ids],
  );
  for (const row of toolRows.rows) signals.get(row.bundle_id)?.add(row.signal);

  return {
    bundles: bundles.rows.map(bundle => {
      const values = [...(signals.get(bundle.id) ?? new Set<string>())].filter(Boolean);
      const categories = new Set(categorySignals(values));
      if (backendRows.rows.some(row => row.bundle_id === bundle.id && isRepositoryCheckoutSource(row))) {
        categories.add('repository-checkout');
      }
      return {
        bundleId: bundle.id,
        bundleName: bundle.name,
        categories: BUNDLE_CAPABILITY_CATEGORIES.filter(category => categories.has(category)),
        signals: values.slice(0, 32),
      };
    }),
    operationalBlockers: [...new Set(operationalIssues.map(issue => issue.message))],
    operationalIssues,
  };
}

export async function loadBundleToolBackendIds(
  pool: pg.Pool,
  bundleIds: number[],
  toolNames: string[],
): Promise<Set<number>> {
  const ids = [...new Set(bundleIds.filter(id => Number.isInteger(id) && id > 0))];
  const names = [...new Set(toolNames.map(name => name.trim()).filter(Boolean))];
  if (ids.length === 0 || names.length === 0) return new Set<number>();
  const result = await pool.query<{ backend_id: number | string }>(
    `/* required_tool_backend_scope */
     SELECT DISTINCT backend.id AS backend_id
       FROM mcp_backends backend
       JOIN mcp_backend_bundles backend_bundle
         ON backend_bundle.backend_id=backend.id AND backend_bundle.bundle_id=ANY($1::int[])
       JOIN mcp_tools tool
         ON tool.backend=backend.name OR tool.backend=('custom:' || backend.name)
       JOIN mcp_tool_bundles tool_bundle
         ON tool_bundle.tool_id=tool.id AND tool_bundle.bundle_id=backend_bundle.bundle_id
      WHERE tool.name=ANY($2::text[])
     UNION
     SELECT DISTINCT remote.backend_id
       FROM mcp_remote_tools remote
       JOIN mcp_backend_bundles backend_bundle
         ON backend_bundle.backend_id=remote.backend_id AND backend_bundle.bundle_id=ANY($1::int[])
      WHERE remote.tool_name=ANY($2::text[]) OR remote.prefixed_name=ANY($2::text[])`,
    [ids, names],
  );
  return new Set(result.rows.map(row => Number(row.backend_id))
    .filter(value => Number.isSafeInteger(value) && value > 0));
}

export async function loadBundleCapabilities(
  pool: pg.Pool,
  bundleIds: number[],
): Promise<BundleCapabilitySnapshot[]> {
  return (await assessBundleCapabilities(pool, bundleIds)).bundles;
}

export async function checkBundleCapabilities(
  pool: pg.Pool,
  bundleIds: number[],
  required: string[],
  options: BundleCapabilityCheckOptions = {},
): Promise<BundleCapabilityCheck> {
  // Unknown categories stay in `missing` so a malformed or newer Pack
  // contract fails closed instead of silently dropping its requirement.
  const normalizedRequired = [...new Set(required
    .map(value => value.trim().toLowerCase())
    .filter(Boolean))];
  const assessment = await assessBundleCapabilities(pool, bundleIds);
  const bundles = assessment.bundles;
  const provided: string[] = [...new Set(bundles.flatMap(bundle => bundle.categories))];
  const missing = normalizedRequired.filter(category => !provided.includes(category));
  let operationalIssues = assessment.operationalIssues;
  const requiredToolNames = [...new Set((options.requiredToolNames ?? [])
    .map(name => name.trim()).filter(Boolean))];
  if (requiredToolNames.length > 0 && operationalIssues.length > 0) {
    const relevantBackendIds = await loadBundleToolBackendIds(pool, bundleIds, requiredToolNames);
    // An unresolvable tool owner retains the bundle-wide fail-closed result.
    // A resolved allowlist can safely ignore unrelated connections from a
    // broader bundle (for example Kubernetes in a metrics-only AIOps lane).
    if (relevantBackendIds.size > 0) {
      operationalIssues = operationalIssues.filter(issue =>
        issue.backendId != null && relevantBackendIds.has(issue.backendId));
    }
  }
  const operationalBlockers = [...new Set(operationalIssues.map(issue => issue.message))];
  return {
    ok: missing.length === 0 && operationalBlockers.length === 0,
    required: normalizedRequired,
    provided,
    missing,
    operationalBlockers,
    operationalIssues,
    bundles,
  };
}
