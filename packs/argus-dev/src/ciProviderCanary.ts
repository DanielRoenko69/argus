import type { CiRun, GitCreds } from './state.js';
import {
  buildCiProbeRequest,
  type CiRerunProvider,
} from './ciProvider.js';

export type CiCanaryStatus = 'ok' | 'failed' | 'timeout' | 'error';

export interface CiCanaryTargetSpec {
  provider: CiRerunProvider;
  base_url: string;
  owner: string;
  repo: string;
  run_id: string;
  run_url?: string;
  token_env: string;
}

export interface CiCanaryTarget {
  provider: CiRerunProvider;
  run: CiRun;
  creds: GitCreds;
}

export interface CiCanaryResult {
  provider: CiRerunProvider;
  external_id: string;
  status: CiCanaryStatus;
  http_status: number | null;
  latency_ms: number;
  provider_status?: string;
  error_message?: string;
}

export class CiCanaryConfigurationError extends Error {}
export class CiCanaryRateLimitError extends Error {}

const SUPPORTED = new Set<CiRerunProvider>(['gitea', 'github', 'gitlab', 'jenkins']);
let lastRunAt = 0;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : String(value ?? '').trim();
}

function boundedTimeout(value: unknown): number {
  const parsed = Number(value ?? 15_000);
  return Number.isFinite(parsed) ? Math.min(120_000, Math.max(1_000, Math.trunc(parsed))) : 15_000;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/(?:authorization|bearer|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 300);
}

function providerStatus(payload: Record<string, unknown>): string {
  const run = (payload['workflow_run'] ?? payload['pipeline'] ?? payload['build'] ?? payload['run'] ?? payload) as Record<string, unknown>;
  return text(run['status'] ?? run['conclusion'] ?? run['result']) || 'unknown';
}

function targetFromSpec(spec: CiCanaryTargetSpec, env: NodeJS.ProcessEnv): CiCanaryTarget {
  if (!SUPPORTED.has(spec.provider)) throw new CiCanaryConfigurationError(`Unsupported CI canary provider '${spec.provider}'`);
  const baseUrl = text(spec.base_url).replace(/\/+$/, '');
  const owner = text(spec.owner);
  const repo = text(spec.repo);
  const runId = text(spec.run_id);
  const tokenEnv = text(spec.token_env);
  if (!/^https?:\/\//i.test(baseUrl)) throw new CiCanaryConfigurationError('CI canary base_url must use http(s)');
  if (!owner || !repo || !runId) throw new CiCanaryConfigurationError('CI canary requires owner, repo and run_id');
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(tokenEnv)) throw new CiCanaryConfigurationError('CI canary token_env must be an environment variable name');
  const token = text(env[tokenEnv]);
  if (!token) throw new CiCanaryConfigurationError(`CI canary credential '${tokenEnv}' is not configured`);
  const kind = spec.provider === 'github' ? 'github' : 'gitea';
  const runUrl = text(spec.run_url) || `${baseUrl}/runs/${encodeURIComponent(runId)}`;
  return {
    provider: spec.provider,
    run: {
      provider: spec.provider,
      external_id: runId,
      workflow: 'live provider canary',
      status: 'unknown',
      conclusion: '',
      branch: '',
      commit_sha: '',
      run_url: runUrl,
      updated_at: new Date().toISOString(),
    },
    creds: {
      kind,
      base_url: baseUrl,
      token,
      project_key: owner,
      user_slug: '',
      repo_slug: repo,
      target_branch: 'main',
    },
  };
}

/** Parse the opt-in JSON target list without ever persisting its credentials. */
export function parseCiCanaryTargets(value: unknown, env: NodeJS.ProcessEnv = process.env): CiCanaryTarget[] {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value); } catch { throw new CiCanaryConfigurationError('ARGUS_CI_CANARY_TARGETS must be valid JSON'); }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) {
    throw new CiCanaryConfigurationError('ARGUS_CI_CANARY_TARGETS must contain 1 to 8 targets');
  }
  return parsed.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new CiCanaryConfigurationError('CI canary target must be an object');
    return targetFromSpec(item as CiCanaryTargetSpec, env);
  });
}

export function loadConfiguredCiCanaryTargets(env: NodeJS.ProcessEnv = process.env): CiCanaryTarget[] {
  if (env['ARGUS_CI_CANARIES_ENABLED'] !== '1') return [];
  const raw = text(env['ARGUS_CI_CANARY_TARGETS']);
  if (!raw) throw new CiCanaryConfigurationError('ARGUS_CI_CANARY_TARGETS is required when CI canaries are enabled');
  return parseCiCanaryTargets(raw, env);
}

export async function runCiProviderCanary(target: CiCanaryTarget, timeoutMs = 15_000): Promise<CiCanaryResult> {
  const started = Date.now();
  try {
    // Canary target configuration is explicit and must not be redirected by
    // the normal CI API override variables used for production retries.
    const request = buildCiProbeRequest(target.provider, target.run, target.creds, { ignoreEnvBase: true });
    const response = await fetch(request.url, { ...request.init, signal: AbortSignal.timeout(boundedTimeout(timeoutMs)) });
    const raw = await response.text().catch(() => '');
    let payload: Record<string, unknown> = {};
    try { payload = raw ? JSON.parse(raw) as Record<string, unknown> : {}; } catch { /* status-only provider response */ }
    const result: CiCanaryResult = {
      provider: target.provider,
      external_id: target.run.external_id,
      status: response.ok ? 'ok' : 'failed',
      http_status: response.status,
      latency_ms: Date.now() - started,
      ...(response.ok ? { provider_status: providerStatus(payload) } : { error_message: `HTTP ${response.status}` }),
    };
    return result;
  } catch (error) {
    const message = safeError(error);
    return {
      provider: target.provider,
      external_id: target.run.external_id,
      status: /timeout|abort/i.test(message) ? 'timeout' : 'error',
      http_status: null,
      latency_ms: Date.now() - started,
      error_message: message || 'unknown error',
    };
  }
}

/** Run all configured read-only probes with a process-local rollout guard. */
export async function runConfiguredCiProviderCanaries(
  env: NodeJS.ProcessEnv = process.env,
): Promise<CiCanaryResult[]> {
  const minIntervalMs = Math.min(86_400_000, Math.max(60_000, Number(env['ARGUS_CI_CANARIES_MIN_INTERVAL_MS'] ?? 900_000) || 900_000));
  if (Date.now() - lastRunAt < minIntervalMs) throw new CiCanaryRateLimitError(`CI canaries are rate-limited to one run every ${Math.ceil(minIntervalMs / 60_000)} minutes`);
  const targets = loadConfiguredCiCanaryTargets(env);
  if (!targets.length) return [];
  lastRunAt = Date.now();
  const timeoutMs = boundedTimeout(env['ARGUS_CI_CANARIES_TIMEOUT_MS']);
  return Promise.all(targets.map(target => runCiProviderCanary(target, timeoutMs)));
}
