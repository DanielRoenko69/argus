/**
 * Workflow trigger wiring — cron scheduler + webhook listener.
 *
 * - Cron: every minute checks all workflows with trigger_config.type='cron'
 *         and fires via internal execute helper if cron_expr matches.
 * - Webhook: routes POST /webhooks/wf/:slug into the matching workflow.
 *
 * Both use the existing execute-pipeline via direct DB+executor wiring (the
 * SSE/event-emitter layer is NOT used here — triggered runs are fire-and-forget).
 */

import type { Express, RequestHandler } from 'express';
import type pg from 'pg';
import { createHash, randomUUID } from 'crypto';
import { logger } from '../lib/logger.js';
import { checkWebhookSignature } from '../lib/webhookSignature.js';
import { RateLimiter } from '../lib/rateLimiter.js';
import { executeWorkflow, type StepRunners } from './executor.js';
import { persistExecutionResult } from './executionPersistence.js';
import { notifySubscribers } from './subscriberRoutes.js';
import { resolveBundleBackendReference } from './backendCredsStore.js';
import type { WorkflowRow, ToolRunner, WorkflowStep, StepCredOverride } from './types.js';
import {
  applyWorkflowAgentAssignments,
  preflightWorkflowAgents,
  workflowExecutionSnapshot,
} from './agentContracts.js';
import { getRbacUser, isAdmin } from './rbacHelpers.js';
import { bindAiSystemProductionRunAudited } from '../compliance/aiSystemRunBinding.js';
import type { AuthenticatedRequest } from '../auth/sessionMiddleware.js';
import { resolveAuthorizedWorkspaceScope, WorkspaceScopeAccessError } from '../auth/workspaceScope.js';

/**
 * Service-identity cred resolver for triggered runs (audit H2). The interactive
 * builder path resolves a step's `cred_ref` bundle to its stored token; without
 * this, cron/webhook runs silently fell back to default service creds (wrong
 * identity). Triggered workflows are admin-approved (lifecycle=production), so
 * no per-user bundle-denial check applies here.
 */
function makeServiceCredResolver(pool: pg.Pool) {
  return async (step: WorkflowStep): Promise<StepCredOverride | null> => {
    const ref = step.cred_ref;
    if (!ref || typeof ref.bundle_id !== 'number') return null;
    const backendId = await resolveBundleBackendReference(pool, ref.bundle_id, ref.backend_cred_id);
    return { token: null, backendId };
  };
}

/**
 * Factory that builds a (hook-wrapped) ToolRunner for one execution. The
 * per-execution sessionId keeps the cost-budget counter scoped to a single run.
 * Audit #1: triggered runs must go through the tool-hook pipeline, not bare
 * executeTool. The optional workflowId lets the human-approval-gate enforce
 * WORKFLOW-level oversight (audit #2) on sensitive tools invoked by steps.
 */
export type ToolRunnerFactory = (sessionId: string, workflowId?: number) => ToolRunner;

interface TriggerableWorkflow {
  id: number;
  name: string;
  trigger_config: {
    type?: 'cron' | 'webhook' | 'manual' | 'api' | 'event';
    cron_expr?: string;
    webhook_path?: string;
    static_inputs?: Record<string, unknown>;
  };
  enabled: boolean;
  maintenance_window?: MaintenanceWindow;
  tenant_key: string;
  workspace_key: string;
}

interface WebhookWorkflow {
  id: number;
  name: string;
  /** webhook_secret_env names a per-workflow HMAC secret env-var (audit #1 per-workflow secret). */
  trigger_config: {
    webhook_path?: string;
    webhook_secret_env?: string;
    provider?: 'auto' | 'generic' | 'github' | 'gitea' | 'gitlab';
    allowed_events?: string[];
    static_inputs?: Record<string, unknown>;
  } | null;
  maintenance_window?: MaintenanceWindow;
  ai_act_governed?: boolean;
  ai_system_id?: string | null;
  ai_system_revision?: number | null;
  lifecycle_status?: string;
  tenant_key: string;
  workspace_key: string;
}

interface MaintenanceWindow {
  days?: string[];
  from?: string;
  to?: string;
  timezone?: string;
}

export interface WorkflowTriggerEvidence {
  source: string;
  event_id: string;
  event_type: string;
  received_at: string;
  payload_sha256: string;
  event_id_source: string;
  path: string;
  mode?: 'delivery' | 'local_test';
}

