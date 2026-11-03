import { createHash } from 'node:crypto';
import type pg from 'pg';
import { executionTargetsFromBackend, KUBERNETES_PLATFORMS, type KubernetesPlatform } from './executionTargets.js';

type Queryable = Pick<pg.Pool, 'query'>;

export type KubernetesCertificationStatus = 'passed' | 'failed';
export type KubernetesCertificationFreshness = 'fresh' | 'expiring' | 'stale';

export interface KubernetesCertificationPolicy {
  warningAgeHours: number;
  maxAgeHours: number;
  enforceAIOps: boolean;
}

export interface KubernetesCertificationCheck {
  id: string;
  status: KubernetesCertificationStatus;
  detail: string;
}

export interface NormalizedKubernetesCertificationReport {
  apiVersion: 'certification.argus.eu/v1alpha1';
  kind: 'KubernetesConnectorCertificationReport';
  targetId: string;
  platform: KubernetesPlatform;
  profile: 'in-cluster-read-only' | 'production';
  overall: KubernetesCertificationStatus;
  checks: KubernetesCertificationCheck[];
  generatedAt: string;
  contractSha256: string;
}

export interface KubernetesCertificationRecord {
  id: number;
  backendId: number;
  targetId: string;
  platform: KubernetesPlatform;
  profile: NormalizedKubernetesCertificationReport['profile'];
  status: KubernetesCertificationStatus;
  contractSha256: string;
  reportSha256: string;
  checkCount: number;
  passedCount: number;
  failedCount: number;
  failedChecks: KubernetesCertificationCheck[];
  generatedAt: string;
  importedAt: string;
  importedBy: string | null;
  freshness: KubernetesCertificationFreshness;
  ageHours: number;
  expiresAt: string;
}

export class KubernetesCertificationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const TARGET_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_WARNING_AGE_HOURS = 120;
const DEFAULT_MAX_AGE_HOURS = 168;

function boundedHours(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 8_760 ? parsed : fallback;
}

export function loadKubernetesCertificationPolicy(
  env: NodeJS.ProcessEnv = process.env,
): KubernetesCertificationPolicy {
  const maxAgeHours = Math.max(2, boundedHours(env['KUBERNETES_CERTIFICATION_MAX_AGE_HOURS'], DEFAULT_MAX_AGE_HOURS));
  const requestedWarning = boundedHours(
    env['KUBERNETES_CERTIFICATION_WARNING_AGE_HOURS'],
    Math.max(1, Math.min(DEFAULT_WARNING_AGE_HOURS, maxAgeHours - 1)),
  );
  return {
    warningAgeHours: Math.min(requestedWarning, Math.max(1, maxAgeHours - 1)),
    maxAgeHours,
    enforceAIOps: env['KUBERNETES_CERTIFICATION_ENFORCE_AIOPS'] !== 'false',
  };
}

export function evaluateKubernetesCertificationFreshness(
  generatedAt: string | Date,
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
  nowMs = Date.now(),
): { freshness: KubernetesCertificationFreshness; ageHours: number; expiresAt: string } {
  const generatedAtMs = generatedAt instanceof Date ? generatedAt.getTime() : Date.parse(generatedAt);
  if (!Number.isFinite(generatedAtMs)) throw new KubernetesCertificationError('Certification generation time is invalid');
  const ageHours = Math.max(0, (nowMs - generatedAtMs) / 3_600_000);
  const freshness = ageHours >= policy.maxAgeHours
    ? 'stale'
    : ageHours >= policy.warningAgeHours ? 'expiring' : 'fresh';
  return {
    freshness,
    ageHours: Math.round(ageHours * 10) / 10,
    expiresAt: new Date(generatedAtMs + policy.maxAgeHours * 3_600_000).toISOString(),
  };
}

function boundedText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new KubernetesCertificationError(`${label} must be text`);
  const normalized = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!normalized || normalized.length > max) throw new KubernetesCertificationError(`${label} is required and must not exceed ${max} characters`);
  return normalized;
}

