import { ARGUS_RUNTIME_PROTOCOL, HERMES_RUNTIME_ADAPTER_ID } from './runtimeTypes.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const EXECUTION_GRANT = /^eg_v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export const MANAGED_RUNTIME_LEASE_KIND = 'argus.runtime-mcp-lease/v1alpha1';

/**
 * These states are Pack-normalized lifecycle evidence. They deliberately do
 * not mirror arbitrary native Hermes state strings, which could change across
 * the independently maintained upstream runtime.
 */
export type ManagedHermesRunState =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'awaiting_approval'
  | 'cancelling'
  | 'cancelled'
  | 'completed'
  | 'failed';

export interface ManagedHermesRunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  reasoningTokens?: number;
  apiCalls?: number;
  estimatedCostUsd?: number;
}

export interface ManagedHermesRunSummary {
  id: string;
  mode: 'managed';
  rootTraceId: string;
  state: ManagedHermesRunState;
  /** Time at which the Pack durably accepted the start request. */
  acceptedAt: string;
  /** Time at which the Pack last updated the normalized run state. */
  updatedAt: string;
  /** Opaque Pack event cursor, safe to use for an SSE reconnect. */
  eventCursor?: string;
  /** Bounded final result kept only in Pack memory and returned to Argus Core. */
  output?: string;
  /** Provider-neutral accounting projection; model/provider/session IDs stay private. */
  usage?: ManagedHermesRunUsage;
}

/**
 * Sent only by Argus Core when it requests a lifecycle cancellation. It does
 * not carry the execution grant: the grant is supplied exactly once with the
 * managed start request and is never retained by this Pack.
 */
export interface ManagedHermesRunCancelRequest {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  requestId: string;
  rootTraceId: string;
  reason?: string;
}

export interface ManagedHermesRunStatusResponse {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  run: ManagedHermesRunSummary;
}

export interface ManagedHermesRunCancelResponse {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  run: ManagedHermesRunSummary;
}

/**
 * The future SSE surface emits only this redacted, Pack-owned evidence shape.
 * It must never proxy raw Hermes SSE frames, execution grants, upstream API
 * keys, MCP headers, or native profile paths.
 */
export type ManagedHermesRunEventType =
  | 'run.accepted'
  | 'run.provisioning'
  | 'run.started'
  | 'tool.completed'
  | 'approval.requested'
  | 'approval.resolved'
  | 'cancel.requested'
  | 'run.cancelled'
  | 'run.completed'
  | 'run.failed';

export interface ManagedHermesRunEvent {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  eventId: string;
  sequence: number;
  occurredAt: string;
  run: Pick<ManagedHermesRunSummary, 'id' | 'rootTraceId' | 'state'>;
  type: ManagedHermesRunEventType;
  /** Bounded, redacted lifecycle evidence. Never a native Hermes payload. */
  evidence?: Record<string, string | number | boolean | null>;
}

export interface ManagedHermesRunStartRequest {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  requestId: string;
  mode: 'managed';
  run: {
    id: string;
    rootTraceId: string;
    messageId: string;
    sessionId: string;
    coreAgent: { id: number; name: string };
    input: { text: string };
    instructions?: string;
  };
  runtimeMcpLease: {
    kind: typeof MANAGED_RUNTIME_LEASE_KIND;
    leaseId: string;
    endpoint: string;
    executionGrant: string;
    expiresAt: string;
    rootTraceId: string;
    bundleIds: number[];
    serverName: 'argus_core';
  };
  limits: {
    deadlineAt: string;
    maxToolCalls: number;
    maxOutputBytes: number;
  };
}

export interface ManagedHermesRunStartResponse {
  apiVersion: typeof ARGUS_RUNTIME_PROTOCOL;
  run: ManagedHermesRunSummary;
}

/**
 * The Pack can validate the future wire format before a runner exists. A
 * configured Core origin is deliberately optional in the current health-only
 * release, but becomes mandatory via `requireManagedRuntimeMcpOrigin` before
 * any provisioner is allowed to start a managed runner.
 */
export interface ManagedRunContractValidationOptions {
  coreRuntimeMcpOrigin?: string;
}

export class ManagedRunContractError extends Error {
  constructor(readonly code: 'INVALID_RUNTIME_REQUEST' | 'ATTACHED_MCP_LEASE_UNSUPPORTED', message: string) {
    super(message);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} contains an unsupported field`);
  }
}

function string(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be a non-empty string up to ${max} characters`);
  }
  return value;
}

