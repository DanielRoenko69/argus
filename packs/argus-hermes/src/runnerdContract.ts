import {
  parseManagedHermesRunStartRequest,
  type ManagedHermesRunStartRequest,
  type ManagedHermesRunUsage,
  type ManagedRunContractValidationOptions,
} from './managedRunContract.js';

/**
 * Private Pack <-> runnerd protocol. `runnerd` is a separately deployed,
 * narrowly privileged launcher; the Pack itself never receives a Docker or
 * Kubernetes control-plane credential.
 *
 * The only message carrying the Core execution grant is `POST /v1/runs`.
 * runnerd must hand that value directly to a per-run MCP auth proxy (for
 * example through a 0600 tmpfs file) and must never make it available to the
 * Hermes process, its environment, its native profile, or lifecycle replies.
 */
export const ARGUS_HERMES_RUNNERD_PROTOCOL = 'argus.hermes.runnerd/v1alpha1';
export const HERMES_RUNNERD_RUNS_PATH = '/v1/runs';
export const HERMES_RUNNERD_READY_PATH = '/v1/ready';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const EVIDENCE_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
// V1 evidence is deliberately machine-readable only. Human-readable final
// model output uses the separate bounded `output` field and is never folded
// into durable evidence, diagnostics or connection metadata.
const SENSITIVE_EVIDENCE_KEY = /(?:token|secret|grant|authorization|password|credential|api[._-]?key|endpoint|url|path|profile|command|image|mount|network|prompt|instruction|input|message|output|text|content|detail|raw|error)/i;
// No whitespace, slash, colon or free prose is allowed in a string label.
// In particular this rejects URLs, paths and bare host:port values such as
// `mcp-server:3000` without having to infer intent from arbitrary text.
const EVIDENCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_EVIDENCE_VALUE = /(?:\beg_v1\.|\b(?:bearer|authorization)\b|(?:^|[._-])(?:prompt|instructions?|input|message|output|content|text)(?:$|[._-])|https?:\/\/|(?:^|\s)(?:[A-Za-z]:[\\/]|\/(?:[A-Za-z0-9._-]+\/)+))/i;

export type HermesRunnerdRunState = 'running' | 'completed' | 'failed' | 'cancelled' | 'awaiting_approval';

export type HermesRunnerdEvidence = Record<string, string | number | boolean | null>;

/**
 * `request` is intentionally the existing Pack-managed envelope, rather than
 * an unbounded launch spec. In particular, it contains no image, command,
 * mount, network, environment or host-control field. Those choices belong to
 * runnerd's operator-owned policy, not to Core or this Pack.
 */
export interface HermesRunnerdLaunchRequest {
  apiVersion: typeof ARGUS_HERMES_RUNNERD_PROTOCOL;
  request: ManagedHermesRunStartRequest;
}

/**
 * Redacted runnerd projection. This is the entire response shape for launch,
 * status and cancellation. It intentionally cannot carry a grant, MCP URL,
 * native profile path, image reference, raw log line, or upstream error.
 */
export interface HermesRunnerdRun {
  id: string;
  nativeRunId?: string;
  state: HermesRunnerdRunState;
  evidence?: HermesRunnerdEvidence;
  /** In-memory terminal model result. Never persisted by runnerd. */
  output?: string;
  /** Sanitized terminal accounting. Never includes model, provider or session IDs. */
  usage?: ManagedHermesRunUsage;
  errorCode?: string;
}

export interface HermesRunnerdRunResponse {
  apiVersion: typeof ARGUS_HERMES_RUNNERD_PROTOCOL;
  run: HermesRunnerdRun;
}

/**
 * The Pack must preflight this exact response before it advertises managed
 * execution. A runnerd transport being merely configured is not readiness.
 */
export interface HermesRunnerdReadyResponse {
  apiVersion: typeof ARGUS_HERMES_RUNNERD_PROTOCOL;
  state: 'ready';
}

/**
 * The run identity is bound by the URL path. Duplicating it in the body would
 * add a mismatch primitive, so only the bounded operator reason is accepted.
 */
export interface HermesRunnerdCancelRequest {
  apiVersion: typeof ARGUS_HERMES_RUNNERD_PROTOCOL;
  reason?: string;
}

export class HermesRunnerdContractError extends Error {
  constructor(
    readonly code: 'INVALID_RUNNERD_REQUEST' | 'INVALID_RUNNERD_RESPONSE',
    message: string,
  ) {
    super(message);
  }
}

