// Execution state — populated by the SSE stream from the backend.
// Per-step status is keyed by step-id and used by BaseNode for the
// live status badge (pulse / check / cross).

import { create } from 'zustand';

export type StepExecStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed' | 'skipped';

export interface StepExecState {
  status: StepExecStatus;
  startedAt?: number;
  durationMs?: number;
  result?: string;
  rawResult?: unknown;
  rawEvidence?: unknown;
  error?: string;
}

export type FinalExecutionStatus = 'waiting_for_approval' | 'completed' | 'failed';

interface ExecutionState {
  executionId: number | null;
  executionStartedAt: number | null;
  running: boolean;
  finalStatus: FinalExecutionStatus | null;
  finalError: string | null;
  stepStates: Record<string, StepExecState>;
  logOpen: boolean;

  start: (id: number) => void;
  selectRun: (id: number, status: string, startedAt?: string | number | null) => void;
  syncRunStatus: (id: number, status: string, error?: string | null) => void;
  setStepStatus: (id: string, patch: Partial<StepExecState>) => void;
  setRunStepStatus: (executionId: number, id: string, patch: Partial<StepExecState>) => void;
  finish: (status: FinalExecutionStatus, error?: string) => void;
  finishRun: (executionId: number, status: FinalExecutionStatus, error?: string) => void;
  reset: () => void;
  toggleLog: () => void;
  setLogOpen: (open: boolean) => void;
}

export const useExecutionStore = create<ExecutionState>((set) => ({
  executionId: null,
  executionStartedAt: null,
  running: false,
  finalStatus: null,
  finalError: null,
  stepStates: {},
  logOpen: false,

  start: (id) => set({
    executionId: id,
    executionStartedAt: Date.now(),
    running: true,
    finalStatus: null,
    finalError: null,
    stepStates: {},
    logOpen: true,
  }),

  selectRun: (id, status, startedAt) => {
    const parsedStartedAt = typeof startedAt === 'number' ? startedAt : startedAt ? Date.parse(startedAt) : Date.now();
    const finalStatus: FinalExecutionStatus | null = status === 'completed' || status === 'failed' || status === 'waiting_for_approval'
      ? status
      : null;
    set({
      executionId: id,
      executionStartedAt: Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now(),
      running: status === 'running' || status === 'queued',
      finalStatus,
      finalError: null,
      stepStates: {},
      logOpen: true,
    });
  },

  syncRunStatus: (id, status, error) => set((state) => {
    if (state.executionId !== id) return state;
    const finalStatus: FinalExecutionStatus | null = status === 'completed' || status === 'failed' || status === 'waiting_for_approval'
      ? status
      : null;
    return {
      ...state,
      running: status === 'running' || status === 'queued',
      finalStatus,
      finalError: status === 'waiting_for_approval' ? null : error ?? state.finalError,
    };
  }),

  setStepStatus: (id, patch) =>
    set((s) => ({
      stepStates: { ...s.stepStates, [id]: { ...s.stepStates[id], ...patch, status: patch.status ?? s.stepStates[id]?.status ?? 'pending' } },
    })),

  setRunStepStatus: (executionId, id, patch) =>
    set((state) => state.executionId !== executionId ? state : ({
      ...state,
      stepStates: {
        ...state.stepStates,
        [id]: {
          ...state.stepStates[id],
          ...patch,
          status: patch.status ?? state.stepStates[id]?.status ?? 'pending',
        },
      },
    })),

  finish: (status, error) =>
    set({ running: false, finalStatus: status, finalError: error ?? null }),

  finishRun: (executionId, status, error) =>
    set((state) => state.executionId !== executionId ? state : ({
      ...state,
      running: false,
      finalStatus: status,
      finalError: error ?? null,
    })),

  reset: () =>
    set({ executionId: null, executionStartedAt: null, running: false, finalStatus: null, finalError: null, stepStates: {} }),

  toggleLog: () => set((s) => ({ logOpen: !s.logOpen })),
  setLogOpen: (logOpen) => set({ logOpen }),
}));