function firstHeader(headers: Record<string, unknown>, names: string[]): { name: string; value: string } | null {
  for (const name of names) {
    const raw = headers[name];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) {
      return { name, value: value.trim().slice(0, 256) };
    }
  }
  return null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeScheduledWorkflowInputs(config: TriggerableWorkflow['trigger_config'] | null | undefined): Record<string, unknown> {
  return { ...objectValue(config?.static_inputs) };
}

function boundedString(value: unknown, maximum = 20_000): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, maximum) : undefined;
}

/**
 * Normalize provider-specific webhook headers into an auditable, stable
 * identity. Providers normally supply a delivery UUID; generic callers can
 * send X-Argus-Event-Id. A payload fingerprint is the deterministic fallback
 * so accidental retransmissions are still deduplicated.
 */
export function workflowWebhookEvidence(input: {
  headers: Record<string, unknown>;
  rawBody?: Buffer;
  body?: unknown;
  path: string;
  receivedAt?: Date;
}): WorkflowTriggerEvidence {
  const rawBody = input.rawBody ?? Buffer.from(JSON.stringify(input.body ?? {}));
  const payloadSha256 = createHash('sha256').update(rawBody).digest('hex');
  const sourceHeader = firstHeader(input.headers, ['x-argus-event-source']);
  const eventHeader = firstHeader(input.headers, [
    'x-argus-event-type', 'x-github-event', 'x-gitea-event', 'x-gitlab-event',
  ]);
  const idHeader = firstHeader(input.headers, [
    'x-argus-event-id', 'x-github-delivery', 'x-gitea-delivery',
    'x-gitlab-event-uuid', 'idempotency-key',
  ]);
  const inferredSource = input.headers['x-github-event'] ? 'github'
    : input.headers['x-gitea-event'] ? 'gitea'
      : input.headers['x-gitlab-event'] ? 'gitlab'
        : 'webhook';

  const action = boundedString(objectValue(input.body)['action'], 64);
  const baseEventType = (eventHeader?.value ?? 'event').slice(0, 128);
  const eventType = action && !baseEventType.includes('.') ? `${baseEventType}.${action}` : baseEventType;

  return {
    source: (sourceHeader?.value ?? inferredSource).toLowerCase().slice(0, 64),
    event_id: idHeader?.value ?? `sha256:${payloadSha256}`,
    event_type: eventType,
    received_at: (input.receivedAt ?? new Date()).toISOString(),
    payload_sha256: payloadSha256,
    event_id_source: idHeader?.name ?? 'payload-sha256',
    path: (input.path ?? '').slice(0, 256),
    mode: 'delivery',
  };
}

/**
 * Convert provider-native payloads into the stable, flat inputs consumed by
 * visual workflows. Raw provider payloads are intentionally not persisted as
 * execution inputs; the trace keeps a fingerprint while the workflow receives
 * only bounded, useful fields plus administrator-configured static inputs.
 */
export function normalizeWorkflowWebhookInputs(
  body: unknown,
  evidence: WorkflowTriggerEvidence,
  config: WebhookWorkflow['trigger_config'],
): Record<string, unknown> {
  const payload = objectValue(body);
  const staticInputs = objectValue(config?.static_inputs);
  const configuredProvider = config?.provider ?? 'auto';
  const provider = configuredProvider === 'auto' ? evidence.source : configuredProvider;

  if (provider === 'github') {
    const repository = objectValue(payload['repository']);
    const repositoryOwner = objectValue(repository['owner']);
    const issue = objectValue(payload['issue']);
    const sender = objectValue(payload['sender']);
    const fullName = boundedString(repository['full_name'], 512);
    const owner = boundedString(repositoryOwner['login'], 256)
      ?? boundedString(repositoryOwner['name'], 256)
      ?? fullName?.split('/')[0];
    const name = boundedString(repository['name'], 256) ?? fullName?.split('/')[1];
    const issueNumber = typeof issue['number'] === 'number' ? issue['number'] : Number(issue['number']);

    return {
      ...(owner ? { repository_owner: owner } : {}),
      ...(name ? { repository_name: name } : {}),
      ...(Number.isFinite(issueNumber) ? { issue_number: issueNumber } : {}),
      ...(boundedString(issue['title'], 1_000) ? { issue_title: boundedString(issue['title'], 1_000) } : {}),
      ...(boundedString(issue['body']) ? { issue_body: boundedString(issue['body']) } : {}),
      ...(boundedString(issue['html_url'], 2_000) ? { issue_url: boundedString(issue['html_url'], 2_000) } : {}),
      ...(boundedString(payload['action'], 64) ? { issue_action: boundedString(payload['action'], 64) } : {}),
      ...(boundedString(sender['login'], 256) ? { sender_login: boundedString(sender['login'], 256) } : {}),
      ...staticInputs,
    };
  }

  return { ...payload, ...staticInputs };
}

