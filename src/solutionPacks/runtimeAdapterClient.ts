import { z } from 'zod';
import {
  readSolutionPackServiceToken,
  type SolutionPackEndpoint,
  type SolutionPackRegistry,
} from './discovery.js';
import type { SolutionPackManifest } from './manifest.js';

/**
 * The Pack-owned, versioned control-plane protocol used to inventory a
 * runtime adapter. Its public gateway remains read-only; the separately typed
 * managed-start transport below is internal-only and has no route or workflow
 * integration yet.
 */
export const ARGUS_RUNTIME_ADAPTER_PROTOCOL = 'argus-runtime-v1alpha1';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_MANAGED_RUNTIME_EVENTS = 128;
// Pack cancellation may wait for Runnerd to finish a bounded in-flight
// launch and then remove its sidecars. Keep ordinary status calls short, but
// give this cleanup barrier enough time to return its authoritative state.
const MANAGED_RUNTIME_CANCEL_TIMEOUT_MS = 40_000;
const identifier = z.string()
  .min(1)
  .max(128)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'must be a stable lowercase identifier');
const adapterModeSchema = z.enum(['attached', 'managed']);
const adapterStateSchema = z.enum(['ready', 'degraded', 'unavailable']);
const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const opaqueExecutionGrant = z.string()
  .min(1)
  .max(16_384)
  .regex(/^eg_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, 'must be an opaque eg_v1 execution grant');

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

const runtimeMcpEndpoint = z.string()
  .min(1)
  .max(2_048)
  .refine(isHttpUrl, 'must be a credential-free HTTP(S) URL');

const adapterIdentitySchema = z.object({
  id: identifier,
  runtime: identifier,
  protocol: z.literal(ARGUS_RUNTIME_ADAPTER_PROTOCOL),
}).strict();

export const runtimeAdapterCapabilitiesSchema = z.object({
  adapter: adapterIdentitySchema,
  modes: z.array(adapterModeSchema).max(8),
  capabilities: z.array(identifier).max(256),
}).strict();

const runtimeAdapterModeStatusSchema = z.object({
  mode: adapterModeSchema,
  state: adapterStateSchema,
  detail: z.string().trim().min(1).max(512).optional(),
}).strict();

export const runtimeAdapterStatusSchema = z.object({
  adapter: adapterIdentitySchema,
  state: adapterStateSchema,
  checkedAt: z.string().datetime({ offset: true }).optional(),
  modes: z.array(runtimeAdapterModeStatusSchema).max(8),
}).strict();

const managedRuntimeCoreAgentSchema = z.object({
  id: z.number().int().positive(),
  name: identifier,
}).strict();

const managedRuntimeLeaseSchema = z.object({
  kind: z.literal('argus.runtime-mcp-lease/v1alpha1'),
  leaseId: uuid,
  endpoint: runtimeMcpEndpoint,
  executionGrant: opaqueExecutionGrant,
  expiresAt: isoTimestamp,
  rootTraceId: uuid,
  bundleIds: z.array(z.number().int().positive()).min(1).max(64)
    .refine(values => new Set(values).size === values.length, 'must not contain duplicate bundle IDs'),
  serverName: z.literal('argus_core'),
}).strict();

const managedRuntimeRunSchema = z.object({
  id: uuid,
  rootTraceId: uuid,
  messageId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(255),
  coreAgent: managedRuntimeCoreAgentSchema,
  input: z.object({ text: z.string().min(1).max(64 * 1024) }).strict(),
  instructions: z.string().min(1).max(8 * 1024).optional(),
}).strict();

/**
 * Pack-normalized lifecycle states. These intentionally remain independent
 * from any native runtime's state vocabulary so Core never needs to expose or
 * reason about upstream-specific diagnostics.
 */
export const managedRuntimeRunStateSchema = z.enum([
  'queued',
  'provisioning',
  'running',
  'awaiting_approval',
  'cancelling',
  'cancelled',
  'completed',
  'failed',
]);

export const runtimeTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  cacheReadInputTokens: z.number().int().nonnegative().optional(),
  cacheWriteInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  apiCalls: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().finite().nonnegative().optional(),
}).strict();

const eventCursor = z.string()
  .trim()
  .min(1)
  .max(256)
  // This is sent only as a header, but constrain it anyway so an invalid
  // Pack cursor can never become a header-injection or logging concern.
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe opaque event cursor');

