import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { Config } from '../config/env.js';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { executeTool, type ToolResult } from '../tools/toolRunner.js';
import type { ExecutionResourceScope, ExecutionResourceScopeRequest } from '../solutionPacks/executionTargets.js';
import {
  serviceDependenciesFromJaegerResult,
  upsertServiceDependencyEvidence,
  type ServiceDependencyEvidenceInput,
} from './serviceDependencies.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type ServiceCatalogSource = 'kubernetes' | 'opentelemetry' | 'logs' | 'alert_rule';

export interface ServiceCatalogEvidenceInput {
  serviceName: string;
  environment: string;
  source: Exclude<ServiceCatalogSource, 'alert_rule'>;
  sourceRef: string;
  bundleId: number;
  backendId?: number | null;
  targetId?: string | null;
  cluster?: string | null;
  namespace?: string | null;
  workloadKind?: string | null;
  workloadName?: string | null;
  attributes?: Record<string, string>;
  observedAt?: string;
  ttlMinutes?: number;
}

export interface ServiceCatalogTarget {
  backendId: number;
  targetId: string;
  cluster: string;
  namespace: string;
  workloads: Array<{ kind: string; name: string }>;
  lastSeenAt: string;
  current: boolean;
}

export interface ServiceCatalogEntry {
  id: string;
  serviceName: string;
  environment: string;
  sources: ServiceCatalogSource[];
  targets: ServiceCatalogTarget[];
  lastSeenAt: string;
  current: boolean;
  evidenceCount: number;
}

export interface ServiceCatalogResponse {
  generatedAt: string;
  entries: ServiceCatalogEntry[];
  summary: { services: number; current: number; kubernetes: number; opentelemetry: number; logs: number; configured: number };
}

interface EvidenceRow {
  service_name: string;
  environment: string;
  source: ServiceCatalogSource;
  backend_id: number | string | null;
  target_id: string | null;
  cluster: string | null;
  namespace: string | null;
  workload_kind: string | null;
  workload_name: string | null;
  observed_at: string | Date;
  current: boolean;
}

