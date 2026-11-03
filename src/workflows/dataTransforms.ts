import { runInNewContext } from 'node:vm';
import type { StepResult } from './types.js';

const MAX_FUNCTION_CODE_BYTES = 20_000;
const MAX_TRANSFORM_RESULT_BYTES = 1_000_000;
const MAX_TABLE_ROWS = 10_000;
const FUNCTION_TIMEOUT_MS = 250;
export const MAX_FOR_EACH_ITEMS = 1_000;

export type ForEachErrorMode = 'stop' | 'continue';

export interface ForEachItemResult {
  index: number;
  status: 'completed' | 'failed';
  attempts: number;
  value?: unknown;
  error?: string;
  /** Persisted child-run or provider evidence associated with the final attempt. */
  evidence?: unknown;
  /** Evidence from failed attempts that preceded the final outcome. */
  attempt_evidence?: unknown[];
}

export interface ForEachResult {
  total: number;
  succeeded: number;
  failed: number;
  results: ForEachItemResult[];
  /** Ordered successful values; failed entries are represented by null. */
  values: unknown[];
}

export class ForEachExecutionError extends Error {
  constructor(message: string, public readonly result: ForEachResult) {
    super(message);
    this.name = 'ForEachExecutionError';
  }
}

export function parseVariables(value: unknown): Record<string, unknown> {
  const parsed = parseJsonText(value, 'Variables');
  if (!isRecord(parsed)) {
    throw new Error('Variables must resolve to a JSON object');
  }
  return normalizeJsonValue(parsed, 'Variables') as Record<string, unknown>;
}

export function parseTableRows(value: unknown): unknown[] {
  const parsed = parseJsonText(value, 'Table rows');
  if (!Array.isArray(parsed)) {
    throw new Error('Table rows must resolve to a JSON array');
  }
  if (parsed.length > MAX_TABLE_ROWS) {
    throw new Error(`Table rows exceed the controlled limit (${MAX_TABLE_ROWS} rows)`);
  }
  return normalizeJsonValue(parsed, 'Table rows') as unknown[];
}

export function parseForEachItems(value: unknown): unknown[] {
  const parsed = parseJsonText(value, 'For Each items');
  if (!Array.isArray(parsed)) {
    throw new Error('For Each items must resolve to a JSON array');
  }
  if (parsed.length > MAX_FOR_EACH_ITEMS) {
    throw new Error(`For Each items exceed the controlled limit (${MAX_FOR_EACH_ITEMS} items)`);
  }
  return normalizeJsonValue(parsed, 'For Each items') as unknown[];
}

export function runControlledFunction(
  code: string,
  input: Record<string, unknown>,
  steps: Record<string, StepResult>,
  locals?: { item?: unknown; index?: number },
): unknown {
  const source = code.trim();
  if (!source) throw new Error('Function code is empty');
  if (Buffer.byteLength(source, 'utf8') > MAX_FUNCTION_CODE_BYTES) {
    throw new Error(`Function code exceeds the controlled limit (${MAX_FUNCTION_CODE_BYTES} bytes)`);
  }

  const context = {
    input: deepFreeze(jsonClone(input, 'Function input')),
    steps: deepFreeze(jsonClone(steps, 'Function steps')),
    item: locals?.item === undefined
      ? undefined
      : deepFreeze(jsonClone(locals.item, 'Function item')),
    index: locals?.index,
  };
  const result = runInNewContext(
    `(function (input, steps, item, index) { "use strict";\n${source}\n})(input, steps, item, index)`,
    context,
    {
      timeout: FUNCTION_TIMEOUT_MS,
      contextCodeGeneration: { strings: false, wasm: false },
    },
  ) as unknown;

  if (isPromiseLike(result)) throw new Error('Function code must be synchronous');
  if (result === undefined) throw new Error('Function code must return a JSON-compatible value');
  return normalizeJsonValue(result, 'Function result');
}

/**
 * Runs a bounded worker pool while retaining input order in the final result.
 * The worker may call a governed sub-workflow or execute a controlled transform.
 */
