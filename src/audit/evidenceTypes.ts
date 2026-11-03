import type {
  CanonicalAuditActorType,
  CanonicalAuditOutcome,
  CanonicalAuditRisk,
} from './canonicalAuditTypes.js';
import type { TagRef } from '../tags/types.js';

export interface AuditEvidenceScope {
  workspaceKey: string;
  tenantKey: string;
}

export interface AuditEvidenceQuery {
  limit: number;
  cursor: string | null;
  actorId: string | null;
  actorType: CanonicalAuditActorType | null;
  resourceType: string | null;
  resourceId: string | null;
  tagId: string | null;
  action: string | null;
  outcome: CanonicalAuditOutcome | null;
  risk: CanonicalAuditRisk | null;
  policyId: string | null;
  rootRunId: string | null;
  traceId: string | null;
  environment: string | null;
  from: string | null;
  to: string | null;
}

export interface AuditEvidenceCursor {
  occurredAt: string;
  eventId: string;
}

export type AuditEvidenceTagSource = 'event_payload' | 'current_live_fallback' | 'not_captured';
export type AuditEvidenceHashState = 'event_hash_valid' | 'event_hash_invalid';

export interface AuditEvidenceItem {
  id: string;
  occurredAt: string;
  receivedAt: string;
  environment: string;
  workspaceKey: string;
  tenantKey: string;
  solution: string | null;
  producer: { name: string; eventId: string };
  actor: {
    type: CanonicalAuditActorType;
    id: string;
    ssoSubject: string | null;
    authMethod: string;
    effectiveRoles: string[];
  };
  action: string;
  outcome: CanonicalAuditOutcome;
  risk: CanonicalAuditRisk;
  policy: { id: string | null; version: string | null; decision: string | null };
  approval: { id: string | null; href: string | null };
  resource: {
    type: string;
    id: string;
    label: string;
    labelSource: 'event_payload' | 'resource_id';
    href: string | null;
    version: string | null;
    tags: TagRef[];
    tagSource: AuditEvidenceTagSource;
  };
  correlation: {
    rootRunId: string | null;
    traceId: string | null;
    spanId: string | null;
    requestId: string | null;
    rootRunHref: string | null;
    logsHref: string | null;
  };
  digests: {
    payload: string;
    before: string | null;
    after: string | null;
    redactionProfile: string;
  };
  integrity: {
    sequence: number;
    previousHash: string;
    hash: string;
    hashState: AuditEvidenceHashState;
    signingKeyId: string | null;
    checkpointId: string | null;
  };
  retention: { class: string; until: string | null; legalHold: boolean };
  summary: string;
}

export interface AuditEvidenceGap {
  code: 'legacy_sources_not_canonical' | 'unsigned_checkpoint' | 'checkpoint_invalid' | 'resource_tags_live_fallback';
  description: string;
}

export interface AuditEvidencePage {
  schemaVersion: 1;
  generatedAt: string;
  verification: {
    state: 'event_hashes_valid' | 'event_hashes_and_checkpoint_valid' | 'integrity_failure' | 'not_applicable';
    chainContinuity: 'not_evaluated_for_filtered_page';
    checkpointId: string | null;
    checkedAt: string;
  };
  coverage: {
    canonicalProducerFamilies: [
      'tags',
      'access.user_lifecycle',
      'access.api_key_lifecycle',
      'access.policy_management',
      'access.sso_identity',
      'approval.runtime',
      'approval.workflow',
      'risk_policy.external_filter',
    ];
    legacyGaps: AuditEvidenceGap[];
  };
  items: AuditEvidenceItem[];
  nextCursor: string | null;
  export: {
    allowed: boolean;
    state: 'available' | 'not_authorized';
    formats: ['json', 'jsonl', 'csv'] | [];
    requiresStepUp: boolean;
  };
}