export function normalizeKubernetesCertificationReport(value: unknown): NormalizedKubernetesCertificationReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KubernetesCertificationError('Certification report must be an object');
  }
  const input = value as Record<string, unknown>;
  if (input['apiVersion'] !== 'certification.argus.eu/v1alpha1'
    || input['kind'] !== 'KubernetesConnectorCertificationReport') {
    throw new KubernetesCertificationError('Unsupported Kubernetes connector certification report');
  }
  const targetId = boundedText(input['targetId'], 128, 'Target ID');
  if (!TARGET_ID_PATTERN.test(targetId)) throw new KubernetesCertificationError('Target ID must be a lowercase slug');
  const platform = boundedText(input['platform'], 16, 'Platform') as KubernetesPlatform;
  if (!KUBERNETES_PLATFORMS.includes(platform)) throw new KubernetesCertificationError('Unsupported Kubernetes platform');
  const profile = input['profile'];
  if (profile !== 'in-cluster-read-only' && profile !== 'production') throw new KubernetesCertificationError('Unsupported certification profile');
  const overall = input['overall'];
  if (overall !== 'passed' && overall !== 'failed') throw new KubernetesCertificationError('Certification status must be passed or failed');
  const contractSha256 = boundedText(input['contractSha256'], 64, 'Contract SHA-256').toLowerCase();
  if (!SHA256_PATTERN.test(contractSha256)) throw new KubernetesCertificationError('Contract SHA-256 is invalid');
  if (!Array.isArray(input['checks']) || input['checks'].length < 1 || input['checks'].length > 256) {
    throw new KubernetesCertificationError('Certification report must contain between 1 and 256 checks');
  }
  const ids = new Set<string>();
  const checks = input['checks'].map((value, index): KubernetesCertificationCheck => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new KubernetesCertificationError(`Check ${index + 1} is invalid`);
    }
    const check = value as Record<string, unknown>;
    const id = boundedText(check['id'], 160, `Check ${index + 1} ID`);
    if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(id) || ids.has(id)) {
      throw new KubernetesCertificationError(`Check ID ${id} is invalid or duplicated`);
    }
    ids.add(id);
    if (check['status'] !== 'passed' && check['status'] !== 'failed') {
      throw new KubernetesCertificationError(`Check ${id} has an invalid status`);
    }
    return {
      id,
      status: check['status'],
      detail: boundedText(check['detail'], 600, `Check ${id} detail`),
    };
  });
  const failedCount = checks.filter(check => check.status === 'failed').length;
  if ((overall === 'passed' && failedCount !== 0) || (overall === 'failed' && failedCount === 0)) {
    throw new KubernetesCertificationError('Overall certification status does not match its checks');
  }
  const generatedAtMs = Date.parse(boundedText(input['generatedAt'], 64, 'Generated at'));
  if (!Number.isFinite(generatedAtMs) || generatedAtMs > Date.now() + 5 * 60_000) {
    throw new KubernetesCertificationError('Certification generation time is invalid');
  }
  return {
    apiVersion: 'certification.argus.eu/v1alpha1',
    kind: 'KubernetesConnectorCertificationReport',
    targetId,
    platform,
    profile,
    overall,
    checks,
    generatedAt: new Date(generatedAtMs).toISOString(),
    contractSha256,
  };
}

