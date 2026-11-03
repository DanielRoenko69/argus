import { Agent } from 'undici';

// Separate from model calls: an isolated stack includes setup, Docker snapshot
// and tests. Outlive Workspace (2520s) and Core (2550s), without changing any
// global dispatcher, runtime/model deadline or repair admission window.
export const STACK_HTTP_TIMEOUT_MS = 2_580_000;
const dispatcher = new Agent({ headersTimeout: 2_610_000, bodyTimeout: 2_610_000 });
export function stackHttpOptions(action: 'inspect' | 'project' | 'run'): RequestInit & { dispatcher: Agent } {
  return { dispatcher, signal: AbortSignal.timeout(action === 'inspect' ? 60_000 : STACK_HTTP_TIMEOUT_MS) };
}
