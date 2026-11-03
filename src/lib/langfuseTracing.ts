/**
 * Agent-level Langfuse tracing helper. Wraps the Langfuse SDK with a
 * structured `withTrace` / `span` / `generation` API that:
 *
 * - is a no-op when Langfuse env keys are missing (every helper still
 *   calls the user's fn, just without emitting anything)
 * - always ends the trace/span (success path or error path)
 * - propagates user errors after marking the trace with level='ERROR'
 * - shares the same pooled client as the gateway callback
 *
 * Named `langfuseTracing.ts` because `tracing.ts` is already taken by the
 * OpenTelemetry helpers — these are distinct observability layers.
 *
 * Usage:
 *
 *     const answer = await withTrace(
 *       { name: 'agent.chat', sessionId, userId, tags: [...], input: userMsg },
 *       async (trace) => {
 *         const docs = await trace.span({ name: 'rag.search', input: query },
 *           async (span) => {
 *             const emb = await span.generation(
 *               { name: 'rag.embedQuery', model: 'text-embedding-3-large', input: query },
 *               async (gen) => {
 *                 const r = await embed(query);
 *                 gen.setUsage({ input: r.tokens, output: 0, total: r.tokens });
 *                 return r.embedding;
 *               },
 *             );
 *             return await vectorSearch(emb);
 *           },
 *         );
 *         trace.setOutput(answer);
 *         return answer;
 *       },
 *     );
 */

import { AsyncLocalStorage } from 'async_hooks';
import {
  getLangfuseClient,
  isLangfuseConfigured,
  type LangfuseTrace,
  type LangfuseSpan,
  type LangfuseGeneration,
} from './langfuseClient.js';
import { logger } from './logger.js';
import { redactJson, summarizeFound, mergeFoundCounters, type DetectorName } from './redaction.js';

// Per-trace accumulator: every span/gen/output redaction inside a trace
// merges its `found` counter here so the trace's final metadata can carry
// the rollup as `_redacted: { total, byDetector }`.
type FoundCounter = Partial<Record<DetectorName, number>>;

/** Redact a single JSON value and merge counters into the trace's accumulator. */
function redactWithAccumulator<T>(value: T, accumulator: FoundCounter): T {
  if (value === undefined || value === null) return value;
  const r = redactJson(value);
  for (const [k, n] of Object.entries(r.found)) {
    accumulator[k as DetectorName] = (accumulator[k as DetectorName] ?? 0) + (n as number);
  }
  return r.value;
}

// ─── Public option types ─────────────────────────────────────────

export interface TraceOptions {
  /** e.g. 'agent.chat', 'compliance.audit', 'coding.workflow' */
  name: string;
  userId?: string;
  sessionId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  input?: unknown;
  /** If supplied, lets us link to an existing trace from another component. */
  id?: string;
}

export interface SpanOptions {
  /** e.g. 'rag.search', 'memory.retrieve', 'tool.workspace_exec' */
  name: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  level?: 'DEFAULT' | 'ERROR' | 'WARNING' | 'DEBUG';
}

export interface GenerationOptions {
  /** e.g. 'rag.embedQuery', 'llm.iter[1]', 'memory.extract' */
  name: string;
  model: string;
  input?: unknown;
  metadata?: Record<string, unknown>;
  promptName?: string;
  promptVersion?: number;
}