const SERVICE_NAME = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:/-]{0,158}[a-zA-Z0-9])?$/;

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function normalizedServiceName(value: unknown): string {
  const name = boundedText(value, 160);
  return SERVICE_NAME.test(name) ? name : '';
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function catalogId(serviceName: string, environment: string): string {
  return createHash('sha256').update(`${serviceName.toLowerCase()}\0${environment.toLowerCase()}`).digest('hex').slice(0, 24);
}

function evidenceKey(input: ServiceCatalogEvidenceInput): string {
  return createHash('sha256').update([
    input.source, input.sourceRef, input.serviceName.toLowerCase(), input.environment.toLowerCase(),
    input.backendId ?? '', input.targetId ?? '', input.namespace ?? '', input.workloadKind ?? '', input.workloadName ?? '',
  ].join('\0')).digest('hex');
}

function jsonCandidate(text: string): unknown {
  const trimmed = text.trim();
  for (const index of [trimmed.indexOf('{'), trimmed.indexOf('[')].filter(value => value >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(trimmed.slice(index)); } catch { /* try the next candidate */ }
  }
  return null;
}

function resultPayload(result: ToolResult): unknown {
  const text = result.content.map(part => part.text).join('\n');
  return jsonCandidate(text);
}

function metadataName(value: Record<string, unknown>): string {
  const metadata = value['metadata'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return '';
  return normalizedServiceName((metadata as Record<string, unknown>)['name']);
}

function objectLabels(value: Record<string, unknown>): Record<string, string> {
  const metadata = value['metadata'];
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const labels = (metadata as Record<string, unknown>)['labels'];
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return {};
  const allowed = new Set(['app.kubernetes.io/name', 'app.kubernetes.io/component', 'app.kubernetes.io/version', 'app', 'k8s-app']);
  return Object.fromEntries(Object.entries(labels as Record<string, unknown>)
    .flatMap(([key, child]) => allowed.has(key) && typeof child === 'string' ? [[key, child.slice(0, 200)]] : []));
}

function preferredServiceName(value: Record<string, unknown>, fallback: string): string {
  const labels = objectLabels(value);
  return normalizedServiceName(labels['app.kubernetes.io/name'])
    || normalizedServiceName(labels['app'])
    || normalizedServiceName(labels['k8s-app'])
    || fallback;
}

function collectKubernetesObjects(value: unknown, output: Array<{ kind: string; name: string; serviceName: string; labels: Record<string, string> }>): void {
  if (Array.isArray(value)) {
    for (const child of value) collectKubernetesObjects(child, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  const kind = boundedText(object['kind'], 64);
  const name = metadataName(object);
  if (kind && name && ['service', 'deployment', 'statefulset', 'daemonset'].includes(kind.toLowerCase())) {
    output.push({ kind, name, serviceName: preferredServiceName(object, name), labels: objectLabels(object) });
  }
  for (const child of Object.values(object)) collectKubernetesObjects(child, output);
}

function collectStrings(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    const name = normalizedServiceName(value);
    if (name) output.push(name);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectStrings(child, output);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object['data'])) collectStrings(object['data'], output);
  else if (Array.isArray(object['services'])) collectStrings(object['services'], output);
}

export function serviceEvidenceFromKubernetesResult(
  result: ToolResult,
  context: { bundleId: number; scope: ExecutionResourceScope; sourceRef: string },
): ServiceCatalogEvidenceInput[] {
  if (result.isError) return [];
  const objects: Array<{ kind: string; name: string; serviceName: string; labels: Record<string, string> }> = [];
  collectKubernetesObjects(resultPayload(result), objects);
  return objects.map(object => ({
    serviceName: object.serviceName,
    environment: context.scope.environment,
    source: 'kubernetes',
    sourceRef: context.sourceRef,
    bundleId: context.bundleId,
    backendId: context.scope.backendId,
    targetId: context.scope.targetId,
    cluster: context.scope.cluster,
    namespace: context.scope.namespace,
    workloadKind: object.kind,
    workloadName: object.name,
    attributes: object.labels,
    ttlMinutes: 60,
  }));
}

export function serviceEvidenceFromOtelResult(
  result: ToolResult,
  context: { bundleId: number; environment: string; sourceRef: string },
): ServiceCatalogEvidenceInput[] {
  if (result.isError) return [];
  const services: string[] = [];
  collectStrings(resultPayload(result), services);
  return [...new Set(services)].map(serviceName => ({
    serviceName,
    environment: context.environment,
    source: 'opentelemetry',
    sourceRef: context.sourceRef,
    bundleId: context.bundleId,
    ttlMinutes: 60,
  }));
}

export function serviceEvidenceFromLokiResult(
  result: ToolResult,
  context: { bundleId: number; environment: string; sourceRef: string },
): ServiceCatalogEvidenceInput[] {
  if (result.isError) return [];
  const services: string[] = [];
  collectStrings(resultPayload(result), services);
  return [...new Set(services)].map(serviceName => ({
    serviceName,
    environment: context.environment,
    source: 'logs',
    sourceRef: context.sourceRef,
    bundleId: context.bundleId,
    ttlMinutes: 60,
  }));
}

export async function upsertServiceCatalogEvidence(pool: Queryable, evidence: ServiceCatalogEvidenceInput[]): Promise<number> {
  let count = 0;
  for (const raw of evidence.slice(0, 1_000)) {
    const serviceName = normalizedServiceName(raw.serviceName);
    const environment = boundedText(raw.environment, 120);
    const sourceRef = boundedText(raw.sourceRef, 200);
    if (!serviceName || !environment || !sourceRef || !['kubernetes', 'opentelemetry', 'logs'].includes(raw.source)) continue;
    const observedAt = raw.observedAt && Number.isFinite(Date.parse(raw.observedAt)) ? new Date(raw.observedAt) : new Date();
    const ttlMinutes = Math.max(5, Math.min(24 * 60, Math.trunc(raw.ttlMinutes ?? 60)));
    const expiresAt = new Date(observedAt.getTime() + ttlMinutes * 60_000);
    await pool.query(
      `INSERT INTO mcp_observability_service_catalog_evidence
        (identity_key, service_name, environment, source, source_ref, bundle_id, backend_id,
         target_id, cluster, namespace, workload_kind, workload_name, attributes, observed_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       ON CONFLICT (identity_key) DO UPDATE SET
         service_name=EXCLUDED.service_name, environment=EXCLUDED.environment,
         bundle_id=EXCLUDED.bundle_id, backend_id=EXCLUDED.backend_id,
         target_id=EXCLUDED.target_id, cluster=EXCLUDED.cluster, namespace=EXCLUDED.namespace,
         workload_kind=EXCLUDED.workload_kind, workload_name=EXCLUDED.workload_name,
         attributes=EXCLUDED.attributes, observed_at=EXCLUDED.observed_at,
         expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [
        evidenceKey({ ...raw, serviceName, environment, sourceRef }), serviceName, environment, raw.source, sourceRef,
        raw.bundleId, raw.backendId ?? null, boundedText(raw.targetId, 128) || null,
        boundedText(raw.cluster, 200) || null, boundedText(raw.namespace, 63) || null,
        boundedText(raw.workloadKind, 64) || null, boundedText(raw.workloadName, 200) || null,
        JSON.stringify(raw.attributes ?? {}), observedAt, expiresAt,
      ],
    );
    count++;
  }
  return count;
}

export async function listServiceCatalog(pool: Queryable): Promise<ServiceCatalogResponse> {
  const result = await pool.query<EvidenceRow>(
    `SELECT service_name, environment, source, backend_id, target_id, cluster, namespace,
            workload_kind, workload_name, observed_at, expires_at > now() AS current
       FROM mcp_observability_service_catalog_evidence
      WHERE expires_at > now() - interval '30 days'
     UNION ALL
     SELECT COALESCE(NULLIF(metadata->>'service.name',''), NULLIF(metadata->>'service_name',''), NULLIF(metadata->>'service','')) AS service_name,
            COALESCE(NULLIF(metadata->>'deployment.environment.name',''), NULLIF(metadata->>'deployment.environment',''), NULLIF(metadata->>'environment',''), 'unknown') AS environment,
            'opentelemetry' AS source, NULL AS backend_id, NULL AS target_id,
            NULLIF(metadata->>'k8s.cluster.name','') AS cluster,
            NULLIF(metadata->>'k8s.namespace.name','') AS namespace,
            NULLIF(metadata->>'k8s.workload.kind','') AS workload_kind,
            COALESCE(NULLIF(metadata->>'k8s.deployment.name',''), NULLIF(metadata->>'k8s.statefulset.name',''), NULLIF(metadata->>'k8s.daemonset.name','')) AS workload_name,
            max(started_at) AS observed_at,
            max(started_at) > now() - interval '24 hours' AS current
       FROM mcp_observability_traces
      WHERE started_at > now() - interval '30 days'
        AND COALESCE(NULLIF(metadata->>'service.name',''), NULLIF(metadata->>'service_name',''), NULLIF(metadata->>'service','')) IS NOT NULL
      GROUP BY service_name, environment, cluster, namespace, workload_kind, workload_name
     UNION ALL
     SELECT rule.aiops_service AS service_name, rule.aiops_environment AS environment,
            'alert_rule' AS source,
            CASE WHEN (rule.aiops_resource_scope->>'backendId') ~ '^[0-9]+$' THEN (rule.aiops_resource_scope->>'backendId')::int ELSE NULL END AS backend_id,
            rule.aiops_resource_scope->>'targetId' AS target_id,
            backend.config->>'cluster' AS cluster,
            rule.aiops_resource_scope->>'namespace' AS namespace,
            NULL AS workload_kind, NULL AS workload_name, rule.updated_at AS observed_at, rule.enabled AS current
       FROM mcp_observability_alert_rules rule
       LEFT JOIN mcp_backends backend
         ON backend.id=CASE WHEN (rule.aiops_resource_scope->>'backendId') ~ '^[0-9]+$' THEN (rule.aiops_resource_scope->>'backendId')::int ELSE NULL END
      WHERE rule.archived_at IS NULL AND rule.aiops_auto_investigate
        AND rule.aiops_service IS NOT NULL AND rule.aiops_environment IS NOT NULL`,
  );
  const entries = new Map<string, ServiceCatalogEntry>();
  for (const row of result.rows) {
    const serviceName = normalizedServiceName(row.service_name);
    const environment = boundedText(row.environment, 120) || 'unknown';
    if (!serviceName) continue;
    const id = catalogId(serviceName, environment);
    const observedAt = iso(row.observed_at);
    const entry = entries.get(id) ?? {
      id, serviceName, environment, sources: [], targets: [], lastSeenAt: observedAt, current: false, evidenceCount: 0,
    };
    entry.evidenceCount++;
    if (!entry.sources.includes(row.source)) entry.sources.push(row.source);
    if (Date.parse(observedAt) > Date.parse(entry.lastSeenAt)) entry.lastSeenAt = observedAt;
    entry.current ||= Boolean(row.current);
    const backendId = row.backend_id == null ? 0 : Number(row.backend_id);
    if (backendId > 0 && row.target_id && row.cluster && row.namespace) {
      let target = entry.targets.find(candidate => candidate.backendId === backendId
        && candidate.targetId === row.target_id && candidate.namespace === row.namespace);
      if (!target) {
        target = { backendId, targetId: row.target_id, cluster: row.cluster, namespace: row.namespace, workloads: [], lastSeenAt: observedAt, current: false };
        entry.targets.push(target);
      }
      target.current ||= Boolean(row.current);
      if (Date.parse(observedAt) > Date.parse(target.lastSeenAt)) target.lastSeenAt = observedAt;
      if (row.workload_kind && row.workload_name && !target.workloads.some(workload => workload.kind === row.workload_kind && workload.name === row.workload_name)) {
        target.workloads.push({ kind: row.workload_kind, name: row.workload_name });
      }
    }
    entries.set(id, entry);
  }
  const list = [...entries.values()]
    .map(entry => ({ ...entry, sources: entry.sources.sort(), targets: entry.targets.sort((a, b) => a.cluster.localeCompare(b.cluster) || a.namespace.localeCompare(b.namespace)) }))
    .sort((left, right) => Number(right.current) - Number(left.current) || left.serviceName.localeCompare(right.serviceName) || left.environment.localeCompare(right.environment));
  return {
    generatedAt: new Date().toISOString(),
    entries: list,
    summary: {
      services: list.length,
      current: list.filter(entry => entry.current).length,
      kubernetes: list.filter(entry => entry.sources.includes('kubernetes')).length,
      opentelemetry: list.filter(entry => entry.sources.includes('opentelemetry')).length,
      logs: list.filter(entry => entry.sources.includes('logs')).length,
      configured: list.filter(entry => entry.sources.includes('alert_rule')).length,
    },
  };
}

export async function refreshServiceCatalog(
  pool: pg.Pool,
  config: Config,
  input: { bundleId: number; scope: ExecutionResourceScopeRequest; resolvedScope: ExecutionResourceScope },
): Promise<{ discovered: number; dependencies: number; sources: string[]; warnings: string[] }> {
  const allowed = await loadAllowedToolNames(pool, [input.bundleId], { includeUnscoped: false });
  const evidence: ServiceCatalogEvidenceInput[] = [];
  const dependencyEvidence: ServiceDependencyEvidenceInput[] = [];
  const sources: string[] = [];
  const warnings: string[] = [];
  const kubernetesTool = [...allowed].find(name => name.endsWith('k8s_get_resources'));
  if (kubernetesTool) {
    for (const resourceType of ['service', 'deployment']) {
      const result = await executeTool(kubernetesTool, {
        resource_type: resourceType,
        namespace: input.resolvedScope.namespace,
        output: 'json',
      }, { pool, config, allowedBundles: [input.bundleId] });
      if (result.isError) warnings.push(`Kubernetes ${resourceType} discovery failed`);
      else evidence.push(...serviceEvidenceFromKubernetesResult(result, {
        bundleId: input.bundleId,
        scope: input.resolvedScope,
        sourceRef: kubernetesTool,
      }));
    }
    sources.push('kubernetes');
  } else warnings.push('Selected bundle does not expose a Kubernetes resource listing tool');
  const otelTool = [...allowed].find(name => name.endsWith('jaeger_services'));
  let otelServices: ServiceCatalogEvidenceInput[] = [];
  if (otelTool) {
    const result = await executeTool(otelTool, {}, { pool, config, allowedBundles: [input.bundleId] });
    if (result.isError) warnings.push('OpenTelemetry service discovery failed');
    else {
      otelServices = serviceEvidenceFromOtelResult(result, {
        bundleId: input.bundleId,
        environment: input.resolvedScope.environment,
        sourceRef: otelTool,
      });
      evidence.push(...otelServices);
    }
    sources.push('opentelemetry');
  } else warnings.push('Selected bundle does not expose an OpenTelemetry service catalog tool');
  const traceSearchTool = [...allowed].find(name => name.endsWith('jaeger_find_traces'));
  if (traceSearchTool && otelServices.length > 0) {
    const endMicros = BigInt(Date.now()) * 1_000n;
    const startMicros = endMicros - 60n * 60n * 1_000_000n;
    let traceFailures = 0;
    for (const service of otelServices.slice(0, 12)) {
      const result = await executeTool(traceSearchTool, {
        service: service.serviceName,
        start_micros: startMicros.toString(),
        end_micros: endMicros.toString(),
        limit: 20,
      }, { pool, config, allowedBundles: [input.bundleId] });
      if (result.isError) {
        traceFailures++;
        continue;
      }
      dependencyEvidence.push(...serviceDependenciesFromJaegerResult(result, {
        bundleId: input.bundleId,
        environment: input.resolvedScope.environment,
        sourceRef: traceSearchTool,
      }));
    }
    if (traceFailures > 0) warnings.push(`Runtime dependency discovery failed for ${traceFailures} trace service${traceFailures === 1 ? '' : 's'}`);
  } else if (otelTool && !traceSearchTool) warnings.push('Selected bundle does not expose bounded trace search for runtime dependencies');
  const lokiTool = [...allowed].find(name => name.endsWith('loki_label_values'));
  if (lokiTool) {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60_000);
    const result = await executeTool(lokiTool, {
      label_name: 'service',
      start: start.toISOString(),
      end: end.toISOString(),
    }, { pool, config, allowedBundles: [input.bundleId] });
    if (result.isError) warnings.push('Log service discovery failed');
    else evidence.push(...serviceEvidenceFromLokiResult(result, {
      bundleId: input.bundleId,
      environment: input.resolvedScope.environment,
      sourceRef: lokiTool,
    }));
    sources.push('logs');
  } else warnings.push('Selected bundle does not expose a log service catalog tool');
  const [discovered, dependencies] = await Promise.all([
    upsertServiceCatalogEvidence(pool, evidence),
    upsertServiceDependencyEvidence(pool, dependencyEvidence),
  ]);
  return { discovered, dependencies, sources, warnings };
}
