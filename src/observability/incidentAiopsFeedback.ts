import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type { CanonicalAuditActor, CanonicalAuditEventSummary } from '../audit/canonicalAuditTypes.js';
import { redact } from '../lib/redaction.js';
import {
  submitHumanFeedbackTransaction,
  type FeedbackSentiment,
  type TraceFeedbackRow,
} from './feedbackStore.js';

export const INCIDENT_AIOPS_FEEDBACK_VERDICTS = ['helpful', 'partial', 'incorrect'] as const;
export type IncidentAiopsFeedbackVerdict = typeof INCIDENT_AIOPS_FEEDBACK_VERDICTS[number];

export const INCIDENT_AIOPS_FEEDBACK_REASONS = [
  'accurate_root_cause',
  'useful_evidence',
  'incomplete_evidence',
  'missing_context',
  'incorrect_root_cause',
  'stale_evidence',
  'unsafe_recommendation',
  'other',
] as const;
export type IncidentAiopsFeedbackReason = typeof INCIDENT_AIOPS_FEEDBACK_REASONS[number];

export interface IncidentAiopsFeedbackReview {
  id: number;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string;
  verdict: IncidentAiopsFeedbackVerdict;
  reason: IncidentAiopsFeedbackReason;
  comment: string | null;
  reviewer: { id: number | null; name: string | null };
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  supersedesId: number | null;
  createdAt: string;
}

export interface IncidentAiopsFeedbackSummary {
  reviews: number;
  helpful: number;
  partial: number;
  incorrect: number;
  helpfulPercent: number | null;
  reviewedAt: string | null;
}

export interface IncidentAiopsFeedbackResponse {
  generatedAt: string;
  incidentId: number;
  taskLinkId: number;
  taskId: string;
  rootTraceId: string;
  serviceProfile: { id: number; revision: number; sha256: string } | null;
  currentUserFeedback: IncidentAiopsFeedbackReview | null;
  feedback: IncidentAiopsFeedbackReview[];
  summary: IncidentAiopsFeedbackSummary;
}

export interface IncidentAiopsFeedbackAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
}

export interface SubmitIncidentAiopsFeedbackInput {
  incidentId: number;
  taskLinkId: number;
  userId: number;
  allowedBundleIds: number[] | null;
  verdict: IncidentAiopsFeedbackVerdict;
  reason: IncidentAiopsFeedbackReason;
  comment?: string | null;
  audit: IncidentAiopsFeedbackAuditContext;
}

export interface SubmitIncidentAiopsFeedbackResult extends IncidentAiopsFeedbackResponse {
  submitted: IncidentAiopsFeedbackReview;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export class IncidentAiopsFeedbackError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IncidentAiopsFeedbackError';
  }
}

export interface IncidentAiopsFeedbackStore {
  list(
    incidentId: number,
    taskLinkId: number,
    principal: { userId: number; allowedBundleIds: number[] | null },
  ): Promise<IncidentAiopsFeedbackResponse>;
  submit(input: SubmitIncidentAiopsFeedbackInput): Promise<SubmitIncidentAiopsFeedbackResult>;
}

type TaskBindingRow = pg.QueryResultRow & {
  id: number | string;
  incident_id: number | string;
  task_id: string;
  root_trace_id: string | null;
  state: string;
  result_json: unknown;
  execution_service: string | null;
  execution_environment: string | null;
  execution_bundle_ids: Array<number | string> | null;
  service_profile_id: number | string | null;
  service_profile_revision: number | string | null;
  service_profile_sha256: string | null;
};

type FeedbackListRow = TraceFeedbackRow & { reviewer_name: string | null };

const verdictSet = new Set<string>(INCIDENT_AIOPS_FEEDBACK_VERDICTS);
const reasonSet = new Set<string>(INCIDENT_AIOPS_FEEDBACK_REASONS);

function feedbackLabel(taskLinkId: number): string {
  return `aiops.rca.${taskLinkId}`;
}

function iso(value: string | Date): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function serviceProfile(binding: TaskBindingRow): IncidentAiopsFeedbackReview['serviceProfile'] {
  if (binding.service_profile_id == null
    || binding.service_profile_revision == null
    || binding.service_profile_sha256 == null) return null;
  return {
    id: Number(binding.service_profile_id),
    revision: Number(binding.service_profile_revision),
    sha256: binding.service_profile_sha256,
  };
}

