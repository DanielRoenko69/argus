import type { ProjectProgressEvent } from './projectTestRunner.js';

interface WorkflowProgressReporterOptions {
  endpoint?: string;
  secret?: string;
  fetcher?: typeof fetch;
}

function progressKey(event: ProjectProgressEvent): string {
  return `${event.profileId}:${event.phase}:${event.label}`;
}

/**
 * Mirror deterministic project phases into the Argus-owned workflow trace.
 * Reporting is deliberately best-effort: observability must never make a
 * governed setup, test or build command fail.
 */
export function createWorkflowTestProgressReporter(
  threadId: string,
  options: WorkflowProgressReporterOptions = {},
): (event: ProjectProgressEvent) => Promise<void> {
  const endpoint = (options.endpoint ?? process.env['ARGUS_URL'] ?? 'http://localhost:3000').replace(/\/+$/, '');
  const secret = options.secret ?? process.env['WORKSPACE_SECRET'] ?? '';
  const fetcher = options.fetcher ?? fetch;
  const spans = new Map<string, string>();

  return async event => {
    if (!secret || !threadId) return;
    const key = progressKey(event);
    const spanId = spans.get(key);
    if (event.status !== 'started' && !spanId) return;
    try {
      const response = await fetcher(`${endpoint}/api/internal/telemetry/langgraph-stage`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-workspace-secret': secret,
        },
        body: JSON.stringify({
          threadId,
          stageId: 'tests',
          stageLabel: event.label,
          phase: event.phase,
          profileId: event.profileId,
          runner: event.runner,
          root: event.root,
          command: event.command,
          event: event.status,
          ...(spanId ? { spanId } : {}),
          ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
          ...(event.output ? { output: event.output } : {}),
        }),
        signal: AbortSignal.timeout(3_000),
      });
      if (event.status === 'started' && response.ok) {
        const data = await response.json() as { spanId?: unknown };
        if (typeof data.spanId === 'string') spans.set(key, data.spanId);
      }
    } catch {
      // The deterministic command remains authoritative when telemetry is unavailable.
    } finally {
      if (event.status !== 'started') spans.delete(key);
    }
  };
}