export interface UsageInput {
  input: number;
  output: number;
  total?: number;
  inputCost?: number;
  totalCost?: number;
  /** Anthropic prompt-cache breakdown */
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// ─── Public handle types ─────────────────────────────────────────

export interface ActiveTrace {
  /** Trace id (also usable as `parentTraceId` for cross-process linking). */
  readonly id: string;
  /** True if real emission is happening; false in no-op mode. */
  readonly enabled: boolean;
  span<T>(opts: SpanOptions, fn: (span: ActiveSpan) => Promise<T>): Promise<T>;
  generation<T>(opts: GenerationOptions, fn: (gen: ActiveGeneration) => Promise<T>): Promise<T>;
  event(name: string, metadata?: Record<string, unknown>): void;
  setOutput(output: unknown): void;
  setMetadata(meta: Record<string, unknown>): void;
  score(name: string, value: number, comment?: string): void;
}

export interface ActiveSpan {
  readonly id: string;
  readonly enabled: boolean;
  span<T>(opts: SpanOptions, fn: (span: ActiveSpan) => Promise<T>): Promise<T>;
  generation<T>(opts: GenerationOptions, fn: (gen: ActiveGeneration) => Promise<T>): Promise<T>;
  event(name: string, metadata?: Record<string, unknown>): void;
  setOutput(output: unknown): void;
  setMetadata(meta: Record<string, unknown>): void;
}

export interface ActiveGeneration {
  readonly id: string;
  readonly enabled: boolean;
  setUsage(usage: UsageInput): void;
  setMetadata(meta: Record<string, unknown>): void;
  setOutput(output: unknown): void;
}

// ─── Internal: finalizable handles ───────────────────────────────
// We carry a `__finalize` symbol on the public handle so the outer
// wrapper can end the span/generation after the user's fn returns.

const FINALIZE = Symbol('langfuse.finalize');

interface Finalizable {
  [FINALIZE]: (level: 'DEFAULT' | 'ERROR', statusMessage?: string) => void;
}

// ─── No-op handles ───────────────────────────────────────────────

function noopGeneration(): ActiveGeneration & Finalizable {
  return {
    id: 'noop',
    enabled: false,
    setUsage:    () => {},
    setMetadata: () => {},
    setOutput:   () => {},
    [FINALIZE]: () => {},
  };
}

function noopSpan(): ActiveSpan & Finalizable {
  const span: ActiveSpan & Finalizable = {
    id: 'noop',
    enabled: false,
    span:        async (_opts, fn) => fn(span),
    generation:  async (_opts, fn) => fn(noopGeneration()),
    event:       () => {},
    setOutput:   () => {},
    setMetadata: () => {},
    [FINALIZE]:  () => {},
  };
  return span;
}

function noopTrace(): ActiveTrace {
  const span = noopSpan();
  return {
    id: 'noop',
    enabled: false,
    span:        async (_opts, fn) => fn(span),
    generation:  async (_opts, fn) => fn(noopGeneration()),
    event:       () => {},
    setOutput:   () => {},
    setMetadata: () => {},
    score:       () => {},
  };
}

// ─── Real-mode wrappers ──────────────────────────────────────────

function mapUsage(u: UsageInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    input:  u.input,
    output: u.output,
    total:  u.total ?? u.input + u.output,
    unit:   'TOKENS',
  };
  if (u.inputCost !== undefined) out['inputCost'] = u.inputCost;
  if (u.totalCost !== undefined) out['totalCost'] = u.totalCost;
  if (u.cacheReadInputTokens !== undefined || u.cacheCreationInputTokens !== undefined) {
    out['inputDetails'] = {
      cache_read_input_tokens:     u.cacheReadInputTokens     ?? 0,
      cache_creation_input_tokens: u.cacheCreationInputTokens ?? 0,
    };
  }
  return out;
}

function wrapGeneration(g: LangfuseGeneration, acc: FoundCounter): ActiveGeneration & Finalizable {
  let usage: UsageInput | undefined;
  let output: unknown;
  let extraMeta: Record<string, unknown> | undefined;
  let finalized = false;

  return {
    id: g.id,
    enabled: true,
    setUsage:    (u) => { usage = u; },
    setMetadata: (m) => { extraMeta = { ...(extraMeta ?? {}), ...m }; },
    setOutput:   (o) => { output = o; },
    [FINALIZE]: (level, statusMessage) => {
      if (finalized) return;
      finalized = true;
      const endParams: Record<string, unknown> = { endTime: new Date(), level };
      if (output    !== undefined) endParams['output']        = redactWithAccumulator(output, acc);
      if (usage     !== undefined) endParams['usage']         = mapUsage(usage);
      if (extraMeta !== undefined) endParams['metadata']      = extraMeta;
      if (statusMessage)           endParams['statusMessage'] = statusMessage;
      try { g.end(endParams); } catch (err) {
        logger.warn({ err }, 'Langfuse generation.end failed');
      }
    },
  };
}

