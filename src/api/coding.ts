/**
 * Coding-Workflow API — wraps the LangGraph "coding_workflow" graph.
 * Exposes a small, opinionated REST surface for the Argus workflow UI:
 *
 *   GET    /api/coding/threads          — list recent threads (most-recent first)
 *   POST   /api/coding/threads          — create thread + start run; body { ticket_id, description }
 *   GET    /api/coding/threads/:id      — full state (values, next, tasks/interrupts)
 *   POST   /api/coding/threads/:id/resume — resume after human_approval interrupt
 *   DELETE /api/coding/threads/:id      — delete thread
 */

import { Router, type Request, type Response as ExResponse } from 'express';
import { LANGGRAPH_URL, N8N_CODING_WEBHOOK_URL, WORKSPACE_SECRET } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { redact } from '../lib/redaction.js';
import { verifyWebhookSignature, verifyWebhookToken } from '../lib/webhookSignature.js';
import { submitHumanFeedback } from '../observability/feedbackStore.js';
import { writeAdminAudit } from '../lib/adminAudit.js';
import { findInvalidGitRefField } from '../lib/gitRefs.js';
import { requirementsSubmission } from './codingRequirements.js';
import {
  buildRetryInput,
  sanitizeWorkflowInput,
  workflowInputFromState,
} from './codingRetry.js';
import {
  normalizeCiWebhookEvent,
  toBrowserProviderUrl,
  type CiProvider,
} from '../integrations/ciProviderAdapters.js';
import {
  finishTelemetryTrace,
  flushTelemetryWrites,
  startTelemetryTrace,
  type TelemetryHandle,
} from '../observability/telemetryStore.js';

const DEFAULT_WORKFLOW_TYPE = 'coding_workflow';
const LANGGRAPH_REQUEST_TIMEOUT_MS = 5_000;

interface AssistantSummary {
  assistant_id: string;
  graph_id: string;
  name?: string;
  metadata?: {
    workflow?: {
      label?: string;
      description?: string;
      inputSchema?: Array<{ name: string; label: string; type: 'text' | 'textarea' | 'number' | 'select'; required?: boolean; placeholder?: string }>;
    };
    [key: string]: unknown;
  };
}