export const managedRuntimeRunSummarySchema = z.object({
  id: uuid,
  mode: z.literal('managed'),
  rootTraceId: uuid,
  state: managedRuntimeRunStateSchema,
  // A Pack acceptance time is different from the time a native process
  // started. Keeping both lifecycle fields explicit prevents false claims in
  // UI or audit consumers.
  acceptedAt: isoTimestamp,
  updatedAt: isoTimestamp,
  eventCursor: eventCursor.optional(),
  // Human-readable final model output is a first-class bounded field. It is
  // deliberately separate from machine evidence, which remains label-only.
  output: z.string().max(32 * 1024).optional(),
  usage: runtimeTokenUsageSchema.optional(),
}).strict();

const managedRuntimeLifecycleInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  runId: uuid,
  rootTraceId: uuid,
}).strict();

export const managedRuntimeRunStatusInputSchema = managedRuntimeLifecycleInputSchema;

export const managedRuntimeRunCancelInputSchema = managedRuntimeLifecycleInputSchema.extend({
  requestId: uuid,
  // A cancellation reason is Core-owned audit context only. It is deliberately
  // bounded and is never populated from Pack output.
  reason: z.string().trim().min(1).max(1_024).optional(),
}).strict();

export const managedRuntimeRunEventsInputSchema = managedRuntimeLifecycleInputSchema.extend({
  // Resumption is header-based rather than a caller-controlled URL/query.
  after: eventCursor.optional(),
}).strict();

const managedRuntimeEventEvidenceValueSchema = z.union([
  z.string().trim().max(2_048),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const managedRuntimeEventEvidenceSchema = z.record(managedRuntimeEventEvidenceValueSchema)
  .refine(
    value => Object.keys(value).length <= 32
      && Object.keys(value).every(key => /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(key)),
    'must contain at most 32 stable evidence keys',
  );

export const managedRuntimeRunEventSchema = z.object({
  apiVersion: z.literal(ARGUS_RUNTIME_ADAPTER_PROTOCOL),
  eventId: eventCursor,
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  occurredAt: isoTimestamp,
  run: z.object({
    id: uuid,
    rootTraceId: uuid,
    state: managedRuntimeRunStateSchema,
  }).strict(),
  type: z.enum([
    'run.accepted',
    'run.provisioning',
    'run.started',
    'tool.completed',
    'approval.requested',
    'approval.resolved',
    'cancel.requested',
    'run.cancelled',
    'run.completed',
    'run.failed',
  ]),
  evidence: managedRuntimeEventEvidenceSchema.optional(),
}).strict();

const managedRuntimeRunStatusResponseSchema = z.object({
  apiVersion: z.literal(ARGUS_RUNTIME_ADAPTER_PROTOCOL),
  run: managedRuntimeRunSummarySchema,
}).strict();

const managedRuntimeRunCancelResponseSchema = managedRuntimeRunStatusResponseSchema;

const attachedRuntimeRunId = z.string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'must be a safe attached run ID');

export const attachedRuntimeRunStateSchema = z.enum([
  'queued', 'running', 'awaiting_approval', 'stopping', 'cancelled', 'completed', 'failed',
]);

export const attachedRuntimeRunSummarySchema = z.object({
  id: attachedRuntimeRunId,
  mode: z.literal('attached'),
  state: attachedRuntimeRunStateSchema,
  updatedAt: isoTimestamp,
  output: z.string().max(32 * 1024).optional(),
  usage: runtimeTokenUsageSchema.optional(),
}).strict();

const attachedRuntimeResponseSchema = z.object({
  apiVersion: z.literal(ARGUS_RUNTIME_ADAPTER_PROTOCOL),
  trust: z.literal('external_attested'),
  governance: z.object({
    coreMcpLease: z.literal(false),
    nativeToolsExternallyGoverned: z.literal(true),
  }).strict(),
  run: attachedRuntimeRunSummarySchema,
}).strict();

export const attachedRuntimeStartInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  input: z.object({ text: z.string().trim().min(1).max(64 * 1024) }).strict(),
}).strict();

export const attachedRuntimeLifecycleInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  runId: attachedRuntimeRunId,
}).strict();

export interface ManagedRuntimeRunEventsResult {
  events: ManagedRuntimeRunEvent[];
  lastEventId?: string;
}

const managedRuntimeLimitsSchema = z.object({
  deadlineAt: isoTimestamp,
  maxToolCalls: z.number().int().min(1).max(1_000),
  maxOutputBytes: z.number().int().min(1).max(4 * 1024 * 1024),
}).strict();

/**
 * Core-owned request data for a managed Runtime Adapter start. The client adds
 * the protocol version and fixed managed mode; callers cannot select attached
 * mode through this API.
 *
 * `runtimeMcpLease.executionGrant` is intentionally accepted only by this
 * internal server-side client. It must never originate from, or be returned to,
 * a browser and is never persisted or included in an error message.
 */