export async function runForEach(
  items: unknown[],
  worker: (item: unknown, index: number) => Promise<unknown>,
  options: {
    concurrency: number;
    retries: number;
    onItemError: ForEachErrorMode;
    mapResult?: (value: unknown) => { value: unknown; evidence?: unknown };
  },
): Promise<ForEachResult> {
  if (items.length > MAX_FOR_EACH_ITEMS) {
    throw new Error(`For Each items exceed the controlled limit (${MAX_FOR_EACH_ITEMS} items)`);
  }
  const concurrency = boundedInteger(options.concurrency, 1, 16, 'For Each concurrency');
  const retries = boundedInteger(options.retries, 0, 3, 'For Each retries');
  const results = new Array<ForEachItemResult>(items.length);
  let nextIndex = 0;
  let firstFailure: Error | null = null;

  const runWorker = async (): Promise<void> => {
    while (true) {
      if (firstFailure && options.onItemError === 'stop') return;
      const index = nextIndex++;
      if (index >= items.length) return;
      let lastError: unknown;
      const attemptEvidence: unknown[] = [];
      for (let attempt = 1; attempt <= retries + 1; attempt++) {
        try {
          const rawValue = await worker(items[index], index);
          const mapped = options.mapResult?.(rawValue) ?? { value: rawValue };
          const value = normalizeJsonValue(mapped.value, `For Each item ${index} result`);
          const evidence = mapped.evidence === undefined
            ? undefined
            : normalizeJsonValue(mapped.evidence, `For Each item ${index} evidence`);
          results[index] = {
            index,
            status: 'completed',
            attempts: attempt,
            value,
            ...(evidence === undefined ? {} : { evidence }),
            ...(attemptEvidence.length === 0 ? {} : { attempt_evidence: attemptEvidence }),
          };
          lastError = undefined;
          break;
        } catch (error) {
          lastError = error;
          const evidence = errorEvidence(error);
          if (evidence !== undefined) {
            attemptEvidence.push(normalizeJsonValue(evidence, `For Each item ${index} failed attempt evidence`));
          }
        }
      }
      if (lastError !== undefined) {
        const detail = errorMessage(lastError);
        results[index] = {
          index,
          status: 'failed',
          attempts: retries + 1,
          error: detail.slice(0, 4_000),
          ...(attemptEvidence.length === 0 ? {} : {
            evidence: attemptEvidence.at(-1),
            attempt_evidence: attemptEvidence,
          }),
        };
        if (options.onItemError === 'stop' && !firstFailure) {
          firstFailure = new Error(`For Each item ${index} failed after ${retries + 1} attempt${retries === 0 ? '' : 's'}: ${detail}`);
        }
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(concurrency, Math.max(1, items.length)) },
    () => runWorker(),
  ));
  const settled = results.filter((result): result is ForEachItemResult => Boolean(result));
  const output: ForEachResult = {
    total: items.length,
    succeeded: settled.filter(result => result.status === 'completed').length,
    failed: settled.filter(result => result.status === 'failed').length,
    results: settled,
    values: results.map(result => result?.status === 'completed' ? result.value : null),
  };
  const normalized = normalizeJsonValue(output, 'For Each result') as ForEachResult;
  const terminalFailure = firstFailure as Error | null;
  if (terminalFailure) throw new ForEachExecutionError(terminalFailure.message, normalized);
  return normalized;
}

export function normalizeDataResult(value: unknown, label: string): unknown {
  return normalizeJsonValue(value, label);
}

function parseJsonText(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} contains invalid JSON: ${detail}`);
  }
}

function normalizeJsonValue(value: unknown, label: string): unknown {
  assertJsonValue(value, label, new Set<object>());
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`${label} is not JSON-compatible`);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRANSFORM_RESULT_BYTES) {
    throw new Error(`${label} exceeds the controlled limit (${MAX_TRANSFORM_RESULT_BYTES} bytes)`);
  }
  return JSON.parse(serialized) as unknown;
}

function jsonClone<T>(value: T, label: string): T {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not JSON-compatible: ${detail}`);
  }
  if (serialized === undefined) throw new Error(`${label} is not JSON-compatible`);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_TRANSFORM_RESULT_BYTES) {
    throw new Error(`${label} exceeds the controlled limit (${MAX_TRANSFORM_RESULT_BYTES} bytes)`);
  }
  return JSON.parse(serialized) as T;
}

function assertJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== 'object') {
    throw new Error(`${path} contains unsupported value type '${typeof value}'`);
  }
  if (ancestors.has(value)) throw new Error(`${path} contains a circular reference`);
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === 'object' || typeof value === 'function')
    && typeof (value as { then?: unknown }).then === 'function';
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function errorEvidence(error: unknown): unknown {
  if (error !== null && typeof error === 'object' && 'evidence' in error) {
    return (error as { evidence?: unknown }).evidence;
  }
  return undefined;
}