function object(value: unknown, name: string, code: HermesRunnerdContractError['code']): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HermesRunnerdContractError(code, `${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
  code: HermesRunnerdContractError['code'],
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new HermesRunnerdContractError(code, `${name} contains an unsupported field`);
  }
}

function string(
  value: unknown,
  name: string,
  max: number,
  code: HermesRunnerdContractError['code'],
): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\r\n\u0000]/.test(value)) {
    throw new HermesRunnerdContractError(code, `${name} must be a non-empty safe string up to ${max} characters`);
  }
  return value;
}

function uuid(value: unknown, name: string, code: HermesRunnerdContractError['code']): string {
  const parsed = string(value, name, 36, code);
  if (!UUID.test(parsed)) throw new HermesRunnerdContractError(code, `${name} must be a UUID`);
  return parsed;
}

function evidence(value: unknown, code: HermesRunnerdContractError['code']): HermesRunnerdEvidence {
  const parsed = object(value, 'run.evidence', code);
  const entries = Object.entries(parsed);
  if (entries.length > 16 || entries.some(([key]) => !EVIDENCE_KEY.test(key) || SENSITIVE_EVIDENCE_KEY.test(key))) {
    throw new HermesRunnerdContractError(code, 'run.evidence contains invalid keys');
  }
  const normalized: HermesRunnerdEvidence = {};
  for (const [key, item] of entries) {
    if (typeof item === 'string') {
      if (!EVIDENCE_LABEL.test(item) || SENSITIVE_EVIDENCE_VALUE.test(item)) {
        throw new HermesRunnerdContractError(code, 'run.evidence contains an invalid string value');
      }
      normalized[key] = item;
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new HermesRunnerdContractError(code, 'run.evidence contains an invalid number value');
      normalized[key] = item;
      continue;
    }
    if (typeof item === 'boolean' || item === null) {
      normalized[key] = item;
      continue;
    }
    throw new HermesRunnerdContractError(code, 'run.evidence contains an unsupported value');
  }
  return normalized;
}

function modelOutput(value: unknown, code: HermesRunnerdContractError['code']): string {
  if (typeof value !== 'string' || value.length > 32 * 1024 || value.includes('\u0000')) {
    throw new HermesRunnerdContractError(code, 'response.run.output must be a bounded text result');
  }
  return value;
}

function usage(value: unknown, code: HermesRunnerdContractError['code']): ManagedHermesRunUsage {
  const parsed = object(value, 'response.run.usage', code);
  exactKeys(parsed, [
    'inputTokens', 'outputTokens', 'totalTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens',
    'reasoningTokens', 'apiCalls', 'estimatedCostUsd',
  ], 'response.run.usage', code);
  const integer = (name: string): number => {
    const item = parsed[name];
    if (typeof item !== 'number' || !Number.isSafeInteger(item) || item < 0) {
      throw new HermesRunnerdContractError(code, `response.run.usage.${name} must be a non-negative integer`);
    }
    return item;
  };
  const optionalInteger = (name: string): number | undefined => parsed[name] === undefined ? undefined : integer(name);
  const estimatedCostUsd = parsed.estimatedCostUsd;
  if (estimatedCostUsd !== undefined && (
    typeof estimatedCostUsd !== 'number' || !Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0
  )) {
    throw new HermesRunnerdContractError(code, 'response.run.usage.estimatedCostUsd must be a non-negative number');
  }
  return {
    inputTokens: integer('inputTokens'),
    outputTokens: integer('outputTokens'),
    totalTokens: integer('totalTokens'),
    ...(optionalInteger('cacheReadInputTokens') === undefined ? {} : { cacheReadInputTokens: optionalInteger('cacheReadInputTokens') }),
    ...(optionalInteger('cacheWriteInputTokens') === undefined ? {} : { cacheWriteInputTokens: optionalInteger('cacheWriteInputTokens') }),
    ...(optionalInteger('reasoningTokens') === undefined ? {} : { reasoningTokens: optionalInteger('reasoningTokens') }),
    ...(optionalInteger('apiCalls') === undefined ? {} : { apiCalls: optionalInteger('apiCalls') }),
    ...(estimatedCostUsd === undefined ? {} : { estimatedCostUsd }),
  };
}

/** Build the only permitted Pack-to-runnerd launch payload. */
export function createHermesRunnerdLaunchRequest(request: ManagedHermesRunStartRequest): HermesRunnerdLaunchRequest {
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    request,
  };
}

/**
 * Strict runnerd-side parser. It uses the existing managed request parser so
 * the runnerd boundary independently checks the lease's exact Core MCP path,
 * trace binding, grant format, limits and selected bundle IDs.
 */
export function parseHermesRunnerdLaunchRequest(
  value: unknown,
  options: ManagedRunContractValidationOptions = {},
): HermesRunnerdLaunchRequest {
  const root = object(value, 'request', 'INVALID_RUNNERD_REQUEST');
  exactKeys(root, ['apiVersion', 'request'], 'request', 'INVALID_RUNNERD_REQUEST');
  if (root.apiVersion !== ARGUS_HERMES_RUNNERD_PROTOCOL) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_REQUEST', `apiVersion must be ${ARGUS_HERMES_RUNNERD_PROTOCOL}`);
  }
  try {
    return {
      apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
      request: parseManagedHermesRunStartRequest(root.request, options),
    };
  } catch {
    // Do not propagate nested request errors here: the nested value can carry
    // a grant and runnerd must never reflect it back to a caller or log.
    throw new HermesRunnerdContractError('INVALID_RUNNERD_REQUEST', 'request must be a valid managed Hermes run envelope');
  }
}

/** A stable helper prevents individual callers from constructing loose paths. */
export function hermesRunnerdRunPath(runId: string): string {
  return `${HERMES_RUNNERD_RUNS_PATH}/${uuid(runId, 'runId', 'INVALID_RUNNERD_REQUEST')}`;
}

export function createHermesRunnerdCancelRequest(reason?: string): HermesRunnerdCancelRequest {
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    ...(reason === undefined ? {} : { reason: string(reason, 'reason', 1_024, 'INVALID_RUNNERD_REQUEST') }),
  };
}

export function parseHermesRunnerdReadyResponse(value: unknown): HermesRunnerdReadyResponse {
  const root = object(value, 'response', 'INVALID_RUNNERD_RESPONSE');
  exactKeys(root, ['apiVersion', 'state'], 'response', 'INVALID_RUNNERD_RESPONSE');
  if (root.apiVersion !== ARGUS_HERMES_RUNNERD_PROTOCOL || root.state !== 'ready') {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'runnerd readiness response is invalid');
  }
  return { apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, state: 'ready' };
}

export function parseHermesRunnerdCancelRequest(value: unknown): HermesRunnerdCancelRequest {
  const root = object(value, 'request', 'INVALID_RUNNERD_REQUEST');
  exactKeys(root, ['apiVersion', 'reason'], 'request', 'INVALID_RUNNERD_REQUEST');
  if (root.apiVersion !== ARGUS_HERMES_RUNNERD_PROTOCOL) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_REQUEST', `apiVersion must be ${ARGUS_HERMES_RUNNERD_PROTOCOL}`);
  }
  return {
    apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
    ...(root.reason === undefined ? {} : { reason: string(root.reason, 'reason', 1_024, 'INVALID_RUNNERD_REQUEST') }),
  };
}

/**
 * Strict Pack-side parser for every runnerd response. `expectedRunId` binds a
 * response to the Pack lifecycle call that initiated it and makes a broker
 * mix-up fail closed before it can advance another run's state.
 */
export function parseHermesRunnerdRunResponse(value: unknown, expectedRunId?: string): HermesRunnerdRunResponse {
  const root = object(value, 'response', 'INVALID_RUNNERD_RESPONSE');
  exactKeys(root, ['apiVersion', 'run'], 'response', 'INVALID_RUNNERD_RESPONSE');
  if (root.apiVersion !== ARGUS_HERMES_RUNNERD_PROTOCOL) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', `apiVersion must be ${ARGUS_HERMES_RUNNERD_PROTOCOL}`);
  }
  const run = object(root.run, 'response.run', 'INVALID_RUNNERD_RESPONSE');
  exactKeys(run, ['id', 'nativeRunId', 'state', 'evidence', 'output', 'usage', 'errorCode'], 'response.run', 'INVALID_RUNNERD_RESPONSE');
  const id = uuid(run.id, 'response.run.id', 'INVALID_RUNNERD_RESPONSE');
  if (expectedRunId !== undefined && id !== uuid(expectedRunId, 'expectedRunId', 'INVALID_RUNNERD_RESPONSE')) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.id does not match the requested run');
  }
  if (typeof run.state !== 'string' || !['running', 'completed', 'failed', 'cancelled', 'awaiting_approval'].includes(run.state)) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.state is invalid');
  }
  const state = run.state as HermesRunnerdRunState;
  const nativeRunId = run.nativeRunId === undefined
    ? undefined
    : string(run.nativeRunId, 'response.run.nativeRunId', 255, 'INVALID_RUNNERD_RESPONSE');
  if (nativeRunId !== undefined && !NATIVE_RUN_ID.test(nativeRunId)) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.nativeRunId is invalid');
  }
  if (['running', 'completed', 'awaiting_approval'].includes(state) && !nativeRunId) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.nativeRunId is required for the reported state');
  }
  const errorCode = run.errorCode === undefined
    ? undefined
    : string(run.errorCode, 'response.run.errorCode', 96, 'INVALID_RUNNERD_RESPONSE');
  if (errorCode !== undefined && !ERROR_CODE.test(errorCode)) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.errorCode is invalid');
  }
  if (state === 'failed' && !errorCode) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.errorCode is required for a failed run');
  }
  if (state !== 'failed' && errorCode !== undefined) {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.errorCode is only allowed for a failed run');
  }
  const output = run.output === undefined ? undefined : modelOutput(run.output, 'INVALID_RUNNERD_RESPONSE');
  if (output !== undefined && state !== 'completed') {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.output is only allowed for a completed run');
  }
  const normalizedUsage = run.usage === undefined ? undefined : usage(run.usage, 'INVALID_RUNNERD_RESPONSE');
  if (normalizedUsage !== undefined && state !== 'completed') {
    throw new HermesRunnerdContractError('INVALID_RUNNERD_RESPONSE', 'response.run.usage is only allowed for a completed run');
  }
  const normalized: HermesRunnerdRun = {
    id,
    state,
    ...(nativeRunId === undefined ? {} : { nativeRunId }),
    ...(run.evidence === undefined ? {} : { evidence: evidence(run.evidence, 'INVALID_RUNNERD_RESPONSE') }),
    ...(output === undefined ? {} : { output }),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
  return { apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL, run: normalized };
}

export function isHermesRunnerdTerminalState(state: HermesRunnerdRunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}