function wrapSpan(s: LangfuseSpan, acc: FoundCounter): ActiveSpan & Finalizable {
  let output: unknown;
  let extraMeta: Record<string, unknown> | undefined;
  let finalized = false;

  const handle: ActiveSpan & Finalizable = {
    id: s.id,
    enabled: true,
    span: async (opts, fn) => {
      const child = s.span({
        name:      opts.name,
        input:     redactWithAccumulator(opts.input, acc),
        metadata:  opts.metadata,
        level:     opts.level ?? 'DEFAULT',
        startTime: new Date(),
      });
      const childHandle = wrapSpan(child, acc);
      try {
        const r = await fn(childHandle);
        childHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        childHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    generation: async (opts, fn) => {
      const child = s.generation({
        name:      opts.name,
        model:     opts.model,
        input:     redactWithAccumulator(opts.input, acc),
        metadata:  opts.metadata,
        startTime: new Date(),
        ...(opts.promptName    ? { promptName:    opts.promptName    } : {}),
        ...(opts.promptVersion ? { promptVersion: opts.promptVersion } : {}),
      });
      const childHandle = wrapGeneration(child, acc);
      try {
        const r = await fn(childHandle);
        childHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        childHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    event: (name, metadata) => {
      try { s.event({ name, metadata }); } catch { /* ignore */ }
    },
    setOutput:   (o) => { output = o; },
    setMetadata: (m) => { extraMeta = { ...(extraMeta ?? {}), ...m }; },
    [FINALIZE]: (level, statusMessage) => {
      if (finalized) return;
      finalized = true;
      const endParams: Record<string, unknown> = { endTime: new Date(), level };
      if (output    !== undefined) endParams['output']        = redactWithAccumulator(output, acc);
      if (extraMeta !== undefined) endParams['metadata']      = extraMeta;
      if (statusMessage)           endParams['statusMessage'] = statusMessage;
      try { s.end(endParams); } catch (err) {
        logger.warn({ err }, 'Langfuse span.end failed');
      }
    },
  };
  return handle;
}

// ─── Ambient trace context (AsyncLocalStorage) ───────────────────
// Lets deeply nested code (memory.embedText, ragClient.embedQuery, etc.)
// discover the current agent trace ID without having to thread it through
// every function signature.
//
// runAgentChat calls `enterTraceContext(traceId)` once at start; all
// subsequent awaits inside the generator inherit it. Code that opens
// downstream fetches reads `currentTraceId()` and adds the
// X-Langfuse-Trace-Id header.

interface TraceContextValue {
  /** Empty string when only a sessionId override is set (no parent trace). */
  traceId: string;
  /** Name to use for the next downstream generation (e.g. "memory.embedQuery"). */
  generationName?: string;
  /**
   * Override sessionId on traces opened in this context. Used to link
   * cross-process workflows (e.g. LangGraph coding_workflow) with the
   * Argus agent traces they spawn — set sessionId = workflow threadId so
   * Langfuse session view groups them together.
   */
  sessionIdOverride?: string;
}

const _traceALS = new AsyncLocalStorage<TraceContextValue>();

export function currentTraceId(): string | undefined {
  const id = _traceALS.getStore()?.traceId;
  return id || undefined;
}

export function currentGenerationName(): string | undefined {
  return _traceALS.getStore()?.generationName;
}

export function currentSessionIdOverride(): string | undefined {
  return _traceALS.getStore()?.sessionIdOverride;
}

/**
 * Set the sessionId-override for traces opened later in this async context.
 * Used by HTTP routes that receive an `X-Langfuse-Session-Id` header from a
 * cross-process workflow caller (e.g. LangGraph node).
 */
export function setSessionIdOverride(sessionId: string): void {
  const cur = _traceALS.getStore();
  if (cur) {
    _traceALS.enterWith({ ...cur, sessionIdOverride: sessionId });
  } else {
    // Synthesize a context-only entry; no parent trace yet
    _traceALS.enterWith({ traceId: '', sessionIdOverride: sessionId });
  }
}

/**
 * Set the trace context for the rest of the current async execution.
 * Use this when you can't wrap your code in a callback (e.g. inside
 * AsyncGenerator bodies). Effect persists across await/yield points.
 */
export function enterTraceContext(traceId: string, generationName?: string): void {
  _traceALS.enterWith({ traceId, ...(generationName ? { generationName } : {}) });
}

/**
 * Run fn with the given trace context active. Preferred over enterWith
 * when you have a clear callback boundary.
 */
export function withTraceContext<T>(
  ctx: TraceContextValue,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  return _traceALS.run(ctx, fn);
}

/**
 * Build the standard HTTP headers that propagate the active trace context
 * to a downstream gateway call. Returns {} when no trace is active.
 */
export function traceHeaders(generationName?: string): Record<string, string> {
  const ctx = _traceALS.getStore();
  if (!ctx || !ctx.traceId) return {};
  const headers: Record<string, string> = { 'X-Langfuse-Trace-Id': ctx.traceId };
  const name = generationName ?? ctx.generationName;
  if (name) headers['X-Langfuse-Generation-Name'] = name;
  return headers;
}

// ─── Public entry points ────────────────────────────────────────

export function isTracingEnabled(): boolean {
  return isLangfuseConfigured();
}

/**
 * Manual trace lifecycle for code that can't fit the `withTrace(fn)` pattern
 * — e.g. AsyncGenerators (SSE streaming) where the body yields chunks and
 * can't be wrapped in a plain async function.
 *
 * Usage:
 *
 *     export async function* runAgentChat(...): AsyncGenerator<string> {
 *       const t = openTrace({ name: 'agent.chat', sessionId, ... });
 *       try {
 *         for await (const chunk of someInner(t.trace)) yield chunk;
 *         t.setOutput(finalContent);
 *       } catch (err) {
 *         t.recordError(err);
 *         throw err;
 *       } finally {
 *         await t.end();
 *       }
 *     }
 */
export interface ManualTraceHandle {
  /** Active trace for use with .span() / .generation() and child linking. */
  readonly trace: ActiveTrace;
  /** Set final trace output (rendered as trace.output in Langfuse UI). */
  setOutput(output: unknown): void;
  /** Add extra metadata before .end(). */
  setMetadata(meta: Record<string, unknown>): void;
  /** Record an error; the trace output will be ERROR: {msg}. */
  recordError(err: unknown): void;
  /** Close the trace + non-blocking flush. Idempotent. */
  end(): Promise<void>;
}

export function openTrace(opts: TraceOptions): ManualTraceHandle {
  const client = getLangfuseClient();
  if (!client) {
    const handle = noopTrace();
    return {
      trace: handle,
      setOutput:   () => {},
      setMetadata: () => {},
      recordError: () => {},
      end: async () => {},
    };
  }

  // Per-trace PII counter. Every redactWithAccumulator() call inside
  // this trace pushes here; we attach the summary to trace metadata at end().
  const acc: FoundCounter = {};

  let trace: LangfuseTrace;
  try {
    const effectiveSessionId = currentSessionIdOverride() ?? opts.sessionId;
    trace = client.trace({
      ...(opts.id ? { id: opts.id } : {}),
      name:      opts.name,
      userId:    opts.userId,
      sessionId: effectiveSessionId,
      tags:      opts.tags,
      metadata:  opts.metadata,
      input:     redactWithAccumulator(opts.input, acc),
    });
  } catch (err) {
    logger.warn({ err }, 'Langfuse trace creation failed — manual trace is no-op');
    const handle = noopTrace();
    return {
      trace: handle,
      setOutput:   () => {},
      setMetadata: () => {},
      recordError: () => {},
      end: async () => {},
    };
  }

  let output: unknown;
  let extraMeta: Record<string, unknown> | undefined;
  let errorMsg: string | undefined;
  let ended = false;

  const traceHandle: ActiveTrace = {
    id: trace.id,
    enabled: true,
    span: async (sOpts, sFn) => {
      const span = trace.span({
        name:      sOpts.name,
        input:     redactWithAccumulator(sOpts.input, acc),
        metadata:  sOpts.metadata,
        level:     sOpts.level ?? 'DEFAULT',
        startTime: new Date(),
      });
      const spanHandle = wrapSpan(span, acc);
      try {
        const r = await sFn(spanHandle);
        spanHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spanHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    generation: async (gOpts, gFn) => {
      const gen = trace.generation({
        name:      gOpts.name,
        model:     gOpts.model,
        input:     redactWithAccumulator(gOpts.input, acc),
        metadata:  gOpts.metadata,
        startTime: new Date(),
        ...(gOpts.promptName    ? { promptName:    gOpts.promptName    } : {}),
        ...(gOpts.promptVersion ? { promptVersion: gOpts.promptVersion } : {}),
      });
      const genHandle = wrapGeneration(gen, acc);
      try {
        const r = await gFn(genHandle);
        genHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        genHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    event: (name, metadata) => {
      try { trace.event({ name, metadata }); } catch { /* ignore */ }
    },
    setOutput:   (o) => { output = o; },
    setMetadata: (m) => { extraMeta = { ...(extraMeta ?? {}), ...m }; },
    score: (name, value, comment) => {
      try { trace.score({ name, value, comment }); } catch { /* ignore */ }
    },
  };

  return {
    trace: traceHandle,
    setOutput:   (o) => { output = o; },
    setMetadata: (m) => { extraMeta = { ...(extraMeta ?? {}), ...m }; },
    recordError: (err) => {
      errorMsg = err instanceof Error ? err.message : String(err);
    },
    end: async () => {
      if (ended) return;
      ended = true;
      const redactionSummary = summarizeFound(acc);
      const finalMeta: Record<string, unknown> = { ...(extraMeta ?? {}) };
      if (redactionSummary) finalMeta['_redacted'] = redactionSummary;
      try {
        if (errorMsg !== undefined) {
          trace.update({
            output:   redactWithAccumulator(`ERROR: ${errorMsg}`, acc),
            metadata: { ...finalMeta, error: errorMsg },
          });
        } else {
          trace.update({
            output: redactWithAccumulator(output, acc),
            ...(Object.keys(finalMeta).length ? { metadata: finalMeta } : {}),
          });
        }
      } catch (err) {
        logger.warn({ err }, 'Langfuse trace.update on close failed');
      }
      client.flushAsync().catch(() => {});
    },
  };
}

export async function withTrace<T>(
  opts: TraceOptions,
  fn: (trace: ActiveTrace) => Promise<T>,
): Promise<T> {
  const client = getLangfuseClient();
  if (!client) return fn(noopTrace());

  const acc: FoundCounter = {};

  let trace: LangfuseTrace;
  try {
    const effectiveSessionId = currentSessionIdOverride() ?? opts.sessionId;
    trace = client.trace({
      ...(opts.id ? { id: opts.id } : {}),
      name:      opts.name,
      userId:    opts.userId,
      sessionId: effectiveSessionId,
      tags:      opts.tags,
      metadata:  opts.metadata,
      input:     redactWithAccumulator(opts.input, acc),
    });
  } catch (err) {
    logger.warn({ err }, 'Langfuse trace creation failed — running fn without tracing');
    return fn(noopTrace());
  }

  let output: unknown;
  let extraMeta: Record<string, unknown> | undefined;

  const handle: ActiveTrace = {
    id: trace.id,
    enabled: true,
    span: async (sOpts, sFn) => {
      const span = trace.span({
        name:      sOpts.name,
        input:     redactWithAccumulator(sOpts.input, acc),
        metadata:  sOpts.metadata,
        level:     sOpts.level ?? 'DEFAULT',
        startTime: new Date(),
      });
      const spanHandle = wrapSpan(span, acc);
      try {
        const r = await sFn(spanHandle);
        spanHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        spanHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    generation: async (gOpts, gFn) => {
      const gen = trace.generation({
        name:      gOpts.name,
        model:     gOpts.model,
        input:     redactWithAccumulator(gOpts.input, acc),
        metadata:  gOpts.metadata,
        startTime: new Date(),
        ...(gOpts.promptName    ? { promptName:    gOpts.promptName    } : {}),
        ...(gOpts.promptVersion ? { promptVersion: gOpts.promptVersion } : {}),
      });
      const genHandle = wrapGeneration(gen, acc);
      try {
        const r = await gFn(genHandle);
        genHandle[FINALIZE]('DEFAULT');
        return r;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        genHandle[FINALIZE]('ERROR', msg);
        throw err;
      }
    },
    event: (name, metadata) => {
      try { trace.event({ name, metadata }); } catch { /* ignore */ }
    },
    setOutput:   (o) => { output = o; },
    setMetadata: (m) => { extraMeta = { ...(extraMeta ?? {}), ...m }; },
    score: (name, value, comment) => {
      try { trace.score({ name, value, comment }); } catch { /* ignore */ }
    },
  };

  const finalizeMeta = (): Record<string, unknown> | undefined => {
    const sum = summarizeFound(acc);
    const meta: Record<string, unknown> = { ...(extraMeta ?? {}) };
    if (sum) meta['_redacted'] = sum;
    return Object.keys(meta).length ? meta : undefined;
  };

  try {
    const result = await _traceALS.run({ traceId: trace.id }, () => fn(handle));
    try {
      const meta = finalizeMeta();
      trace.update({
        output: redactWithAccumulator(output, acc),
        ...(meta ? { metadata: meta } : {}),
      });
    } catch (err) {
      logger.warn({ err }, 'Langfuse trace.update failed');
    }
    client.flushAsync().catch(() => {});
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      trace.update({
        output:   redactWithAccumulator(`ERROR: ${msg}`, acc),
        metadata: { ...(finalizeMeta() ?? {}), error: msg },
      });
    } catch { /* ignore */ }
    client.flushAsync().catch(() => {});
    throw err;
  }
}