export interface LocalWebhookTestDelivery {
  payload: Record<string, unknown>;
  evidence: WorkflowTriggerEvidence;
}

/**
 * Build a provider-native local fixture. The authenticated Builder endpoint
 * uses this helper instead of calling its own HTTP listener so no public URL or
 * HMAC secret is required, while normalization, preflight, tool governance and
 * execution persistence remain identical to a real delivery.
 */
export function buildLocalWebhookTestDelivery(input: {
  provider?: 'auto' | 'generic' | 'github' | 'gitea' | 'gitlab';
  event?: string;
  action?: string;
  payload?: unknown;
  path: string;
  deliveryId?: string;
  receivedAt?: Date;
}): LocalWebhookTestDelivery {
  const provider = !input.provider || input.provider === 'auto' ? 'github' : input.provider;
  const event = boundedString(input.event, 128) ?? (provider === 'github' ? 'issues' : 'event');
  const action = boundedString(input.action, 64) ?? (event === 'issues' ? 'opened' : 'test');
  const supplied = objectValue(input.payload);
  const payload = Object.keys(supplied).length > 0
    ? supplied
    : provider === 'github'
      ? {
          action,
          issue: {
            number: 1,
            title: 'Argus local webhook test',
            body: 'Locally generated GitHub-compatible test delivery.',
            html_url: 'https://github.com/argus-local/demo-repository/issues/1',
          },
          repository: {
            name: 'demo-repository',
            full_name: 'argus-local/demo-repository',
            owner: { login: 'argus-local' },
          },
          sender: { login: 'argus-local-tester' },
        }
      : { event, action, message: 'Argus local webhook test' };
  const deliveryId = boundedString(input.deliveryId, 256) ?? `local-${randomUUID()}`;
  const rawBody = Buffer.from(JSON.stringify(payload));
  const headers: Record<string, unknown> = {
    'x-argus-event-source': provider === 'generic' ? 'local-test' : provider,
    'x-argus-event-type': event,
    'x-argus-event-id': deliveryId,
  };
  if (provider === 'github') {
    headers['x-github-event'] = event;
    headers['x-github-delivery'] = deliveryId;
  }
  const evidence = workflowWebhookEvidence({
    headers,
    rawBody,
    body: payload,
    path: input.path,
    receivedAt: input.receivedAt,
  });
  evidence.mode = 'local_test';
  evidence.event_id_source = 'local-test';
  return { payload, evidence };
}

function eventAllowed(eventType: string, allowedEvents: string[] | undefined): boolean {
  if (!allowedEvents?.length) return true;
  const normalized = eventType.toLowerCase();
  const base = normalized.split('.')[0]!;
  return allowedEvents.some(candidate => {
    const allowed = candidate.trim().toLowerCase();
    return allowed === '*' || allowed === normalized || allowed === base;
  });
}

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function withinMaintenanceWindow(mw: MaintenanceWindow | undefined, now: Date): boolean {
  if (!mw || !mw.days?.length) return true;
  const dayName = DAY_NAMES[now.getDay()];
  if (dayName && !mw.days.includes(dayName)) return false;
  if (mw.from && mw.to) {
    const cur = now.getHours() * 60 + now.getMinutes();
    const parse = (t: string): number | null => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(t);
      return m ? Number(m[1]) * 60 + Number(m[2]) : null;
    };
    const from = parse(mw.from);
    const to = parse(mw.to);
    if (from != null && to != null) {
      if (from <= to) return cur >= from && cur <= to;
      return cur >= from || cur <= to;
    }
  }
  return true;
}

