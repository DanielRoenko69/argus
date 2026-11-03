import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { ToolResult } from '../tools/toolRunner.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type ServiceDependencyTargetKind = 'service' | 'database' | 'messaging' | 'external';
export type ServiceDependencyRelation = 'calls' | 'queries' | 'publishes';

export interface ServiceDependencyEvidenceInput {
  identitySeed: string;
  environment: string;
  sourceService: string;
  targetKind: ServiceDependencyTargetKind;
  targetName: string;
  relation: ServiceDependencyRelation;
  bundleId: number;
  sourceRef: string;
  durationMs?: number | null;
  failed: boolean;
  observedAt: string;
  ttlMinutes?: number;
}

export interface ServiceDependencyAggregate {
  environment: string;
  sourceService: string;
  targetKind: ServiceDependencyTargetKind;
  targetName: string;
  relation: ServiceDependencyRelation;
  calls: number;
  failures: number;
  p95DurationMs: number | null;
  lastSeenAt: string;
  current: boolean;
}

type DependencyRow = {
  environment: string;
  source_service: string;
  target_kind: ServiceDependencyTargetKind;
  target_name: string;
  relation: ServiceDependencyRelation;
  calls: number | string;
  failures: number | string;
  p95_duration_ms: number | string | null;
  last_seen_at: string | Date;
  current: boolean;
};

const IDENTITY = /^[a-zA-Z0-9](?:[a-zA-Z0-9._:/-]{0,158}[a-zA-Z0-9])?$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function boundedText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '';
}

function identity(value: unknown): string {
  const normalized = boundedText(value, 160);
  return IDENTITY.test(normalized) ? normalized : '';
}

function jsonPayload(result: ToolResult): unknown {
  const text = result.content.map(part => part.text).join('\n').trim();
  for (const offset of [text.indexOf('{'), text.indexOf('[')].filter(value => value >= 0).sort((a, b) => a - b)) {
    try { return JSON.parse(text.slice(offset)); } catch { /* try next JSON candidate */ }
  }
  return null;
}

function tagMap(value: unknown): Map<string, unknown> {
  const tags = new Map<string, unknown>();
  if (!Array.isArray(value)) return tags;
  for (const candidate of value) {
    const tag = record(candidate);
    const key = boundedText(tag?.['key'], 120);
    if (key) tags.set(key, tag?.['value']);
  }
  return tags;
}

function processService(value: unknown): { service: string; environment: string } | null {
  const process = record(value);
  const service = identity(process?.['serviceName']);
  if (!service) return null;
  const tags = tagMap(process?.['tags']);
  const environment = identity(tags.get('deployment.environment.name'))
    || identity(tags.get('deployment.environment'));
  return { service, environment };
}

function explicitTarget(tags: Map<string, unknown>): {
  kind: ServiceDependencyTargetKind;
  name: string;
  relation: ServiceDependencyRelation;
} | null {
  const peerService = identity(tags.get('peer.service')) || identity(tags.get('rpc.service'));
  if (peerService) return { kind: 'service', name: peerService, relation: 'calls' };
  const database = identity(tags.get('db.system'));
  if (database) return { kind: 'database', name: database, relation: 'queries' };
  const messaging = identity(tags.get('messaging.system'));
  if (messaging) return { kind: 'messaging', name: messaging, relation: 'publishes' };
  const external = identity(tags.get('server.address'))
    || identity(tags.get('net.peer.name'))
    || identity(tags.get('url.domain'))
    || identity(tags.get('http.host'));
  return external ? { kind: 'external', name: external, relation: 'calls' } : null;
}

function failedSpan(tags: Map<string, unknown>): boolean {
  if (tags.get('error') === true) return true;
  if (String(tags.get('otel.status_code') ?? '').toUpperCase() === 'ERROR') return true;
  const httpStatus = Number(tags.get('http.response.status_code') ?? tags.get('http.status_code'));
  if (Number.isFinite(httpStatus) && httpStatus >= 500) return true;
  const rpcStatus = Number(tags.get('rpc.grpc.status_code'));
  return Number.isFinite(rpcStatus) && rpcStatus !== 0;
}

