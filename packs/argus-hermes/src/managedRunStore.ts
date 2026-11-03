import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type {
  ManagedHermesRunEvent,
  ManagedHermesRunEventType,
  ManagedHermesRunStartRequest,
  ManagedHermesRunState,
  ManagedHermesRunSummary,
} from './managedRunContract.js';

const STORE_VERSION = 1;
const MAX_EVENTS_PER_RUN = 512;
// Keep persisted evidence compatible with Core's independently validated
// lifecycle schema. In particular, do not accept separators at the end or
// repeated separators here only to have Core reject the Pack's own events.
const EVENT_EVIDENCE_KEY = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
// Managed lifecycle evidence is an audit signal, not a transport for model
// output or native tool diagnostics. The runnerd boundary applies the same
// policy, but this Pack-local guard is intentionally independent so a future
// runner implementation cannot bypass it by invoking callbacks directly.
const SENSITIVE_EVENT_EVIDENCE_KEY = /(?:token|secret|grant|authorization|password|credential|api[._-]?key|endpoint|url|path|profile|command|image|mount|network|prompt|instruction|input|message|output|text|content|detail|raw|error)/i;
const EVENT_EVIDENCE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_EVENT_EVIDENCE_VALUE = /(?:\beg_v1\.|\b(?:bearer|authorization)\b|(?:^|[._-])(?:prompt|instructions?|input|message|output|content|text)(?:$|[._-])|https?:\/\/|(?:^|\s)(?:[A-Za-z]:[\\/]|\/(?:[A-Za-z0-9._-]+\/)+))/i;
const EVENT_CURSOR = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TERMINAL_STATES = new Set<ManagedHermesRunState>(['cancelled', 'completed', 'failed']);
const MANAGED_STATES = new Set<ManagedHermesRunState>([
  'queued', 'provisioning', 'running', 'awaiting_approval', 'cancelling', 'cancelled', 'completed', 'failed',
]);
const EVENT_TYPES = new Set<ManagedHermesRunEventType>([
  'run.accepted', 'run.provisioning', 'run.started', 'tool.completed', 'approval.requested', 'approval.resolved',
  'cancel.requested', 'run.cancelled', 'run.completed', 'run.failed',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<ManagedHermesRunState, readonly ManagedHermesRunState[]>> = {
  queued: ['provisioning', 'cancelling', 'cancelled', 'failed'],
  provisioning: ['running', 'cancelling', 'cancelled', 'failed'],
  running: ['awaiting_approval', 'cancelling', 'completed', 'failed'],
  awaiting_approval: ['running', 'cancelling', 'completed', 'failed'],
  cancelling: ['cancelled', 'failed'],
  cancelled: [],
  completed: [],
  failed: [],
};

export interface StoredManagedHermesRun {
  id: string;
  requestId: string;
  rootTraceId: string;
  coreAgent: { id: number; name: string };
  leaseId: string;
  mode: 'managed';
  state: ManagedHermesRunState;
  acceptedAt: string;
  updatedAt: string;
  eventCursor?: string;
  nativeRunId?: string;
  errorCode?: string;
  events: ManagedHermesRunEvent[];
}

interface ManagedRunStoreDocument {
  version: typeof STORE_VERSION;
  runs: Record<string, StoredManagedHermesRun>;
}

export interface ManagedRunStoreOptions {
  stateDirectory: string;
  now?: () => Date;
  maxEventsPerRun?: number;
}

export interface ManagedRunTransitionInput {
  state: ManagedHermesRunState;
  type: Exclude<ManagedHermesRunEventType, 'run.accepted' | 'tool.completed'>;
  evidence?: Record<string, string | number | boolean | null>;
  nativeRunId?: string;
  errorCode?: string;
}

/**
 * The accept transaction tells the service whether it owns provisioning.
 * Returning only a summary would make two concurrent idempotent starts both
 * look successful and could launch the same native Hermes run twice.
 */
export interface ManagedRunAcceptance {
  run: ManagedHermesRunSummary;
  created: boolean;
}

export class ManagedRunStoreError extends Error {
  constructor(
    readonly code: 'RUN_NOT_FOUND' | 'RUN_REQUEST_CONFLICT' | 'RUN_STATE_CONFLICT' | 'RUN_EVENT_CURSOR_UNKNOWN' | 'RUN_STORE_CORRUPT',
    message: string,
  ) {
    super(message);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}

function storedString(value: unknown, field: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max || /[\r\n\u0000]/.test(value)) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', `managed run state ${field} is invalid`);
  }
  return value;
}

function storedEventCursor(value: unknown, field: string): string {
  const cursor = storedString(value, field, 256);
  if (!EVENT_CURSOR.test(cursor)) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', `managed run state ${field} is invalid`);
  }
  return cursor;
}

