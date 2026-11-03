import type { ArgusHermesConfig } from './config.js';
import type {
  AttachedHermesRunState,
  AttachedHermesRunSummary,
  HermesAttachedRuntimeStatus,
  HermesEndpointProbe,
} from './runtimeTypes.js';

export type HermesFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Attached mode is pinned to the public capability contract emitted by this
 * Hermes release.  It is intentionally not a loose "any OpenAI-compatible
 * endpoint" check: an attached API must prove that the Hermes agent and its
 * tools execute on the same server-side runtime.
 */
export const ATTACHED_HERMES_CAPABILITY_CONTRACT = Object.freeze({
  releaseRef: 'v2026.7.7.2',
  // The signed Git tag uses the date-based release reference while the
  // official container reports its package version from /health/detailed.
  version: '0.18.2',
  object: 'hermes.api_server.capabilities',
  platform: 'hermes-agent',
  runtime: Object.freeze({
    mode: 'server_agent',
    toolExecution: 'server',
    splitRuntime: false,
  }),
});

type JsonObject = Record<string, unknown>;
type ProbeValidator = (payload: unknown) => string | undefined;

const MAX_ATTACHED_RESPONSE_BYTES = 64 * 1024;
const MAX_ATTACHED_OUTPUT_CHARS = 32 * 1024;
const ATTACHED_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export class AttachedHermesRunError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503,
    readonly code:
      | 'ATTACHED_HERMES_NOT_CONFIGURED'
      | 'ATTACHED_HERMES_AUTH_REQUIRED'
      | 'INVALID_ATTACHED_RUN_REQUEST'
      | 'ATTACHED_HERMES_REJECTED'
      | 'ATTACHED_HERMES_UNAVAILABLE',
    message: string,
  ) {
    super(message);
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeVersion(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.trim().replace(/^v/i, '');
}

/**
 * `/health/detailed` is the only documented health response that exposes the
 * installed Hermes version. A source checkout that reports `dev`, or a newer
 * unvalidated release, fails closed until the Pack contract is updated.
 */
export function validateAttachedHermesHealth(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return 'Attached Hermes health response must be a JSON object.';
  if (payload.status !== 'ok') return 'Attached Hermes health response must report status "ok".';
  if (payload.platform !== ATTACHED_HERMES_CAPABILITY_CONTRACT.platform) {
    return `Attached Hermes health response must report platform "${ATTACHED_HERMES_CAPABILITY_CONTRACT.platform}".`;
  }
  if (normalizeVersion(payload.version) !== ATTACHED_HERMES_CAPABILITY_CONTRACT.version) {
    return `Attached Hermes must report pinned version "${ATTACHED_HERMES_CAPABILITY_CONTRACT.releaseRef}".`;
  }
  return undefined;
}

/**
 * Validates the stable v2026.7.7.2 `/v1/capabilities` runtime placement
 * contract. In particular, a client-side or split tool runtime is unsafe for
 * an external-attested bridge: Argus could not reliably attribute or govern
 * where those tools execute.
 */
export function validateAttachedHermesCapabilities(payload: unknown): string | undefined {
  if (!isJsonObject(payload)) return 'Attached Hermes capabilities response must be a JSON object.';
  if (payload.object !== ATTACHED_HERMES_CAPABILITY_CONTRACT.object) {
    return `Attached Hermes capabilities response must report object "${ATTACHED_HERMES_CAPABILITY_CONTRACT.object}".`;
  }
  if (payload.platform !== ATTACHED_HERMES_CAPABILITY_CONTRACT.platform) {
    return `Attached Hermes capabilities response must report platform "${ATTACHED_HERMES_CAPABILITY_CONTRACT.platform}".`;
  }
  if (!isJsonObject(payload.runtime)) {
    return 'Attached Hermes capabilities response must include a runtime object.';
  }
  if (payload.runtime.mode !== ATTACHED_HERMES_CAPABILITY_CONTRACT.runtime.mode) {
    return `Attached Hermes runtime.mode must be "${ATTACHED_HERMES_CAPABILITY_CONTRACT.runtime.mode}".`;
  }
  if (payload.runtime.tool_execution !== ATTACHED_HERMES_CAPABILITY_CONTRACT.runtime.toolExecution) {
    return `Attached Hermes runtime.tool_execution must be "${ATTACHED_HERMES_CAPABILITY_CONTRACT.runtime.toolExecution}".`;
  }
  if (payload.runtime.split_runtime !== ATTACHED_HERMES_CAPABILITY_CONTRACT.runtime.splitRuntime) {
    return 'Attached Hermes runtime.split_runtime must be false.';
  }
  return undefined;
}

/**
 * Read-only capability probe for a pre-existing Hermes API server.
 *
 * This intentionally does not submit Hermes runs yet. Until Core emits a
 * short-lived, bundle-scoped runtime MCP lease, a run proxy would be an
 * alternative ungoverned execution path.
 */
export class AttachedHermesClient {
  constructor(
    private readonly config: Pick<ArgusHermesConfig, 'hermesBaseUrl' | 'hermesApiKey' | 'requestTimeoutMs'>,
    private readonly fetchFn: HermesFetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async status(): Promise<HermesAttachedRuntimeStatus> {
    const checkedAt = this.now().toISOString();
    if (!this.config.hermesBaseUrl) {
      return {
        configured: false,
        mode: 'attached',
        state: 'not_configured',
        checkedAt,
        detail: 'No external Hermes API service is configured yet.',
      };
    }

    const [health, capabilities] = await Promise.all([
      this.probe('health', '/health/detailed', validateAttachedHermesHealth),
      this.probe('capabilities', '/v1/capabilities', validateAttachedHermesCapabilities),
    ]);
    const state = health.ok && capabilities.ok
      ? 'ready'
      : !health.status && !capabilities.status ? 'unreachable' : 'degraded';
    return {
      configured: true,
      mode: 'attached',
      state,
      checkedAt,
      endpoint: this.config.hermesBaseUrl,
      health,
      capabilities,
      detail: state === 'ready'
        ? `External / attested Hermes ${ATTACHED_HERMES_CAPABILITY_CONTRACT.releaseRef} capability handshake succeeded. Native Hermes tools remain externally governed; attached mode has no runtime MCP lease.`
        : `The configured Hermes API did not satisfy the pinned ${ATTACHED_HERMES_CAPABILITY_CONTRACT.releaseRef} external-attested capability handshake.`,
    };
  }

  async startRun(input: string): Promise<AttachedHermesRunSummary> {
    const text = input.trim();
    if (!text || text.length > 64 * 1024) {
      throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached Hermes input must contain 1 to 65536 characters');
    }
    const payload = await this.runRequest('/v1/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    return this.runSummary(payload);
  }

  async getRun(runId: string): Promise<AttachedHermesRunSummary> {
    const id = this.runId(runId);
    return this.runSummary(await this.runRequest(`/v1/runs/${encodeURIComponent(id)}`, { method: 'GET' }), id);
  }

  async stopRun(runId: string): Promise<AttachedHermesRunSummary> {
    const id = this.runId(runId);
    const payload = await this.runRequest(`/v1/runs/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    // Hermes' stop acknowledgement may contain only `{ status: "stopping" }`.
    return this.runSummary(payload, id);
  }

  private runId(value: string): string {
    if (!ATTACHED_RUN_ID.test(value)) {
      throw new AttachedHermesRunError(400, 'INVALID_ATTACHED_RUN_REQUEST', 'attached Hermes run ID is invalid');
    }
    return value;
  }

  private async runRequest(path: string, init: RequestInit): Promise<unknown> {
    if (!this.config.hermesBaseUrl) {
      throw new AttachedHermesRunError(409, 'ATTACHED_HERMES_NOT_CONFIGURED', 'no external Hermes API service is configured');
    }
    if (!this.config.hermesApiKey) {
      throw new AttachedHermesRunError(409, 'ATTACHED_HERMES_AUTH_REQUIRED', 'attached Hermes execution requires a configured API key');
    }
    try {
      const response = await this.fetchFn(`${this.config.hermesBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.hermesApiKey}`,
          ...init.headers,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_ATTACHED_RESPONSE_BYTES) {
        throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes response exceeds the controlled limit');
      }
      if (!response.ok) {
        throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes rejected the runtime request');
      }
      try {
        return JSON.parse(Buffer.from(buffer).toString('utf8')) as unknown;
      } catch {
        throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned an invalid runtime response');
      }
    } catch (cause) {
      if (cause instanceof AttachedHermesRunError) throw cause;
      throw new AttachedHermesRunError(503, 'ATTACHED_HERMES_UNAVAILABLE', 'attached Hermes runtime is unavailable');
    }
  }

  private runSummary(payload: unknown, expectedRunId?: string): AttachedHermesRunSummary {
    if (!isJsonObject(payload)) {
      throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned an invalid run projection');
    }
    const id = this.runId(typeof payload.run_id === 'string' ? payload.run_id : expectedRunId ?? '');
    if (expectedRunId && id !== expectedRunId) {
      throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned a mismatched run projection');
    }
    const state = this.runState(payload.status);
    const output = typeof payload.output === 'string' && payload.output.length <= MAX_ATTACHED_OUTPUT_CHARS
      ? payload.output
      : undefined;
    const usage = this.runUsage(payload.usage);
    return {
      id,
      mode: 'attached',
      state,
      updatedAt: this.now().toISOString(),
      ...(output === undefined ? {} : { output }),
      ...(usage === undefined ? {} : { usage }),
    };
  }

  private runState(value: unknown): AttachedHermesRunState {
    const normalized: Record<string, AttachedHermesRunState> = {
      queued: 'queued',
      started: 'running',
      running: 'running',
      awaiting_approval: 'awaiting_approval',
      waiting_for_approval: 'awaiting_approval',
      stopping: 'stopping',
      stopped: 'cancelled',
      cancelled: 'cancelled',
      canceled: 'cancelled',
      completed: 'completed',
      failed: 'failed',
      error: 'failed',
    };
    if (typeof value !== 'string' || !normalized[value]) {
      throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned an unsupported run state');
    }
    return normalized[value];
  }

  private runUsage(value: unknown): AttachedHermesRunSummary['usage'] | undefined {
    if (value === undefined) return undefined;
    if (!isJsonObject(value)) {
      throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned invalid token usage');
    }
    const inputTokens = value.input_tokens;
    const outputTokens = value.output_tokens;
    const totalTokens = value.total_tokens;
    if (![inputTokens, outputTokens, totalTokens].every(item => Number.isSafeInteger(item) && Number(item) >= 0)) {
      throw new AttachedHermesRunError(502, 'ATTACHED_HERMES_REJECTED', 'attached Hermes returned invalid token usage');
    }
    return {
      inputTokens: Number(inputTokens),
      outputTokens: Number(outputTokens),
      totalTokens: Number(totalTokens),
    };
  }

  private async probe(
    endpoint: HermesEndpointProbe['endpoint'],
    path: string,
    validate: ProbeValidator,
  ): Promise<HermesEndpointProbe> {
    const startedAt = Date.now();
    let response: Response | undefined;
    try {
      response = await this.fetchFn(`${this.config.hermesBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          ...(this.config.hermesApiKey ? { authorization: `Bearer ${this.config.hermesApiKey}` } : {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      // Consume and bound the response body so a misbehaving upstream cannot
      // keep an Agent worker open. It is deliberately not persisted or exposed.
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_ATTACHED_RESPONSE_BYTES) throw new Error('response exceeds 64 KiB');
      if (!response.ok) {
        return {
          endpoint,
          ok: false,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          error: `HTTP ${response.status}`,
        };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.from(buffer).toString('utf8')) as unknown;
      } catch {
        return {
          endpoint,
          ok: false,
          status: response.status,
          latencyMs: Date.now() - startedAt,
          error: 'response is not valid JSON',
        };
      }
      const validationError = validate(payload);
      return {
        endpoint,
        ok: !validationError,
        status: response.status,
        latencyMs: Date.now() - startedAt,
        ...(validationError ? { error: validationError } : {}),
      };
    } catch (cause) {
      return {
        endpoint,
        ok: false,
        ...(response ? { status: response.status } : {}),
        latencyMs: Date.now() - startedAt,
        error: cause instanceof Error ? cause.message : 'request failed',
      };
    }
  }
}
