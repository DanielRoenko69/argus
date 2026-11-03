import type pg from 'pg';
import {
  loadLatestCanonicalAuditCheckpointEnvelope,
  verifyAuditCheckpointSignature,
  type AuditCheckpointEnvelope,
  type AuditCheckpointScope,
} from './checkpoints.js';
import { verifyCanonicalAuditEventHash } from './canonicalAuditStore.js';
import type { CanonicalAuditEventSummary } from './canonicalAuditTypes.js';
import {
  type AuditEvidenceGap,
  type AuditEvidenceItem,
  type AuditEvidencePage,
  type AuditEvidenceQuery,
  type AuditEvidenceScope,
} from './evidenceTypes.js';
import { decodeAuditEvidenceCursor, encodeAuditEvidenceCursor } from './evidenceValidation.js';
import type { TagRef } from '../tags/types.js';

interface AuditEvidenceRow {
  event_id: string;
  schema_version: number | string;
  sequence: number | string;
  occurred_at: string | Date;
  received_at: string | Date;
  environment: string;
  workspace_key: string;
  tenant_key: string;
  solution: string | null;
  producer_name: string;
  producer_event_id: string;
  actor_type: 'human' | 'service' | 'system';
  actor_id: string;
  actor_sso_subject: string | null;
  actor_auth_method: string;
  actor_roles: string[] | null;
  action: string;
  outcome: 'success' | 'failure' | 'denied' | 'cancelled';
  risk_level: 'low' | 'medium' | 'high' | 'critical';
  resource_type: string;
  resource_id: string;
  resource_revision: string | null;
  policy_id: string | null;
  policy_version: string | null;
  policy_decision: string | null;
  approval_id: string | null;
  root_run_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  request_id: string | null;
  payload_summary: Record<string, unknown> | string | null;
  payload_digest: string;
  before_digest: string | null;
  after_digest: string | null;
  redaction_profile: string;
  retention_class: string;
  retention_until: string | Date | null;
  legal_hold: boolean;
  previous_hash: string;
  event_hash: string;
  signing_key_id: string | null;
  effective_retention_until: string | Date | null;
  effective_legal_hold: boolean;
  resource_tags: unknown;
}

export interface AuditEvidencePageOptions {
  canExport: boolean;
  hasFreshMfa?: boolean;
  now?: Date;
  loadCheckpoint?: (pool: pg.Pool, scope: AuditCheckpointScope) => Promise<AuditCheckpointEnvelope | null>;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function optionalIso(value: string | Date | null): string | null {
  return value == null ? null : iso(value);
}

function payloadObject(value: AuditEvidenceRow['payload_summary']): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

function tagRefs(value: unknown): TagRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.slice(0, 50).flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    const id = typeof row['id'] === 'string' || typeof row['id'] === 'number' ? String(row['id']) : '';
    const label = boundedText(row['label'], 128) ?? '';
    if (!/^[1-9]\d{0,18}$/.test(id) || !label || seen.has(id)) return [];
    seen.add(id);
    const color = typeof row['color'] === 'string' && /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(row['color'])
      ? row['color'].toLowerCase()
      : null;
    return [{ id, label, color }];
  });
}

function capturedTags(payload: Record<string, unknown>): { present: boolean; tags: TagRef[] } {
  const after = payload['after'];
  if (!after || typeof after !== 'object' || Array.isArray(after)) return { present: false, tags: [] };
  if (!Object.prototype.hasOwnProperty.call(after, 'tags')) return { present: false, tags: [] };
  return { present: true, tags: tagRefs((after as Record<string, unknown>)['tags']) };
}

function capturedLabel(payload: Record<string, unknown>): string | null {
  for (const key of ['after', 'before']) {
    const candidate = payload[key];
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const label = boundedText((candidate as Record<string, unknown>)['label'], 256);
    if (label) return label;
  }
  return null;
}

function resourceHref(type: string, id: string): string | null {
  const encoded = encodeURIComponent(id);
  switch (type) {
    case 'agent': return `/build/agents/manage?agent=${encoded}`;
    case 'workflow': return `/build/workflows/studio/${encoded}`;
    case 'knowledge_source':
    case 'repository_snapshot': return '/build/knowledge';
    case 'skill': return '/build/skills';
    case 'public_widget': return '/build/public-widgets';
    case 'mcp_connection': return '/mcp-fabric';
    case 'mcp_bundle': return `/mcp-fabric/bundles/${encoded}`;
    case 'mcp_tool':
    case 'mcp_capability': return '/mcp-fabric/capabilities';
    case 'user': return `/settings/users?user=${encoded}`;
    case 'user_access_policy': return `/governance/policies?tab=users&user=${encoded}`;
    case 'group_access_policy': return `/governance/policies?tab=groups&group=${encoded}`;
    case 'user_tool_rule':
    case 'group_tool_rule': return '/governance/policies';
    default: return null;
  }
}

