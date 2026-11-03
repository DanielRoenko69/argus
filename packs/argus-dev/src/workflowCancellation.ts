import { AsyncLocalStorage } from 'node:async_hooks';

export class WorkflowCanceledError extends Error {
  constructor() { super('Workflow canceled by operator'); this.name = 'WorkflowCanceledError'; }
}

export class CancellationUnconfirmedError extends Error {
  constructor() {
    super('Runtime termination is not confirmed; cancellation remains pending');
    this.name = 'CancellationUnconfirmedError';
  }
}

/** A lost HTTP response is not proof that the remote process exited. */
export async function confirmRuntimeStopped(baseUrl: string, secret: string, provider: 'codex' | 'claude', runId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/${provider}/status`, {
    headers: { 'x-workspace-secret': secret }, signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  const data = response?.ok ? await response.json().catch(() => null) as { runs?: Array<{ id: string; finishedAt?: string }> } | null : null;
  if (!Array.isArray(data?.runs) || !data.runs.some(run => run?.id === runId
    && typeof run.finishedAt === 'string' && Number.isFinite(Date.parse(run.finishedAt)))) {
    throw new CancellationUnconfirmedError();
  }
}

/** One context per execution, never a process-wide stop of unrelated workers. */
export class WorkflowCancellation {
  requested = false;
  private stops = new Set<() => Promise<void>>();
  private stopping = new Set<() => Promise<void>>();

  request(): void { this.requested = true; this.retryStops(); }
  retryStops(): void {
    if (!this.requested) return;
    for (const stop of this.stops) {
      if (this.stopping.has(stop)) continue;
      this.stopping.add(stop);
      // A request can race runtime registration (404) or transient transport
      // failure. Keep retrying until the original worker request settles.
      void stop().catch(() => undefined).finally(() => this.stopping.delete(stop));
    }
  }
  register(stop: () => Promise<void>): () => void {
    this.throwIfRequested();
    this.stops.add(stop);
    return () => this.stops.delete(stop);
  }
  throwIfRequested(): void { if (this.requested) throw new WorkflowCanceledError(); }
}

const context = new AsyncLocalStorage<WorkflowCancellation>();
export const withWorkflowCancellation = <T>(control: WorkflowCancellation, run: () => Promise<T>): Promise<T> => context.run(control, run);
export function workflowCancellationRequested(): boolean { return context.getStore()?.requested ?? false; }
export function assertWorkflowNotCanceled(): void { context.getStore()?.throwIfRequested(); }
export function registerWorkflowStop(stop: () => Promise<void>): () => void {
  return context.getStore()?.register(stop) ?? (() => undefined);
}

/** Run one graph superstep at a time; never advance past an accepted cancel.
 * In-flight non-interruptible operations finish before a terminal receipt.
 * Real LangGraph human interrupts remain untouched.
 */
export async function runCooperatively<T>(options: {
  control: WorkflowCancellation;
  isCancellationRequested: () => Promise<boolean>;
  invoke: (first: boolean) => Promise<void>;
  snapshot: () => Promise<{ next: readonly string[]; tasks?: readonly { interrupts?: readonly unknown[] }[] } & T>;
  pollMs?: number;
}): Promise<T> {
  const check = async () => {
    if (await options.isCancellationRequested()) options.control.request();
    options.control.throwIfRequested();
  };
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void options.isCancellationRequested().then(requested => {
      if (requested) options.control.request();
    }).catch(() => undefined).finally(() => { polling = false; });
    options.control.retryStops();
  }, options.pollMs ?? 1_000);
  timer.unref();
  try {
    return await withWorkflowCancellation(options.control, async () => {
      let first = true;
      while (true) {
        await check();
        await options.invoke(first);
        first = false;
        await check();
        const snapshot = await options.snapshot();
        if (snapshot.next.length === 0 || snapshot.tasks?.some(task => (task.interrupts?.length ?? 0) > 0)) return snapshot;
      }
    });
  } finally { clearInterval(timer); }
}

export async function stopWorkspaceRuntime(baseUrl: string, secret: string, provider: 'codex' | 'claude', runId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/${provider}/runs/${encodeURIComponent(runId)}/cancel`, {
    method: 'POST', headers: { 'x-workspace-secret': secret }, signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Runtime stop not acknowledged (${response.status})`);
}