export const managedRuntimeStartInputSchema = z.object({
  packId: identifier,
  adapterId: identifier,
  requestId: uuid,
  run: managedRuntimeRunSchema,
  runtimeMcpLease: managedRuntimeLeaseSchema,
  limits: managedRuntimeLimitsSchema,
}).strict().superRefine((input, ctx) => {
  if (input.run.rootTraceId !== input.runtimeMcpLease.rootTraceId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['runtimeMcpLease', 'rootTraceId'],
      message: 'must match run.rootTraceId',
    });
  }
  if (Date.parse(input.limits.deadlineAt) > Date.parse(input.runtimeMcpLease.expiresAt)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['limits', 'deadlineAt'],
      message: 'must not exceed runtimeMcpLease.expiresAt',
    });
  }
});

const managedRuntimeStartResponseSchema = z.object({
  apiVersion: z.literal(ARGUS_RUNTIME_ADAPTER_PROTOCOL),
  run: managedRuntimeRunSummarySchema.extend({ state: z.literal('queued') }),
}).strict();

const managedRunnerNotProvisionedResponseSchema = z.object({
  error: z.object({
    code: z.literal('MANAGED_RUNNER_NOT_PROVISIONED'),
    message: z.string().min(1).max(1_000),
  }).strict(),
}).strict();

export type RuntimeAdapterCapabilities = z.infer<typeof runtimeAdapterCapabilitiesSchema>;
export type RuntimeAdapterStatus = z.infer<typeof runtimeAdapterStatusSchema>;
export type RuntimeAdapterDeclaration = SolutionPackManifest['spec']['components']['runtimeAdapters'][number];
export type ManagedRuntimeStartInput = z.infer<typeof managedRuntimeStartInputSchema>;
export type ManagedRuntimeStartResult = z.infer<typeof managedRuntimeStartResponseSchema>;
export type ManagedRuntimeRunSummary = z.infer<typeof managedRuntimeRunSummarySchema>;
export type ManagedRuntimeRunStatusInput = z.infer<typeof managedRuntimeRunStatusInputSchema>;
export type ManagedRuntimeRunStatusResult = z.infer<typeof managedRuntimeRunStatusResponseSchema>;
export type ManagedRuntimeRunCancelInput = z.infer<typeof managedRuntimeRunCancelInputSchema>;
export type ManagedRuntimeRunCancelResult = z.infer<typeof managedRuntimeRunCancelResponseSchema>;
export type ManagedRuntimeRunEventsInput = z.infer<typeof managedRuntimeRunEventsInputSchema>;
export type ManagedRuntimeRunEvent = z.infer<typeof managedRuntimeRunEventSchema>;
export type AttachedRuntimeStartInput = z.infer<typeof attachedRuntimeStartInputSchema>;
export type AttachedRuntimeLifecycleInput = z.infer<typeof attachedRuntimeLifecycleInputSchema>;
export type AttachedRuntimeRunResult = z.infer<typeof attachedRuntimeResponseSchema>;

export interface RuntimeAdapterCapabilitiesResult {
  adapter: RuntimeAdapterDeclaration;
  capabilities: RuntimeAdapterCapabilities;
}

export interface RuntimeAdapterStatusResult {
  adapter: RuntimeAdapterDeclaration;
  status: RuntimeAdapterStatus;
}

export interface RuntimeAdapterGateway {
  getCapabilities(packId: string, adapterId: string): Promise<RuntimeAdapterCapabilitiesResult>;
  getStatus(packId: string, adapterId: string): Promise<RuntimeAdapterStatusResult>;
  startAttachedRun?(input: AttachedRuntimeStartInput): Promise<AttachedRuntimeRunResult>;
  getAttachedRunStatus?(input: AttachedRuntimeLifecycleInput): Promise<AttachedRuntimeRunResult>;
  stopAttachedRun?(input: AttachedRuntimeLifecycleInput): Promise<AttachedRuntimeRunResult>;
}

export interface RuntimeAdapterClientOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  readTokenFile?: (filename: string) => Promise<string>;
}

export type RuntimeAdapterClientErrorCode =
  | 'invalid_attached_runtime_request'
  | 'attached_runtime_not_supported'
  | 'attached_runtime_unavailable'
  | 'invalid_managed_runtime_start'
  | 'invalid_managed_runtime_lifecycle_request'
  | 'pack_not_found'
  | 'pack_not_ready'
  | 'runtime_adapter_not_found'
  | 'managed_runtime_not_supported'
  | 'managed_runner_not_provisioned'
  | 'managed_run_not_found'
  | 'peer_unavailable'
  | 'peer_rejected'
  | 'response_too_large'
  | 'invalid_response'
  | 'adapter_identity_mismatch'
  | 'adapter_contract_mismatch'
  | 'managed_run_identity_mismatch';