function canonicalSummary(row: AuditEvidenceRow, payload: Record<string, unknown>): CanonicalAuditEventSummary {
  if (Number(row.schema_version) !== 1) throw new Error('audit evidence schema version is unsupported');
  const sequence = Number(row.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('audit evidence sequence is invalid');
  return {
    eventId: row.event_id,
    schemaVersion: 1,
    sequence,
    occurredAt: iso(row.occurred_at),
    receivedAt: iso(row.received_at),
    environment: row.environment,
    workspaceKey: row.workspace_key,
    tenantKey: row.tenant_key,
    solution: row.solution,
    producer: { name: row.producer_name, eventId: row.producer_event_id },
    actor: {
      type: row.actor_type,
      id: row.actor_id,
      ssoSubject: row.actor_sso_subject,
      authMethod: row.actor_auth_method,
      effectiveRoles: row.actor_roles ?? [],
    },
    action: row.action,
    outcome: row.outcome,
    risk: row.risk_level,
    resource: { type: row.resource_type, id: row.resource_id, revision: row.resource_revision },
    policy: { id: row.policy_id, version: row.policy_version, decision: row.policy_decision },
    approvalId: row.approval_id,
    correlation: {
      rootRunId: row.root_run_id,
      traceId: row.trace_id,
      spanId: row.span_id,
      requestId: row.request_id,
    },
    payloadSummary: payload,
    payloadDigest: row.payload_digest,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    redactionProfile: row.redaction_profile,
    retentionClass: row.retention_class,
    retentionUntil: optionalIso(row.retention_until),
    legalHold: row.legal_hold,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
    signingKeyId: row.signing_key_id,
    replayed: false,
  };
}

function mapEvidenceItem(row: AuditEvidenceRow): AuditEvidenceItem {
  const payload = payloadObject(row.payload_summary);
  const event = canonicalSummary(row, payload);
  const immutableTags = capturedTags(payload);
  const liveTags = tagRefs(row.resource_tags);
  const tags = immutableTags.present ? immutableTags.tags : liveTags;
  const tagSource = immutableTags.present
    ? 'event_payload' as const
    : liveTags.length > 0 ? 'current_live_fallback' as const : 'not_captured' as const;
  const label = capturedLabel(payload);
  const traceKey = event.correlation.rootRunId ?? event.correlation.traceId;
  return {
    id: event.eventId,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    environment: event.environment,
    workspaceKey: event.workspaceKey,
    tenantKey: event.tenantKey,
    solution: event.solution,
    producer: event.producer,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      ssoSubject: event.actor.ssoSubject ?? null,
      authMethod: event.actor.authMethod,
      effectiveRoles: event.actor.effectiveRoles,
    },
    action: event.action,
    outcome: event.outcome,
    risk: event.risk,
    policy: event.policy,
    approval: {
      id: event.approvalId,
      href: event.approvalId ? `/governance?approval=${encodeURIComponent(event.approvalId)}` : null,
    },
    resource: {
      type: event.resource.type,
      id: event.resource.id,
      label: label ?? event.resource.id,
      labelSource: label ? 'event_payload' : 'resource_id',
      href: resourceHref(event.resource.type, event.resource.id),
      version: event.resource.revision ?? null,
      tags,
      tagSource,
    },
    correlation: {
      rootRunId: event.correlation.rootRunId,
      traceId: event.correlation.traceId,
      spanId: event.correlation.spanId,
      requestId: event.correlation.requestId,
      rootRunHref: traceKey ? `/runs?root_trace=${encodeURIComponent(traceKey)}` : null,
      logsHref: traceKey ? `/observe/logs?root_trace=${encodeURIComponent(traceKey)}` : null,
    },
    digests: {
      payload: event.payloadDigest,
      before: event.beforeDigest,
      after: event.afterDigest,
      redactionProfile: event.redactionProfile,
    },
    integrity: {
      sequence: event.sequence,
      previousHash: event.previousHash,
      hash: event.eventHash,
      hashState: verifyCanonicalAuditEventHash(event) ? 'event_hash_valid' : 'event_hash_invalid',
      signingKeyId: event.signingKeyId,
      checkpointId: null,
    },
    retention: {
      class: event.retentionClass,
      until: optionalIso(row.effective_retention_until),
      legalHold: row.effective_legal_hold,
    },
    summary: `${event.action} → ${event.outcome} · ${event.resource.type} ${label ?? event.resource.id}`,
  };
}

