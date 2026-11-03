import type { ApprovalRequest } from '../data-provider/sse.js';

/** A tool-call or tool-result step rendered under an assistant message. */
export interface Step {
  kind: 'call' | 'result';
  name: string;
  /** For 'call': the raw args object; for 'result': the preview string. */
  payload: unknown;
  id?: string;
  status?: 'running' | 'done' | 'error' | 'blocked';
  durationMs?: number;
  traceId?: string;
  spanId?: string;
}

/** The runtime message model used in the UI (not persisted). */
export interface UiMessage {
  role: 'user' | 'assistant';
  content: string;
  steps?: Step[];
  usage?: { prompt: number; completion: number; total: number; cost: number };
  /** Image attachments shown on this (user) turn only; never persisted to history. */
  images?: { name: string; dataUrl: string }[];
  id?: string;
  variant?: { index: number; count: number; siblingIds: string[] };
  isLastAssistant?: boolean;
  citations?: { source: string; snippet: string; score: number; index: string }[];
  approvalRequest?: ApprovalRequest;
  error?: string;
}
