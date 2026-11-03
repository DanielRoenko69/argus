export type CanonicalAuditActorType = 'human' | 'service' | 'system';
export type CanonicalAuditOutcome = 'success' | 'failure' | 'denied' | 'cancelled';
export type CanonicalAuditRisk = 'low' | 'medium' | 'high' | 'critical';

export interface CanonicalAuditProducer {
  name: string;
  eventId: string;
}

export interface CanonicalAuditScope {
  environment: string;
  workspaceKey?: string;
  tenantKey?: string;
}

export interface CanonicalAuditActor {
  type: CanonicalAuditActorType;
  id: string;
  ssoSubject?: string | null;
  authMethod: string;
  effectiveRoles: string[];
}

export interface CanonicalAuditResource {
  type: string;
  id: string;
  revision?: string | null;
}

export interface CanonicalAuditPolicy {
  id?: string | null;
  version?: string | null;
  decision?: string | null;
}

export interface CanonicalAuditCorrelation {
  rootRunId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
  requestId?: string | null;
}

export interface CanonicalAuditPayload {
  before?: unknown;
  after?: unknown;
  context?: unknown;
}

export interface CanonicalAuditEventInput {
  producer: CanonicalAuditProducer;
  occurredAt?: string | Date;
  environment: string;
  workspaceKey?: string;
  tenantKey?: string;
  solution?: string | null;
  actor: CanonicalAuditActor;
  action: string;
  outcome: CanonicalAuditOutcome;
  risk: CanonicalAuditRisk;
  resource: CanonicalAuditResource;
  policy?: CanonicalAuditPolicy | null;
  approvalId?: string | null;
  correlation?: CanonicalAuditCorrelation | null;
  payload?: CanonicalAuditPayload | null;
  retentionClass?: string;
  retentionUntil?: string | Date | null;
  legalHold?: boolean;
  signingKeyId?: string | null;
}

export interface CanonicalAuditEventSummary {
  eventId: string;
  schemaVersion: 1;
  sequence: number;
  occurredAt: string;
  receivedAt: string;
  environment: string;
  workspaceKey: string;
  tenantKey: string;
  solution: string | null;
  producer: CanonicalAuditProducer;
  actor: CanonicalAuditActor;
  action: string;
  outcome: CanonicalAuditOutcome;
  risk: CanonicalAuditRisk;
  resource: Required<CanonicalAuditResource>;
  policy: Required<CanonicalAuditPolicy>;
  approvalId: string | null;
  correlation: Required<CanonicalAuditCorrelation>;
  payloadSummary: Record<string, unknown>;
  payloadDigest: string;
  beforeDigest: string | null;
  afterDigest: string | null;
  redactionProfile: string;
  retentionClass: string;
  retentionUntil: string | null;
  legalHold: boolean;
  previousHash: string;
  eventHash: string;
  signingKeyId: string | null;
  replayed: boolean;
}

export interface CanonicalAuditOutboxDelivery {
  id: string;
  eventId: string;
  topic: string;
  attemptCount: number;
  event: CanonicalAuditEventSummary;
}

export interface CanonicalAuditMutationResult<T> {
  event: CanonicalAuditEventSummary;
  replayed: boolean;
  result: T | null;
}