function addFilter(where: string[], params: unknown[], expression: string, value: unknown): void {
  if (value == null) return;
  params.push(value);
  where.push(expression.replace('?', `$${params.length}`));
}

function querySql(query: AuditEvidenceQuery, scopes: AuditEvidenceScope[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [scopes.map(scope => scope.workspaceKey), scopes.map(scope => scope.tenantKey)];
  const where = [
    `EXISTS (
       SELECT 1 FROM unnest($1::text[], $2::text[]) AS allowed(workspace_key, tenant_key)
        WHERE allowed.workspace_key=event.workspace_key AND allowed.tenant_key=event.tenant_key
     )`,
  ];
  addFilter(where, params, 'event.actor_id=?', query.actorId);
  addFilter(where, params, 'event.actor_type=?', query.actorType);
  addFilter(where, params, 'event.resource_type=?', query.resourceType);
  addFilter(where, params, 'event.resource_id=?', query.resourceId);
  addFilter(where, params, 'event.action=?', query.action);
  addFilter(where, params, 'event.outcome=?', query.outcome);
  addFilter(where, params, 'event.risk_level=?', query.risk);
  addFilter(where, params, 'event.policy_id=?', query.policyId);
  addFilter(where, params, 'event.root_run_id=?', query.rootRunId);
  addFilter(where, params, 'event.trace_id=?', query.traceId);
  addFilter(where, params, 'event.environment=?', query.environment);
  addFilter(where, params, 'event.occurred_at>=?::timestamptz', query.from);
  addFilter(where, params, 'event.occurred_at<=?::timestamptz', query.to);
  if (query.tagId) {
    params.push(query.tagId);
    const position = params.length;
    where.push(`(
      (event.resource_type='workspace_tag' AND event.resource_id=$${position})
      OR EXISTS (
        SELECT 1 FROM mcp_resource_tag_assignments tagged
         WHERE tagged.workspace_key=event.workspace_key
           AND tagged.resource_type=event.resource_type
           AND tagged.resource_id=event.resource_id
           AND tagged.tag_id::text=$${position}
      )
      OR COALESCE(event.payload_summary #> '{after,tags}', '[]'::jsonb)
           @> jsonb_build_array(jsonb_build_object('id', $${position}::text))
    )`);
  }
  if (query.cursor) {
    const cursor = decodeAuditEvidenceCursor(query.cursor);
    params.push(cursor.occurredAt, cursor.eventId);
    where.push(`(event.occurred_at, event.event_id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(query.limit + 1);
  return {
    sql: `SELECT event.*,
            COALESCE(
              event.retention_until,
              CASE WHEN retention_policy.duration_days IS NULL THEN NULL
                   ELSE event.occurred_at + (retention_policy.duration_days * interval '1 day') END
            ) AS effective_retention_until,
            (event.legal_hold OR EXISTS (
              SELECT 1
                FROM mcp_canonical_audit_legal_hold_actions placed
               WHERE placed.workspace_key=event.workspace_key
                 AND placed.tenant_key=event.tenant_key
                 AND placed.environment=event.environment
                 AND placed.action='placed'
                 AND event.sequence>=placed.from_sequence
                 AND (placed.through_sequence IS NULL OR event.sequence<=placed.through_sequence)
                 AND (placed.resource_type IS NULL OR
                      (placed.resource_type=event.resource_type AND placed.resource_id=event.resource_id))
                 AND NOT EXISTS (
                   SELECT 1 FROM mcp_canonical_audit_legal_hold_actions released
                    WHERE released.hold_id=placed.hold_id AND released.action='released'
                 )
            )) AS effective_legal_hold,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('id', tag.id::text, 'label', tag.label, 'color', tag.color)
                               ORDER BY lower(tag.label), tag.id)
                FROM mcp_resource_tag_assignments assignment
                JOIN mcp_workspace_tags tag
                  ON tag.workspace_key=assignment.workspace_key AND tag.id=assignment.tag_id
               WHERE assignment.workspace_key=event.workspace_key
                 AND assignment.resource_type=event.resource_type
                 AND assignment.resource_id=event.resource_id
            ), '[]'::jsonb) AS resource_tags
       FROM mcp_canonical_audit_events event
       LEFT JOIN LATERAL (
         SELECT policy.duration_days
           FROM mcp_canonical_audit_retention_policies policy
          WHERE policy.workspace_key=event.workspace_key
            AND policy.tenant_key=event.tenant_key
            AND policy.environment=event.environment
            AND policy.retention_class=event.retention_class
            AND policy.effective_from<=event.occurred_at
          ORDER BY policy.effective_from DESC, policy.version DESC
          LIMIT 1
       ) retention_policy ON true
      WHERE ${where.join('\n        AND ')}
      ORDER BY event.occurred_at DESC, event.event_id DESC
      LIMIT $${params.length}`,
    params,
  };
}

export async function loadAuditEvidencePage(
  pool: pg.Pool,
  scopes: AuditEvidenceScope[],
  query: AuditEvidenceQuery,
  options: AuditEvidencePageOptions,
): Promise<AuditEvidencePage> {
  if (scopes.length < 1 || scopes.length > 100) throw new Error('audit evidence scope is unavailable');
  const uniqueScopes = [...new Map(scopes.map(scope => [`${scope.workspaceKey}\u0000${scope.tenantKey}`, scope])).values()];
  const statement = querySql(query, uniqueScopes);
  const result = await pool.query<AuditEvidenceRow>(statement.sql, statement.params);
  const hasNext = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  let items = rows.map(mapEvidenceItem);
  const generatedAt = (options.now ?? new Date()).toISOString();
  const gaps: AuditEvidenceGap[] = [
    {
      code: 'legacy_sources_not_canonical',
      description: 'Only migrated producer families are canonical; older and unmigrated audit sources are not represented as complete history.',
    },
  ];
  let checkpointId: string | null = null;
  let checkpointValid = false;
  let checkpointInvalid = false;
  const evidenceScopes = new Map<string, AuditCheckpointScope>();
  for (const item of items) {
    const scope = { workspaceKey: item.workspaceKey, tenantKey: item.tenantKey, environment: item.environment };
    evidenceScopes.set(`${scope.workspaceKey}\u0000${scope.tenantKey}\u0000${scope.environment}`, scope);
  }
  if (items.length > 0 && evidenceScopes.size === 1) {
    const scope = [...evidenceScopes.values()][0]!;
    const envelope = await (options.loadCheckpoint ?? loadLatestCanonicalAuditCheckpointEnvelope)(pool, scope);
    if (envelope) {
      const maxSequence = Math.max(...items.map(item => item.integrity.sequence));
      checkpointValid = envelope.checkpoint.lastSequence >= maxSequence
        && verifyAuditCheckpointSignature(envelope.checkpoint, envelope.publicKeyPem);
      checkpointInvalid = !checkpointValid;
      if (checkpointValid) {
        checkpointId = envelope.checkpoint.checkpointId;
        items = items.map(item => ({
          ...item,
          integrity: { ...item.integrity, checkpointId },
        }));
      }
    }
  }
  if (!checkpointValid) {
    gaps.push({
      code: checkpointInvalid ? 'checkpoint_invalid' : 'unsigned_checkpoint',
      description: checkpointInvalid
        ? 'A checkpoint covers this page, but its signature or signed chain position is invalid.'
        : 'No valid signed checkpoint covers the canonical events on this page; filtered-page chain continuity is not asserted.',
    });
  }
  if (items.some(item => item.resource.tagSource === 'current_live_fallback')) {
    gaps.push({
      code: 'resource_tags_live_fallback',
      description: 'At least one resource tag list reflects current workspace state rather than an immutable event-time snapshot.',
    });
  }
  const last = rows.at(-1);
  return {
    schemaVersion: 1,
    generatedAt,
    verification: {
      state: items.length === 0
        ? 'not_applicable'
        : items.every(item => item.integrity.hashState === 'event_hash_valid') && !checkpointInvalid
          ? checkpointValid ? 'event_hashes_and_checkpoint_valid' : 'event_hashes_valid'
          : 'integrity_failure',
      chainContinuity: 'not_evaluated_for_filtered_page',
      checkpointId,
      checkedAt: generatedAt,
    },
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
      ],
      legacyGaps: gaps,
    },
    items,
    nextCursor: hasNext && last
      ? encodeAuditEvidenceCursor({ occurredAt: iso(last.occurred_at), eventId: last.event_id })
      : null,
    export: {
      allowed: options.canExport,
      state: options.canExport ? 'available' : 'not_authorized',
      formats: options.canExport ? ['json', 'jsonl', 'csv'] : [],
      requiresStepUp: options.canExport && options.hasFreshMfa !== true,
    },
  };
}