/** Static descriptive metadata per known graph_id — extend when new workflows are added. */
const WORKFLOW_INFO: Record<string, { label: string; description: string; input_schema: Array<{ name: string; label: string; type: 'text' | 'textarea'; required?: boolean; placeholder?: string }> }> = {
  coding_workflow: {
    label: 'Coding Workflow',
    description: 'Planner → Knowledge → Coder → Tests → Reviewer → Human Approval. Implementiert Tickets als Code im /workspace.',
    input_schema: [
      { name: 'ticket_id',   label: 'Ticket ID',     type: 'text',     required: true,  placeholder: 'ARGUS-123' },
      { name: 'description', label: 'Beschreibung',  type: 'textarea', required: true,  placeholder: 'Was soll umgesetzt werden? Klar und konkret.' },
      // argus_workflow_id is supplied programmatically (UI: from workflow-picker; default 0 = no Bitbucket creds)
    ],
  },
  pull_request_review: {
    label: 'Pull request review',
    description: 'Existing PR → inspection → tests → review → governed release handoff.',
    input_schema: [
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'review_goal', label: 'Review goal', type: 'textarea', required: true, placeholder: 'What must this PR prove?' },
    ],
  },
  ci_failure_recovery: {
    label: 'CI failure recovery',
    description: 'Failed CI run → diagnosis → focused fix → local tests → governed provider retry.',
    input_schema: [
      { name: 'ticket_id', label: 'Recovery ID', type: 'text', required: true, placeholder: 'ARGUS-CI-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'branch_name', label: 'Failed branch', type: 'text', required: true, placeholder: 'feature/ARGUS-123' },
      { name: 'commit_sha', label: 'Failed commit', type: 'text', required: true, placeholder: 'abcdef123456' },
      { name: 'ci_failure_context', label: 'Failure evidence', type: 'textarea', required: true, placeholder: 'Paste the failing job and error output.' },
    ],
  },
  security_remediation: {
    label: 'Security remediation',
    description: 'Security/dependency finding → triage → minimal fix → verification → governed remediation PR.',
    input_schema: [
      { name: 'ticket_id', label: 'Remediation ID', type: 'text', required: true, placeholder: 'ARGUS-SEC-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Base branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'security_finding_id', label: 'Finding ID', type: 'text', required: true, placeholder: 'CVE-2026-12345' },
      { name: 'security_package', label: 'Affected package', type: 'text', required: true, placeholder: 'package-name' },
      { name: 'security_finding_context', label: 'Finding evidence', type: 'textarea', required: true, placeholder: 'Paste scanner output and acceptance criteria.' },
    ],
  },
  release_notes: {
    label: 'Release notes',
    description: 'Release scope → changelog draft → review → approval-backed handoff.',
    input_schema: [
      { name: 'release_id', label: 'Release ID', type: 'text', required: true, placeholder: 'ARGUS-REL-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Source branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'release_version', label: 'Release version', type: 'text', required: true, placeholder: 'v1.4.0' },
      { name: 'release_scope', label: 'Release scope', type: 'textarea', required: true, placeholder: 'PRs, commits or tickets to include.' },
      { name: 'release_goal', label: 'Release goal', type: 'textarea', required: true, placeholder: 'Audience and acceptance criteria.' },
    ],
  },
  backlog_grooming: {
    label: 'Backlog Planning',
    description: 'Issue/epic → repository research → vertical tasks → review → approval-backed implementation handoff.',
    input_schema: [
      { name: 'backlog_id', label: 'Backlog ID', type: 'text', required: true, placeholder: 'ARGUS-EPIC-123' },
      { name: 'repository', label: 'Repository', type: 'text', required: true, placeholder: 'owner/repository' },
      { name: 'source_branch', label: 'Source branch', type: 'text', required: true, placeholder: 'main' },
      { name: 'issue_title', label: 'Issue title', type: 'text', required: true, placeholder: 'Feature title' },
      { name: 'issue_body', label: 'Issue description', type: 'textarea', required: true, placeholder: 'Paste the epic/issue description.' },
    ],
  },
};

interface ThreadSummary {
  thread_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata: Record<string, unknown>;
  values?: Record<string, unknown>;
  interrupts?: Record<string, unknown>;
}

function pid(req: Request, key: string): string {
  const v = req.params[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? v[0] ?? '' : '';
}

async function lgFetch(path: string, init?: RequestInit): Promise<globalThis.Response> {
  return fetch(LANGGRAPH_URL + path, {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(LANGGRAPH_REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      'X-Workspace-Secret': WORKSPACE_SECRET,
      ...(init?.headers ?? {}),
    },
  });
}

async function lgJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await lgFetch(path, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LangGraph ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

function requestUserId(req: Request): number | null {
  const id = (req as unknown as { user?: { id?: number } }).user?.id;
  return typeof id === 'number' && Number.isInteger(id) ? id : null;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function startCodingTelemetry(
  req: Request,
  threadId: string,
  workflowType: string,
  input: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  startTelemetryTrace({
    id: threadId,
    externalTraceId: threadId,
    rootTraceId: threadId,
    parentTraceId: null,
    parentSpanId: null,
    name: `langgraph.${workflowType}`,
    kind: 'workflow',
    sessionId: threadId,
    userId: requestUserId(req),
    input,
    metadata: { ...metadata, workflow_type: workflowType, runtime: 'argus-langgraph' },
  });
  // The runtime may call an agent immediately. Persist the root first so the
  // trusted agent endpoint can validate parentage instead of racing the queue.
  await flushTelemetryWrites();
}

async function reconcileCodingTelemetry(threadId: string, state: {
  status?: string;
  error?: string | null;
  next?: string[];
  interrupts?: Array<{ value?: Record<string, unknown> }>;
}): Promise<void> {
  const externalCiWaiting = state.status === 'interrupted'
    && (state.next?.includes('external_ci') === true
      || state.interrupts?.some(interrupt => interrupt.value?.['stage'] === 'external_ci') === true);
  const status = state.status === 'interrupted' || externalCiWaiting || state.status === 'waiting_external_ci'
    ? 'waiting'
    : state.status === 'completed' || state.status === 'failed'
      ? state.status
      : null;
  if (!status) return;
  const handle: TelemetryHandle = { id: threadId, rootTraceId: threadId, startedAt: Date.now() };
  finishTelemetryTrace(handle, {
    status,
    error: state.error ?? undefined,
    output: { runtime_status: state.status },
    metadata: { runtime_status: state.status, reconciled_by: 'coding-api' },
  });
  await flushTelemetryWrites();
}

function normalizeRepositoryName(value: unknown): string {
  let normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return '';
  try {
    const parsed = new URL(normalized);
    normalized = parsed.pathname;
  } catch {
    // Repository values are commonly owner/repo strings, not URLs.
  }
  return normalized.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
}

function threadRepositories(values: Record<string, unknown>): string[] {
  const candidates = new Set<string>();
  const direct = normalizeRepositoryName(values['repository'] ?? values['repo_full_name']);
  if (direct) candidates.add(direct);

  // Existing coding runs persist provider credentials under this legacy key.
  // Keep reading it while new workflows can persist a plain repository field.
  const creds = recordValue(values['bitbucket_creds']);
  const owner = String(creds['project_key'] ?? creds['user_slug'] ?? '').trim();
  const repo = String(creds['repo_slug'] ?? '').trim();
  if (owner && repo) candidates.add(normalizeRepositoryName(`${owner}/${repo}`));
  if (repo) candidates.add(normalizeRepositoryName(repo));
  return Array.from(candidates).filter(Boolean);
}

interface CiWebhookRouteOptions {
  provider: CiProvider;
  path: string;
  auth: ReturnType<typeof verifyWebhookSignature>;
  eventHeader?: string;
  allowedEvents?: string[];
}

/** Persist one normalized external CI event against the matching LangGraph run. */
async function handleCiWebhook(
  req: Request,
  res: ExResponse,
  options: CiWebhookRouteOptions,
): Promise<void> {
  const eventName = options.eventHeader
    ? String(req.get(options.eventHeader) ?? '').trim().toLowerCase()
    : '';
  if (eventName && options.allowedEvents && !options.allowedEvents.includes(eventName)) {
    res.status(202).json({ accepted: false, reason: 'unsupported_event', provider: options.provider, event: eventName });
    return;
  }

  const normalized = normalizeCiWebhookEvent(options.provider, recordValue(req.body));
  const branch = normalized.branch;
  const repoFullName = normalizeRepositoryName(normalized.repository);
  if (!branch || !repoFullName) {
    res.status(400).json({ error: 'CI payload must include a branch and repository' });
    return;
  }

  try {
    const threads = await lgJson<Array<{ thread_id: string; values?: Record<string, unknown> }>>(
      '/threads/search',
      { method: 'POST', body: JSON.stringify({ limit: 100 }) },
    );
    const match = threads.find(thread => {
      const values = thread.values ?? {};
      const storedBranch = String(values['branch_name'] ?? values['source_branch'] ?? '').trim();
      if (!storedBranch || storedBranch !== branch) return false;
      const storedProvider = String(values['ci_provider'] ?? '').trim().toLowerCase();
      if (storedProvider && storedProvider !== 'unknown' && storedProvider !== options.provider) return false;
      return threadRepositories(values).includes(repoFullName);
    });
    if (!match) {
      res.status(202).json({ accepted: false, reason: 'no_matching_argus_thread', provider: options.provider, branch, repository: repoFullName });
      return;
    }

    const ciRun = {
      ...normalized.ciRun,
      run_url: toBrowserProviderUrl(options.provider, normalized.ciRun.run_url).slice(0, 2048),
    };
    const updated = await lgJson<{ ok: true; thread_id: string; ci_run: typeof ciRun }>(
      `/threads/${encodeURIComponent(match.thread_id)}/ci`,
      { method: 'POST', body: JSON.stringify(ciRun) },
    );
    res.json({ accepted: true, provider: options.provider, ...updated });
  } catch (err) {
    logger.error({ err, provider: options.provider, branch, repository: repoFullName }, 'CI webhook failed');
    res.status(502).json({ error: err instanceof Error ? err.message : 'failed to persist CI evidence' });
  }
}

export function createCodingRouter(): Router {
  const r = Router();

  // ── List available workflow types ─────────────────────────────
  r.get('/workflows', async (_req: Request, res: ExResponse): Promise<void> => {
    try {
      const assistants = await lgJson<AssistantSummary[]>('/assistants/search', {
        method: 'POST',
        body: JSON.stringify({ limit: 20 }),
      });
      const byGraphId = new Map<string, AssistantSummary>();
      for (const a of assistants) byGraphId.set(a.graph_id, a);
      const workflows = Array.from(byGraphId.values()).map((a) => {
        const info = WORKFLOW_INFO[a.graph_id];
        const published = a.metadata?.workflow;
        return {
          graph_id:    a.graph_id,
          assistant_id: a.assistant_id,
          label:       published?.label ?? info?.label ?? a.graph_id,
          description: published?.description ?? info?.description ?? '',
          input_schema: published?.inputSchema ?? info?.input_schema ?? [
            { name: 'description', label: 'Input', type: 'textarea', required: true },
          ],
        };
      });
      res.json({ workflows });
    } catch (err) {
      logger.error({ err }, 'list workflows failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── List threads ──────────────────────────────────────────────
  r.get('/threads', async (req: Request, res: ExResponse): Promise<void> => {
    try {
      const source = typeof req.query['source'] === 'string' ? req.query['source'].trim() : '';
      if (source && !/^[a-z0-9._-]{1,64}$/i.test(source)) {
        res.status(400).json({ error: 'source filter is invalid' });
        return;
      }
      const threads = await lgJson<ThreadSummary[]>('/threads/search', {
        method: 'POST',
        body: JSON.stringify({ limit: 50, ...(source ? { metadata: { source } } : {}) }),
      });
      res.json({ threads });
    } catch (err) {
      logger.error({ err }, 'list coding threads failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── Create thread + start run ─────────────────────────────────
  r.post('/threads', async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as {
      workflow_type?: string;
      input?: Record<string, unknown>;
      ticket_id?: string;
      description?: string;
      argus_workflow_id?: number;       // legacy resolution path (workflow → bundle → backend)
      argus_bundle_id?: number;         // preferred — UI picks bundle directly
    };
    const workflow_type = (body.workflow_type ?? DEFAULT_WORKFLOW_TYPE).trim();

    // Backwards-compat: accept top-level fields for coding_workflow
    const input: Record<string, unknown> = body.input ?? {};
    if (workflow_type === 'coding_workflow') {
      if (body.ticket_id   && input['ticket_id']   === undefined) input['ticket_id']   = body.ticket_id;
      if (body.description && input['description'] === undefined) input['description'] = body.description;
      // Creds resolution — prefer bundle_id (new UI), fallback to workflow_id (legacy).
      if (body.argus_bundle_id !== undefined && input['argus_bundle_id'] === undefined) {
        input['argus_bundle_id'] = body.argus_bundle_id;
      }
      if (body.argus_workflow_id !== undefined && input['argus_workflow_id'] === undefined) {
        input['argus_workflow_id'] = body.argus_workflow_id;
      }
    }

    const invalidRefField = findInvalidGitRefField(input);
    if (invalidRefField) {
      res.status(400).json({ error: `Field '${invalidRefField}' must be a valid Git branch name` });
      return;
    }

    // Validate required fields based on workflow info
    const info = WORKFLOW_INFO[workflow_type];
    if (info) {
      for (const field of info.input_schema) {
        if (field.required && (input[field.name] == null || String(input[field.name]).trim() === '')) {
          res.status(400).json({ error: `Field '${field.name}' is required for workflow '${workflow_type}'` });
          return;
        }
      }
    }

    try {
      const workflowInput = sanitizeWorkflowInput(workflow_type, input);
      const thread = await lgJson<{ thread_id: string }>('/threads', {
        method: 'POST',
        body: JSON.stringify({
          graph_id: workflow_type,
          metadata: {
            workflow_type,
            workflow_input: workflowInput,
            ticket_id: input['ticket_id'] ?? null,
            description: input['description'] ?? null,
            argus_workflow_id: input['argus_workflow_id'] ?? null,
            argus_bundle_id: input['argus_bundle_id'] ?? null,
          },
        }),
      });
      await startCodingTelemetry(req, thread.thread_id, workflow_type, input, {
        ticket_id: input['ticket_id'] ?? null,
        argus_workflow_id: input['argus_workflow_id'] ?? null,
        argus_bundle_id: input['argus_bundle_id'] ?? null,
      });
      // Fire-and-forget — UI polls state for progress
      lgJson(`/threads/${thread.thread_id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ assistant_id: workflow_type, input }),
      }).catch((err) => logger.warn({ err, thread: thread.thread_id, workflow_type }, 'run start failed'));
      res.json({ thread_id: thread.thread_id, workflow_type });
    } catch (err) {
      logger.error({ err }, 'create coding thread failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── Get state ─────────────────────────────────────────────────
  r.get('/threads/:id', async (req: Request, res: ExResponse): Promise<void> => {
    try {
      const threadId = pid(req, 'id');
      const state = await lgJson<{ status?: string; error?: string | null; values?: Record<string, unknown> }>(
        `/threads/${encodeURIComponent(threadId)}/state`,
      );
      await reconcileCodingTelemetry(threadId, state);
      if (state.values && typeof state.values['pr_url'] === 'string') {
        state.values = {
          ...state.values,
           pr_url: toBrowserProviderUrl('gitea', state.values['pr_url']),
        };
      }
      res.json(state);
    } catch (err) {
      logger.error({ err, id: pid(req, 'id') }, 'get coding thread state failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  r.get('/threads/:id/checkpoints', async (req: Request, res: ExResponse): Promise<void> => {
    try {
      const threadId = pid(req, 'id');
      const rawLimit = Number(req.query['limit'] ?? 30);
      const limit = Number.isSafeInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;
      const history = await lgJson(`/threads/${encodeURIComponent(threadId)}/checkpoints?limit=${limit}`);
      res.json(history);
    } catch (err) {
      logger.error({ err, id: pid(req, 'id') }, 'get coding checkpoint history failed');
      res.status(502).json({ error: 'Checkpoint history is unavailable.' });
    }
  });

  // A separate, owner-bound action: never write a code approval for clarification.
  r.post('/threads/:id/requirements', async (req: Request, res: ExResponse): Promise<void> => {
    try {
      const threadId = pid(req, 'id');
      const thread = await lgJson<Record<string, any>>(`/threads/${encodeURIComponent(threadId)}`);
      const submission = requirementsSubmission(req.body, thread, requestUserId(req));
      const pool = req.app.locals.adminPool as import('pg').Pool | undefined;
      if (!pool || !await writeAdminAudit(pool, req, 'workflow_requirements_submitted', 'argus_langgraph_threads',
        threadId, 'Requirements clarification', undefined, { sha256: submission.digest, length: submission.requirements.length,
          stage: 'requirements_input', checkpoint: thread.checkpoint_id })) {
        res.status(503).json({ error: 'Clarification audit unavailable; the run was not resumed.' });
        return;
      }
      await lgJson(`/threads/${encodeURIComponent(threadId)}/runs`, {
        method: 'POST', body: JSON.stringify({ assistant_id: thread.graph_id,
          command: { resume: submission.resume } }),
      });
      res.json({ ok: true });
    } catch (error) {
      const status = Number((error as { status?: number }).status) || 502;
      res.status(status).json({ error: error instanceof Error ? error.message : 'Clarification failed' });
    }
  });

  // ── Resume after human_approval ───────────────────────────────
  // Body: { approved: boolean, feedback?: string, rationale?: string }
  // - `feedback` is shown back to the agent on reject (legacy)
  // - `rationale` is the human-readable justification stored in the
  //   immutable approval audit log (DORA / EU AI Act Art. 14)
  r.post('/threads/:id/resume', async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as { approved?: boolean; feedback?: string; rationale?: string };
    if (typeof body.approved !== 'boolean') {
      res.status(400).json({ error: 'approved (boolean) is required' });
      return;
    }
    try {
      const threadId = pid(req, 'id');
      // Pull workflow context: workflow_type for re-dispatch + thread state
      // for ticket_id / branch_name / commit_sha so the audit row is fully
      // populated even if the LangGraph node forgets to forward them.
      let workflowType = DEFAULT_WORKFLOW_TYPE;
      let auditCtx: {
        ticket_id:   string | null;
        branch_name: string | null;
        commit_sha:  string | null;
        retry_count: number;
        gate_type:   'code_approval' | 'functional_approval';
      } = {
        ticket_id: null, branch_name: null, commit_sha: null, retry_count: 0, gate_type: 'code_approval',
      };
      try {
        const thr = await lgJson<{
          metadata?: { workflow_type?: string };
          values?: Record<string, unknown>;
          interrupts?: Array<{ value?: { stage?: string } }> | Record<string, { value?: { stage?: string } }[]>;
        }>(`/threads/${encodeURIComponent(threadId)}`);
        if (thr.metadata?.workflow_type) workflowType = thr.metadata.workflow_type;
        const v = thr.values ?? {};
        auditCtx.ticket_id   = (v['ticket_id']   as string | undefined) ?? null;
        auditCtx.branch_name = (v['branch_name'] as string | undefined) ?? null;
        auditCtx.commit_sha  = (v['commit_sha']  as string | undefined) ?? null;
        auditCtx.retry_count = Number(v['retry_count'] ?? 0) || 0;
        // Gate type: extract from interrupt payload if present.
        // human_approval_pr interrupt sets stage='pr_approval'.
        const ints = thr.interrupts;
        const flat = Array.isArray(ints) ? ints
                   : ints && typeof ints === 'object' ? Object.values(ints).flat()
                   : [];
        if (flat.some(it => it?.value?.stage === 'requirements_input')) {
          res.status(409).json({ error: 'This run needs requirements clarification, not an approval.' });
          return;
        }
        for (const it of flat) {
          if (it?.value?.stage === 'pr_approval') {
            auditCtx.gate_type = 'functional_approval';
            break;
          }
        }
      } catch { /* ignore — fall back to default */ }

      // ── Write approval audit row BEFORE resuming the workflow ────────
      // This way even if the resume fails, we have proof of the human decision.
      const user = (req as unknown as { user?: { id?: number; username?: string } }).user;
      const ip = String(
        req.headers['x-forwarded-for']?.toString().split(',')[0] ?? req.socket.remoteAddress ?? ''
      ).trim() || null;
      const rationale = (body.rationale ?? body.feedback ?? '').trim();
      const pool = (req.app.locals as { adminPool?: import('pg').Pool }).adminPool;

      try {
        const { createHash } = await import('crypto');
        const rowHash = createHash('sha256').update([
          threadId, auditCtx.gate_type, String(body.approved), user?.id ?? '', rationale, Date.now(),
        ].join(':')).digest('hex');

        // adminPool is exposed via app.locals.adminPool in src/index.ts boot
        if (pool) {
          await pool.query(
            `INSERT INTO mcp_agent_approvals
               (thread_id, ticket_id, workflow_type, gate_type, approved,
                approver_user_id, approver_username, approver_ip, rationale,
                branch_name, commit_sha, retry_count, row_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
            [
              threadId, auditCtx.ticket_id, workflowType, auditCtx.gate_type, body.approved,
              user?.id ?? null, user?.username ?? null, ip, rationale,
              auditCtx.branch_name, auditCtx.commit_sha, auditCtx.retry_count, rowHash,
            ],
          );
        } else {
          logger.warn({ threadId }, 'approval audit: adminPool not on app.locals — audit row NOT persisted');
        }
      } catch (auditErr) {
        // Audit failures must not block legitimate workflow continuation,
        // but they must be loud — compliance issue.
        logger.error({ err: auditErr, threadId }, 'approval audit row write FAILED');
      }

      // Approval decisions are also first-class trace feedback. Repeated
      // decisions by the same reviewer create a supersession chain, while the
      // immutable compliance audit above retains every decision separately.
      if (pool && user?.id != null) {
        try {
          await flushTelemetryWrites();
          await submitHumanFeedback(pool, {
            traceId: threadId,
            label: auditCtx.gate_type,
            score: body.approved ? 1 : 0,
            sentiment: body.approved ? 'positive' : 'negative',
            comment: rationale ? redact(rationale).text : null,
            tags: ['human-approval', auditCtx.gate_type],
            userId: user.id,
          });
        } catch (feedbackErr) {
          logger.error({ err: feedbackErr, threadId }, 'approval trace feedback write FAILED');
        }
      }

      // Use /runs (background) instead of /runs/wait to avoid blocking the UI
      // when the resumed workflow loops back through coder → tests → reviewer.
      await lgJson(`/threads/${encodeURIComponent(threadId)}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          assistant_id: workflowType,
          command: { resume: { approved: body.approved, feedback: body.feedback ?? '' } },
        }),
      });
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, id: pid(req, 'id') }, 'resume coding thread failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── Trigger via n8n (Ticket-ID only — n8n holt Jira-Details) ──
  // Argus ruft n8n-Webhook auf, n8n holt Jira-Infos, ruft /start zurück.
  // N8N_CODING_WEBHOOK_URL muss in .env gesetzt sein.
  r.post('/trigger-jira', async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as { ticket_id?: string };
    if (!body.ticket_id?.trim()) {
      res.status(400).json({ error: 'ticket_id ist erforderlich' });
      return;
    }
    if (!N8N_CODING_WEBHOOK_URL) {
      res.status(503).json({
        error: 'N8N_CODING_WEBHOOK_URL nicht konfiguriert',
        hint: 'Setze N8N_CODING_WEBHOOK_URL in .env auf die n8n Webhook-URL (z.B. http://localhost:5678/webhook/argus-coding-trigger)',
      });
      return;
    }
    try {
      // Argus-URL für den Callback (n8n ruft /start zurück)
      const argusCallbackUrl = `${req.protocol}://${req.get('host')}/api/coding/start`;
      const n8nRes = await fetch(N8N_CODING_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticket_id:    body.ticket_id.trim(),
          callback_url: argusCallbackUrl,
          source:       'argus_ui',
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!n8nRes.ok) {
        const text = await n8nRes.text().catch(() => '');
        throw new Error(`n8n returned ${n8nRes.status}: ${text.slice(0, 200)}`);
      }
      const n8nData = await n8nRes.json() as Record<string, unknown>;
      logger.info({ ticket_id: body.ticket_id, n8n_response: n8nData }, 'Jira-enriched coding trigger sent to n8n');
      res.json({
        status: 'pending',
        message: `n8n holt Jira-Details für ${body.ticket_id} und startet den Workflow…`,
        thread_id: (n8nData['thread_id'] as string | undefined) ?? null,
      });
    } catch (err) {
      logger.error({ err }, 'trigger-jira failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'n8n nicht erreichbar' });
    }
  });

  // ── n8n / Jira-friendly trigger ───────────────────────────────
  // Accepts { ticket_id, description, title?, jira_url?, source? }
  // Returns { thread_id, status, workflow_url }
  r.post('/start', async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as {
      ticket_id?: string; description?: string; title?: string;
      jira_url?: string; source?: string;
    };
    if (!body.ticket_id?.trim() || !body.description?.trim()) {
      res.status(400).json({ error: 'ticket_id and description are required' });
      return;
    }
    try {
      const thread = await lgJson<{ thread_id: string }>('/threads', {
        method: 'POST',
        body: JSON.stringify({
          metadata: {
            workflow_type: DEFAULT_WORKFLOW_TYPE,
            ticket_id: body.ticket_id.trim(),
            description: body.description.trim(),
            jira_url: body.jira_url ?? null,
            source: body.source ?? 'api',
          },
        }),
      });
      const input = { ticket_id: body.ticket_id.trim(), description: body.description.trim() };
      await startCodingTelemetry(req, thread.thread_id, DEFAULT_WORKFLOW_TYPE, input, {
        ticket_id: body.ticket_id.trim(),
        jira_url: body.jira_url ?? null,
        source: body.source ?? 'api',
      });
      lgJson(`/threads/${thread.thread_id}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          assistant_id: DEFAULT_WORKFLOW_TYPE,
          input,
        }),
      }).catch((err) => logger.warn({ err, thread: thread.thread_id }, 'auto-run start failed'));
      res.json({
        thread_id: thread.thread_id,
        status: 'started',
        workflow_url: `/build/workflows/studio`,
      });
    } catch (err) {
      logger.error({ err }, 'coding /start failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── Retry from error (n8n Jira-comment hook) ──────────────────
  // Restarts the workflow for a ticket, injecting the error context.
  r.post('/threads/:id/retry', async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as { error_context?: string; jira_comment?: string };
    try {
      const threadId = pid(req, 'id');
      // Read the full persisted thread so a retry keeps the original
      // workflow/bundle scope. A retry must not silently fall back to an
      // unscoped legacy run after a governed A2A execution failed.
      const state = await lgJson<{
        metadata?: Record<string, unknown>;
        values?: Record<string, unknown>;
      }>(
        `/threads/${encodeURIComponent(threadId)}`,
      );
      const values = state.values ?? {};
      const metadata = state.metadata ?? {};
      const workflowType = typeof metadata['workflow_type'] === 'string' && metadata['workflow_type'].trim()
        ? metadata['workflow_type'].trim()
        : DEFAULT_WORKFLOW_TYPE;
      const originalInput = workflowInputFromState(workflowType, { metadata, values });
      const valueTicket = typeof values['ticket_id'] === 'string' ? values['ticket_id'].trim() : '';
      const metadataTicket = typeof metadata['ticket_id'] === 'string' ? metadata['ticket_id'].trim() : '';
      const ticket_id = valueTicket || metadataTicket;
      if (Object.keys(originalInput).length === 0) {
        res.status(400).json({ error: 'The failed workflow does not contain persisted workflow input and cannot be retried' });
        return;
      }
      const errorNote   = String(body.error_context ?? body.jira_comment ?? 'Fehler aus CI/CD — bitte erneut versuchen.').slice(0, 12_000);
      const retryInput = buildRetryInput(workflowType, originalInput, errorNote);
      // LangGraph's Annotation default is numeric 0, so a metadata bundle
      // must still be considered when the value channel has not been
      // initialized yet.
      const bundleId = Number(retryInput['argus_bundle_id'] ?? 0)
        || Number(values['argus_bundle_id'] ?? 0)
        || Number(metadata['argus_bundle_id'] ?? 0)
        || undefined;
      const executionBundleIds = Array.isArray(metadata['execution_bundle_ids'])
        ? metadata['execution_bundle_ids'].filter((value): value is number => Number.isInteger(value) && value > 0)
        : bundleId ? [bundleId] : [];
      const sessionScope = (req as unknown as { user?: { allowed_bundles?: number[] | null } }).user?.allowed_bundles;
      const keyScope = (req as unknown as { allowedBundles?: number[] | null }).allowedBundles;
      const allowedBundles = sessionScope ?? keyScope ?? null;
      if (allowedBundles && executionBundleIds.some(id => !allowedBundles.includes(id))) {
        res.status(403).json({ error: 'Retry bundle scope is outside the calling principal scope' });
        return;
      }
      const newThread = await lgJson<{ thread_id: string }>('/threads', {
        method: 'POST',
        body: JSON.stringify({
          graph_id: workflowType,
          metadata: {
            workflow_type: workflowType,
            ticket_id,
            description: retryInput['description'] ?? null,
            workflow_input: retryInput,
            source: 'retry_after_error',
            retry_of: threadId,
            retry_failure_context: errorNote,
            ...(bundleId ? { argus_bundle_id: bundleId } : {}),
            ...(executionBundleIds.length ? { execution_bundle_ids: executionBundleIds } : {}),
          },
        }),
      });
      await startCodingTelemetry(req, newThread.thread_id, workflowType, retryInput, {
        ticket_id,
        source: 'retry_after_error',
        retry_of: threadId,
        ...(bundleId ? { argus_bundle_id: bundleId } : {}),
        ...(executionBundleIds.length ? { execution_bundle_ids: executionBundleIds } : {}),
      });
      lgJson(`/threads/${newThread.thread_id}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          assistant_id: workflowType,
          input: retryInput,
        }),
      }).catch((err) => logger.warn({ err }, 'retry run start failed'));
      res.json({ thread_id: newThread.thread_id, original_thread_id: threadId, workflow_type: workflowType, status: 'started' });
    } catch (err) {
      logger.error({ err, id: pid(req, 'id') }, 'retry coding thread failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── External CI/CD status webhooks ─────────────────────────────────────
  // Providers only submit signed/token-authenticated evidence. Argus stores
  // the normalized run on the matching LangGraph thread; it never executes
  // the provider's build or deployment pipeline.
  const registerCiWebhook = (options: CiWebhookRouteOptions): void => {
    r.post(options.path, options.auth, (req: Request, res: ExResponse) => {
      void handleCiWebhook(req, res, options);
    });
  };

  registerCiWebhook({
    provider: 'gitea',
    path: '/webhook/ci/gitea',
    auth: verifyWebhookSignature({ secretEnvVar: 'GITEA_CI_WEBHOOK_SECRET', headerName: 'x-gitea-signature', stripPrefix: null }),
    eventHeader: 'x-gitea-event',
    allowedEvents: ['workflow_run'],
  });
  registerCiWebhook({
    provider: 'github',
    path: '/webhook/ci/github',
    auth: verifyWebhookSignature({ secretEnvVar: 'GITHUB_CI_WEBHOOK_SECRET', headerName: 'x-hub-signature-256' }),
    eventHeader: 'x-github-event',
    allowedEvents: ['workflow_run'],
  });
  registerCiWebhook({
    provider: 'gitlab',
    path: '/webhook/ci/gitlab',
    auth: verifyWebhookToken({ secretEnvVar: 'GITLAB_CI_WEBHOOK_SECRET', headerName: 'x-gitlab-token' }),
    eventHeader: 'x-gitlab-event',
    allowedEvents: ['pipeline', 'pipeline hook'],
  });
  registerCiWebhook({
    provider: 'jenkins',
    path: '/webhook/ci/jenkins',
    auth: verifyWebhookToken({ secretEnvVar: 'JENKINS_CI_WEBHOOK_SECRET', headerName: 'x-jenkins-token' }),
  });

  // ── n8n Jira-Comment webhook — auto-detect error + restart ───
  // Body: { ticket_id, comment, comment_author?, jira_url? }
  // Patterns: "ERROR IN NEW IMAGE", "IMAGE BUILD FAILED", "CI FAILED", etc.
  // Jira-Comment webhook — HMAC-verified to prevent spoofing.
  // Set JIRA_WEBHOOK_SECRET in .env to enable. In production an unset secret
  // causes 503 (fail-closed); in dev it warns + passes through.
  r.post(
    '/webhook/jira-comment',
    verifyWebhookSignature({ secretEnvVar: 'JIRA_WEBHOOK_SECRET' }),
    async (req: Request, res: ExResponse): Promise<void> => {
    const body = (req.body ?? {}) as {
      ticket_id?: string; comment?: string; comment_author?: string; jira_url?: string;
    };
    if (!body.ticket_id || !body.comment) {
      res.status(400).json({ error: 'ticket_id and comment are required' });
      return;
    }

    const ERROR_PATTERNS = [
      /ERROR\s+IN\s+NEW\s+IMAGE/i,
      /IMAGE\s+BUILD\s+FAIL/i,
      /CI\s+FAIL/i,
      /BUILD\s+ERROR/i,
      /DEPLOY\s+FAIL/i,
      /PIPELINE\s+FAIL/i,
      /TESTS?\s+FAIL/i,
      /CONTAINER\s+ERROR/i,
    ];

    const matched = ERROR_PATTERNS.find((p) => p.test(body.comment!));
    if (!matched) {
      res.json({ triggered: false, reason: 'no_error_pattern_matched', comment_preview: body.comment!.slice(0, 100) });
      return;
    }

    try {
      const threads = await lgJson<Array<{ thread_id: string; metadata: Record<string, unknown>; values?: Record<string, unknown> }>>(
        '/threads/search',
        { method: 'POST', body: JSON.stringify({ limit: 100 }) },
      );
      const ticketThreads = threads
        .filter((t) => t.metadata?.['ticket_id'] === body.ticket_id)
        .sort((a, b) => {
          const at = (a as { updated_at?: string }).updated_at ?? '';
          const bt = (b as { updated_at?: string }).updated_at ?? '';
          return bt.localeCompare(at);
        });

      if (ticketThreads.length === 0) {
        res.json({ triggered: false, reason: 'no_thread_found_for_ticket', ticket_id: body.ticket_id });
        return;
      }

      const latest = ticketThreads[0];
      const origDesc = (latest.values?.['description'] as string | undefined) ?? '';
      const retryBundleId = Number(latest.values?.['argus_bundle_id'] ?? latest.metadata?.['argus_bundle_id'] ?? 0) || undefined;
      const retryExecutionBundleIds = Array.isArray(latest.metadata?.['execution_bundle_ids'])
        ? latest.metadata['execution_bundle_ids'].filter((value): value is number => Number.isInteger(value) && value > 0)
        : retryBundleId ? [retryBundleId] : [];
      const errorContext = [
        `Jira-Kommentar von ${body.comment_author ?? 'unbekannt'}:`,
        body.comment,
        body.jira_url ? `Ticket: ${body.jira_url}` : '',
      ].filter(Boolean).join('\n');

      const newThread = await lgJson<{ thread_id: string }>('/threads', {
        method: 'POST',
        body: JSON.stringify({
          metadata: {
            workflow_type: DEFAULT_WORKFLOW_TYPE,
            ticket_id: body.ticket_id,
            source: 'jira_comment_error',
            retry_of: latest.thread_id,
            error_pattern: matched.toString(),
            ...(retryBundleId ? { argus_bundle_id: retryBundleId } : {}),
            ...(retryExecutionBundleIds.length ? { execution_bundle_ids: retryExecutionBundleIds } : {}),
          },
        }),
      });

      const newDesc = `${origDesc}\n\n---\n🔴 **CI/CD Fehler aus Jira-Kommentar:**\n${errorContext}\n\nBitte analysiere den Fehler und behebe ihn.`;
      const retryInput = { ticket_id: body.ticket_id, description: newDesc, ...(retryBundleId ? { argus_bundle_id: retryBundleId } : {}) };
      await startCodingTelemetry(req, newThread.thread_id, DEFAULT_WORKFLOW_TYPE, retryInput, {
        ticket_id: body.ticket_id,
        source: 'jira_comment_error',
        retry_of: latest.thread_id,
        error_pattern: matched.toString(),
        ...(retryBundleId ? { argus_bundle_id: retryBundleId } : {}),
        ...(retryExecutionBundleIds.length ? { execution_bundle_ids: retryExecutionBundleIds } : {}),
      });
      lgJson(`/threads/${newThread.thread_id}/runs`, {
        method: 'POST',
        body: JSON.stringify({
          assistant_id: DEFAULT_WORKFLOW_TYPE,
          input: retryInput,
        }),
      }).catch((err) => logger.warn({ err }, 'jira-comment retry run start failed'));

      logger.info({ ticket_id: body.ticket_id, new_thread: newThread.thread_id, pattern: matched.toString() }, 'Coding workflow restarted from Jira error comment');
      res.json({
        triggered: true,
        thread_id: newThread.thread_id,
        original_thread_id: latest.thread_id,
        pattern_matched: matched.toString(),
      });
    } catch (err) {
      logger.error({ err }, 'jira-comment webhook failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // ── Delete ────────────────────────────────────────────────────
  // LangGraph requires UUID thread_ids. If the UI (or a stale cached
  // build) sends a ticket id like "ARGUS-4943", look it up via metadata
  // search first and delete by the real UUID. This keeps the user-facing
  // 502/400 from blowing up on a recoverable mismatch.
  r.delete('/threads/:id', async (req: Request, res: ExResponse): Promise<void> => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    let id = pid(req, 'id');
    try {
      if (!UUID_RE.test(id)) {
        // Resolve ticket_id → thread_id via metadata search
        const found = await lgJson<Array<{ thread_id: string; metadata?: Record<string, unknown> }>>(
          '/threads/search',
          {
            method: 'POST',
            body: JSON.stringify({ metadata: { ticket_id: id }, limit: 1 }),
          },
        );
        if (Array.isArray(found) && found.length > 0 && found[0]?.thread_id) {
          logger.info({ ticket_id: id, resolved_thread_id: found[0].thread_id }, 'resolved non-UUID delete to thread_id via metadata');
          id = found[0].thread_id;
        } else {
          // Nothing to delete — treat as already-gone (idempotent)
          res.json({ ok: true, note: 'no thread matched given id; treated as already deleted' });
          return;
        }
      }
      const upstream = await lgFetch(`/threads/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (!upstream.ok && upstream.status !== 404) {
        const text = await upstream.text().catch(() => '');
        throw new Error(`LangGraph ${upstream.status}: ${text.slice(0, 200)}`);
      }
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err, id }, 'delete coding thread failed');
      res.status(502).json({ error: err instanceof Error ? err.message : 'failed' });
    }
  });

  return r;
}