function verdictFrom(row: TraceFeedbackRow): IncidentAiopsFeedbackVerdict {
  const value = row.metadata?.['verdict'];
  if (typeof value === 'string' && verdictSet.has(value)) return value as IncidentAiopsFeedbackVerdict;
  const score = row.score == null ? 0 : Number(row.score);
  return score >= 0.75 ? 'helpful' : score >= 0.25 ? 'partial' : 'incorrect';
}

function reasonFrom(row: TraceFeedbackRow): IncidentAiopsFeedbackReason {
  const value = row.metadata?.['reason'];
  return typeof value === 'string' && reasonSet.has(value)
    ? value as IncidentAiopsFeedbackReason
    : 'other';
}

function mapReview(row: FeedbackListRow | TraceFeedbackRow, binding: TaskBindingRow): IncidentAiopsFeedbackReview {
  return {
    id: Number(row.id),
    incidentId: Number(binding.incident_id),
    taskLinkId: Number(binding.id),
    taskId: binding.task_id,
    rootTraceId: binding.root_trace_id!,
    verdict: verdictFrom(row),
    reason: reasonFrom(row),
    comment: row.comment,
    reviewer: {
      id: row.created_by_user_id == null ? null : Number(row.created_by_user_id),
      name: 'reviewer_name' in row ? row.reviewer_name : row.created_by_name,
    },
    serviceProfile: serviceProfile(binding),
    supersedesId: row.supersedes_id == null ? null : Number(row.supersedes_id),
    createdAt: iso(row.created_at),
  };
}

function summarize(reviews: IncidentAiopsFeedbackReview[]): IncidentAiopsFeedbackSummary {
  const helpful = reviews.filter(review => review.verdict === 'helpful').length;
  const partial = reviews.filter(review => review.verdict === 'partial').length;
  const incorrect = reviews.filter(review => review.verdict === 'incorrect').length;
  return {
    reviews: reviews.length,
    helpful,
    partial,
    incorrect,
    helpfulPercent: reviews.length ? Math.round((helpful / reviews.length) * 1_000) / 10 : null,
    reviewedAt: reviews[0]?.createdAt ?? null,
  };
}

async function loadBinding(
  queryable: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>,
  incidentId: number,
  taskLinkId: number,
  allowedBundleIds: number[] | null,
  lock = false,
): Promise<TaskBindingRow> {
  const result = await queryable.query<TaskBindingRow>(
    `SELECT id, incident_id, task_id, root_trace_id, state, result_json,
            execution_service, execution_environment, execution_bundle_ids,
            service_profile_id, service_profile_revision, service_profile_sha256
       FROM mcp_observability_incident_aiops_tasks
      WHERE id=$1 AND incident_id=$2
      ${lock ? 'FOR SHARE' : ''}`,
    [taskLinkId, incidentId],
  );
  const binding = result.rows[0];
  if (!binding) throw new IncidentAiopsFeedbackError(404, 'investigation_not_found', 'AIOps investigation was not found for this incident');
  if (!binding.root_trace_id || !binding.result_json || binding.state !== 'TASK_STATE_COMPLETED') {
    throw new IncidentAiopsFeedbackError(409, 'investigation_not_reviewable', 'A completed AIOps result with Root Trace evidence is required before review');
  }
  if (allowedBundleIds !== null) {
    const allowed = new Set(allowedBundleIds);
    const denied = (binding.execution_bundle_ids ?? []).map(Number).filter(bundleId => !allowed.has(bundleId));
    if (denied.length > 0) {
      throw new IncidentAiopsFeedbackError(403, 'feedback_forbidden', 'The reviewer is not authorized for this investigation evidence scope');
    }
  }
  return binding;
}

async function listRows(
  pool: pg.Pool,
  binding: TaskBindingRow,
): Promise<FeedbackListRow[]> {
  const result = await pool.query<FeedbackListRow>(
    `SELECT feedback.*,
            COALESCE(reviewer.display_name, reviewer.username) AS reviewer_name,
            COALESCE(reviewer.display_name, reviewer.username) AS created_by_name
       FROM mcp_observability_feedback feedback
       LEFT JOIN mcp_users reviewer ON reviewer.id=feedback.created_by_user_id
      WHERE feedback.trace_id=$1::uuid AND feedback.label=$2
        AND feedback.source='human' AND feedback.active
      ORDER BY feedback.created_at DESC, feedback.id DESC
      LIMIT 100`,
    [binding.root_trace_id, feedbackLabel(Number(binding.id))],
  );
  return result.rows;
}

