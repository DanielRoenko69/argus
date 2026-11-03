import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  parseSolutionPackManifestDocument,
  SolutionPackManifestError,
  type SolutionPackManifest,
} from './manifest.js';
import { logger } from '../lib/logger.js';

export const SOLUTION_PACK_MANIFEST_PATH = '/.well-known/argus-solution-pack.yaml';
const PACK_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const MAX_ENDPOINTS = 32;
const MAX_SERVICE_TOKEN_BYTES = 8 * 1024;

export interface SolutionPackEndpoint {
  packId: string;
  endpoint: string;
  tokenFile?: string;
}

export type SolutionPackDiscoveryState =
  | 'not_checked'
  | 'ready'
  | 'degraded'
  | 'unreachable'
  | 'invalid'
  | 'incompatible';

export interface SolutionPackProbeResult {
  ok: boolean;
  status?: number;
  latencyMs: number;
  error?: string;
}

export interface SolutionPackDiscoveryResult {
  configuredId: string;
  endpoint: string;
  state: SolutionPackDiscoveryState;
  checkedAt: string | null;
  manifest?: SolutionPackManifest;
  health?: SolutionPackProbeResult;
  readiness?: SolutionPackProbeResult;
  error?: string;
  revision?: number;
  previousVersion?: string;
  previousManifest?: SolutionPackManifest;
}

export type SolutionPackRollbackStatus = 'pending' | 'accepted' | 'applied' | 'failed' | 'canceled';

export interface SolutionPackRollbackRequest {
  id: string;
  packId: string;
  requestedBy: string;
  reason: string;
  sourceRevision: number;
  currentVersion: string | null;
  targetVersion: string;
  targetManifest: SolutionPackManifest;
  status: SolutionPackRollbackStatus;
  error: string | null;
  requestedAt: string;
  updatedAt: string;
  appliedAt: string | null;
  claimedBy?: string | null;
  claimedAt?: string | null;
  claimExpiresAt?: string | null;
}

export interface SolutionPackRollbackRequestInput {
  packId: string;
  requestedBy: string;
  reason: string;
  sourceRevision: number;
  currentVersion: string | null;
  targetVersion: string;
  targetManifest: SolutionPackManifest;
}

export interface SolutionPackDiscoveryOptions {
  coreVersion: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  readTokenFile?: (filename: string) => Promise<string>;
}

export interface SolutionPackRegistryPersistence {
  load(packIds: string[]): Promise<SolutionPackDiscoveryResult[]>;
  save(results: SolutionPackDiscoveryResult[]): Promise<void>;
  createRollbackRequest(input: SolutionPackRollbackRequestInput): Promise<SolutionPackRollbackRequest>;
  listRollbackRequestsForPack?(packId: string, limit?: number): Promise<SolutionPackRollbackRequest[]>;
}

export class SolutionPackRollbackError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 503,
    public readonly code: 'pack_not_found' | 'rollback_unavailable' | 'rollback_not_configured' | 'rollback_persistence_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SolutionPackRollbackError';
  }
}

export class SolutionPackEndpointConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolutionPackEndpointConfigError';
  }
}

function isIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isForbiddenInfrastructureHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '0.0.0.0' || host === '::' || host === '169.254.169.254') return true;
  if (isIpv4(host)) {
    const [first, second] = host.split('.').map(Number);
    return first === 169 && second === 254;
  }
  return host.startsWith('fe80:');
}

function isPrivateHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
  if (!host.includes('.') && !host.includes(':')) return true; // Compose/Kubernetes service name
  if (host.endsWith('.svc') || host.endsWith('.svc.cluster.local')) return true;
  if (host.startsWith('fd') || host.startsWith('fc')) return true;
  if (!isIpv4(host)) return false;
  const [first, second] = host.split('.').map(Number);
  return first === 10
    || first === 127
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

