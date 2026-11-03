import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { appendCanonicalAuditEvent } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventSummary,
  CanonicalAuditOutcome,
  CanonicalAuditRisk,
} from '../audit/canonicalAuditTypes.js';

export interface IncidentRemediationAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
}

export interface IncidentRemediationOperator {
  id: number | null;
  username: string;
  audit?: IncidentRemediationAuditContext;
}

export interface IncidentRemediationAuditEvent {
  eventKey: string;
  action: string;
  outcome: CanonicalAuditOutcome;
  risk: CanonicalAuditRisk;
  incidentId: number;
  remediationId: number;
  resourceType: 'aiops-remediation' | 'aiops-change-plan' | 'aiops-post-change-monitor';
  resourceId: string;
  resourceRevision?: string | null;
  planId?: number | null;
  monitorId?: number | null;
  planHash?: string | null;
  rollbackHash?: string | null;
  rootTraceId?: string | null;
  traceId?: string | null;
  policy?: { id: string; version?: string | null; decision?: string | null } | null;
  approvalId?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  context?: Record<string, unknown>;
  operator: IncidentRemediationOperator;
}

export type IncidentRemediationAuditWriter = (
  client: pg.PoolClient,
  event: IncidentRemediationAuditEvent,
) => Promise<CanonicalAuditEventSummary | void>;

function boundedProducerEventId(base: string, eventKey: string): string {
  const candidate = `${base}:${eventKey}`;
  if (candidate.length <= 256) return candidate;
  const digest = createHash('sha256').update(candidate).digest('hex');
  return `${base.slice(0, 180)}:${digest}`;
}

function actorFor(operator: IncidentRemediationOperator): CanonicalAuditActor {
  if (operator.audit) return operator.audit.actor;
  if (operator.id == null) {
    return {
      type: 'system',
      id: operator.username || 'argus.core',
      ssoSubject: null,
      authMethod: 'internal-scheduler',
      effectiveRoles: [],
    };
  }
  const usesSso = /^(?:entra|oidc):/.test(operator.username);
  return {
    type: 'human',
    id: String(operator.id),
    ssoSubject: usesSso ? operator.username : null,
    authMethod: usesSso ? 'oidc' : 'session',
    effectiveRoles: [],
  };
}

export function incidentRemediationCanonicalEvent(
  event: IncidentRemediationAuditEvent,
) {
  const baseProducerEventId = event.operator.audit?.producerEventId
    ?? `${event.resourceType}:${event.resourceId}:${event.resourceRevision ?? event.traceId ?? randomUUID()}`;
  return {
    producer: {
      name: 'aiops.remediation.lifecycle',
      eventId: boundedProducerEventId(baseProducerEventId, event.eventKey),
    },
    environment: event.operator.audit?.environment ?? process.env['NODE_ENV'] ?? 'development',
    solution: 'argus.aiops',
    actor: actorFor(event.operator),
    action: event.action,
    outcome: event.outcome,
    risk: event.risk,
    resource: {
      type: event.resourceType,
      id: event.resourceId,
      revision: event.resourceRevision ?? null,
    },
    policy: event.policy ?? null,
    approvalId: event.approvalId ?? null,
    correlation: {
      rootRunId: event.rootTraceId ?? null,
      traceId: event.traceId ?? event.rootTraceId ?? null,
      requestId: event.operator.audit?.requestId ?? null,
    },
    payload: {
      ...(event.before ? { before: event.before } : {}),
      ...(event.after ? { after: event.after } : {}),
      context: {
        incidentId: event.incidentId,
        remediationId: event.remediationId,
        planId: event.planId ?? null,
        monitorId: event.monitorId ?? null,
        planHash: event.planHash ?? null,
        rollbackHash: event.rollbackHash ?? null,
        ...(event.context ?? {}),
      },
    },
  } as const;
}

export async function appendIncidentRemediationAudit(
  client: pg.PoolClient,
  event: IncidentRemediationAuditEvent,
): Promise<CanonicalAuditEventSummary> {
  return appendCanonicalAuditEvent(client, incidentRemediationCanonicalEvent(event));
}

export const noOpIncidentRemediationAudit: IncidentRemediationAuditWriter = async () => undefined;

export const unconfiguredIncidentRemediationAudit: IncidentRemediationAuditWriter = async () => {
  throw new Error('incident remediation canonical audit writer is not configured');
};