function responseFor(
  binding: TaskBindingRow,
  rows: FeedbackListRow[],
  userId: number,
): IncidentAiopsFeedbackResponse {
  const feedback = rows.map(row => mapReview(row, binding));
  return {
    generatedAt: new Date().toISOString(),
    incidentId: Number(binding.incident_id),
    taskLinkId: Number(binding.id),
    taskId: binding.task_id,
    rootTraceId: binding.root_trace_id!,
    serviceProfile: serviceProfile(binding),
    currentUserFeedback: feedback.find(review => review.reviewer.id === userId) ?? null,
    feedback,
    summary: summarize(feedback),
  };
}

function feedbackScore(verdict: IncidentAiopsFeedbackVerdict): number {
  return verdict === 'helpful' ? 1 : verdict === 'partial' ? 0.5 : 0;
}

function feedbackSentiment(verdict: IncidentAiopsFeedbackVerdict): FeedbackSentiment {
  return verdict === 'helpful' ? 'positive' : verdict === 'partial' ? 'mixed' : 'negative';
}

export class PostgresIncidentAiopsFeedbackStore implements IncidentAiopsFeedbackStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(
    incidentId: number,
    taskLinkId: number,
    principal: { userId: number; allowedBundleIds: number[] | null },
  ): Promise<IncidentAiopsFeedbackResponse> {
    const binding = await loadBinding(this.pool, incidentId, taskLinkId, principal.allowedBundleIds);
    return responseFor(binding, await listRows(this.pool, binding), principal.userId);
  }

  async submit(input: SubmitIncidentAiopsFeedbackInput): Promise<SubmitIncidentAiopsFeedbackResult> {
    if (!verdictSet.has(input.verdict) || !reasonSet.has(input.reason)) {
      throw new IncidentAiopsFeedbackError(400, 'invalid_rca_feedback', 'A valid RCA verdict and reason are required');
    }
    const comment = input.comment == null ? null : redact(input.comment.trim(), { forceEnabled: true }).text.slice(0, 2_000) || null;
    const outcome = await executeCanonicalAuditedMutation(
      this.pool,
      { name: 'aiops.incident.rca.review', eventId: input.audit.producerEventId },
      { environment: input.audit.environment },
      async client => {
        const binding = await loadBinding(client, input.incidentId, input.taskLinkId, input.allowedBundleIds, true);
        const profile = serviceProfile(binding);
        const feedback = await submitHumanFeedbackTransaction(client, {
          traceId: binding.root_trace_id!,
          label: feedbackLabel(input.taskLinkId),
          score: feedbackScore(input.verdict),
          sentiment: feedbackSentiment(input.verdict),
          comment,
          tags: ['aiops', 'rca-review', input.verdict, input.reason],
          metadata: {
            schemaVersion: 1,
            kind: 'aiops_rca_review',
            incidentId: input.incidentId,
            taskLinkId: input.taskLinkId,
            taskId: binding.task_id,
            rootTraceId: binding.root_trace_id,
            service: binding.execution_service,
            environment: binding.execution_environment,
            serviceProfile: profile,
            verdict: input.verdict,
            reason: input.reason,
          },
          userId: input.userId,
        });
        return { binding, feedback };
      },
      result => ({
        environment: input.audit.environment,
        solution: 'argus.aiops',
        actor: input.audit.actor,
        action: 'aiops.incident.rca_review.submitted',
        outcome: 'success',
        risk: 'low',
        resource: {
          type: 'aiops_incident_rca_review',
          id: `${input.incidentId}:${input.taskLinkId}:${input.userId}`,
          revision: String(result.feedback.id),
        },
        correlation: {
          traceId: result.binding.root_trace_id,
          requestId: input.audit.requestId ?? input.audit.producerEventId,
        },
        payload: {
          before: { supersededFeedbackId: result.feedback.supersedes_id },
          after: {
            incidentId: input.incidentId,
            taskLinkId: input.taskLinkId,
            taskId: result.binding.task_id,
            serviceProfile: serviceProfile(result.binding),
            verdict: input.verdict,
            reason: input.reason,
            commentPresent: comment != null,
          },
        },
        retentionClass: 'business-audit-standard',
      }),
    );

    const current = await this.list(input.incidentId, input.taskLinkId, {
      userId: input.userId,
      allowedBundleIds: input.allowedBundleIds,
    });
    const submitted = outcome.result
      ? mapReview(outcome.result.feedback, outcome.result.binding)
      : current.currentUserFeedback;
    if (!submitted) throw new Error('canonical RCA feedback replay has no persisted review');
    return { ...current, submitted, auditEvent: outcome.event, replayed: outcome.replayed };
  }
}