export function normalizeSolutionPackEndpoint(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new SolutionPackEndpointConfigError('solution pack endpoint must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SolutionPackEndpointConfigError('solution pack endpoint must use HTTP or HTTPS');
  }
  if (parsed.username || parsed.password) {
    throw new SolutionPackEndpointConfigError('solution pack endpoint must not contain credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new SolutionPackEndpointConfigError('solution pack endpoint must not contain a query or fragment');
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new SolutionPackEndpointConfigError('solution pack endpoint must not contain a path');
  }
  if (isForbiddenInfrastructureHost(parsed.hostname)) {
    throw new SolutionPackEndpointConfigError('solution pack endpoint targets a forbidden infrastructure address');
  }
  if (parsed.protocol === 'http:' && !isPrivateHttpHost(parsed.hostname)) {
    throw new SolutionPackEndpointConfigError('plain HTTP is allowed only for loopback, private or cluster-local hosts');
  }
  return parsed.origin;
}

export function parseSolutionPackEndpoints(raw: string): SolutionPackEndpoint[] {
  const entries = raw.split(',').map(value => value.trim()).filter(Boolean);
  if (entries.length > MAX_ENDPOINTS) {
    throw new SolutionPackEndpointConfigError(`at most ${MAX_ENDPOINTS} solution pack endpoints are allowed`);
  }

  const seen = new Set<string>();
  return entries.map(entry => {
    const separator = entry.indexOf('=');
    if (separator < 1) {
      throw new SolutionPackEndpointConfigError(`invalid solution pack endpoint entry '${entry}'`);
    }
    const packId = entry.slice(0, separator).trim();
    const endpoint = entry.slice(separator + 1).trim();
    if (!PACK_ID_PATTERN.test(packId)) {
      throw new SolutionPackEndpointConfigError(`invalid solution pack id '${packId}'`);
    }
    if (seen.has(packId)) {
      throw new SolutionPackEndpointConfigError(`duplicate solution pack id '${packId}'`);
    }
    seen.add(packId);
    return { packId, endpoint: normalizeSolutionPackEndpoint(endpoint) };
  });
}

export function attachSolutionPackTokenFiles(
  endpoints: SolutionPackEndpoint[],
  raw: string,
): SolutionPackEndpoint[] {
  if (!raw.trim()) return endpoints;
  const files = new Map<string, string>();
  for (const entry of raw.split(',').map(value => value.trim()).filter(Boolean)) {
    const separator = entry.indexOf('=');
    if (separator < 1) throw new SolutionPackEndpointConfigError(`invalid solution pack token-file entry '${entry}'`);
    const packId = entry.slice(0, separator).trim();
    const filename = entry.slice(separator + 1).trim();
    if (files.has(packId)) throw new SolutionPackEndpointConfigError(`duplicate solution pack token file for '${packId}'`);
    if (!path.isAbsolute(filename) || filename.includes('\0')) {
      throw new SolutionPackEndpointConfigError(`token file for '${packId}' must be an absolute path`);
    }
    files.set(packId, filename);
  }
  for (const packId of files.keys()) {
    if (!endpoints.some(endpoint => endpoint.packId === packId)) {
      throw new SolutionPackEndpointConfigError(`token file references unknown solution pack '${packId}'`);
    }
  }
  return endpoints.map(endpoint => ({
    ...endpoint,
    ...(files.has(endpoint.packId) ? { tokenFile: files.get(endpoint.packId)! } : {}),
  }));
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return 1;
    if (left[index]! < right[index]!) return -1;
  }
  return 0;
}

export function isCoreVersionCompatible(range: string, coreVersion: string): boolean {
  const minimum = range.startsWith('>=');
  const required = parseSemver(minimum ? range.slice(2) : range);
  const actual = parseSemver(coreVersion);
  if (!required || !actual) return false;
  const comparison = compareSemver(actual, required);
  return minimum ? comparison >= 0 : comparison === 0;
}

export async function readSolutionPackServiceToken(filename: string): Promise<string> {
  const value = await readFile(filename, { encoding: 'utf8' });
  if (Buffer.byteLength(value, 'utf8') > MAX_SERVICE_TOKEN_BYTES) {
    throw new Error('service credential exceeds the 8 KiB limit');
  }
  const token = value.trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('service credential is empty or malformed');
  return token;
}

