import type { Citation } from './types.js';

export interface ApprovalRiskFactor {
  id: string;
  label: string;
  category: string;
  weight: number;
  evidence: string;
}

export interface ApprovalRequest {
  approval_id: string;
  action_description: string;
  tool_name: string;
  target_scope: string;
  parameters: Record<string, unknown>;
  risk_level: 'medium' | 'high' | 'critical';
  risk_score: number;
  risk_factors: ApprovalRiskFactor[];
  expected_impacts: string[];
  ttl_seconds: number;
  created_at: string;
}

export type SseEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id?: string; name: string; args: unknown }
  | { type: 'tool_result'; id?: string; name: string; preview: string; durationMs?: number; isError?: boolean; traceId?: string; spanId?: string }
  | { type: 'error'; message: string }
  | { type: 'usage'; prompt: number; completion: number; total: number; cost: number; model: string }
  | { type: 'citations'; citations: Citation[] }
  | { type: 'approval_requested'; approval: ApprovalRequest }
  | { type: 'done' };

/** Parse complete `\n\n`-delimited SSE blocks from `buffer`; emit events; return the unparsed remainder. */
export function parseSseChunk(buffer: string, emit: (e: SseEvent) => void): string {
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;                       // comment/heartbeat (`: heartbeat`) → skip
    const data = line.slice(6);
    if (data === '[DONE]') { emit({ type: 'done' }); continue; }
    let o: Record<string, unknown>;
    try { o = JSON.parse(data); } catch { continue; }
    if (typeof o.delta === 'string') emit({ type: 'delta', text: o.delta });
    else if (o.tool_call) {
      const t = o.tool_call as { id?: string; name: string; args: unknown };
      emit({ type: 'tool_call', ...(t.id ? { id: t.id } : {}), name: t.name, args: t.args });
    }
    else if (o.tool_result) {
      const t = o.tool_result as { tool_call_id?: string; name: string; preview: string; duration_ms?: number; is_error?: boolean; trace_id?: string; span_id?: string };
      emit({
        type: 'tool_result',
        ...(t.tool_call_id ? { id: t.tool_call_id } : {}),
        name: t.name,
        preview: t.preview,
        ...(typeof t.duration_ms === 'number' ? { durationMs: t.duration_ms } : {}),
        ...(typeof t.is_error === 'boolean' ? { isError: t.is_error } : {}),
        ...(t.trace_id ? { traceId: t.trace_id } : {}),
        ...(t.span_id ? { spanId: t.span_id } : {}),
      });
    }
    else if (typeof o.error === 'string') emit({ type: 'error', message: o.error });
    else if (o.token_usage) {
      const u = o.token_usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number; cost: number; model: string };
      emit({ type: 'usage', prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens, cost: u.cost, model: u.model });
    }
    else if (Array.isArray(o.citations)) {
      emit({ type: 'citations', citations: o.citations as Citation[] });
    }
    else if (o.approval_requested) {
      emit({ type: 'approval_requested', approval: o.approval_requested as ApprovalRequest });
    }
  }
  return buffer;
}

export interface ChatAttachment {
  name: string;
  type?: string;
  content?: string;
  dataUrl?: string;
}

export interface ChatBody { message: string; model_override?: string; attachments?: ChatAttachment[]; params?: { temperature?: number; max_tokens?: number; top_p?: number } }
/**
 * POST to the chat SSE endpoint; stream events until [DONE]/abort. Resolves when the stream ends.
 * NOTE: a pre-response network error (the initial fetch rejecting) propagates as a rejected
 * promise — callers should wrap this call in try/catch. Errors AFTER the response (bad status,
 * mid-stream failure) are delivered as `{ type: 'error' }` events instead.
 */
export async function streamChat(url: string, body: ChatBody, onEvent: (e: SseEvent) => void, signal: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST', credentials: 'include', signal,
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error;
    onEvent({
      type: 'error',
      message: error instanceof TypeError && error.message === 'Failed to fetch'
        ? 'Could not reach Argus. Check that the Argus server is running on http://localhost:3000 and open the chat through /chat.'
        : error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (!res.ok || !res.body) { onEvent({ type: 'error', message: `HTTP ${res.status}${res.body ? '' : ' (no body)'}` }); return; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = parseSseChunk(buf + dec.decode(value, { stream: true }), onEvent);
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') onEvent({ type: 'error', message: String(e) });
  } finally {
    try { reader.releaseLock(); } catch { /* already released/closed */ }
  }
}
