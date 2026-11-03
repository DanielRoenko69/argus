import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { parseManagedHermesRunId } from './managedRunContract.js';
import {
  ARGUS_HERMES_RUNNERD_PROTOCOL,
  isHermesRunnerdTerminalState,
  parseHermesRunnerdRunResponse,
  type HermesRunnerdEvidence,
  type HermesRunnerdRun,
  type HermesRunnerdRunState,
} from './runnerdContract.js';

const STORE_VERSION = 1;
const MAX_STORED_RUNS = 10_000;

/**
 * `accepted` is an internal crash-recovery marker only.  It is never
 * returned through the Pack <-> runnerd wire protocol: a service must either
 * bind a native run ID and report `running`, or fail/cancel the run closed.
 */
export type RunnerdStoredRunState = 'accepted' | HermesRunnerdRunState;

/**
 * This is deliberately the complete durable runnerd record.  In particular,
 * it does not contain a managed start request, execution grant, prompt,
 * instructions, Core endpoint, lease ID, container specification, or raw
 * upstream response.  The process that launches a run may hold the original
 * request only in memory long enough to create its isolated proxy.
 */
export interface RunnerdStoredRun {
  id: string;
  requestId: string;
  rootTraceId: string;
  state: RunnerdStoredRunState;
  nativeRunId?: string;
  evidence?: HermesRunnerdEvidence;
  errorCode?: string;
  acceptedAt: string;
  updatedAt: string;
}

export interface RunnerdRunStoreOptions {
  stateDirectory: string;
  now?: () => Date;
}

/** The only request-derived data runnerd may persist before launching. */
export interface RunnerdRunAcceptInput {
  id: string;
  requestId: string;
  rootTraceId: string;
}

/**
 * A runnerd service supplies a normalized public state.  The store constructs
 * the response itself, so an untrusted caller cannot choose another run ID or
 * smuggle a secret-shaped field into the persisted projection.
 */
export interface RunnerdRunTransitionInput {
  state: HermesRunnerdRunState;
  nativeRunId?: string;
  evidence?: HermesRunnerdEvidence;
  errorCode?: string;
}

export interface RunnerdRunAcceptance {
  run: RunnerdStoredRun;
  created: boolean;
}

interface RunnerdRunStoreDocument {
  version: typeof STORE_VERSION;
  runs: Record<string, RunnerdStoredRun>;
}

