import type { SolutionPackRollbackRequest } from './discovery.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_SECONDS = 300;
const WORKER_ID_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;

export interface SolutionPackReconcilerClientOptions {
  baseUrl: string;
  workspaceSecret: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export interface SolutionPackReconcilerPollOptions {
  limit?: number;
  leaseSeconds?: number;
}

export interface SolutionPackReconcilerPollSummary {
  listed: number;
  claimed: number;
  applied: number;
  failed: number;
  skipped: number;
  reportErrors: number;
}

export type SolutionPackRollbackApplier = (request: SolutionPackRollbackRequest) => Promise<void>;

export class SolutionPackReconcilerClientError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = 'SolutionPackReconcilerClientError';
  }
}

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SolutionPackReconcilerClientError('reconciler baseUrl must be an absolute URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SolutionPackReconcilerClientError('reconciler baseUrl must use http or https');
  }
  return url.toString().replace(/\/$/, '');
}

function boundedLimit(value: number | undefined): number {
  const limit = value === undefined ? 20 : Math.trunc(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SolutionPackReconcilerClientError('limit must be an integer from 1 to 100');
  }
  return limit;
}

function boundedLease(value: number | undefined): number {
  const lease = value === undefined ? DEFAULT_LEASE_SECONDS : Math.trunc(value);
  if (!Number.isInteger(lease) || lease < 30 || lease > 3600) {
    throw new SolutionPackReconcilerClientError('leaseSeconds must be an integer from 30 to 3600');
  }
  return lease;
}

function workerId(value: string): string {
  const id = value.trim();
  if (!WORKER_ID_PATTERN.test(id)) {
    throw new SolutionPackReconcilerClientError('workerId must contain 1-128 safe characters');
  }
  return id;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export class SolutionPackReconcilerClient {
  private readonly baseUrl: string;
  private readonly workspaceSecret: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: SolutionPackReconcilerClientOptions) {
    if (!options.workspaceSecret.trim()) {
      throw new SolutionPackReconcilerClientError('workspaceSecret is required');
    }
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.workspaceSecret = options.workspaceSecret;
    this.timeoutMs = Math.min(60_000, Math.max(1_000, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)));
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async listPending(limit?: number): Promise<SolutionPackRollbackRequest[]> {
    const bounded = boundedLimit(limit);
    const payload = await this.request<{ requests?: unknown }>(
      `/api/internal/solution-packs/rollback-requests?status=pending&limit=${bounded}`,
      { method: 'GET' },
    );
    if (!Array.isArray(payload.requests)) {
      throw new SolutionPackReconcilerClientError('reconciler returned an invalid request list');
    }
    return payload.requests as SolutionPackRollbackRequest[];
  }

  async claim(requestId: string, worker: string, leaseSeconds?: number): Promise<SolutionPackRollbackRequest | null> {
    const id = requestId.trim();
    if (!id) throw new SolutionPackReconcilerClientError('requestId is required');
    const payload = await this.request<{ rollback?: SolutionPackRollbackRequest }>(
      `/api/internal/solution-packs/rollback-requests/${encodeURIComponent(id)}/claim`,
      {
        method: 'POST',
        body: { workerId: workerId(worker), leaseSeconds: boundedLease(leaseSeconds) },
      },
      { allowConflict: true },
    );
    return payload.rollback ?? null;
  }

  async report(
    requestId: string,
    worker: string,
    status: 'applied' | 'failed',
    error?: string,
  ): Promise<SolutionPackRollbackRequest> {
    const id = requestId.trim();
    if (!id) throw new SolutionPackReconcilerClientError('requestId is required');
    if (status === 'failed' && !error?.trim()) {
      throw new SolutionPackReconcilerClientError('failed results require an error message');
    }
    const payload = await this.request<{ rollback?: SolutionPackRollbackRequest }>(
      `/api/internal/solution-packs/rollback-requests/${encodeURIComponent(id)}/result`,
      {
        method: 'POST',
        body: {
          workerId: workerId(worker),
          status,
          ...(error?.trim() ? { error: error.trim().slice(0, 2_000) } : {}),
        },
      },
    );
    if (!payload.rollback) throw new SolutionPackReconcilerClientError('reconciler returned no rollback result');
    return payload.rollback;
  }

  async pollOnce(
    worker: string,
    apply: SolutionPackRollbackApplier,
    options: SolutionPackReconcilerPollOptions = {},
  ): Promise<SolutionPackReconcilerPollSummary> {
    const id = workerId(worker);
    const requests = await this.listPending(options.limit);
    const summary: SolutionPackReconcilerPollSummary = {
      listed: requests.length, claimed: 0, applied: 0, failed: 0, skipped: 0, reportErrors: 0,
    };
    for (const request of requests) {
      const claimed = await this.claim(request.id, id, options.leaseSeconds);
      if (!claimed) {
        summary.skipped += 1;
        continue;
      }
      summary.claimed += 1;
      try {
        await apply(claimed);
        await this.report(claimed.id, id, 'applied');
        summary.applied += 1;
      } catch (cause) {
        summary.failed += 1;
        try {
          await this.report(claimed.id, id, 'failed', errorMessage(cause));
        } catch {
          summary.reportErrors += 1;
        }
      }
    }
    return summary;
  }

  private async request<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown> },
    options: { allowConflict?: boolean } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Accept: 'application/json',
          'X-Workspace-Secret': this.workspaceSecret,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      throw new SolutionPackReconcilerClientError(`reconciler request failed: ${errorMessage(cause)}`);
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (options.allowConflict && response.status === 409) return {} as T;
    if (!response.ok) {
      throw new SolutionPackReconcilerClientError(
        typeof payload['error'] === 'string' ? payload['error'] : `reconciler returned HTTP ${response.status}`,
        response.status,
        typeof payload['code'] === 'string' ? payload['code'] : undefined,
      );
    }
    return payload as T;
  }
}
