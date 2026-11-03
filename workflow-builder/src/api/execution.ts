import { useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';
import { useExecutionStore } from '@/stores/executionStore';

interface ExecuteResponse {
  executionId: number;
}

export interface LocalWebhookTestResponse {
  workflow_id: number;
  workflow_name: string;
  execution_id: number;
  started: boolean;
  duplicate: boolean;
  inputs: Record<string, unknown>;
  event: {
    source: string;
    event_id: string;
    event_type: string;
    mode: 'local_test';
  };
}

export interface RetryExecutionResponse extends ExecuteResponse {
  retryOfExecutionId: number;
  failedStepIds: string[];
  retryStepIds: string[];
  reusedStepIds: string[];
  changedInputNames: string[];
}

export interface PackRunResponse {
  taskId: string;
  rootTraceId: string;
  workflowThreadId: string;
  status: string;
  spec: { id: string; label: string; revision: number };
  publication: { workflowId?: string; graphId?: string; revision?: number; publishedAt?: string };
  task: {
    id: string;
    status: { state: string };
    metadata?: Record<string, unknown>;
  };
}

export function useExecuteWorkflow() {
  const start = useExecutionStore((s) => s.start);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { workflowId: number; input?: Record<string, unknown>; mock?: boolean }) => {
      const res = await api.post<ExecuteResponse>(`/api/workflows/${vars.workflowId}/execute`, {
        input: vars.input ?? {},
        mock: vars.mock === true,
      });
      start(res.executionId);
      void queryClient.invalidateQueries({ queryKey: ['execution-log-runs', vars.workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['runs', vars.workflowId] });
      return res;
    },
  });
}

export function useTestWebhookWorkflow() {
  const start = useExecutionStore((state) => state.start);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      workflowId: number;
      provider?: string;
      event?: string;
      action?: string;
      payload?: Record<string, unknown>;
    }) => {
      const response = await api.post<LocalWebhookTestResponse>(
        `/api/workflows/${vars.workflowId}/test-webhook`,
        {
          provider: vars.provider,
          event: vars.event,
          action: vars.action,
          payload: vars.payload,
        },
      );
      start(response.execution_id);
      void queryClient.invalidateQueries({ queryKey: ['execution-log-runs', vars.workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['runs', vars.workflowId] });
      return response;
    },
  });
}

export function useRetryWorkflow() {
  const start = useExecutionStore((state) => state.start);
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { workflowId: number; runId: number; input?: Record<string, unknown> }) => {
      const response = await api.post<RetryExecutionResponse>(
        `/api/workflows/${vars.workflowId}/runs/${vars.runId}/retry`,
        { input: vars.input ?? {} },
      );
      start(response.executionId);
      void queryClient.invalidateQueries({ queryKey: ['execution-log-runs', vars.workflowId] });
      void queryClient.invalidateQueries({ queryKey: ['runs', vars.workflowId] });
      return response;
    },
  });
}

export function usePackRunWorkflow() {
  return useMutation({
    mutationFn: (vars: { workflowId: number; input?: Record<string, unknown> }) =>
      api.post<PackRunResponse>(`/api/workflows/${vars.workflowId}/pack-run`, {
        input: vars.input ?? {},
      }),
  });
}

/**
 * Connects to the SSE stream for the active execution and pumps events
 * into the executionStore. Closes the stream on unmount or when the
 * execution finishes (the server sends 'done' and closes the connection).
 */
export function useExecutionStream(workflowId: number | null): void {
  const executionId = useExecutionStore((s) => s.executionId);
  const setRunStepStatus = useExecutionStore((s) => s.setRunStepStatus);
  const finishRun = useExecutionStore((s) => s.finishRun);
  const running = useExecutionStore((s) => s.running);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workflowId || !executionId || !running) return;
    const url = `/api/workflows/${workflowId}/executions/${executionId}/stream`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener('step', (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent).data) as {
          kind: 'started' | 'completed' | 'failed' | 'skipped';
          stepId: string;
          ts: number;
          result?: { duration_ms?: number; result?: unknown; evidence?: unknown; error?: string };
        };
        const patch: { status: 'running' | 'completed' | 'failed' | 'skipped'; startedAt?: number; durationMs?: number; result?: string; rawResult?: unknown; rawEvidence?: unknown; error?: string } = {
          status: payload.kind === 'started' ? 'running' : payload.kind,
        };
        if (payload.kind === 'started') patch.startedAt = payload.ts;
        if (payload.result?.duration_ms !== undefined) patch.durationMs = payload.result.duration_ms;
        if (payload.result?.result !== undefined) {
          patch.rawResult = payload.result.result;
          patch.result = typeof payload.result.result === 'string'
            ? payload.result.result
            : JSON.stringify(payload.result.result, null, 2);
        }
        if (payload.result?.evidence !== undefined) patch.rawEvidence = payload.result.evidence;
        if (payload.result?.error !== undefined) patch.error = payload.result.error;
        setRunStepStatus(executionId, payload.stepId, patch);
      } catch { /* ignore malformed event */ }
    });

    es.addEventListener('done', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          status: 'waiting_for_approval' | 'completed' | 'failed' | 'unknown';
          error?: string;
        };
        if (data.status !== 'unknown') {
          finishRun(executionId, data.status, data.error);
          void queryClient.invalidateQueries({ queryKey: ['execution-log-runs', workflowId] });
          void queryClient.invalidateQueries({ queryKey: ['workflow-run-detail', workflowId, executionId] });
        }
      } catch { /* ignore */ }
      es.close();
    });

    es.onerror = () => {
      // EventSource auto-reconnects; if we're done, server will have closed.
      // We don't manually finish() here to avoid double-call.
    };

    return () => es.close();
  }, [workflowId, executionId, running, setRunStepStatus, finishRun, queryClient]);
}