// Very small cron-matcher: supports `*`, `*/N`, comma-lists, exact numbers in
// the 5-field format `minute hour dom month dow`. Good enough for Argus (we
// don't need ranges with steps etc).
function cronMatches(expr: string, now: Date): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const f = [now.getMinutes(), now.getHours(), now.getDate(), now.getMonth() + 1, now.getDay()];
  for (let i = 0; i < 5; i++) {
    const seg = parts[i]!;
    if (seg === '*') continue;
    if (seg.startsWith('*/')) {
      const step = Number(seg.slice(2));
      if (Number.isFinite(step) && step > 0 && (f[i]! % step === 0)) continue;
      return false;
    }
    const vals = seg.split(',').map((s) => Number(s));
    if (vals.some((v) => v === f[i])) continue;
    return false;
  }
  return true;
}

/**
 * Cross-replica cron-tick dedup (audit #3). The previous module-global
 * `lastTickMinute` only deduped WITHIN one pod — with N replicas every
 * scheduled workflow fired N times per minute. We now claim the minute bucket
 * via an INSERT … ON CONFLICT DO NOTHING: exactly one pod inserts the row and
 * gets it back (RETURNING), the others conflict and skip. Fail-OPEN on a DB
 * error (e.g. table missing pre-migration) so cron never silently dies.
 */
async function claimCronTick(pool: pg.Pool, key: string): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ tick_key: string }>(
      `INSERT INTO mcp_cron_ticks (tick_key) VALUES ($1)
       ON CONFLICT (tick_key) DO NOTHING RETURNING tick_key`,
      [key],
    );
    return rows.length > 0;
  } catch (err) {
    logger.warn({ err: String(err) }, 'cron-tick dedup claim failed — proceeding (fail-open)');
    return true;
  }
}

async function runCronTick(pool: pg.Pool, toolRunnerFactory: ToolRunnerFactory, runners: StepRunners): Promise<void> {
  const now = new Date();
  const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
  if (!(await claimCronTick(pool, key))) return;  // another replica owns this tick
  // Opportunistic prune so the dedup table stays small (one row per minute).
  void pool.query(`DELETE FROM mcp_cron_ticks WHERE fired_at < now() - interval '1 hour'`).catch(() => {});

  const { rows } = await pool.query<TriggerableWorkflow>(
    `SELECT id, name, trigger_config, enabled, maintenance_window, tenant_key, workspace_key
     FROM mcp_workflows
     WHERE enabled = true AND lifecycle_status = 'production'
       AND trigger_config @> '{"type":"cron"}'::jsonb`
  ).catch(() => ({ rows: [] as TriggerableWorkflow[] }));

  for (const w of rows) {
    const expr = w.trigger_config?.cron_expr;
    if (!expr) continue;
    if (!cronMatches(expr, now)) continue;
    if (!withinMaintenanceWindow(w.maintenance_window, now)) {
      logger.info({ workflowId: w.id, name: w.name }, 'cron fire skipped (outside maintenance window)');
      continue;
    }
    logger.info({ workflowId: w.id, name: w.name, cron: expr }, 'firing scheduled workflow');
    // audit H1: fireWorkflow awaits DB queries BEFORE its background IIFE, so a
    // transient error here would reject this detached promise → unhandled
    // rejection → pod shutdown. Always attach a .catch.
    void fireWorkflow(
      pool,
      w.id,
      normalizeScheduledWorkflowInputs(w.trigger_config),
      'cron-scheduler',
      toolRunnerFactory,
      runners,
      undefined,
      { production: true },
    )
      .catch((err) => logger.warn({ err: String(err), workflowId: w.id }, 'cron fireWorkflow failed'));
  }
}

