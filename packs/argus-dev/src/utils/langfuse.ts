/**
 * Lightweight Langfuse client for LangGraph workflows.
 * Used to:
 *  - Send scores after Human Approval gates (Stage 1 + Stage 2)
 *  - Tag traces with session/ticket context
 *
 * Complements the Argus agent-runtime Langfuse integration, which
 * traces individual LLM calls. This one scores completed workflow runs.
 */

const LANGFUSE_PUBLIC_KEY = process.env['LANGFUSE_PUBLIC_KEY'] ?? '';
const LANGFUSE_SECRET_KEY = process.env['LANGFUSE_SECRET_KEY'] ?? '';
const LANGFUSE_HOST       = process.env['LANGFUSE_HOST'] ?? 'http://langfuse:3100';

const enabled = !!(LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY &&
  !LANGFUSE_PUBLIC_KEY.includes('changeme'));

function authHeader(): string {
  return 'Basic ' + Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString('base64');
}

export interface WorkflowScore {
  /** LangGraph thread_id — used as Langfuse trace/session ID */
  threadId:   string;
  /** Score name, e.g. "human_code_approval" */
  name:       string;
  /** 0.0 → rejected / 1.0 → approved */
  value:      number;
  /** Optional human feedback comment */
  comment?:   string;
  /** Additional context tags */
  tags?: Record<string, string | number>;
}

/**
 * Post a numeric score to Langfuse for a workflow run.
 * Fire-and-forget — failures are logged but never throw.
 */
export async function postWorkflowScore(score: WorkflowScore): Promise<void> {
  if (!enabled) {
    console.debug('[langfuse] disabled — skipping score', score.name);
    return;
  }

  try {
    const body: Record<string, unknown> = {
      traceId:  score.threadId,
      name:     score.name,
      value:    score.value,
      dataType: 'NUMERIC',
      ...(score.comment ? { comment: score.comment } : {}),
    };

    const res = await fetch(`${LANGFUSE_HOST}/api/public/scores`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[langfuse] score POST failed ${res.status}: ${text.slice(0, 200)}`);
    } else {
      console.debug(`[langfuse] score posted: ${score.name}=${score.value} trace=${score.threadId.slice(0, 8)}`);
    }
  } catch (err) {
    console.warn('[langfuse] score POST error:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Create or update a Langfuse trace for this workflow run.
 * Call once at the start of the workflow to tag it with ticket/session info.
 */
export async function upsertWorkflowTrace(opts: {
  threadId:  string;
  ticketId:  string;
  workflow:  string;
  tags?:     string[];
}): Promise<void> {
  if (!enabled) return;

  try {
    await fetch(`${LANGFUSE_HOST}/api/public/traces`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': authHeader() },
      body: JSON.stringify({
        id:        opts.threadId,
        name:      `${opts.workflow}:${opts.ticketId}`,
        sessionId: opts.threadId,
        tags:      [opts.ticketId, opts.workflow, ...(opts.tags ?? [])],
        metadata:  { ticketId: opts.ticketId, workflow: opts.workflow },
      }),
    });
  } catch (err) {
    console.warn('[langfuse] trace upsert error:', err instanceof Error ? err.message : String(err));
  }
}

export const langfuseEnabled = enabled;