function uuid(value: unknown, name: string): string {
  const parsed = string(value, name, 36);
  if (!UUID.test(parsed)) throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be a UUID`);
  return parsed;
}

/** Strict parser shared by status, cancellation and event route handling. */
export function parseManagedHermesRunId(value: unknown): string {
  return uuid(value, 'runId');
}

function timestamp(value: unknown, name: string): string {
  const parsed = string(value, name, 40);
  if (Number.isNaN(Date.parse(parsed))) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be an ISO timestamp`);
  }
  return parsed;
}

function positive(value: unknown, name: string, max: number): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be a positive integer no larger than ${max}`);
  }
  return Number(value);
}

function identifiers(value: unknown, name: string, max: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must be an array with between 1 and ${max} IDs`);
  }
  const ids = value.map((item, index) => positive(item, `${name}[${index}]`, Number.MAX_SAFE_INTEGER));
  if (new Set(ids).size !== ids.length) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `${name} must not contain duplicate IDs`);
  }
  return ids;
}

function runtimeMcpEndpoint(
  value: unknown,
  leaseId: string,
  coreRuntimeMcpOrigin?: string,
): string {
  const endpoint = string(value, 'runtimeMcpLease.endpoint', 2_048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtimeMcpLease.endpoint must be an HTTP URL');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash) {
    throw new ManagedRunContractError(
      'INVALID_RUNTIME_REQUEST',
      'runtimeMcpLease.endpoint must be a credential-free HTTP(S) URL without query or fragment',
    );
  }
  if (url.pathname !== `/mcp/runtime/${leaseId}`) {
    throw new ManagedRunContractError(
      'INVALID_RUNTIME_REQUEST',
      'runtimeMcpLease.endpoint must target its exact /mcp/runtime/<leaseId> path',
    );
  }
  if (coreRuntimeMcpOrigin && url.origin !== coreRuntimeMcpOrigin) {
    throw new ManagedRunContractError(
      'INVALID_RUNTIME_REQUEST',
      'runtimeMcpLease.endpoint must target the configured Argus Core runtime MCP origin',
    );
  }
  return endpoint;
}

/**
 * Parses a managed-run request before anything can be provisioned. The opaque
 * execution grant is validated for format only; its signature and active
 * lease binding are always verified by Argus Core at the MCP endpoint.
 */