const ALLOWED_TRANSITIONS: Readonly<Record<RunnerdStoredRunState, readonly HermesRunnerdRunState[]>> = {
  accepted: ['running', 'failed', 'cancelled'],
  running: ['awaiting_approval', 'completed', 'failed', 'cancelled'],
  awaiting_approval: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export class RunnerdRunStoreError extends Error {
  constructor(
    readonly code: 'RUN_NOT_FOUND' | 'RUN_REQUEST_CONFLICT' | 'RUN_STATE_CONFLICT' | 'RUN_STORE_CORRUPT' | 'INVALID_RUNNERD_STATE',
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

function safeUuid(value: unknown, field: string, code: RunnerdRunStoreError['code']): string {
  try {
    return parseManagedHermesRunId(value);
  } catch {
    throw new RunnerdRunStoreError(code, `runnerd state ${field} is invalid`);
  }
}

function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.length > 40 || /[\r\n\u0000]/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', `runnerd state ${field} is invalid`);
  }
  return value;
}

function publicRun(
  runId: string,
  input: RunnerdRunTransitionInput,
  code: RunnerdRunStoreError['code'],
): HermesRunnerdRun {
  try {
    return parseHermesRunnerdRunResponse({
      apiVersion: ARGUS_HERMES_RUNNERD_PROTOCOL,
      run: {
        id: runId,
        state: input.state,
        ...(input.nativeRunId === undefined ? {} : { nativeRunId: input.nativeRunId }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      },
    }, runId).run;
  } catch {
    // Validation input can have been sourced from an upstream Hermes API.
    // Its diagnostic may contain raw data, so never preserve or rethrow it.
    throw new RunnerdRunStoreError(code, 'runnerd run state is invalid');
  }
}

function storedRun(value: unknown, expectedId: string): RunnerdStoredRun {
  if (!isObject(value) || !exactKeys(value, [
    'id', 'requestId', 'rootTraceId', 'state', 'nativeRunId', 'evidence', 'errorCode', 'acceptedAt', 'updatedAt',
  ])) {
    throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', 'runnerd state is invalid');
  }
  const id = safeUuid(value.id, 'id', 'RUN_STORE_CORRUPT');
  if (id !== expectedId) {
    throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', 'runnerd state key does not match its run ID');
  }
  const requestId = safeUuid(value.requestId, 'requestId', 'RUN_STORE_CORRUPT');
  const rootTraceId = safeUuid(value.rootTraceId, 'rootTraceId', 'RUN_STORE_CORRUPT');
  const acceptedAt = timestamp(value.acceptedAt, 'acceptedAt');
  const updatedAt = timestamp(value.updatedAt, 'updatedAt');

  if (value.state === 'accepted') {
    if (value.nativeRunId !== undefined || value.evidence !== undefined || value.errorCode !== undefined) {
      throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', 'accepted runnerd state cannot contain execution details');
    }
    return { id, requestId, rootTraceId, state: 'accepted', acceptedAt, updatedAt };
  }

  const normalized = publicRun(id, {
    state: value.state as HermesRunnerdRunState,
    ...(value.nativeRunId === undefined ? {} : { nativeRunId: value.nativeRunId as string }),
    ...(value.evidence === undefined ? {} : { evidence: value.evidence as HermesRunnerdEvidence }),
    ...(value.errorCode === undefined ? {} : { errorCode: value.errorCode as string }),
  }, 'RUN_STORE_CORRUPT');
  return {
    id,
    requestId,
    rootTraceId,
    state: normalized.state,
    ...(normalized.nativeRunId === undefined ? {} : { nativeRunId: normalized.nativeRunId }),
    ...(normalized.evidence === undefined ? {} : { evidence: normalized.evidence }),
    ...(normalized.errorCode === undefined ? {} : { errorCode: normalized.errorCode }),
    acceptedAt,
    updatedAt,
  };
}

function terminal(state: RunnerdStoredRunState): boolean {
  return state !== 'accepted' && isHermesRunnerdTerminalState(state);
}

/**
 * Durable, redacted state for the privileged runnerd broker.
 *
 * A runnerd deployment must have one writer per state volume. This local
 * mutex serializes API requests in that process; active-active brokers must
 * instead use a shared transactional store before they advertise readiness.
 */
export class RunnerdRunStore {
  private readonly filename: string;
  private readonly now: () => Date;
  private document?: RunnerdRunStoreDocument;
  private mutation = Promise.resolve();

  constructor(options: RunnerdRunStoreOptions) {
    this.filename = join(options.stateDirectory, 'runnerd-runs.json');
    this.now = options.now ?? (() => new Date());
  }

  async accept(input: RunnerdRunAcceptInput): Promise<RunnerdRunAcceptance> {
    return this.exclusive(async () => {
      const id = safeUuid(input.id, 'id', 'INVALID_RUNNERD_STATE');
      const requestId = safeUuid(input.requestId, 'requestId', 'INVALID_RUNNERD_STATE');
      const rootTraceId = safeUuid(input.rootTraceId, 'rootTraceId', 'INVALID_RUNNERD_STATE');
      const document = clone(await this.load());
      const existingForRequest = Object.values(document.runs).find(run => run.requestId === requestId);
      if (existingForRequest) {
        if (existingForRequest.id !== id || existingForRequest.rootTraceId !== rootTraceId) {
          throw new RunnerdRunStoreError('RUN_REQUEST_CONFLICT', 'request ID is already bound to another runnerd run');
        }
        return { run: clone(existingForRequest), created: false };
      }
      if (document.runs[id]) {
        throw new RunnerdRunStoreError('RUN_REQUEST_CONFLICT', 'runnerd run ID is already in use');
      }
      if (Object.keys(document.runs).length >= MAX_STORED_RUNS) {
        throw new RunnerdRunStoreError('RUN_STATE_CONFLICT', 'runnerd state capacity has been reached');
      }
      const acceptedAt = this.now().toISOString();
      const run: RunnerdStoredRun = {
        id,
        requestId,
        rootTraceId,
        state: 'accepted',
        acceptedAt,
        updatedAt: acceptedAt,
      };
      document.runs[id] = run;
      await this.persist(document);
      this.document = document;
      return { run: clone(run), created: true };
    });
  }

  async get(runId: string): Promise<RunnerdStoredRun> {
    const id = safeUuid(runId, 'runId', 'INVALID_RUNNERD_STATE');
    const run = (await this.load()).runs[id];
    if (!run) throw new RunnerdRunStoreError('RUN_NOT_FOUND', 'runnerd run does not exist');
    return clone(run);
  }

  async findByRequestId(requestId: string): Promise<RunnerdStoredRun | undefined> {
    const id = safeUuid(requestId, 'requestId', 'INVALID_RUNNERD_STATE');
    const run = Object.values((await this.load()).runs).find(item => item.requestId === id);
    return run ? clone(run) : undefined;
  }

  /** Crash-recovery view; it cannot reconstruct the one-time launch grant. */
  async unfinished(): Promise<RunnerdStoredRun[]> {
    return Object.values((await this.load()).runs)
      .filter(run => !terminal(run.state))
      .map(run => clone(run));
  }

  /**
   * The launcher binds its server-generated Hermes ID exactly once. Repeating
   * the same bind is safe for a lost HTTP response; a different ID fails
   * closed rather than changing the identity of a live run.
   */
  async bindNativeRun(
    runId: string,
    nativeRunId: string,
    evidence?: HermesRunnerdEvidence,
  ): Promise<RunnerdStoredRun> {
    return this.exclusive(async () => {
      const id = safeUuid(runId, 'runId', 'INVALID_RUNNERD_STATE');
      const document = clone(await this.load());
      const current = document.runs[id];
      if (!current) throw new RunnerdRunStoreError('RUN_NOT_FOUND', 'runnerd run does not exist');
      if (current.state === 'running') {
        if (current.nativeRunId === nativeRunId) return clone(current);
        throw new RunnerdRunStoreError('RUN_STATE_CONFLICT', 'native Hermes run ID is already bound');
      }
      if (current.state !== 'accepted') {
        throw new RunnerdRunStoreError('RUN_STATE_CONFLICT', 'native Hermes run can only be bound once');
      }
      const normalized = publicRun(id, { state: 'running', nativeRunId, ...(evidence === undefined ? {} : { evidence }) }, 'INVALID_RUNNERD_STATE');
      const updated: RunnerdStoredRun = {
        ...current,
        state: normalized.state,
        nativeRunId: normalized.nativeRunId,
        ...(normalized.evidence === undefined ? {} : { evidence: normalized.evidence }),
        updatedAt: this.now().toISOString(),
      };
      document.runs[id] = updated;
      await this.persist(document);
      this.document = document;
      return clone(updated);
    });
  }

  async transition(runId: string, input: RunnerdRunTransitionInput): Promise<RunnerdStoredRun> {
    return this.exclusive(async () => {
      const id = safeUuid(runId, 'runId', 'INVALID_RUNNERD_STATE');
      const document = clone(await this.load());
      const current = document.runs[id];
      if (!current) throw new RunnerdRunStoreError('RUN_NOT_FOUND', 'runnerd run does not exist');
      if (!ALLOWED_TRANSITIONS[current.state].includes(input.state)) {
        throw new RunnerdRunStoreError('RUN_STATE_CONFLICT', 'runnerd run transition is not allowed');
      }
      const nativeRunId = input.nativeRunId ?? current.nativeRunId;
      if (current.nativeRunId && nativeRunId !== current.nativeRunId) {
        throw new RunnerdRunStoreError('RUN_STATE_CONFLICT', 'native Hermes run ID cannot change');
      }
      const normalized = publicRun(id, {
        state: input.state,
        ...(nativeRunId === undefined ? {} : { nativeRunId }),
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      }, 'INVALID_RUNNERD_STATE');
      const updated: RunnerdStoredRun = {
        ...current,
        state: normalized.state,
        ...(normalized.nativeRunId === undefined ? {} : { nativeRunId: normalized.nativeRunId }),
        ...(normalized.evidence === undefined ? {} : { evidence: normalized.evidence }),
        ...(normalized.errorCode === undefined ? {} : { errorCode: normalized.errorCode }),
        updatedAt: this.now().toISOString(),
      };
      document.runs[id] = updated;
      await this.persist(document);
      this.document = document;
      return clone(updated);
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

  private async load(): Promise<RunnerdRunStoreDocument> {
    if (this.document) return this.document;
    await mkdir(dirname(this.filename), { recursive: true, mode: 0o700 });
    try {
      const text = await readFile(this.filename, 'utf8');
      const parsed = JSON.parse(text) as Partial<RunnerdRunStoreDocument>;
      if (parsed.version !== STORE_VERSION || !isObject(parsed.runs) || Object.keys(parsed.runs).length > MAX_STORED_RUNS) {
        throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', 'runnerd state is invalid');
      }
      const runs: Record<string, RunnerdStoredRun> = {};
      for (const [id, run] of Object.entries(parsed.runs)) {
        runs[id] = storedRun(run, safeUuid(id, 'run key', 'RUN_STORE_CORRUPT'));
      }
      this.document = { version: STORE_VERSION, runs };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
        this.document = { version: STORE_VERSION, runs: {} };
      } else if (cause instanceof RunnerdRunStoreError) {
        throw cause;
      } else {
        throw new RunnerdRunStoreError('RUN_STORE_CORRUPT', 'runnerd state cannot be loaded');
      }
    }
    return this.document;
  }

  private async persist(document: RunnerdRunStoreDocument): Promise<void> {
    const temporary = `${this.filename}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.filename);
    await chmod(this.filename, 0o600).catch(() => undefined);
  }
}