export class RuntimeAdapterClientError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 502,
    readonly code: RuntimeAdapterClientErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeAdapterClientError';
  }
}

interface ResolvedRuntimeAdapter {
  endpoint: SolutionPackEndpoint;
  adapter: RuntimeAdapterDeclaration;
}

function parseJsonOrNull(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function isSubset(values: string[], declared: readonly string[]): boolean {
  const allowed = new Set(declared);
  return values.every(value => allowed.has(value));
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new RuntimeAdapterClientError(502, 'response_too_large', 'Runtime adapter response exceeds 64 KiB');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new RuntimeAdapterClientError(502, 'response_too_large', 'Runtime adapter response exceeds 64 KiB');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned invalid JSON');
  }
}

/**
 * Parses a finite, bounded snapshot of the Pack-owned SSE lifecycle stream.
 * It intentionally accepts only normalized event JSON; raw native-runtime
 * frames, headers, tool payloads and diagnostics never escape this boundary.
 */
export function parseManagedRuntimeEventStream(text: string): ManagedRuntimeRunEventsResult {
  const events: ManagedRuntimeRunEvent[] = [];
  let dataLines: string[] = [];
  let frameId: string | undefined;
  let previousSequence = 0;

  const flush = (): void => {
    if (dataLines.length === 0) {
      frameId = undefined;
      return;
    }
    if (events.length >= MAX_MANAGED_RUNTIME_EVENTS) {
      throw new RuntimeAdapterClientError(
        502,
        'response_too_large',
        `Runtime adapter returned more than ${MAX_MANAGED_RUNTIME_EVENTS} managed lifecycle events`,
      );
    }
    const parsed = managedRuntimeRunEventSchema.safeParse(parseJsonOrNull(dataLines.join('\n')));
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid managed lifecycle event');
    }
    if (frameId !== undefined && frameId !== parsed.data.eventId) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter event ID does not match its event payload');
    }
    if (parsed.data.sequence <= previousSequence) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter lifecycle event sequence is not strictly increasing');
    }
    previousSequence = parsed.data.sequence;
    events.push(parsed.data);
    dataLines = [];
    frameId = undefined;
  };

  // Normalize CRLF/CR framing before applying the SSE blank-line delimiter.
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (line === '') {
      flush();
      continue;
    }
    // Standard SSE comments / keep-alives carry no evidence.
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : (line.charAt(colon + 1) === ' ' ? line.slice(colon + 2) : line.slice(colon + 1));
    if (field === 'data') {
      dataLines.push(value);
    } else if (field === 'id') {
      const parsedId = eventCursor.safeParse(value);
      if (!parsedId.success) {
        throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid managed lifecycle event ID');
      }
      frameId = parsedId.data;
    } else if (field === 'event' && value !== 'message' && value !== 'argus.runtime.event') {
      // Event names are not a trust boundary, but rejecting unexpected names
      // keeps the Pack event protocol narrow and versioned.
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an unsupported managed lifecycle event type');
    }
    // `retry` and unknown SSE extension fields are intentionally ignored. The
    // normalized JSON payload above is the sole evidence Core consumes.
  }
  flush();
  return {
    events,
    ...(events.length > 0 ? { lastEventId: events.at(-1)?.eventId } : {}),
  };
}

/**
 * Read-only Core client for Pack-declared runtime adapters.
 *
 * The service credential is read only inside Core from the operator-provided
 * token file. The client never accepts an adapter URL, credentials, or an
 * execution grant from a browser request.
 */
export class SolutionPackRuntimeAdapterClient implements RuntimeAdapterGateway {
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly readTokenFile: (filename: string) => Promise<string>;

  constructor(
    private readonly registry: SolutionPackRegistry,
    options: RuntimeAdapterClientOptions = {},
  ) {
    this.timeoutMs = Math.min(15_000, Math.max(250, options.timeoutMs ?? 5_000));
    this.fetchFn = options.fetchFn ?? fetch;
    this.readTokenFile = options.readTokenFile ?? readSolutionPackServiceToken;
  }