export function parseManagedHermesRunStartRequest(
  value: unknown,
  options: ManagedRunContractValidationOptions = {},
): ManagedHermesRunStartRequest {
  const root = object(value, 'request');
  exactKeys(root, ['apiVersion', 'requestId', 'mode', 'run', 'runtimeMcpLease', 'limits'], 'request');
  if (root.apiVersion !== ARGUS_RUNTIME_PROTOCOL) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `apiVersion must be ${ARGUS_RUNTIME_PROTOCOL}`);
  }
  if (root.mode === 'attached' && root.runtimeMcpLease !== undefined) {
    throw new ManagedRunContractError('ATTACHED_MCP_LEASE_UNSUPPORTED', 'attached Hermes cannot accept a Core-issued runtime MCP lease');
  }
  if (root.mode !== 'managed') {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'mode must be managed');
  }
  const run = object(root.run, 'run');
  exactKeys(run, ['id', 'rootTraceId', 'messageId', 'sessionId', 'coreAgent', 'input', 'instructions'], 'run');
  const coreAgent = object(run.coreAgent, 'run.coreAgent');
  exactKeys(coreAgent, ['id', 'name'], 'run.coreAgent');
  const input = object(run.input, 'run.input');
  exactKeys(input, ['text'], 'run.input');
  const lease = object(root.runtimeMcpLease, 'runtimeMcpLease');
  exactKeys(lease, ['kind', 'leaseId', 'endpoint', 'executionGrant', 'expiresAt', 'rootTraceId', 'bundleIds', 'serverName'], 'runtimeMcpLease');
  const limits = object(root.limits, 'limits');
  exactKeys(limits, ['deadlineAt', 'maxToolCalls', 'maxOutputBytes'], 'limits');
  if (lease.kind !== MANAGED_RUNTIME_LEASE_KIND) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `runtimeMcpLease.kind must be ${MANAGED_RUNTIME_LEASE_KIND}`);
  }
  if (lease.serverName !== 'argus_core') {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtimeMcpLease.serverName must be argus_core');
  }
  const leaseId = uuid(lease.leaseId, 'runtimeMcpLease.leaseId');
  const endpoint = runtimeMcpEndpoint(lease.endpoint, leaseId, options.coreRuntimeMcpOrigin);
  const executionGrant = string(lease.executionGrant, 'runtimeMcpLease.executionGrant', 16_384);
  if (!EXECUTION_GRANT.test(executionGrant)) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'runtimeMcpLease.executionGrant must be an opaque eg_v1 token');
  }
  const rootTraceId = uuid(run.rootTraceId, 'run.rootTraceId');
  const leaseTraceId = uuid(lease.rootTraceId, 'runtimeMcpLease.rootTraceId');
  if (rootTraceId !== leaseTraceId) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'run.rootTraceId must match runtimeMcpLease.rootTraceId');
  }
  const expiresAt = timestamp(lease.expiresAt, 'runtimeMcpLease.expiresAt');
  const deadlineAt = timestamp(limits.deadlineAt, 'limits.deadlineAt');
  if (Date.parse(deadlineAt) > Date.parse(expiresAt)) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'limits.deadlineAt must not exceed runtimeMcpLease.expiresAt');
  }
  return {
    apiVersion: ARGUS_RUNTIME_PROTOCOL,
    requestId: uuid(root.requestId, 'requestId'),
    mode: 'managed',
    run: {
      id: uuid(run.id, 'run.id'),
      rootTraceId,
      messageId: string(run.messageId, 'run.messageId', 128),
      sessionId: string(run.sessionId, 'run.sessionId', 255),
      coreAgent: {
        id: positive(coreAgent.id, 'run.coreAgent.id', Number.MAX_SAFE_INTEGER),
        name: (() => {
          const name = string(coreAgent.name, 'run.coreAgent.name', 128);
          if (!IDENTIFIER.test(name)) throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', 'run.coreAgent.name must be a stable identifier');
          return name;
        })(),
      },
      input: { text: string(input.text, 'run.input.text', 64 * 1024) },
      ...(run.instructions === undefined ? {} : { instructions: string(run.instructions, 'run.instructions', 8 * 1024) }),
    },
    runtimeMcpLease: {
      kind: MANAGED_RUNTIME_LEASE_KIND,
      leaseId,
      endpoint,
      executionGrant,
      expiresAt,
      rootTraceId: leaseTraceId,
      bundleIds: identifiers(lease.bundleIds, 'runtimeMcpLease.bundleIds', 64),
      serverName: 'argus_core',
    },
    limits: {
      deadlineAt,
      maxToolCalls: positive(limits.maxToolCalls, 'limits.maxToolCalls', 1_000),
      maxOutputBytes: positive(limits.maxOutputBytes, 'limits.maxOutputBytes', 4 * 1024 * 1024),
    },
  };
}

/**
 * Validates a Core-originated cancellation envelope independently from the
 * runtime start request. In particular, an execution grant is not accepted on
 * this lifecycle operation, preventing it from becoming a second secret
 * transport or an accidental renewal path.
 */
export function parseManagedHermesRunCancelRequest(value: unknown): ManagedHermesRunCancelRequest {
  const root = object(value, 'request');
  exactKeys(root, ['apiVersion', 'requestId', 'rootTraceId', 'reason'], 'request');
  if (root.apiVersion !== ARGUS_RUNTIME_PROTOCOL) {
    throw new ManagedRunContractError('INVALID_RUNTIME_REQUEST', `apiVersion must be ${ARGUS_RUNTIME_PROTOCOL}`);
  }
  return {
    apiVersion: ARGUS_RUNTIME_PROTOCOL,
    requestId: uuid(root.requestId, 'requestId'),
    rootTraceId: uuid(root.rootTraceId, 'rootTraceId'),
    ...(root.reason === undefined ? {} : { reason: string(root.reason, 'reason', 1_024) }),
  };
}

export function managedRunNotProvisioned(): { error: { code: string; message: string } } {
  return {
    error: {
      code: 'MANAGED_RUNNER_NOT_PROVISIONED',
      message: `No isolated managed Hermes runner is provisioned for adapter ${HERMES_RUNTIME_ADAPTER_ID}.`,
    },
  };
}