function storedTimestamp(value: unknown, field: string): string {
  const timestamp = storedString(value, field, 40);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', `managed run state ${field} is invalid`);
  }
  return timestamp;
}

function storedState(value: unknown, field: string): ManagedHermesRunState {
  if (typeof value !== 'string' || !MANAGED_STATES.has(value as ManagedHermesRunState)) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', `managed run state ${field} is invalid`);
  }
  return value as ManagedHermesRunState;
}

function summary(run: StoredManagedHermesRun): ManagedHermesRunSummary {
  return {
    id: run.id,
    mode: 'managed',
    rootTraceId: run.rootTraceId,
    state: run.state,
    acceptedAt: run.acceptedAt,
    updatedAt: run.updatedAt,
    ...(run.eventCursor ? { eventCursor: run.eventCursor } : {}),
  };
}

function safeEvidence(value: Record<string, string | number | boolean | null> | undefined): Record<string, string | number | boolean | null> | undefined {
  if (!value) return undefined;
  const entries = Object.entries(value);
  if (entries.length > 16 || entries.some(([key]) => !EVENT_EVIDENCE_KEY.test(key) || SENSITIVE_EVENT_EVIDENCE_KEY.test(key))) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event evidence is invalid');
  }
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of entries) {
    if (typeof item === 'string') {
      if (!EVENT_EVIDENCE_LABEL.test(item) || SENSITIVE_EVENT_EVIDENCE_VALUE.test(item)) {
        throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event evidence is invalid');
      }
      sanitized[key] = item;
      continue;
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event evidence is invalid');
      sanitized[key] = item;
      continue;
    }
    if (typeof item === 'boolean' || item === null) {
      sanitized[key] = item;
      continue;
    }
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event evidence is invalid');
  }
  return sanitized;
}

function normalizeNativeRunId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Za-z0-9._:-]{1,255}$/.test(value)) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'native Hermes run ID is invalid');
  }
  return value;
}

function normalizeErrorCode(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(value)) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run error code is invalid');
  }
  return value;
}