async function probe(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
  headers: HeadersInit,
): Promise<SolutionPackProbeResult> {
  const started = Date.now();
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { ok: response.ok, status: response.status, latencyMs: Date.now() - started };
  } catch (cause) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export async function discoverSolutionPack(
  configured: SolutionPackEndpoint,
  options: SolutionPackDiscoveryOptions,
): Promise<SolutionPackDiscoveryResult> {
  const checkedAt = new Date().toISOString();
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = Math.min(30_000, Math.max(250, options.timeoutMs ?? 5_000));
  const headers: Record<string, string> = {
    accept: 'application/yaml, application/json;q=0.9, text/yaml;q=0.8',
  };

  if (configured.tokenFile) {
    try {
      const token = await (options.readTokenFile ?? readSolutionPackServiceToken)(configured.tokenFile);
      headers.authorization = `Bearer ${token}`;
    } catch (cause) {
      return {
        configuredId: configured.packId,
        endpoint: configured.endpoint,
        state: 'unreachable',
        checkedAt,
        error: `service credential unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
    }
  }

  let manifest: SolutionPackManifest;
  try {
    const response = await fetchFn(`${configured.endpoint}${SOLUTION_PACK_MANIFEST_PATH}`, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`manifest request returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? 0);
    if (declaredLength > 512 * 1024) throw new Error('manifest exceeds the 512 KiB limit');
    manifest = parseSolutionPackManifestDocument(await response.text());
  } catch (cause) {
    return {
      configuredId: configured.packId,
      endpoint: configured.endpoint,
      state: cause instanceof SolutionPackManifestError ? 'invalid' : 'unreachable',
      checkedAt,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  if (manifest.metadata.id !== configured.packId) {
    return {
      configuredId: configured.packId,
      endpoint: configured.endpoint,
      state: 'incompatible',
      checkedAt,
      manifest,
      error: `manifest id '${manifest.metadata.id}' does not match configured id '${configured.packId}'`,
    };
  }
  if (!isCoreVersionCompatible(manifest.spec.requires.core, options.coreVersion)) {
    return {
      configuredId: configured.packId,
      endpoint: configured.endpoint,
      state: 'incompatible',
      checkedAt,
      manifest,
      error: `pack requires Core ${manifest.spec.requires.core}, current Core is ${options.coreVersion}`,
    };
  }

  const [health, readiness] = await Promise.all([
    probe(`${configured.endpoint}${manifest.spec.delivery.healthPath}`, fetchFn, timeoutMs, headers),
    probe(`${configured.endpoint}${manifest.spec.delivery.readinessPath}`, fetchFn, timeoutMs, headers),
  ]);
  return {
    configuredId: configured.packId,
    endpoint: configured.endpoint,
    state: health.ok && readiness.ok ? 'ready' : 'degraded',
    checkedAt,
    manifest,
    health,
    readiness,
  };
}

export class SolutionPackRegistry {
  private readonly results = new Map<string, SolutionPackDiscoveryResult>();
  private refreshPromise: Promise<SolutionPackDiscoveryResult[]> | null = null;
  private readonly packRefreshPromises = new Map<string, Promise<SolutionPackDiscoveryResult | undefined>>();
  private persistence: SolutionPackRegistryPersistence | undefined;

  constructor(
    private readonly endpoints: SolutionPackEndpoint[],
    private readonly options: SolutionPackDiscoveryOptions,
  ) {
    for (const endpoint of endpoints) {
      this.results.set(endpoint.packId, {
        configuredId: endpoint.packId,
        endpoint: endpoint.endpoint,
        state: 'not_checked',
        checkedAt: null,
      });
    }
  }

  list(): SolutionPackDiscoveryResult[] {
    return [...this.results.values()].sort((left, right) => left.configuredId.localeCompare(right.configuredId));
  }

  get(packId: string): SolutionPackDiscoveryResult | undefined {
    return this.results.get(packId);
  }

  /**
   * Internal service configuration for Core-owned Pack clients. This method is
   * deliberately never serialized by the admin inventory routes because the
   * token-file location is part of the deployment's credential boundary.
   */
  getEndpoint(packId: string): SolutionPackEndpoint | undefined {
    const endpoint = this.endpoints.find(item => item.packId === packId);
    return endpoint ? { ...endpoint } : undefined;
  }

  async attachPersistence(persistence: SolutionPackRegistryPersistence): Promise<void> {
    this.persistence = persistence;
    const persisted = await persistence.load(this.endpoints.map(endpoint => endpoint.packId));
    for (const result of persisted) {
      const configured = this.endpoints.find(endpoint => endpoint.packId === result.configuredId);
      if (!configured) continue;
      // Endpoint/token configuration remains operator-owned and comes from the
      // current environment; only discovery/install evidence is restored.
      this.results.set(result.configuredId, { ...result, endpoint: configured.endpoint });
    }
  }

  async requestRollback(packId: string, requestedBy: string, reason: string): Promise<SolutionPackRollbackRequest> {
    const pack = this.results.get(packId);
    if (!pack) {
      throw new SolutionPackRollbackError(404, 'pack_not_found', `solution pack '${packId}' is not configured`);
    }
    if (!pack.previousManifest || !pack.previousVersion) {
      throw new SolutionPackRollbackError(
        409,
        'rollback_unavailable',
        `solution pack '${packId}' has no previous manifest available for rollback`,
      );
    }
    if (!this.persistence) {
      throw new SolutionPackRollbackError(
        503,
        'rollback_persistence_unavailable',
        'solution pack rollback persistence is not configured',
      );
    }
    return this.persistence.createRollbackRequest({
      packId,
      requestedBy,
      reason,
      sourceRevision: pack.revision ?? 0,
      currentVersion: pack.manifest?.metadata.version ?? null,
      targetVersion: pack.previousVersion,
      targetManifest: pack.previousManifest,
    });
  }

  async listRollbackRequests(packId: string, limit = 20): Promise<SolutionPackRollbackRequest[]> {
    if (!this.results.has(packId)) {
      throw new SolutionPackRollbackError(404, 'pack_not_found', `solution pack '${packId}' is not configured`);
    }
    if (!this.persistence?.listRollbackRequestsForPack) {
      throw new SolutionPackRollbackError(
        503,
        'rollback_persistence_unavailable',
        'solution pack rollback persistence is not configured',
      );
    }
    return this.persistence.listRollbackRequestsForPack(packId, limit);
  }

  private enrich(result: SolutionPackDiscoveryResult): SolutionPackDiscoveryResult {
    const previous = this.results.get(result.configuredId);
    const previousVersion = previous?.manifest?.metadata.version;
    const currentVersion = result.manifest?.metadata.version;
    return {
      ...result,
      revision: (previous?.revision ?? 0) + 1,
      ...(previousVersion && currentVersion && previousVersion !== currentVersion
        ? { previousVersion, previousManifest: previous?.manifest }
        : previous?.previousVersion
          ? { previousVersion: previous.previousVersion, previousManifest: previous.previousManifest }
          : {}),
    };
  }

  /**
   * Refresh one Pack immediately for request-time routing decisions. Normal
   * inventory refreshes remain batched, while an Auto runtime preflight does
   * not have to trust a potentially stale background-poll result.
   */
  refreshPack(packId: string): Promise<SolutionPackDiscoveryResult | undefined> {
    if (this.refreshPromise) return this.refreshPromise.then(() => this.results.get(packId));
    const pending = this.packRefreshPromises.get(packId);
    if (pending) return pending;
    const endpoint = this.endpoints.find(item => item.packId === packId);
    if (!endpoint) return Promise.resolve(undefined);
    const refresh = discoverSolutionPack(endpoint, this.options)
      .then(async result => {
        const enriched = this.enrich(result);
        this.results.set(packId, enriched);
        if (this.persistence) {
          await this.persistence.save([enriched]).catch(error => {
            logger.warn({ err: error, packId }, 'Solution Pack discovery persistence failed');
          });
        }
        return enriched;
      })
      .finally(() => { this.packRefreshPromises.delete(packId); });
    this.packRefreshPromises.set(packId, refresh);
    return refresh;
  }

  refresh(): Promise<SolutionPackDiscoveryResult[]> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = Promise.all(this.endpoints.map(endpoint => discoverSolutionPack(endpoint, this.options)))
      .then(async results => {
        const enriched = results.map(result => this.enrich(result));
        for (const result of enriched) this.results.set(result.configuredId, result);
        if (this.persistence) {
          await this.persistence.save(enriched).catch(error => {
            logger.warn({ err: error }, 'Solution Pack discovery persistence failed');
          });
        }
        return this.list();
      })
      .finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }
}
