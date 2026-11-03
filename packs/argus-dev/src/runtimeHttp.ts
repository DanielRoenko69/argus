import { Agent } from 'undici';

export const RUNTIME_HTTP_GRACE_MS = 30_000;
export const RUNTIME_HTTP_MAX_MS = 1_800_000 + RUNTIME_HTTP_GRACE_MS;

// Match Core's subscription-runtime transport. Ordinary fetch/status/telemetry
// calls keep their own short deadlines; never change the global dispatcher.
const runtimeDispatcher = new Agent({
  headersTimeout: RUNTIME_HTTP_MAX_MS,
  bodyTimeout: RUNTIME_HTTP_MAX_MS,
});

export function runtimeHttpTimeoutMs(workerTimeoutSec: number): number {
  if (!Number.isInteger(workerTimeoutSec) || workerTimeoutSec < 30 || workerTimeoutSec > 1_800) {
    throw new RangeError('Runtime worker timeout must be between 30 and 1800 seconds');
  }
  return workerTimeoutSec * 1_000 + RUNTIME_HTTP_GRACE_MS;
}

export function runtimeHttpOptions(workerTimeoutSec: number): RequestInit & { dispatcher: Agent } {
  return {
    dispatcher: runtimeDispatcher,
    signal: AbortSignal.timeout(runtimeHttpTimeoutMs(workerTimeoutSec)),
  };
}

export function runtimeHttpFailure(error: unknown, workerTimeoutSec: number): string {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `HTTP deadline exceeded after ${runtimeHttpTimeoutMs(workerTimeoutSec) / 1_000}s `
      + `(worker limit ${workerTimeoutSec}s plus ${RUNTIME_HTTP_GRACE_MS / 1_000}s response grace)`;
  }
  let cause: unknown = error;
  let code = '';
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    const detail = cause as { code?: unknown; cause?: unknown };
    if (typeof detail.code === 'string' && /^(UND_ERR_[A-Z_]+|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)$/.test(detail.code)) {
      code = detail.code;
      break;
    }
    cause = detail.cause;
  }
  if (code === 'UND_ERR_HEADERS_TIMEOUT') return `HTTP response-header timeout (${code}); worker limit ${workerTimeoutSec}s`;
  if (code === 'UND_ERR_BODY_TIMEOUT') return `HTTP response-body timeout (${code}); worker limit ${workerTimeoutSec}s`;
  // Report only the allow-listed cause code, never nested payloads or headers.
  const message = error instanceof Error ? error.message : 'Runtime transport failed';
  return code ? `${message} (${code})` : message;
}