function parseStoredEvent(value: unknown, run: Pick<StoredManagedHermesRun, 'id' | 'rootTraceId'>): ManagedHermesRunEvent {
  if (!isObject(value) || !exactKeys(value, ['apiVersion', 'eventId', 'sequence', 'occurredAt', 'run', 'type', 'evidence'])) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event is invalid');
  }
  if (value.apiVersion !== 'argus-runtime-v1alpha1' || typeof value.sequence !== 'number'
    || !Number.isInteger(value.sequence) || value.sequence < 1 || value.sequence > Number.MAX_SAFE_INTEGER
    || typeof value.type !== 'string' || !EVENT_TYPES.has(value.type as ManagedHermesRunEventType)
    || !isObject(value.run) || !exactKeys(value.run, ['id', 'rootTraceId', 'state'])
    || value.run.id !== run.id || value.run.rootTraceId !== run.rootTraceId) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event is invalid');
  }
  const evidence = value.evidence === undefined
    ? undefined
    : isObject(value.evidence)
      ? safeEvidence(value.evidence as Record<string, string | number | boolean | null>)
      : (() => { throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event evidence is invalid'); })();
  return {
    apiVersion: 'argus-runtime-v1alpha1',
    eventId: storedEventCursor(value.eventId, 'event.eventId'),
    sequence: value.sequence,
    occurredAt: storedTimestamp(value.occurredAt, 'event.occurredAt'),
    run: {
      id: run.id,
      rootTraceId: run.rootTraceId,
      state: storedState(value.run.state, 'event.run.state'),
    },
    type: value.type as ManagedHermesRunEventType,
    ...(evidence ? { evidence } : {}),
  };
}

function parseStoredRun(value: unknown, expectedId: string, maxEvents: number): StoredManagedHermesRun {
  if (!isObject(value) || !exactKeys(value, [
    'id', 'requestId', 'rootTraceId', 'coreAgent', 'leaseId', 'mode', 'state', 'acceptedAt', 'updatedAt',
    'eventCursor', 'nativeRunId', 'errorCode', 'events',
  ]) || !isObject(value.coreAgent) || !exactKeys(value.coreAgent, ['id', 'name']) || !Array.isArray(value.events)
    || value.events.length > maxEvents || value.mode !== 'managed') {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run state is invalid');
  }
  const run: StoredManagedHermesRun = {
    id: storedString(value.id, 'id', 64),
    requestId: storedString(value.requestId, 'requestId', 64),
    rootTraceId: storedString(value.rootTraceId, 'rootTraceId', 64),
    coreAgent: {
      id: typeof value.coreAgent.id === 'number' && Number.isInteger(value.coreAgent.id) && value.coreAgent.id > 0
        ? value.coreAgent.id
        : (() => { throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run state coreAgent.id is invalid'); })(),
      name: storedString(value.coreAgent.name, 'coreAgent.name', 128),
    },
    leaseId: storedString(value.leaseId, 'leaseId', 64),
    mode: 'managed',
    state: storedState(value.state, 'state'),
    acceptedAt: storedTimestamp(value.acceptedAt, 'acceptedAt'),
    updatedAt: storedTimestamp(value.updatedAt, 'updatedAt'),
    ...(value.eventCursor === undefined ? {} : { eventCursor: storedEventCursor(value.eventCursor, 'eventCursor') }),
    ...(value.nativeRunId === undefined ? {} : { nativeRunId: normalizeNativeRunId(storedString(value.nativeRunId, 'nativeRunId', 255)) }),
    ...(value.errorCode === undefined ? {} : { errorCode: normalizeErrorCode(storedString(value.errorCode, 'errorCode', 96)) }),
    events: [],
  };
  if (run.id !== expectedId) throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run state key does not match its run ID');
  let previousSequence = 0;
  run.events = value.events.map(event => {
    const parsed = parseStoredEvent(event, run);
    if (parsed.sequence <= previousSequence) throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event sequence is invalid');
    previousSequence = parsed.sequence;
    return parsed;
  });
  if (run.events.length && run.eventCursor !== run.events.at(-1)?.eventId) {
    throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run event cursor is invalid');
  }
  return run;
}

/**
 * Durable, redacted Pack-side projection of managed runs.
 *
 * This store intentionally never receives or writes `executionGrant`, input
 * text, instructions, provider keys, full MCP endpoints, or raw Hermes event
 * payloads. The future broker gets the one-time launch request in memory and
 * must keep the grant exclusively inside the per-run auth proxy.
 */
export class ManagedRunStore {
  private readonly filename: string;
  private readonly now: () => Date;
  private readonly maxEventsPerRun: number;
  private document?: ManagedRunStoreDocument;
  private mutation = Promise.resolve();

  constructor(options: ManagedRunStoreOptions) {
    this.filename = join(options.stateDirectory, 'managed-runs.json');
    this.now = options.now ?? (() => new Date());
    this.maxEventsPerRun = Math.min(MAX_EVENTS_PER_RUN, Math.max(8, options.maxEventsPerRun ?? 128));
  }

  async accept(request: ManagedHermesRunStartRequest): Promise<ManagedRunAcceptance> {
    return this.exclusive(async () => {
      // Mutate a transaction copy and publish it in memory only after the
      // atomic file replacement succeeds. A failed disk write must never make
      // an idempotent retry look durably accepted.
      const document = clone(await this.load());
      const existingForRequest = Object.values(document.runs).find(run => run.requestId === request.requestId);
      if (existingForRequest) {
        if (existingForRequest.id !== request.run.id
          || existingForRequest.rootTraceId !== request.run.rootTraceId
          || existingForRequest.leaseId !== request.runtimeMcpLease.leaseId
          || existingForRequest.coreAgent.id !== request.run.coreAgent.id) {
          throw new ManagedRunStoreError('RUN_REQUEST_CONFLICT', 'request ID is already bound to another managed run');
        }
        return { run: summary(existingForRequest), created: false };
      }
      if (document.runs[request.run.id]) {
        throw new ManagedRunStoreError('RUN_REQUEST_CONFLICT', 'managed run ID is already in use');
      }
      const acceptedAt = this.now().toISOString();
      const eventId = randomUUID();
      const record: StoredManagedHermesRun = {
        id: request.run.id,
        requestId: request.requestId,
        rootTraceId: request.run.rootTraceId,
        coreAgent: { id: request.run.coreAgent.id, name: request.run.coreAgent.name },
        leaseId: request.runtimeMcpLease.leaseId,
        mode: 'managed',
        state: 'queued',
        acceptedAt,
        updatedAt: acceptedAt,
        eventCursor: eventId,
        events: [{
          apiVersion: request.apiVersion,
          eventId,
          sequence: 1,
          occurredAt: acceptedAt,
          run: { id: request.run.id, rootTraceId: request.run.rootTraceId, state: 'queued' },
          type: 'run.accepted',
          evidence: {
            adapter: 'hermes-http',
            mode: 'managed',
          },
        }],
      };
      document.runs[record.id] = record;
      await this.persist(document);
      this.document = document;
      return { run: summary(record), created: true };
    });
  }

  async get(runId: string): Promise<ManagedHermesRunSummary> {
    const run = await this.getRecord(runId);
    return summary(run);
  }

  async findByRequestId(requestId: string): Promise<StoredManagedHermesRun | undefined> {
    const document = await this.load();
    const run = Object.values(document.runs).find(item => item.requestId === requestId);
    return run ? clone(run) : undefined;
  }

  async getRecord(runId: string): Promise<StoredManagedHermesRun> {
    const document = await this.load();
    const run = document.runs[runId];
    if (!run) throw new ManagedRunStoreError('RUN_NOT_FOUND', 'managed run does not exist');
    return clone(run);
  }

  /**
   * Restart-recovery view. It exposes only the already redacted durable
   * lifecycle projection, never the original launch request or its grant.
   */
  async unfinished(): Promise<StoredManagedHermesRun[]> {
    const document = await this.load();
    return Object.values(document.runs)
      .filter(run => !TERMINAL_STATES.has(run.state))
      .map(run => clone(run));
  }

  async events(runId: string, afterEventId?: string): Promise<ManagedHermesRunEvent[]> {
    if (afterEventId !== undefined && !EVENT_CURSOR.test(afterEventId)) {
      throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'event cursor is invalid');
    }
    const run = await this.getRecord(runId);
    if (!afterEventId) return run.events;
    const index = run.events.findIndex(event => event.eventId === afterEventId);
    if (index >= 0) return run.events.slice(index + 1);
    if (afterEventId === run.eventCursor) return [];
    throw new ManagedRunStoreError('RUN_EVENT_CURSOR_UNKNOWN', 'managed run event cursor is unknown');
  }

  async transition(runId: string, input: ManagedRunTransitionInput): Promise<ManagedHermesRunSummary> {
    return this.exclusive(async () => {
      const document = clone(await this.load());
      const run = document.runs[runId];
      if (!run) throw new ManagedRunStoreError('RUN_NOT_FOUND', 'managed run does not exist');
      if (run.state !== input.state && !ALLOWED_TRANSITIONS[run.state].includes(input.state)) {
        throw new ManagedRunStoreError('RUN_STATE_CONFLICT', 'managed run transition is not allowed');
      }
      const occurredAt = this.now().toISOString();
      const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
      const eventId = randomUUID();
      const evidence = safeEvidence(input.evidence);
      const nativeRunId = normalizeNativeRunId(input.nativeRunId);
      const errorCode = normalizeErrorCode(input.errorCode);
      run.state = input.state;
      run.updatedAt = occurredAt;
      run.eventCursor = eventId;
      if (nativeRunId) run.nativeRunId = nativeRunId;
      if (errorCode) run.errorCode = errorCode;
      const event: ManagedHermesRunEvent = {
        apiVersion: 'argus-runtime-v1alpha1',
        eventId,
        sequence,
        occurredAt,
        run: { id: run.id, rootTraceId: run.rootTraceId, state: run.state },
        type: input.type,
        ...(evidence ? { evidence } : {}),
      };
      run.events.push(event);
      if (run.events.length > this.maxEventsPerRun) run.events.splice(0, run.events.length - this.maxEventsPerRun);
      await this.persist(document);
      this.document = document;
      return summary(run);
    });
  }

  async appendToolCompleted(
    runId: string,
    evidence: Record<string, string | number | boolean | null>,
  ): Promise<ManagedHermesRunSummary> {
    return this.exclusive(async () => {
      const document = clone(await this.load());
      const run = document.runs[runId];
      if (!run) throw new ManagedRunStoreError('RUN_NOT_FOUND', 'managed run does not exist');
      if (TERMINAL_STATES.has(run.state)) {
        throw new ManagedRunStoreError('RUN_STATE_CONFLICT', 'cannot append tool evidence to a terminal managed run');
      }
      const occurredAt = this.now().toISOString();
      const sequence = (run.events.at(-1)?.sequence ?? 0) + 1;
      const eventId = randomUUID();
      run.updatedAt = occurredAt;
      run.eventCursor = eventId;
      run.events.push({
        apiVersion: 'argus-runtime-v1alpha1',
        eventId,
        sequence,
        occurredAt,
        run: { id: run.id, rootTraceId: run.rootTraceId, state: run.state },
        type: 'tool.completed',
        evidence: safeEvidence(evidence),
      });
      if (run.events.length > this.maxEventsPerRun) run.events.splice(0, run.events.length - this.maxEventsPerRun);
      await this.persist(document);
      this.document = document;
      return summary(run);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.mutation;
    this.mutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private async load(): Promise<ManagedRunStoreDocument> {
    if (this.document) return this.document;
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filename, 'utf8');
      const parsed = JSON.parse(text) as Partial<ManagedRunStoreDocument>;
      if (parsed.version !== STORE_VERSION || !isObject(parsed.runs)) {
        throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run state is invalid');
      }
      const runs: Record<string, StoredManagedHermesRun> = {};
      for (const [id, run] of Object.entries(parsed.runs)) {
        runs[id] = parseStoredRun(run, id, this.maxEventsPerRun);
      }
      this.document = { version: STORE_VERSION, runs };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.document = { version: STORE_VERSION, runs: {} };
      } else if (cause instanceof ManagedRunStoreError) {
        throw cause;
      } else {
        throw new ManagedRunStoreError('RUN_STORE_CORRUPT', 'managed run state cannot be loaded');
      }
    }
    return this.document;
  }

  private async persist(document: ManagedRunStoreDocument): Promise<void> {
    const encoded = JSON.stringify(document);
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filename);
    await chmod(this.filename, 0o600).catch(() => undefined);
  }
}