function observedAt(value: unknown, fallback: string): string {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return fallback;
  const date = new Date(Math.trunc(micros / 1_000));
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

export function serviceDependenciesFromJaegerResult(
  result: ToolResult,
  context: { bundleId: number; environment: string; sourceRef: string; observedAt?: string },
): ServiceDependencyEvidenceInput[] {
  if (result.isError) return [];
  const payload = record(jsonPayload(result));
  const traces = Array.isArray(payload?.['data']) ? payload!['data'] as unknown[] : [];
  const evidence = new Map<string, ServiceDependencyEvidenceInput>();
  const fallbackObservedAt = context.observedAt ?? new Date().toISOString();
  const scopedEnvironment = identity(context.environment).toLowerCase();
  for (const traceValue of traces.slice(0, 100)) {
    const trace = record(traceValue);
    const traceId = boundedText(trace?.['traceID'], 64);
    const processValues = record(trace?.['processes']) ?? {};
    const processes = new Map<string, { service: string; environment: string }>();
    for (const [processId, processValue] of Object.entries(processValues)) {
      const normalized = processService(processValue);
      if (normalized) processes.set(processId, normalized);
    }
    const spans = Array.isArray(trace?.['spans']) ? trace!['spans'] as unknown[] : [];
    const spanById = new Map<string, Record<string, unknown>>();
    for (const spanValue of spans) {
      const span = record(spanValue);
      const spanId = boundedText(span?.['spanID'], 64);
      if (span && spanId) spanById.set(spanId, span);
    }
    for (const spanValue of spans.slice(0, 2_000)) {
      const span = record(spanValue);
      const spanId = boundedText(span?.['spanID'], 64);
      const process = processes.get(boundedText(span?.['processID'], 128));
      if (!span || !spanId || !process) continue;
      const tags = tagMap(span['tags']);
      const durationMicros = Number(span['duration']);
      const durationMs = Number.isFinite(durationMicros) && durationMicros >= 0 ? Math.round(durationMicros / 1_000) : null;
      const spanFailed = failedSpan(tags);
      const spanObservedAt = observedAt(span['startTime'], fallbackObservedAt);
      const sourceInScope = Boolean(process.environment)
        && process.environment.toLowerCase() === scopedEnvironment;
      const add = (targetKind: ServiceDependencyTargetKind, targetName: string, relation: ServiceDependencyRelation) => {
        if (!targetName || targetName.toLowerCase() === process.service.toLowerCase()) return;
        const identitySeed = [traceId, spanId, process.service, targetKind, targetName, relation].join('\0');
        evidence.set(identitySeed, {
          identitySeed,
          environment: process.environment,
          sourceService: process.service,
          targetKind,
          targetName,
          relation,
          bundleId: context.bundleId,
          sourceRef: context.sourceRef,
          durationMs,
          failed: spanFailed,
          observedAt: spanObservedAt,
          ttlMinutes: 24 * 60,
        });
      };

      const target = explicitTarget(tags);
      if (target && sourceInScope) add(target.kind, target.name, target.relation);

      const references = Array.isArray(span['references']) ? span['references'] as unknown[] : [];
      const parentReference = references.map(record).find(reference => reference?.['refType'] === 'CHILD_OF');
      const parent = parentReference ? spanById.get(boundedText(parentReference['spanID'], 64)) : null;
      const parentProcess = parent ? processes.get(boundedText(parent['processID'], 128)) : null;
      const parentInScope = Boolean(parentProcess?.environment)
        && parentProcess!.environment.toLowerCase() === scopedEnvironment;
      if (parentProcess && parentInScope && parentProcess.service.toLowerCase() !== process.service.toLowerCase()) {
        const childTarget = process.service;
        const identitySeed = [traceId, spanId, parentProcess.service, 'service', childTarget, 'calls'].join('\0');
        evidence.set(identitySeed, {
          identitySeed,
          environment: parentProcess.environment,
          sourceService: parentProcess.service,
          targetKind: 'service',
          targetName: childTarget,
          relation: 'calls',
          bundleId: context.bundleId,
          sourceRef: context.sourceRef,
          durationMs,
          failed: spanFailed,
          observedAt: spanObservedAt,
          ttlMinutes: 24 * 60,
        });
      }
    }
  }
  return [...evidence.values()];
}

export async function upsertServiceDependencyEvidence(
  pool: Queryable,
  evidence: ServiceDependencyEvidenceInput[],
): Promise<number> {
  let count = 0;
  for (const raw of evidence.slice(0, 5_000)) {
    const environment = identity(raw.environment);
    const sourceService = identity(raw.sourceService);
    const targetName = identity(raw.targetName);
    const sourceRef = boundedText(raw.sourceRef, 200);
    const observed = new Date(raw.observedAt);
    if (!environment || !sourceService || !targetName || !sourceRef
      || sourceService.toLowerCase() === targetName.toLowerCase()
      || !Number.isFinite(observed.getTime())) continue;
    const ttlMinutes = Math.max(60, Math.min(7 * 24 * 60, Math.trunc(raw.ttlMinutes ?? 24 * 60)));
    const expires = new Date(observed.getTime() + ttlMinutes * 60_000);
    const identityKey = createHash('sha256').update(raw.identitySeed).digest('hex');
    await pool.query(
      `INSERT INTO mcp_observability_service_dependency_evidence
        (identity_key, environment, source_service, target_kind, target_name, relation,
         bundle_id, source_ref, duration_ms, failed, observed_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (identity_key) DO UPDATE SET
         environment=EXCLUDED.environment, bundle_id=EXCLUDED.bundle_id,
         source_ref=EXCLUDED.source_ref, duration_ms=EXCLUDED.duration_ms,
         failed=EXCLUDED.failed, observed_at=EXCLUDED.observed_at,
         expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [identityKey, environment, sourceService, raw.targetKind, targetName, raw.relation,
        raw.bundleId, sourceRef, raw.durationMs ?? null, raw.failed, observed, expires],
    );
    count++;
  }
  return count;
}

export async function listServiceDependencies(pool: Queryable): Promise<ServiceDependencyAggregate[]> {
  const result = await pool.query<DependencyRow>(
    `SELECT environment, source_service, target_kind, target_name, relation,
            count(*)::int AS calls,
            count(*) FILTER (WHERE failed)::int AS failures,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)
              FILTER (WHERE duration_ms IS NOT NULL) AS p95_duration_ms,
            max(observed_at) AS last_seen_at,
            bool_or(expires_at > now()) AS current
       FROM mcp_observability_service_dependency_evidence
      WHERE expires_at > now() - interval '30 days'
      GROUP BY environment, source_service, target_kind, target_name, relation
      ORDER BY failures DESC, calls DESC, source_service, target_name`,
  );
  return result.rows.map(row => ({
    environment: row.environment,
    sourceService: row.source_service,
    targetKind: row.target_kind,
    targetName: row.target_name,
    relation: row.relation,
    calls: Number(row.calls),
    failures: Number(row.failures),
    p95DurationMs: row.p95_duration_ms == null ? null : Math.round(Number(row.p95_duration_ms)),
    lastSeenAt: (row.last_seen_at instanceof Date ? row.last_seen_at : new Date(row.last_seen_at)).toISOString(),
    current: Boolean(row.current),
  }));
}
