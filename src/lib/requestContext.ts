/**
 * requestContext — AsyncLocalStorage für per-Request "callingUser"-Identität.
 *
 * Argus's deep tool-execution-stacks (toolRunner → customBackends → fetch)
 * sehen die HTTP-Layer-Auth nicht direkt. Statt callingUser durch jede
 * Funktions-Signatur durchzuschleifen, nutzen wir AsyncLocalStorage:
 *
 *   // Express middleware setzt es einmal:
 *   withRequestContext({ callingUser }, async () => { … });
 *
 *   // Tiefer im Stack (e.g. K8s-Backend-Call) kann jeder Code es lesen:
 *   const user = getCurrentCallingUser();
 *
 * Async-Tasks die mit setTimeout/setInterval losgelöst werden VERLIEREN den
 * Context (das ist Node's ALS-Verhalten). Fire-and-forget Memory-Extraction
 * läuft also OHNE callingUser — bewusst, weil das Side-Effekt-Aufgaben sind
 * die nicht die User-Identity brauchen.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallingUser {
  id?: number;
  username?: string;
  email?: string;
  role?: string;
  entra_groups?: string[];
}

interface Ctx {
  callingUser?: CallingUser;
}

const als = new AsyncLocalStorage<Ctx>();

export function withRequestContext<T>(ctx: Ctx, fn: () => T | Promise<T>): T | Promise<T> {
  return als.run(ctx, fn);
}

export function getCurrentCallingUser(): CallingUser | undefined {
  return als.getStore()?.callingUser;
}