export async function fireWorkflow(
  pool: pg.Pool, wfId: number, inputs: Record<string, unknown>,
  triggeredBy: string, toolRunnerFactory: ToolRunnerFactory, runners: StepRunners,
  triggerEvidence?: WorkflowTriggerEvidence,
  options: { production?: boolean } = {},
): Promise<{ executionId: number; status: string; duplicate: boolean } | null> {
  const { rows } = await pool.query<WorkflowRow>(
    `SELECT id, name, description, steps, input_params, enabled, agent_requirements,
            lifecycle_status, ai_act_governed, ai_system_id, ai_system_revision,
            tenant_key, workspace_key
     FROM mcp_workflows WHERE id = $1 AND enabled = true`,
    [wfId]
  );
  const wf = rows[0];
  if (!wf || !Array.isArray(wf.steps) || wf.steps.length === 0) return null;
  const agentPreflight = await preflightWorkflowAgents(pool, wf);
  if (!agentPreflight.ready) {
    logger.warn(
      { workflowId: wfId, blockers: agentPreflight.blockers },
      'triggered workflow blocked by its Agent contract',
    );
    return null;
  }
  const resolvedWorkflow = applyWorkflowAgentAssignments(wf, agentPreflight);

  const ins = await pool.query<{ id: number }>(
    `INSERT INTO mcp_workflow_executions (
       workflow_id, status, triggered_by, input_args, execution_snapshot, trigger_evidence,
       tenant_key, workspace_key
     )
     VALUES ($1, 'running', $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      wfId,
      triggeredBy,
      JSON.stringify(inputs),
      JSON.stringify(workflowExecutionSnapshot(agentPreflight)),
      JSON.stringify(triggerEvidence ?? {}),
      wf.tenant_key ?? 'default',
      wf.workspace_key ?? 'default',
    ]
  );
  const inserted = ins.rows[0];
  if (!inserted && triggerEvidence) {
    const existing = await pool.query<{ id: number; status: string }>(
      `SELECT id, status
       FROM mcp_workflow_executions
       WHERE workflow_id = $1
         AND tenant_key = $2 AND workspace_key = $3
         AND trigger_evidence->>'source' = $4
         AND trigger_evidence->>'event_id' = $5
       ORDER BY started_at DESC
       LIMIT 2`,
      [wfId, wf.tenant_key ?? 'default', wf.workspace_key ?? 'default', triggerEvidence.source, triggerEvidence.event_id],
    );
    const duplicate = existing.rows[0];
    if (duplicate) {
      logger.info(
        { workflowId: wfId, executionId: duplicate.id, source: triggerEvidence.source, eventId: triggerEvidence.event_id },
        'duplicate workflow webhook delivery suppressed',
      );
      return { executionId: duplicate.id, status: duplicate.status, duplicate: true };
    }
    throw new Error('Webhook execution conflicted but the original delivery could not be resolved');
  }
  const executionId = inserted!.id;
  if (options.production && wf.ai_act_governed) {
    const gateFailure = async (message: string) => {
      await pool.query(
        `UPDATE mcp_workflow_executions
            SET status='failed', completed_at=now(), error_message=$2,
                execution_snapshot=execution_snapshot || jsonb_build_object(
                  'aiActProductionGate',
                  COALESCE(execution_snapshot->'aiActProductionGate', '{}'::jsonb)
                    || jsonb_build_object('status','blocked','reason',$2)
                )
          WHERE id=$1`,
        [executionId, message],
      );
      logger.warn({ workflowId: wfId, executionId, reason: message }, 'production run blocked by AI-system release gate');
      return { executionId, status: 'blocked', duplicate: false };
    };
    if (!wf.ai_system_id || !wf.ai_system_revision) {
      return gateFailure('AI Act governed workflow has no complete AI-system revision binding.');
    }
    try {
      const identitySubject = process.env['ARGUS_AI_ACT_WORKLOAD_IDENTITY_SUBJECT']
        ?? 'workload:argus-core:workflow-trigger';
      const identityVerified = process.env['ARGUS_AI_ACT_WORKLOAD_IDENTITY_VERIFIED'] === 'true';
      const gate = await bindAiSystemProductionRunAudited(pool, {
        scope: {
          workspaceKey: wf.workspace_key ?? 'default',
          tenantKey: wf.tenant_key ?? 'default',
          environment: process.env['ARGUS_ENVIRONMENT'] ?? 'production',
        },
        environment: process.env['ARGUS_ENVIRONMENT'] ?? 'production',
        workflowExecutionId: executionId,
        aiSystemId: wf.ai_system_id,
        aiSystemRevision: wf.ai_system_revision,
        identity: {
          actorType: 'service',
          subjectId: identitySubject,
          role: 'workflow_trigger',
          authenticationMethod: 'workload_identity',
          identityVerified,
          mfaStepUpAt: null,
        },
        actor: {
          type: 'service',
          id: identitySubject,
          authMethod: 'workload_identity',
          effectiveRoles: ['workflow_trigger'],
        },
        producerEventId: `workflow-production-gate:${executionId}`,
      });
      await pool.query(
        `UPDATE mcp_workflow_executions
            SET execution_snapshot=execution_snapshot || jsonb_build_object(
              'aiActProductionGate', jsonb_build_object(
                'status',$2::text,
                'bindingId',$3::text,
                'bindingSha256',$4::text,
                'aiSystemId',$5::text,
                'aiSystemRevision',$6::integer
              )
            )
          WHERE id=$1`,
        [executionId, gate.binding.releaseGate.status, gate.bindingId, gate.bindingSha256,
          wf.ai_system_id, wf.ai_system_revision],
      );
      if (!gate.binding.executionAuthorized) {
        return gateFailure(`AI Act production release gate blocked execution: ${gate.binding.releaseGate.blockingReasons.join('; ')}`);
      }
    } catch (error) {
      return gateFailure(`AI Act production release gate failed closed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Per-execution hooked tool runner (audit #1) — sessionId scopes cost-budget;
  // wfId lets the human-approval-gate enforce workflow-level oversight (audit #2).
  const toolRunner = toolRunnerFactory(`trigger:${executionId}`, wfId);

  // Run in background
  void (async () => {
    try {
      const r = await executeWorkflow({
        workflow: { ...resolvedWorkflow, bundle_ids: [], created_by: null, created_at: '', updated_at: '' },
        inputs, toolRunner, runners, executionId, triggeredBy,
        // audit H2: resolve step cred_ref bundles with service identity (was
        // only wired on the interactive builder path → triggered runs silently
        // used default service creds).
        credResolver: makeServiceCredResolver(pool),
      });
      await persistExecutionResult(pool, executionId, r);
      // audit H2: notify subscribers (Slack/PagerDuty) — was only wired on the
      // interactive path, so unattended runs never alerted on failure.
      if (r.status !== 'waiting_for_approval') {
        const finalStatus = r.status === 'completed' ? 'completed' : 'failed';
        void notifySubscribers(pool, wfId, finalStatus, executionId, r.error ?? null);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await pool.query(
        `UPDATE mcp_workflow_executions SET status='failed', completed_at=now(), error_message=$2 WHERE id=$1`,
        [executionId, msg]
      ).catch(() => {});
      void notifySubscribers(pool, wfId, 'failed', executionId, msg);
    }
  })();

  return { executionId, status: 'started', duplicate: false };
}

export function startTriggerWorker(pool: pg.Pool, toolRunnerFactory: ToolRunnerFactory, runners: StepRunners): NodeJS.Timeout {
  logger.info('workflow cron-trigger worker started (60s interval)');
  const timer = setInterval(() => {
    void runCronTick(pool, toolRunnerFactory, runners).catch((err) => {
      logger.warn({ err: String(err) }, 'cron tick failed');
    });
  }, 60_000);
  timer.unref();
  return timer;
}

// ── webhook rate limiter ───────────────────────────────────────────
// Bounds blast radius of the (HMAC-authenticated) webhook trigger: even a
// valid-signature caller can't hammer a workflow into a tool-spend /
// cluster-action storm. Audit #3: the previous in-memory Map was per-pod, so
// with N replicas the effective limit was N×30. RateLimiter uses a Redis
// sliding window (shared across replicas) with an in-memory fallback when
// Redis is unavailable — same primitive the API-key middleware uses.
const WEBHOOK_RL_MAX = 30;
const webhookLimiter = new RateLimiter(WEBHOOK_RL_MAX);

const WEBHOOK_SIG_HEADER = 'x-argus-signature';

export function registerWebhookTriggerRoute(
  app: Express,
  pool: pg.Pool,
  toolRunnerFactory: ToolRunnerFactory,
  runners: StepRunners,
  requireAuth?: RequestHandler,
): void {
  // SECURITY (audit #3): the trigger receiver requires an HMAC-SHA256 signature
  // over the raw body (X-Argus-Signature: sha256=<hex>). Audit #1 per-workflow
  // secret: each workflow may name its OWN secret env-var via
  // trigger_config.webhook_secret_env; absent → the shared ARGUS_WEBHOOK_SECRET.
  // This means knowing one workflow's secret no longer lets a caller trigger
  // EVERY webhook workflow. Because the secret depends on which workflow the
  // slug resolves to, verification happens INSIDE the handler (after lookup),
  // not as up-front middleware. Fail-CLOSED in production when the chosen
  // secret is unset (503), fail-open in dev. rawBody is captured by
  // express.json({verify}) in index.ts.
  app.post('/webhooks/wf/:slug', async (req, res) => {
    const slug = String(req.params['slug'] ?? '');

    if (!(await webhookLimiter.isAllowed(`webhook:${slug}`))) {
      res.status(429).json({ error: 'rate limit exceeded for webhook', slug });
      return;
    }

    const path = '/' + slug;
    const { rows } = await pool.query<WebhookWorkflow>(
      `SELECT id, name, trigger_config, maintenance_window, tenant_key, workspace_key FROM mcp_workflows
       WHERE enabled = true AND lifecycle_status = 'production'
         AND trigger_config @> $1::jsonb
       LIMIT 1`,
      [JSON.stringify({ type: 'webhook', webhook_path: path })]
    );
    const wf = rows[0];
    if (!wf) {
      res.status(404).json({ error: 'no workflow bound to webhook path', path });
      return;
    }

    // Resolve the per-workflow secret env-var, falling back to the global one.
    const cfgSecretEnv = wf.trigger_config?.webhook_secret_env;
    const secretEnvVar = (typeof cfgSecretEnv === 'string' && cfgSecretEnv.trim())
      ? cfgSecretEnv.trim()
      : 'ARGUS_WEBHOOK_SECRET';
    const signatureHeader = req.headers[WEBHOOK_SIG_HEADER]
      ?? req.headers['x-hub-signature-256']
      ?? req.headers['x-gitea-signature'];
    const sig = checkWebhookSignature({
      secret: process.env[secretEnvVar],
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
      signatureHeader,
      isProduction: process.env['NODE_ENV'] === 'production',
      secretEnvVar,
      path: req.path,
    });
    if (!sig.ok) {
      res.status(sig.status ?? 403).json({ error: sig.error ?? 'Invalid signature' });
      return;
    }

    // audit M1: honour the maintenance window on the webhook path too — cron
    // already gates on it, and the builder UI promises "Cron- und Webhook-
    // Trigger feuern nur in diesem Fenster". Outside the window → 409.
    if (!withinMaintenanceWindow(wf.maintenance_window, new Date())) {
      res.status(409).json({ error: 'workflow is outside its maintenance window', workflow_id: wf.id });
      return;
    }

    const triggerEvidence = workflowWebhookEvidence({
      headers: req.headers as Record<string, unknown>,
      rawBody: (req as unknown as { rawBody?: Buffer }).rawBody,
      body: req.body,
      path: req.path,
    });
    const configuredProvider = wf.trigger_config?.provider;
    if (configuredProvider && configuredProvider !== 'auto' && configuredProvider !== 'generic'
        && triggerEvidence.source !== configuredProvider) {
      res.status(422).json({
        error: 'webhook provider does not match workflow trigger configuration',
        expected: configuredProvider,
        received: triggerEvidence.source,
      });
      return;
    }
    if (rows.length > 1) {
      // The public URL has no authenticated tenant selector. Ambiguous slugs
      // therefore fail closed instead of choosing an arbitrary tenant row.
      res.status(409).json({ error: 'webhook path is ambiguous; assign a unique path' });
      return;
    }
    if (!eventAllowed(triggerEvidence.event_type, wf.trigger_config?.allowed_events)) {
      res.status(202).json({
        workflow_id: wf.id,
        workflow_name: wf.name,
        started: false,
        duplicate: false,
        ignored: true,
        reason: 'event type is not enabled for this workflow',
        event: triggerEvidence,
      });
      return;
    }
    const inputs = normalizeWorkflowWebhookInputs(req.body, triggerEvidence, wf.trigger_config);
    const r = await fireWorkflow(
      pool,
      wf.id,
      inputs,
      `webhook:${triggerEvidence.source}:${slug}`,
      toolRunnerFactory,
      runners,
      triggerEvidence,
      { production: true },
    );
    res.status(r?.duplicate ? 200 : 202).json({
      workflow_id: wf.id,
      workflow_name: wf.name,
      execution_id: r?.executionId,
      started: r != null && !r.duplicate && r.status === 'started',
      duplicate: r?.duplicate ?? false,
      status: r?.status,
      event: triggerEvidence,
    });
  });

  const localTestHandler: RequestHandler = async (req, res) => {
    const workflowId = Number(req.params['id']);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      res.status(400).json({ error: 'invalid workflow id' });
      return;
    }
    if (!(await webhookLimiter.isAllowed(`webhook-test:${workflowId}`))) {
      res.status(429).json({ error: 'rate limit exceeded for local webhook test', workflow_id: workflowId });
      return;
    }

    const user = getRbacUser(req);
    let scope;
    try {
      scope = resolveAuthorizedWorkspaceScope(req, (req as AuthenticatedRequest).user!);
    } catch (error) {
      if (error instanceof WorkspaceScopeAccessError) {
        res.status(404).json({ error: 'webhook workflow not found or not accessible' });
        return;
      }
      throw error;
    }
    let workflowSql = `SELECT id, name, trigger_config, maintenance_window, lifecycle_status,
                              tenant_key, workspace_key
       FROM mcp_workflows
       WHERE id = $1 AND tenant_key = $2 AND workspace_key = $3 AND enabled = true
         AND trigger_config @> '{"type":"webhook"}'::jsonb`;
    const workflowParams: unknown[] = [workflowId, scope.tenantKey, scope.workspaceKey];
    if (!isAdmin(user)) {
      // A local test can execute writes, so merely being able to view an
      // unassigned workflow is insufficient. Require an explicit Bundle grant.
      workflowSql += ` AND EXISTS (
        SELECT 1 FROM mcp_workflow_bundles wb
        WHERE wb.workflow_id = mcp_workflows.id
          AND wb.bundle_id = ANY($4::int[])
      )`;
      workflowParams.push(user.allowed_bundles ?? []);
    }
    const { rows } = await pool.query<WebhookWorkflow>(workflowSql, workflowParams);
    const workflow = rows[0];
    if (!workflow) {
      res.status(404).json({ error: 'webhook workflow not found or not accessible' });
      return;
    }
    if (!withinMaintenanceWindow(workflow.maintenance_window, new Date())) {
      res.status(409).json({ error: 'workflow is outside its maintenance window', workflow_id: workflow.id });
      return;
    }

    const requestBody = objectValue(req.body);
    const requestedProvider = boundedString(requestBody['provider'], 32);
    const provider = requestedProvider === 'generic' || requestedProvider === 'github'
      || requestedProvider === 'gitea' || requestedProvider === 'gitlab' || requestedProvider === 'auto'
      ? requestedProvider
      : workflow.trigger_config?.provider ?? 'github';
    const configuredProvider = workflow.trigger_config?.provider;
    const effectiveProvider = provider === 'auto' ? 'github' : provider;
    if (configuredProvider && configuredProvider !== 'auto' && configuredProvider !== 'generic'
        && effectiveProvider !== configuredProvider) {
      res.status(422).json({
        error: 'local test provider does not match workflow trigger configuration',
        expected: configuredProvider,
        received: effectiveProvider,
      });
      return;
    }
    const configuredEvent = workflow.trigger_config?.allowed_events?.[0];
    const event = boundedString(requestBody['event'], 128) ?? configuredEvent
      ?? (effectiveProvider === 'github' ? 'issues' : 'event');
    const delivery = buildLocalWebhookTestDelivery({
      provider: effectiveProvider,
      event,
      action: boundedString(requestBody['action'], 64),
      payload: requestBody['payload'],
      path: `/webhooks/wf${boundedString(workflow.trigger_config?.webhook_path, 256) ?? `/workflow-${workflow.id}`}`,
    });
    if (!eventAllowed(delivery.evidence.event_type, workflow.trigger_config?.allowed_events)) {
      res.status(422).json({
        error: 'local test event type is not enabled for this workflow',
        event_type: delivery.evidence.event_type,
        allowed_events: workflow.trigger_config?.allowed_events ?? [],
      });
      return;
    }

    const inputs = normalizeWorkflowWebhookInputs(delivery.payload, delivery.evidence, workflow.trigger_config);
    const result = await fireWorkflow(
      pool,
      workflow.id,
      inputs,
      `webhook-test:${delivery.evidence.source}`,
      toolRunnerFactory,
      runners,
      delivery.evidence,
      { production: false },
    );
    if (!result) {
      res.status(422).json({ error: 'workflow could not start; inspect its Agent contract and saved steps' });
      return;
    }
    res.status(202).json({
      workflow_id: workflow.id,
      workflow_name: workflow.name,
      execution_id: result.executionId,
      started: !result.duplicate,
      duplicate: result.duplicate,
      inputs,
      event: delivery.evidence,
    });
  };

  if (requireAuth) app.post('/api/workflows/:id/test-webhook', requireAuth, localTestHandler);
}