  async getCapabilities(packId: string, adapterId: string): Promise<RuntimeAdapterCapabilitiesResult> {
    const resolved = this.resolveAdapter(packId, adapterId);
    const payload = await this.request(resolved, 'capabilities');
    const parsed = runtimeAdapterCapabilitiesSchema.safeParse(payload);
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid capabilities response');
    }
    this.assertIdentity(resolved.adapter, parsed.data.adapter);
    if (!unique(parsed.data.modes) || !unique(parsed.data.capabilities)
      || !isSubset(parsed.data.modes, resolved.adapter.modes)
      || !isSubset(parsed.data.capabilities, resolved.adapter.capabilities)) {
      throw new RuntimeAdapterClientError(
        502,
        'adapter_contract_mismatch',
        'Runtime adapter capabilities exceed or conflict with the discovered Pack declaration',
      );
    }
    return { adapter: resolved.adapter, capabilities: parsed.data };
  }

  async getStatus(packId: string, adapterId: string): Promise<RuntimeAdapterStatusResult> {
    const resolved = this.resolveAdapter(packId, adapterId);
    const payload = await this.request(resolved, 'status');
    const parsed = runtimeAdapterStatusSchema.safeParse(payload);
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid status response');
    }
    this.assertIdentity(resolved.adapter, parsed.data.adapter);
    const reportedModes = parsed.data.modes.map(item => item.mode);
    if (!unique(reportedModes) || !isSubset(reportedModes, resolved.adapter.modes)) {
      throw new RuntimeAdapterClientError(
        502,
        'adapter_contract_mismatch',
        'Runtime adapter status conflicts with the discovered Pack declaration',
      );
    }
    return { adapter: resolved.adapter, status: parsed.data };
  }

  async startAttachedRun(input: AttachedRuntimeStartInput): Promise<AttachedRuntimeRunResult> {
    const parsed = attachedRuntimeStartInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'Attached runtime request is invalid');
    }
    const request = parsed.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertAttachedCapabilities(resolved, ['runs']);
    return this.requestAttached(
      resolved,
      'POST',
      '/attached/runs',
      JSON.stringify({ apiVersion: ARGUS_RUNTIME_ADAPTER_PROTOCOL, input: request.input }),
    );
  }

  async getAttachedRunStatus(input: AttachedRuntimeLifecycleInput): Promise<AttachedRuntimeRunResult> {
    const parsed = attachedRuntimeLifecycleInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'Attached runtime lifecycle request is invalid');
    }
    const request = parsed.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertAttachedCapabilities(resolved, ['runs']);
    const result = await this.requestAttached(resolved, 'GET', `/attached/runs/${encodeURIComponent(request.runId)}`);
    this.assertAttachedRunBinding(request.runId, result.run.id);
    return result;
  }

  async stopAttachedRun(input: AttachedRuntimeLifecycleInput): Promise<AttachedRuntimeRunResult> {
    const parsed = attachedRuntimeLifecycleInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_attached_runtime_request', 'Attached runtime lifecycle request is invalid');
    }
    const request = parsed.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertAttachedCapabilities(resolved, ['runs', 'cancel']);
    const result = await this.requestAttached(
      resolved,
      'POST',
      `/attached/runs/${encodeURIComponent(request.runId)}/stop`,
      JSON.stringify({ apiVersion: ARGUS_RUNTIME_ADAPTER_PROTOCOL }),
    );
    this.assertAttachedRunBinding(request.runId, result.run.id);
    return result;
  }

  /**
   * Internal managed-runtime contract transport.
   *
   * This method is deliberately not part of RuntimeAdapterGateway: that
   * interface backs the read-only admin inventory routes. There is currently
   * no browser route, workflow route, or runtime-profile integration that can
   * invoke this start operation.
   */
  async startManagedRun(input: ManagedRuntimeStartInput): Promise<ManagedRuntimeStartResult> {
    const parsedInput = managedRuntimeStartInputSchema.safeParse(input);
    if (!parsedInput.success) {
      // Zod's diagnostic may include user-controlled values, including an
      // opaque execution grant. Keep the public error deliberately generic.
      throw new RuntimeAdapterClientError(
        400,
        'invalid_managed_runtime_start',
        'Managed runtime start request is invalid',
      );
    }
    const request = parsedInput.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertManagedCapabilities(resolved, ['runs', 'mcp-fabric']);

    const body = JSON.stringify({
      apiVersion: ARGUS_RUNTIME_ADAPTER_PROTOCOL,
      requestId: request.requestId,
      mode: 'managed',
      run: request.run,
      runtimeMcpLease: request.runtimeMcpLease,
      limits: request.limits,
    });
    let response: Response;
    try {
      response = await this.fetchFn(
        `${resolved.endpoint.endpoint}${resolved.adapter.endpoint}/adapters/${encodeURIComponent(resolved.adapter.id)}/runs`,
        {
          method: 'POST',
          headers: {
            ...await this.headers(resolved.endpoint),
            'content-type': 'application/json',
            'x-argus-root-trace-id': request.run.rootTraceId,
          },
          body,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (cause) {
      if (cause instanceof RuntimeAdapterClientError) throw cause;
      // Do not include a network error's message: URLs, request details, or
      // wrapped diagnostics may disclose internal runtime information.
      throw new RuntimeAdapterClientError(502, 'peer_unavailable', 'Runtime adapter is unavailable');
    }

    const text = await boundedText(response);
    if (response.status === 409) {
      const notProvisioned = managedRunnerNotProvisionedResponseSchema.safeParse(parseJsonOrNull(text));
      if (notProvisioned.success) {
        // The Pack's human-readable message is intentionally not exposed.
        throw new RuntimeAdapterClientError(
          409,
          'managed_runner_not_provisioned',
          'The managed runtime is not provisioned',
        );
      }
    }
    if (response.status !== 202) {
      throw new RuntimeAdapterClientError(
        502,
        'peer_rejected',
        `Runtime adapter rejected the managed start request (HTTP ${response.status})`,
      );
    }
    const parsedResponse = managedRuntimeStartResponseSchema.safeParse(parseJsonOrNull(text));
    if (!parsedResponse.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid managed start response');
    }
    if (parsedResponse.data.run.id !== request.run.id
      || parsedResponse.data.run.rootTraceId !== request.run.rootTraceId) {
      throw new RuntimeAdapterClientError(
        502,
        'managed_run_identity_mismatch',
        'Runtime adapter start response is not bound to the requested run and trace',
      );
    }
    return parsedResponse.data;
  }

  /**
   * Reads normalized managed-run state from a fixed Pack lifecycle path.
   * The expected root trace is supplied by Core and must be echoed by the
   * Pack, preventing a lifecycle response from being attached to another run.
   */
  async getManagedRunStatus(input: ManagedRuntimeRunStatusInput): Promise<ManagedRuntimeRunStatusResult> {
    const parsedInput = managedRuntimeRunStatusInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_managed_runtime_lifecycle_request', 'Managed runtime lifecycle request is invalid');
    }
    const request = parsedInput.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertManagedCapabilities(resolved, ['runs']);
    const { response, text } = await this.requestManagedLifecycle(
      resolved,
      request,
      'GET',
      `/runs/${encodeURIComponent(request.runId)}`,
    );
    this.throwIfManagedRunnerNotProvisioned(response, text);
    if (response.status === 404) {
      throw new RuntimeAdapterClientError(404, 'managed_run_not_found', 'Managed runtime run was not found');
    }
    if (response.status !== 200) {
      throw new RuntimeAdapterClientError(502, 'peer_rejected', `Runtime adapter rejected the managed status request (HTTP ${response.status})`);
    }
    const parsedResponse = managedRuntimeRunStatusResponseSchema.safeParse(parseJsonOrNull(text));
    if (!parsedResponse.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid managed status response');
    }
    this.assertManagedRunBinding(request, parsedResponse.data.run);
    return parsedResponse.data;
  }

  /**
   * Requests cancellation through the Pack's fixed lifecycle contract. The
   * execution grant deliberately is not accepted here: a cancellation never
   * renews, transports, or exposes the runner's MCP lease.
   */
  async cancelManagedRun(input: ManagedRuntimeRunCancelInput): Promise<ManagedRuntimeRunCancelResult> {
    const parsedInput = managedRuntimeRunCancelInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_managed_runtime_lifecycle_request', 'Managed runtime lifecycle request is invalid');
    }
    const request = parsedInput.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertManagedCapabilities(resolved, ['runs', 'cancel']);
    const { response, text } = await this.requestManagedLifecycle(
      resolved,
      request,
      'POST',
      `/runs/${encodeURIComponent(request.runId)}/cancel`,
      JSON.stringify({
        apiVersion: ARGUS_RUNTIME_ADAPTER_PROTOCOL,
        requestId: request.requestId,
        rootTraceId: request.rootTraceId,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }),
    );
    this.throwIfManagedRunnerNotProvisioned(response, text);
    if (response.status === 404) {
      throw new RuntimeAdapterClientError(404, 'managed_run_not_found', 'Managed runtime run was not found');
    }
    if (response.status !== 200) {
      throw new RuntimeAdapterClientError(502, 'peer_rejected', `Runtime adapter rejected the managed cancel request (HTTP ${response.status})`);
    }
    const parsedResponse = managedRuntimeRunCancelResponseSchema.safeParse(parseJsonOrNull(text));
    if (!parsedResponse.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid managed cancel response');
    }
    this.assertManagedRunBinding(request, parsedResponse.data.run);
    return parsedResponse.data;
  }

  /**
   * Reads a finite, body-bounded snapshot of the Pack's redacted SSE event
   * stream. It is not a raw EventSource proxy and it cannot surface native
   * Hermes frames, Pack diagnostics, or lease credentials to a consumer.
   */
  async getManagedRunEvents(input: ManagedRuntimeRunEventsInput): Promise<ManagedRuntimeRunEventsResult> {
    const parsedInput = managedRuntimeRunEventsInputSchema.safeParse(input);
    if (!parsedInput.success) {
      throw new RuntimeAdapterClientError(400, 'invalid_managed_runtime_lifecycle_request', 'Managed runtime lifecycle request is invalid');
    }
    const request = parsedInput.data;
    const resolved = this.resolveAdapter(request.packId, request.adapterId);
    this.assertManagedCapabilities(resolved, ['runs', 'events-sse']);
    const { response, text } = await this.requestManagedLifecycle(
      resolved,
      request,
      'GET',
      `/runs/${encodeURIComponent(request.runId)}/events`,
      undefined,
      'text/event-stream',
      request.after,
    );
    this.throwIfManagedRunnerNotProvisioned(response, text);
    if (response.status === 404) {
      throw new RuntimeAdapterClientError(404, 'managed_run_not_found', 'Managed runtime run was not found');
    }
    if (response.status !== 200) {
      throw new RuntimeAdapterClientError(502, 'peer_rejected', `Runtime adapter rejected the managed events request (HTTP ${response.status})`);
    }
    if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned a non-SSE managed events response');
    }
    const result = parseManagedRuntimeEventStream(text);
    for (const event of result.events) {
      this.assertManagedRunBinding(request, event.run);
    }
    return result;
  }

  private resolveAdapter(packId: string, adapterId: string): ResolvedRuntimeAdapter {
    const discovered = this.registry.get(packId);
    const endpoint = this.registry.getEndpoint(packId);
    if (!discovered || !endpoint) {
      throw new RuntimeAdapterClientError(404, 'pack_not_found', `solution pack '${packId}' is not configured`);
    }
    if (discovered.state !== 'ready' || !discovered.manifest) {
      throw new RuntimeAdapterClientError(409, 'pack_not_ready', `solution pack '${packId}' is ${discovered.state}`);
    }
    const adapter = discovered.manifest.spec.components.runtimeAdapters.find(item => item.id === adapterId);
    if (!adapter) {
      throw new RuntimeAdapterClientError(404, 'runtime_adapter_not_found', `runtime adapter '${adapterId}' was not declared by '${packId}'`);
    }
    return { endpoint, adapter };
  }

  private assertManagedCapabilities(resolved: ResolvedRuntimeAdapter, requiredCapabilities: readonly string[]): void {
    if (!resolved.adapter.modes.includes('managed')
      || !requiredCapabilities.every(capability => resolved.adapter.capabilities.includes(capability))) {
      throw new RuntimeAdapterClientError(
        409,
        'managed_runtime_not_supported',
        'The discovered runtime adapter does not declare the required managed runtime capabilities',
      );
    }
  }

  private assertAttachedCapabilities(resolved: ResolvedRuntimeAdapter, requiredCapabilities: readonly string[]): void {
    if (!resolved.adapter.modes.includes('attached')
      || !requiredCapabilities.every(capability => resolved.adapter.capabilities.includes(capability))) {
      throw new RuntimeAdapterClientError(
        409,
        'attached_runtime_not_supported',
        'The discovered runtime adapter does not declare the required attached runtime capabilities',
      );
    }
  }

  private assertAttachedRunBinding(expected: string, actual: string): void {
    if (expected !== actual) {
      throw new RuntimeAdapterClientError(502, 'adapter_contract_mismatch', 'Attached runtime response is not bound to the requested run');
    }
  }

  private assertManagedRunBinding(
    expected: Pick<ManagedRuntimeRunStatusInput, 'runId' | 'rootTraceId'>,
    actual: Pick<ManagedRuntimeRunSummary | ManagedRuntimeRunEvent['run'], 'id' | 'rootTraceId'>,
  ): void {
    if (actual.id !== expected.runId || actual.rootTraceId !== expected.rootTraceId) {
      throw new RuntimeAdapterClientError(
        502,
        'managed_run_identity_mismatch',
        'Runtime adapter lifecycle response is not bound to the requested run and trace',
      );
    }
  }

  private throwIfManagedRunnerNotProvisioned(response: Response, text: string): void {
    if (response.status !== 409) return;
    const notProvisioned = managedRunnerNotProvisionedResponseSchema.safeParse(parseJsonOrNull(text));
    if (notProvisioned.success) {
      // The Pack's human-readable message is intentionally not exposed.
      throw new RuntimeAdapterClientError(
        409,
        'managed_runner_not_provisioned',
        'The managed runtime is not provisioned',
      );
    }
  }

  private async headers(endpoint: SolutionPackEndpoint, accept = 'application/json'): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      accept,
      'x-argus-runtime-protocol': ARGUS_RUNTIME_ADAPTER_PROTOCOL,
    };
    if (endpoint.tokenFile) headers.authorization = `Bearer ${await this.readTokenFile(endpoint.tokenFile)}`;
    return headers;
  }

  private async requestManagedLifecycle(
    resolved: ResolvedRuntimeAdapter,
    request: Pick<ManagedRuntimeRunStatusInput, 'runId' | 'rootTraceId'>,
    method: 'GET' | 'POST',
    suffix: string,
    body?: string,
    accept = 'application/json',
    after?: string,
  ): Promise<{ response: Response; text: string }> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${resolved.endpoint.endpoint}${resolved.adapter.endpoint}/adapters/${encodeURIComponent(resolved.adapter.id)}${suffix}`,
        {
          method,
          headers: {
            ...await this.headers(resolved.endpoint, accept),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            'x-argus-root-trace-id': request.rootTraceId,
            ...(after === undefined ? {} : { 'last-event-id': after }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: AbortSignal.timeout(
            method === 'POST' && suffix.endsWith('/cancel')
              ? MANAGED_RUNTIME_CANCEL_TIMEOUT_MS
              : this.timeoutMs,
          ),
        },
      );
    } catch (cause) {
      if (cause instanceof RuntimeAdapterClientError) throw cause;
      // Never include peer/network error text: it can carry Pack internals.
      throw new RuntimeAdapterClientError(502, 'peer_unavailable', 'Runtime adapter is unavailable');
    }
    let text: string;
    try {
      text = await boundedText(response);
    } catch (cause) {
      if (cause instanceof RuntimeAdapterClientError) throw cause;
      throw new RuntimeAdapterClientError(502, 'peer_unavailable', 'Runtime adapter is unavailable');
    }
    return { response, text };
  }

  private async requestAttached(
    resolved: ResolvedRuntimeAdapter,
    method: 'GET' | 'POST',
    suffix: string,
    body?: string,
  ): Promise<AttachedRuntimeRunResult> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${resolved.endpoint.endpoint}${resolved.adapter.endpoint}/adapters/${encodeURIComponent(resolved.adapter.id)}${suffix}`,
        {
          method,
          headers: {
            ...await this.headers(resolved.endpoint),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new RuntimeAdapterClientError(502, 'peer_unavailable', 'Runtime adapter is unavailable');
    }
    const text = await boundedText(response);
    if (response.status === 409) {
      throw new RuntimeAdapterClientError(409, 'attached_runtime_unavailable', 'Attached Hermes execution is not configured');
    }
    if ((method === 'POST' && response.status !== 200 && response.status !== 202)
      || (method === 'GET' && response.status !== 200)) {
      throw new RuntimeAdapterClientError(502, 'peer_rejected', `Runtime adapter rejected the attached lifecycle request (HTTP ${response.status})`);
    }
    const parsed = attachedRuntimeResponseSchema.safeParse(parseJsonOrNull(text));
    if (!parsed.success) {
      throw new RuntimeAdapterClientError(502, 'invalid_response', 'Runtime adapter returned an invalid attached run response');
    }
    return parsed.data;
  }

  private async request(resolved: ResolvedRuntimeAdapter, operation: 'capabilities' | 'status'): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(
        `${resolved.endpoint.endpoint}${resolved.adapter.endpoint}/adapters/${encodeURIComponent(resolved.adapter.id)}/${operation}`,
        {
        method: 'GET',
        headers: await this.headers(resolved.endpoint),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (cause) {
      if (cause instanceof RuntimeAdapterClientError) throw cause;
      throw new RuntimeAdapterClientError(
        502,
        'peer_unavailable',
        'Runtime adapter is unavailable',
      );
    }
    const text = await boundedText(response);
    if (!response.ok) {
      // Do not relay Pack response bodies: they can contain upstream runtime
      // diagnostics or configuration details which do not belong in the UI.
      throw new RuntimeAdapterClientError(502, 'peer_rejected', `Runtime adapter rejected the request (HTTP ${response.status})`);
    }
    return parseResponse(text);
  }

  private assertIdentity(
    declared: RuntimeAdapterDeclaration,
    reported: RuntimeAdapterCapabilities['adapter'],
  ): void {
    if (reported.id !== declared.id || reported.runtime !== declared.runtime
      || reported.protocol !== declared.protocol) {
      throw new RuntimeAdapterClientError(
        502,
        'adapter_identity_mismatch',
        'Runtime adapter response does not match the discovered Pack declaration',
      );
    }
  }
}