function reportSha256(report: NormalizedKubernetesCertificationReport): string {
  return createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

type KubernetesCertificationRow = {
  id: number; backend_id: number; target_id: string; platform: KubernetesPlatform;
  profile: NormalizedKubernetesCertificationReport['profile']; status: KubernetesCertificationStatus;
  contract_sha256: string; report_sha256: string; checks: KubernetesCertificationCheck[];
  check_count: number; passed_count: number; failed_count: number;
  generated_at: string | Date; imported_at: string | Date; imported_by: string | null;
};

function mapRecord(
  row: KubernetesCertificationRow,
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
  nowMs = Date.now(),
): KubernetesCertificationRecord {
  const lifecycle = evaluateKubernetesCertificationFreshness(row.generated_at, policy, nowMs);
  return {
    id: Number(row.id), backendId: Number(row.backend_id), targetId: row.target_id, platform: row.platform,
    profile: row.profile, status: row.status, contractSha256: row.contract_sha256, reportSha256: row.report_sha256,
    checkCount: Number(row.check_count), passedCount: Number(row.passed_count), failedCount: Number(row.failed_count),
    failedChecks: row.checks.filter(check => check.status === 'failed'), generatedAt: iso(row.generated_at),
    importedAt: iso(row.imported_at), importedBy: row.imported_by,
    ...lifecycle,
  };
}

export async function importKubernetesCertification(
  pool: Queryable,
  input: { backendId: number; report: unknown; importedBy?: string | null },
): Promise<KubernetesCertificationRecord> {
  if (!Number.isInteger(input.backendId) || input.backendId <= 0) throw new KubernetesCertificationError('Backend ID is invalid');
  const report = normalizeKubernetesCertificationReport(input.report);
  const backend = await pool.query<{
    id: number; name: string; description: string; enabled: boolean; config: Record<string, unknown> | null; bundle_ids: number[];
  }>(
    `SELECT backend.id, backend.name, backend.description, backend.enabled, backend.config,
            COALESCE(array_agg(DISTINCT membership.bundle_id)
              FILTER (WHERE membership.bundle_id IS NOT NULL), '{}')::int[] AS bundle_ids
       FROM mcp_backends backend
       LEFT JOIN mcp_backend_bundles membership ON membership.backend_id=backend.id
      WHERE backend.id=$1
      GROUP BY backend.id`,
    [input.backendId],
  );
  const target = backend.rows.flatMap(executionTargetsFromBackend).find(candidate => candidate.targetId === report.targetId);
  if (!target) throw new KubernetesCertificationError('Certification target is not an enabled MCP Fabric execution target', 404);
  if (target.platform !== report.platform) throw new KubernetesCertificationError('Certification platform does not match the MCP Fabric target', 409);
  const passedCount = report.checks.filter(check => check.status === 'passed').length;
  const failedCount = report.checks.length - passedCount;
  const digest = reportSha256(report);
  const result = await pool.query<KubernetesCertificationRow>(
    `INSERT INTO mcp_kubernetes_connector_certifications
       (backend_id, target_id, platform, profile, status, contract_sha256, report_sha256,
        checks, check_count, passed_count, failed_count, generated_at, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (backend_id, target_id, report_sha256) DO UPDATE SET imported_at=now(), imported_by=EXCLUDED.imported_by
     RETURNING id, backend_id, target_id, platform, profile, status, contract_sha256, report_sha256,
               checks, check_count, passed_count, failed_count, generated_at, imported_at, imported_by`,
    [input.backendId, report.targetId, report.platform, report.profile, report.overall,
      report.contractSha256, digest, JSON.stringify(report.checks), report.checks.length,
      passedCount, failedCount, report.generatedAt, input.importedBy?.slice(0, 160) || null],
  );
  return mapRecord(result.rows[0]!);
}

export async function resolveKubernetesCertificationBackendId(
  pool: Queryable,
  targetId: string,
): Promise<number> {
  if (!TARGET_ID_PATTERN.test(targetId)) throw new KubernetesCertificationError('Target ID is invalid');
  const result = await pool.query<{
    id: number; name: string; description: string; enabled: boolean;
    config: Record<string, unknown> | null; bundle_ids: number[];
  }>(
    `SELECT backend.id, backend.name, backend.description, backend.enabled, backend.config,
            COALESCE(array_agg(DISTINCT membership.bundle_id)
              FILTER (WHERE membership.bundle_id IS NOT NULL), '{}')::int[] AS bundle_ids
       FROM mcp_backends backend
       LEFT JOIN mcp_backend_bundles membership ON membership.backend_id=backend.id
      WHERE backend.enabled=true
      GROUP BY backend.id
      ORDER BY backend.id`,
  );
  const candidates = result.rows.filter(backend =>
    executionTargetsFromBackend(backend).some(target => target.targetId === targetId));
  if (candidates.length === 0) {
    throw new KubernetesCertificationError('Certification target is not an enabled MCP Fabric execution target', 404);
  }
  if (candidates.length > 1) {
    throw new KubernetesCertificationError('Certification target is ambiguous; provide a backend ID', 409);
  }
  return Number(candidates[0]!.id);
}

export async function listLatestKubernetesCertifications(
  pool: Queryable,
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
): Promise<KubernetesCertificationRecord[]> {
  const result = await pool.query<KubernetesCertificationRow>(
    `SELECT DISTINCT ON (backend_id, target_id)
            id, backend_id, target_id, platform, profile, status, contract_sha256, report_sha256,
            checks, check_count, passed_count, failed_count, generated_at, imported_at, imported_by
       FROM mcp_kubernetes_connector_certifications
      ORDER BY backend_id, target_id, generated_at DESC, id DESC`,
  );
  const nowMs = Date.now();
  return result.rows.map(row => mapRecord(row, policy, nowMs));
}

export async function listKubernetesCertificationHistory(
  pool: Queryable,
  input: { backendId: number; targetId: string; limit?: number },
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
): Promise<KubernetesCertificationRecord[]> {
  if (!Number.isInteger(input.backendId) || input.backendId <= 0) throw new KubernetesCertificationError('Backend ID is invalid');
  if (!TARGET_ID_PATTERN.test(input.targetId)) throw new KubernetesCertificationError('Target ID is invalid');
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new KubernetesCertificationError('History limit must be between 1 and 50');
  const result = await pool.query<KubernetesCertificationRow>(
    `SELECT id, backend_id, target_id, platform, profile, status, contract_sha256, report_sha256,
            checks, check_count, passed_count, failed_count, generated_at, imported_at, imported_by
       FROM mcp_kubernetes_connector_certifications
      WHERE backend_id=$1 AND target_id=$2
      ORDER BY generated_at DESC, id DESC
      LIMIT $3`,
    [input.backendId, input.targetId, limit],
  );
  const nowMs = Date.now();
  return result.rows.map(row => mapRecord(row, policy, nowMs));
}

export async function getLatestKubernetesCertification(
  pool: Queryable,
  input: { backendId: number; targetId: string },
  policy: KubernetesCertificationPolicy = loadKubernetesCertificationPolicy(),
): Promise<KubernetesCertificationRecord | null> {
  const history = await listKubernetesCertificationHistory(pool, { ...input, limit: 1 }, policy);
  return history[0] ?? null;
}
