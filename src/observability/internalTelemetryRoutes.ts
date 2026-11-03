import express, { type Request, type Response, type Router } from 'express';
import { logger } from '../lib/logger.js';
import {
  finishTelemetrySpan,
  finishTelemetryTrace,
  flushTelemetryWrites,
  startTelemetrySpan,
  startTelemetryTrace,
  type TelemetryHandle,
} from './telemetryStore.js';
import { getSharedPool } from '../lib/sharedPool.js';
import { safeSecretEqual } from './internalTraceContext.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
type LifecycleEvent = 'started' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export function createInternalTelemetryRouter(): Router {
  const router = express.Router();

  router.post('/api/internal/telemetry/langgraph', async (req: Request, res: Response) => {
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');
    if (!expectedSecret) {
      logger.error('internal-telemetry: WORKSPACE_SECRET not set');
      return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    }
    if (!safeSecretEqual(providedSecret, expectedSecret)) {
      logger.warn({ ip: req.ip, path: req.path }, 'internal-telemetry: auth failed');
      return res.status(401).json({ error: 'unauthorized' });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const threadId = typeof body['threadId'] === 'string' ? body['threadId'] : '';
    const rawEvent = typeof body['event'] === 'string' ? body['event'] : '';
    if (!UUID_RE.test(threadId)) return res.status(400).json({ error: 'valid threadId UUID required' });
    if (!['started', 'waiting', 'completed', 'failed', 'cancelled'].includes(rawEvent)) {
      return res.status(400).json({ error: 'invalid lifecycle event' });
    }
    const event = rawEvent as LifecycleEvent;

    const workflowType = typeof body['workflowType'] === 'string' && body['workflowType']
      ? body['workflowType']
      : 'coding_workflow';
    const metadata = body['metadata'] && typeof body['metadata'] === 'object' && !Array.isArray(body['metadata'])
      ? body['metadata'] as Record<string, unknown>
      : {};
    const executionPrincipal = typeof metadata['execution_principal'] === 'string'
      ? metadata['execution_principal']
      : '';
    const principalMatch = /^user:(\d+)$/.exec(executionPrincipal);
    const userId = principalMatch ? Number(principalMatch[1]) : undefined;

    if (event === 'started') {
      startTelemetryTrace({
        id: threadId,
        externalTraceId: threadId,
        rootTraceId: threadId,
        parentTraceId: null,
        parentSpanId: null,
        name: `langgraph.${workflowType}`,
        kind: 'workflow',
        sessionId: threadId,
        userId,
        input: body['input'],
        metadata: { ...metadata, workflow_type: workflowType, runtime: 'argus-langgraph' },
      });
    } else {
      const handle: TelemetryHandle = { id: threadId, rootTraceId: threadId, startedAt: Date.now() };
      finishTelemetryTrace(handle, {
        status: event === 'waiting' ? 'waiting' : event,
        error: body['error'],
        metadata: { ...metadata, workflow_type: workflowType, runtime: 'argus-langgraph' },
      });
    }
    await flushTelemetryWrites();
    return res.json({ ok: true, traceId: threadId, status: event });
  });

  router.post('/api/internal/telemetry/langgraph-stage', async (req: Request, res: Response) => {
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');
    if (!expectedSecret) return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    if (!safeSecretEqual(providedSecret, expectedSecret)) return res.status(401).json({ error: 'unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const threadId = typeof body['threadId'] === 'string' ? body['threadId'] : '';
    const stageId = typeof body['stageId'] === 'string' ? body['stageId'] : '';
    const phase = typeof body['phase'] === 'string' ? body['phase'] : '';
    const event = typeof body['event'] === 'string' ? body['event'] : '';
    if (!UUID_RE.test(threadId)) return res.status(400).json({ error: 'valid threadId UUID required' });
    if (!STAGE_ID_RE.test(stageId) || !STAGE_ID_RE.test(phase)) {
      return res.status(400).json({ error: 'valid stageId and phase required' });
    }
    if (!['started', 'completed', 'failed'].includes(event)) {
      return res.status(400).json({ error: 'invalid stage lifecycle event' });
    }

    const stageLabel = typeof body['stageLabel'] === 'string' && body['stageLabel'].trim()
      ? body['stageLabel'].trim().slice(0, 160)
      : phase;
    const profileId = typeof body['profileId'] === 'string' ? body['profileId'].slice(0, 160) : '';
    const runner = typeof body['runner'] === 'string' ? body['runner'].slice(0, 64) : '';
    const root = typeof body['root'] === 'string' ? body['root'].slice(0, 512) : '';
    const command = typeof body['command'] === 'string' ? body['command'].slice(0, 4_000) : '';
    const metadata = {
      workflow_stage_id: stageId,
      workflow_stage_label: stageLabel,
      workflow_phase: phase,
      project_profile_id: profileId,
      project_runner: runner,
      project_root: root,
      ...(typeof body['exitCode'] === 'number' ? { exit_code: body['exitCode'] } : {}),
    };

    if (event === 'started') {
      const span = startTelemetrySpan({
        traceId: threadId,
        name: `workflow.stage.${stageId}.${phase}`,
        kind: 'workflow',
        input: { label: stageLabel, profileId, runner, root, command },
        metadata,
      });
      await flushTelemetryWrites();
      return res.json({ ok: true, traceId: threadId, spanId: span.id, status: event });
    }

    const spanId = typeof body['spanId'] === 'string' ? body['spanId'] : '';
    if (!UUID_RE.test(spanId)) return res.status(400).json({ error: 'valid spanId UUID required' });
    const pool = getSharedPool();
    if (!pool) return res.status(503).json({ error: 'database unavailable' });
    const existing = await pool.query<{ started_at: Date }>(
      'SELECT started_at FROM mcp_observability_spans WHERE id=$1::uuid AND trace_id=$2::uuid LIMIT 1',
      [spanId, threadId],
    );
    const startedAt = existing.rows[0]?.started_at;
    if (!startedAt) return res.status(404).json({ error: 'workflow stage span not found' });
    finishTelemetrySpan({
      id: spanId,
      rootTraceId: threadId,
      traceId: threadId,
      startedAt: startedAt.getTime(),
      kind: 'workflow',
      name: `workflow.stage.${stageId}.${phase}`,
    }, {
      status: event === 'completed' ? 'completed' : 'failed',
      output: body['output'],
      error: event === 'failed' ? body['error'] ?? body['output'] : undefined,
      metadata,
    });
    await flushTelemetryWrites();
    return res.json({ ok: true, traceId: threadId, spanId, status: event });
  });

  const runtimeTelemetryHandler = async (req: Request, res: Response) => {
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');
    if (!expectedSecret) return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    if (!safeSecretEqual(providedSecret, expectedSecret)) return res.status(401).json({ error: 'unauthorized' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const traceId = typeof body['traceId'] === 'string' ? body['traceId'] : '';
    const rootTraceId = typeof body['rootTraceId'] === 'string' ? body['rootTraceId'] : '';
    const rawEvent = typeof body['event'] === 'string' ? body['event'] : '';
    if (!UUID_RE.test(traceId) || !UUID_RE.test(rootTraceId)) {
      return res.status(400).json({ error: 'valid traceId and rootTraceId UUIDs required' });
    }
    if (!['started', 'completed', 'failed', 'cancelled'].includes(rawEvent)) {
      return res.status(400).json({ error: 'invalid lifecycle event' });
    }
    const event = rawEvent as Exclude<LifecycleEvent, 'waiting'>;
    const agentId = Number.isInteger(body['agentId']) && Number(body['agentId']) > 0
      ? Number(body['agentId'])
      : undefined;
    const model = typeof body['model'] === 'string' && body['model'] ? body['model'] : 'codex-default';
    const runtime = typeof body['runtime'] === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(body['runtime'])
      ? body['runtime']
      : 'codex-sdk';
    const provider = typeof body['provider'] === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(body['provider'])
      ? body['provider']
      : 'codex';
    const runtimeAgentName = runtime === 'codex-sdk' ? 'agent.codex' : `agent.${runtime}`;
    const metadata = body['metadata'] && typeof body['metadata'] === 'object' && !Array.isArray(body['metadata'])
      ? body['metadata'] as Record<string, unknown>
      : {};

    if (event === 'started') {
      const pool = getSharedPool();
      if (!pool) return res.status(503).json({ error: 'database unavailable' });
      const owner = await pool.query<{ user_id: number | null }>(
        'SELECT user_id FROM mcp_observability_traces WHERE id = $1',
        [rootTraceId],
      );
      // A standalone workspace smoke-test may not have a parent workflow trace.
      // Promote the Codex trace to its own root so its detail and log links stay
      // valid instead of pointing at a non-existent parent UUID.
      const effectiveRootTraceId = owner.rows.length > 0 ? rootTraceId : traceId;
      startTelemetryTrace({
        id: traceId,
        externalTraceId: traceId,
        rootTraceId: effectiveRootTraceId,
        parentTraceId: owner.rows.length > 0 ? rootTraceId : null,
        name: runtimeAgentName,
        kind: 'agent',
        sessionId: traceId,
        userId: owner.rows[0]?.user_id ?? undefined,
        agentId,
        model,
        provider,
        input: body['input'],
        metadata: { ...metadata, runtime, agent_mode: 'worker' },
      });
      await flushTelemetryWrites();
      return res.json({ ok: true, traceId, rootTraceId: effectiveRootTraceId, status: event });
    }

    const usage = body['usage'] && typeof body['usage'] === 'object' && !Array.isArray(body['usage'])
      ? body['usage'] as Record<string, unknown>
      : {};
    const inputTokens = Math.max(0, Number(usage['input_tokens']) || 0);
    const outputTokens = Math.max(0, Number(usage['output_tokens']) || 0);
    const llmSpan = startTelemetrySpan({
      traceId,
      name: `llm.${runtime}.turn`,
      kind: 'llm',
      model,
      provider,
      metadata: { ...metadata, runtime },
    });
    finishTelemetrySpan(llmSpan, {
      status: event === 'completed' ? 'completed' : event,
      inputTokens,
      outputTokens,
      error: body['error'],
      metadata: { ...metadata, runtime },
    });

    const runtimeEvents = Array.isArray(body['events']) ? body['events'].slice(0, 250) : [];
    for (const raw of runtimeEvents) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const type = typeof item['type'] === 'string' ? item['type'] : 'event';
      if (!['command_execution', 'file_change', 'mcp_tool_call', 'error'].includes(type)) continue;
      const failed = item['status'] === 'failed'
        || type === 'error'
        || typeof item['exitCode'] === 'number' && item['exitCode'] !== 0;
      const toolName = type === 'mcp_tool_call'
        ? `${runtime}.${String(item['server'] ?? 'mcp')}.${String(item['tool'] ?? 'tool')}`
        : `${runtime}.${type}`;
      const span = startTelemetrySpan({
        traceId,
        name: `tool.${toolName}`,
        kind: type === 'error' ? 'event' : 'tool',
        toolName,
        input: item['command'] ?? item['arguments'] ?? item['changes'],
        metadata: { runtime, source_event_type: type },
      });
      finishTelemetrySpan(span, {
        status: failed ? 'failed' : 'completed',
        output: item['output'] ?? item['result'] ?? item['changes'],
        error: item['error'],
      });
    }

    const handle: TelemetryHandle = {
      id: traceId,
      rootTraceId,
      startedAt: Date.now(),
      kind: 'agent',
      name: runtimeAgentName,
    };
    finishTelemetryTrace(handle, {
      status: event,
      output: body['output'],
      error: body['error'],
      inputTokens,
      outputTokens,
      metadata: { ...metadata, runtime, agent_mode: 'worker', termination: event },
    });
    await flushTelemetryWrites();
    return res.json({ ok: true, traceId, status: event });
  };

  // Keep the legacy Codex endpoint for existing sidecars while exposing a
  // provider-neutral endpoint for Claude Code and future local runtimes.
  router.post('/api/internal/telemetry/codex', runtimeTelemetryHandler);
  router.post('/api/internal/telemetry/runtime', runtimeTelemetryHandler);

  return router;
}
