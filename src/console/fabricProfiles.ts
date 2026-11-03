import { createHash } from 'node:crypto';
import pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventInput,
  CanonicalAuditEventSummary,
  CanonicalAuditScope,
} from '../audit/canonicalAuditTypes.js';

export const FABRIC_PROFILE_API_VERSION = 'fabric.argus.dev/v1alpha1';
export const FABRIC_PROFILE_KIND = 'FabricProfile';

type Queryable = pg.Pool | pg.PoolClient;

export interface FabricProfileConnector {
  slot: string;
  backendName: string;
  backendType: 'mcp' | 'http' | 'builtin';
}

export interface FabricProfileBundleConnector {
  slot: string;
  toolPolicy: {
    mode: 'all' | 'selected';
    allowedToolNames: string[];
  };
}

export interface FabricProfileBundle {
  name: string;
  label: string;
  description: string;
  icon: string;
  systemPrompt: string | null;
  agentRole: string | null;
  connectors: FabricProfileBundleConnector[];
  skills: string[];
  directTools: string[];
}

export interface FabricProfileManifest {
  apiVersion: typeof FABRIC_PROFILE_API_VERSION;
  kind: typeof FABRIC_PROFILE_KIND;
  metadata: {
    name: string;
    label: string;
    description: string;
    version: string;
  };
  spec: {
    connectors: FabricProfileConnector[];
    bundles: FabricProfileBundle[];
    access: null | {
      compositeName: string;
      description: string;
      toolAllowPatterns: string[];
      toolDenyPatterns: string[];
      groupBindings: Array<{
        logicalName: string;
        required: boolean;
      }>;
    };
  };
}

export interface FabricProfileSsoGroup {
  name: string;
  memberCount: number;
}

export interface FabricProfileMappings {
  backends?: Record<string, string>;
  skills?: Record<string, string>;
  groups?: Record<string, string>;
}

export interface FabricProfileRecord {
  id: number;
  name: string;
  label: string;
  description: string;
  manifestVersion: string;
  revision: number;
  manifest: FabricProfileManifest;
  manifestDigest: string;
  source: 'local' | 'imported';
  installedBundleIds: number[];
  appliedMappings: FabricProfileMappings;
  createdBy: string | null;
  updatedBy: string | null;
  lastAppliedAt: string | null;
  drift?: FabricProfileDriftSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface FabricProfileVersionRecord {
  id: number;
  profileId: number;
  revision: number;
  manifestVersion: string;
  manifest: FabricProfileManifest;
  manifestDigest: string;
  source: 'local' | 'imported';
  installedBundleIds: number[];
  appliedMappings: FabricProfileMappings;
  changeKind: 'created' | 'exported' | 'applied';
  applied: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface FabricProfileVersionDiffChange {
  kind: 'added' | 'removed' | 'changed';
  scope: 'metadata' | 'connector' | 'bundle' | 'access';
  resource: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface FabricProfileVersionDiff {
  profileId: number;
  from: Pick<FabricProfileVersionRecord, 'revision' | 'manifestVersion' | 'manifestDigest' | 'createdAt'>;
  to: Pick<FabricProfileVersionRecord, 'revision' | 'manifestVersion' | 'manifestDigest' | 'createdAt'>;
  counts: { total: number; added: number; removed: number; changed: number };
  changes: FabricProfileVersionDiffChange[];
  truncated: boolean;
}

export interface FabricProfileRestoreRequest {
  id: string;
  profileId: number;
  profileLabel: string;
  targetRevision: number;
  targetManifestDigest: string;
  requestedFromRevision: number;
  requestedFromManifestDigest: string;
  mappings: FabricProfileMappings;
  planToken: string;
  planSnapshot: Pick<FabricProfilePlan, 'actions' | 'blockers'>;
  status: 'pending' | 'approved' | 'rejected' | 'applied' | 'stale';
  requestedBy: number | null;
  requestedByUsername: string;
  requestComment: string;
  decidedBy: number | null;
  decidedByUsername: string | null;
  decisionComment: string | null;
  requestedAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

export type FabricProfileDriftCode =
  | 'bundle_missing'
  | 'bundle_metadata_changed'
  | 'backend_assignment_changed'
  | 'tool_policy_changed'
  | 'skill_assignment_changed'
  | 'direct_tool_assignment_changed'
  | 'composite_missing'
  | 'composite_changed'
  | 'group_binding_missing'
  | 'group_binding_changed';

export interface FabricProfileDriftFinding {
  code: FabricProfileDriftCode;
  severity: 'warning' | 'critical';
  resourceType: 'bundle' | 'connector' | 'skill' | 'tool' | 'composite' | 'sso_group';
  resource: string;
  message: string;
  expected: unknown;
  actual: unknown;
}

export interface FabricProfileDrift {
  status: 'in_sync' | 'drifted' | 'not_applied';
  checkedAt: string;
  profileId: number;
  profileRevision: number;
  manifestDigest: string;
  counts: { total: number; critical: number; warning: number };
  findings: FabricProfileDriftFinding[];
}

export type FabricProfileDriftFindingSummary = Pick<
  FabricProfileDriftFinding,
  'code' | 'severity' | 'resourceType' | 'resource' | 'message'
>;

export interface FabricProfileDriftSnapshot extends Omit<FabricProfileDrift, 'findings'> {
  findings: FabricProfileDriftFindingSummary[];
  findingDigest: string;
  source: 'manual' | 'scheduled';
  transitionSequence: number;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  changedAt: string;
  notifiedAt: string | null;
}

export interface FabricProfileDriftPersistenceResult {
  snapshot: FabricProfileDriftSnapshot;
  transitioned: boolean;
  previousStatus: FabricProfileDriftSnapshot['status'] | null;
  previousFindingDigest: string | null;
}

export interface FabricProfileAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
  traceId?: string | null;
  spanId?: string | null;
}

export interface FabricProfilePlan {
  manifest: FabricProfileManifest;
  manifestDigest: string;
  planToken: string;
  actions: Array<{
    kind: 'bundle' | 'composite' | 'group';
    target: string;
    operation: 'create' | 'update' | 'bind';
    detail: string;
  }>;
  blockers: Array<{
    code: 'missing_backend' | 'missing_skill' | 'missing_tool' | 'missing_group';
    resource: string;
    message: string;
  }>;
  resolved: {
    backends: Record<string, { id: number; name: string }>;
    skills: Record<string, { id: number; name: string }>;
    directTools: Record<string, { id: number; name: string }>;
    groups: Record<string, FabricProfileSsoGroup>;
  };
}

interface FabricProfileDbRow {
  id: string | number;
  name: string;
  label: string;
  description: string;
  manifest_version: string;
  revision: number;
  manifest: FabricProfileManifest;
  manifest_digest: string;
  source: 'local' | 'imported';
  installed_bundle_ids: number[];
  applied_mappings?: FabricProfileMappings;
  created_by: string | null;
  updated_by: string | null;
  last_applied_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  drift_profile_revision?: number | string | null;
  drift_manifest_digest?: string | null;
  drift_status?: FabricProfileDriftSnapshot['status'] | null;
  drift_finding_count?: number | string | null;
  drift_critical_count?: number | string | null;
  drift_warning_count?: number | string | null;
  drift_findings?: FabricProfileDriftFindingSummary[] | null;
  drift_finding_digest?: string | null;
  drift_check_source?: FabricProfileDriftSnapshot['source'] | null;
  drift_transition_sequence?: number | string | null;
  drift_consecutive_failures?: number | string | null;
  drift_last_error_code?: string | null;
  drift_last_error_at?: string | Date | null;
  drift_checked_at?: string | Date | null;
  drift_changed_at?: string | Date | null;
  drift_notified_at?: string | Date | null;
}

interface FabricProfileDriftDbRow {
  profile_id: number | string;
  profile_revision: number | string;
  manifest_digest: string;
  status: FabricProfileDriftSnapshot['status'];
  finding_count: number | string;
  critical_count: number | string;
  warning_count: number | string;
  findings: FabricProfileDriftFindingSummary[];
  finding_digest: string;
  check_source: FabricProfileDriftSnapshot['source'];
  transition_sequence: number | string;
  consecutive_failures: number | string;
  last_error_code: string | null;
  last_error_at: string | Date | null;
  checked_at: string | Date;
  changed_at: string | Date;
  notified_at: string | Date | null;
}

interface FabricProfileVersionDbRow {
  id: string | number;
  profile_id: string | number;
  revision: number;
  manifest_version: string;
  manifest: FabricProfileManifest;
  manifest_digest: string;
  source: 'local' | 'imported';
  installed_bundle_ids: number[];
  applied_mappings: FabricProfileMappings;
  change_kind: FabricProfileVersionRecord['changeKind'];
  applied: boolean;
  created_by: string | null;
  created_at: string | Date;
}

interface FabricProfileRestoreDbRow {
  id: string;
  profile_id: number | string;
  profile_label: string;
  target_revision: number;
  target_manifest_digest: string;
  requested_from_revision: number;
  requested_from_manifest_digest: string;
  mappings: FabricProfileMappings;
  plan_token: string;
  plan_snapshot: Pick<FabricProfilePlan, 'actions' | 'blockers'>;
  status: FabricProfileRestoreRequest['status'];
  requested_by: number | string | null;
  requested_by_username: string;
  request_comment: string;
  decided_by: number | string | null;
  decided_by_username: string | null;
  decision_comment: string | null;
  requested_at: string | Date;
  decided_at: string | Date | null;
  applied_at: string | Date | null;
}

function mapRestoreRequest(row: FabricProfileRestoreDbRow): FabricProfileRestoreRequest {
  return {
    id: row.id,
    profileId: Number(row.profile_id),
    profileLabel: row.profile_label,
    targetRevision: Number(row.target_revision),
    targetManifestDigest: row.target_manifest_digest,
    requestedFromRevision: Number(row.requested_from_revision),
    requestedFromManifestDigest: row.requested_from_manifest_digest,
    mappings: row.mappings ?? {},
    planToken: row.plan_token,
    planSnapshot: row.plan_snapshot,
    status: row.status,
    requestedBy: row.requested_by == null ? null : Number(row.requested_by),
    requestedByUsername: row.requested_by_username,
    requestComment: row.request_comment,
    decidedBy: row.decided_by == null ? null : Number(row.decided_by),
    decidedByUsername: row.decided_by_username,
    decisionComment: row.decision_comment,
    requestedAt: iso(row.requested_at)!,
    decidedAt: row.decided_at == null ? null : iso(row.decided_at),
    appliedAt: row.applied_at == null ? null : iso(row.applied_at),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Fabric profile must be a JSON object');
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maxLength: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && value == null) return '';
    throw new Error(`${label} must be text`);
  }
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${label} is required`);
  if (normalized.length > maxLength) throw new Error(`${label} exceeds ${maxLength} characters`);
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value == null || value === '') return null;
  return text(value, label, maxLength);
}

function name(value: unknown, label: string, allowHyphen = true): string {
  const normalized = text(value, label, 128);
  const pattern = allowHyphen ? /^[a-z0-9][a-z0-9_-]*$/ : /^[a-z0-9][a-z0-9_]*$/;
  if (!pattern.test(normalized)) throw new Error(`${label} has an invalid stable name`);
  return normalized;
}

function textList(value: unknown, label: string, limit = 5_000): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const normalized = [...new Set(value.map(item => text(item, label, 256)))];
  if (normalized.length > limit) throw new Error(`${label} contains too many entries`);
  return normalized.sort();
}

function containsSensitiveKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveKey);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    /password|secret|token|api[_-]?key|authorization|credential|cookie|private[_-]?key/i.test(key)
      || containsSensitiveKey(nested));
}

function iso(value: string | Date | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapProfile(row: FabricProfileDbRow): FabricProfileRecord {
  return {
    id: Number(row.id),
    name: row.name,
    label: row.label,
    description: row.description,
    manifestVersion: row.manifest_version,
    revision: row.revision,
    manifest: row.manifest,
    manifestDigest: row.manifest_digest,
    source: row.source,
    installedBundleIds: row.installed_bundle_ids ?? [],
    appliedMappings: row.applied_mappings ?? {},
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    lastAppliedAt: iso(row.last_applied_at),
    drift: row.drift_status && row.drift_checked_at && row.drift_changed_at
      ? {
          status: row.drift_status,
          checkedAt: iso(row.drift_checked_at)!,
          profileId: Number(row.id),
          profileRevision: Number(row.drift_profile_revision ?? row.revision),
          manifestDigest: row.drift_manifest_digest ?? row.manifest_digest,
          counts: {
            total: Number(row.drift_finding_count ?? 0),
            critical: Number(row.drift_critical_count ?? 0),
            warning: Number(row.drift_warning_count ?? 0),
          },
          findings: row.drift_findings ?? [],
          findingDigest: row.drift_finding_digest ?? '',
          source: row.drift_check_source ?? 'manual',
          transitionSequence: Number(row.drift_transition_sequence ?? 1),
          consecutiveFailures: Number(row.drift_consecutive_failures ?? 0),
          lastErrorCode: row.drift_last_error_code ?? null,
          lastErrorAt: iso(row.drift_last_error_at ?? null),
          changedAt: iso(row.drift_changed_at)!,
          notifiedAt: iso(row.drift_notified_at ?? null),
        }
      : null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

function mapDriftSnapshot(row: FabricProfileDriftDbRow): FabricProfileDriftSnapshot {
  return {
    status: row.status,
    checkedAt: iso(row.checked_at)!,
    profileId: Number(row.profile_id),
    profileRevision: Number(row.profile_revision),
    manifestDigest: row.manifest_digest,
    counts: {
      total: Number(row.finding_count),
      critical: Number(row.critical_count),
      warning: Number(row.warning_count),
    },
    findings: row.findings ?? [],
    findingDigest: row.finding_digest,
    source: row.check_source,
    transitionSequence: Number(row.transition_sequence),
    consecutiveFailures: Number(row.consecutive_failures),
    lastErrorCode: row.last_error_code,
    lastErrorAt: iso(row.last_error_at),
    changedAt: iso(row.changed_at)!,
    notifiedAt: iso(row.notified_at),
  };
}

function mapProfileVersion(row: FabricProfileVersionDbRow): FabricProfileVersionRecord {
  return {
    id: Number(row.id),
    profileId: Number(row.profile_id),
    revision: Number(row.revision),
    manifestVersion: row.manifest_version,
    manifest: row.manifest,
    manifestDigest: row.manifest_digest,
    source: row.source,
    installedBundleIds: row.installed_bundle_ids ?? [],
    appliedMappings: row.applied_mappings ?? {},
    changeKind: row.change_kind,
    applied: row.applied,
    createdBy: row.created_by,
    createdAt: iso(row.created_at)!,
  };
}

export function validateFabricProfileManifest(value: unknown): FabricProfileManifest {
  const rawBytes = Buffer.byteLength(JSON.stringify(value ?? null));
  if (rawBytes > 1_048_576) throw new Error('Fabric profile exceeds the 1 MB limit');
  if (containsSensitiveKey(value)) throw new Error('Fabric profiles cannot contain credentials, tokens or secret fields');

  const root = record(value);
  if (root.apiVersion !== FABRIC_PROFILE_API_VERSION || root.kind !== FABRIC_PROFILE_KIND) {
    throw new Error(`Fabric profile must use ${FABRIC_PROFILE_API_VERSION} and kind ${FABRIC_PROFILE_KIND}`);
  }
  const metadata = record(root.metadata);
  const spec = record(root.spec);
  if (!Array.isArray(spec.connectors) || !Array.isArray(spec.bundles)) {
    throw new Error('Fabric profile connectors and bundles must be lists');
  }
  if (spec.connectors.length > 250 || spec.bundles.length === 0 || spec.bundles.length > 100) {
    throw new Error('Fabric profile must contain 1-100 bundles and no more than 250 connectors');
  }

  const connectors = spec.connectors.map((entry, index): FabricProfileConnector => {
    const connector = record(entry);
    const backendType = connector.backendType;
    if (backendType !== 'mcp' && backendType !== 'http' && backendType !== 'builtin') {
      throw new Error(`Connector ${index + 1} has an invalid backend type`);
    }
    return {
      slot: name(connector.slot, `Connector ${index + 1} slot`),
      backendName: name(connector.backendName, `Connector ${index + 1} backend`, true),
      backendType,
    };
  });
  if (new Set(connectors.map(connector => connector.slot)).size !== connectors.length) {
    throw new Error('Fabric profile connector slots must be unique');
  }
  const connectorSlots = new Set(connectors.map(connector => connector.slot));

  const bundles = spec.bundles.map((entry, index): FabricProfileBundle => {
    const bundle = record(entry);
    if (!Array.isArray(bundle.connectors)) throw new Error(`Bundle ${index + 1} connectors must be a list`);
    const bundleConnectors = bundle.connectors.map((item, connectorIndex): FabricProfileBundleConnector => {
      const connector = record(item);
      const slot = name(connector.slot, `Bundle ${index + 1} connector ${connectorIndex + 1}`);
      if (!connectorSlots.has(slot)) throw new Error(`Bundle ${index + 1} references unknown connector slot ${slot}`);
      const policy = record(connector.toolPolicy);
      if (policy.mode !== 'all' && policy.mode !== 'selected') {
        throw new Error(`Bundle ${index + 1} connector ${slot} has an invalid tool policy`);
      }
      return {
        slot,
        toolPolicy: {
          mode: policy.mode,
          allowedToolNames: policy.mode === 'all' ? [] : textList(policy.allowedToolNames, `Allowed tools for ${slot}`),
        },
      };
    });
    if (new Set(bundleConnectors.map(connector => connector.slot)).size !== bundleConnectors.length) {
      throw new Error(`Bundle ${index + 1} contains duplicate connector slots`);
    }
    return {
      name: name(bundle.name, `Bundle ${index + 1} name`, false),
      label: text(bundle.label, `Bundle ${index + 1} label`, 256),
      description: text(bundle.description ?? '', `Bundle ${index + 1} description`, 5_000, false),
      icon: text(bundle.icon ?? '', `Bundle ${index + 1} icon`, 32, false),
      systemPrompt: optionalText(bundle.systemPrompt, `Bundle ${index + 1} system prompt`, 20_000),
      agentRole: optionalText(bundle.agentRole, `Bundle ${index + 1} agent role`, 128),
      connectors: bundleConnectors.sort((left, right) => left.slot.localeCompare(right.slot)),
      skills: textList(bundle.skills, `Bundle ${index + 1} skills`, 500),
      directTools: textList(bundle.directTools, `Bundle ${index + 1} direct tools`, 5_000),
    };
  });
  if (new Set(bundles.map(bundle => bundle.name)).size !== bundles.length) {
    throw new Error('Fabric profile bundle names must be unique');
  }

  let access: FabricProfileManifest['spec']['access'] = null;
  if (spec.access != null) {
    const rawAccess = record(spec.access);
    const rawGroupBindings = rawAccess.groupBindings == null ? [] : rawAccess.groupBindings;
    if (!Array.isArray(rawGroupBindings)) throw new Error('Access group bindings must be a list');
    if (rawGroupBindings.length > 100) throw new Error('Access group bindings contain too many entries');
    const groupBindings = rawGroupBindings.map((entry, index) => {
      const binding = record(entry);
      if (binding.required != null && typeof binding.required !== 'boolean') {
        throw new Error(`Access group binding ${index + 1} required must be true or false`);
      }
      const logicalName = name(binding.logicalName, `Access group binding ${index + 1} logical name`);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(logicalName)) {
        throw new Error(`Access group binding ${index + 1} must use a portable alias, not an identity-provider object ID`);
      }
      return {
        logicalName,
        required: binding.required !== false,
      };
    });
    if (new Set(groupBindings.map(binding => binding.logicalName)).size !== groupBindings.length) {
      throw new Error('Access group binding logical names must be unique');
    }
    access = {
      compositeName: name(rawAccess.compositeName, 'Access composite name'),
      description: text(rawAccess.description ?? '', 'Access composite description', 5_000, false),
      toolAllowPatterns: textList(rawAccess.toolAllowPatterns, 'Composite allow patterns', 500),
      toolDenyPatterns: textList(rawAccess.toolDenyPatterns, 'Composite deny patterns', 500),
      groupBindings: groupBindings.sort((left, right) => left.logicalName.localeCompare(right.logicalName)),
    };
  }

  const version = text(metadata.version, 'Profile version', 32);
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-z0-9.-]+)?$/i.test(version)) {
    throw new Error('Profile version must use semantic versioning');
  }
  return {
    apiVersion: FABRIC_PROFILE_API_VERSION,
    kind: FABRIC_PROFILE_KIND,
    metadata: {
      name: name(metadata.name, 'Profile name'),
      label: text(metadata.label, 'Profile label', 256),
      description: text(metadata.description ?? '', 'Profile description', 5_000, false),
      version,
    },
    spec: {
      connectors: connectors.sort((left, right) => left.slot.localeCompare(right.slot)),
      bundles: bundles.sort((left, right) => left.name.localeCompare(right.name)),
      access,
    },
  };
}

export function fabricProfileDigest(manifest: FabricProfileManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}

export async function exportFabricProfile(
  db: Queryable,
  input: {
    name: string;
    label: string;
    description: string;
    version?: string;
    bundleIds: number[];
    createComposite?: boolean;
    groupBindings?: Array<{ logicalName: string; required?: boolean }>;
  },
): Promise<FabricProfileManifest> {
  const bundleIds = [...new Set(input.bundleIds.map(Number))].sort((left, right) => left - right);
  if (bundleIds.length === 0 || bundleIds.length > 100 || bundleIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
    throw new Error('Select between 1 and 100 valid bundles');
  }
  const bundles = (await db.query<{
    id: number; name: string; label: string; description: string; icon: string;
    system_prompt: string | null; agent_role: string | null;
  }>(
    `SELECT id, name, label, description, icon, system_prompt, agent_role
       FROM mcp_service_bundles WHERE id = ANY($1::int[]) ORDER BY name`,
    [bundleIds],
  )).rows;
  if (bundles.length !== bundleIds.length) throw new Error('At least one selected bundle no longer exists');

  const backends = (await db.query<{
    bundle_id: number; id: number; name: string; backend_type: string;
    mode: 'all' | 'selected' | null; allowed_tool_names: string[] | null;
  }>(
    `SELECT assignment.bundle_id, backend.id, backend.name, backend.backend_type,
            policy.mode, policy.allowed_tool_names
       FROM mcp_backend_bundles assignment
       JOIN mcp_backends backend ON backend.id = assignment.backend_id
       LEFT JOIN mcp_bundle_backend_tool_policies policy
         ON policy.backend_id = assignment.backend_id AND policy.bundle_id = assignment.bundle_id
      WHERE assignment.bundle_id = ANY($1::int[])
      ORDER BY backend.name`,
    [bundleIds],
  )).rows;
  const skills = (await db.query<{ bundle_id: number; name: string }>(
    `SELECT assignment.bundle_id, skill.name
       FROM mcp_bundle_skills assignment
       JOIN mcp_skills skill ON skill.id = assignment.skill_id
      WHERE assignment.bundle_id = ANY($1::int[])
      ORDER BY assignment.position, skill.name`,
    [bundleIds],
  )).rows;
  const directTools = (await db.query<{ bundle_id: number; name: string }>(
    `SELECT assignment.bundle_id, tool.name
       FROM mcp_tool_bundles assignment
       JOIN mcp_tools tool ON tool.id = assignment.tool_id
      WHERE assignment.bundle_id = ANY($1::int[])
        AND NOT EXISTS (
          SELECT 1 FROM mcp_backends backend
           WHERE tool.backend = backend.name OR tool.backend = 'custom:' || backend.name
        )
      ORDER BY tool.name`,
    [bundleIds],
  )).rows;

  const uniqueBackends = new Map<number, FabricProfileConnector>();
  for (const backend of backends) {
    const backendType = backend.backend_type === 'mcp' ? 'mcp' : backend.backend_type === 'http' ? 'http' : 'builtin';
    uniqueBackends.set(backend.id, { slot: backend.name, backendName: backend.name, backendType });
  }
  return validateFabricProfileManifest({
    apiVersion: FABRIC_PROFILE_API_VERSION,
    kind: FABRIC_PROFILE_KIND,
    metadata: {
      name: input.name,
      label: input.label,
      description: input.description,
      version: input.version ?? '1.0.0',
    },
    spec: {
      connectors: [...uniqueBackends.values()],
      bundles: bundles.map(bundle => ({
        name: bundle.name,
        label: bundle.label,
        description: bundle.description,
        icon: bundle.icon,
        systemPrompt: bundle.system_prompt,
        agentRole: bundle.agent_role,
        connectors: backends.filter(backend => backend.bundle_id === bundle.id).map(backend => ({
          slot: backend.name,
          toolPolicy: {
            mode: backend.mode ?? 'all',
            allowedToolNames: backend.mode === 'selected' ? backend.allowed_tool_names ?? [] : [],
          },
        })),
        skills: skills.filter(skill => skill.bundle_id === bundle.id).map(skill => skill.name),
        directTools: directTools.filter(tool => tool.bundle_id === bundle.id).map(tool => tool.name),
      })),
      access: input.createComposite === false ? null : {
        compositeName: `${input.name}-access`,
        description: `Team access generated from Fabric profile ${input.label}`,
        toolAllowPatterns: [],
        toolDenyPatterns: [],
        groupBindings: input.groupBindings ?? [],
      },
    },
  });
}

export async function listFabricProfiles(db: Queryable): Promise<FabricProfileRecord[]> {
  const { rows } = await db.query<FabricProfileDbRow>(
    `SELECT profile.*,
            drift.profile_revision AS drift_profile_revision,
            drift.manifest_digest AS drift_manifest_digest,
            drift.status AS drift_status,
            drift.finding_count AS drift_finding_count,
            drift.critical_count AS drift_critical_count,
            drift.warning_count AS drift_warning_count,
            drift.findings AS drift_findings,
            drift.finding_digest AS drift_finding_digest,
            drift.check_source AS drift_check_source,
            drift.transition_sequence AS drift_transition_sequence,
            drift.consecutive_failures AS drift_consecutive_failures,
            drift.last_error_code AS drift_last_error_code,
            drift.last_error_at AS drift_last_error_at,
            drift.checked_at AS drift_checked_at,
            drift.changed_at AS drift_changed_at,
            drift.notified_at AS drift_notified_at
       FROM mcp_fabric_profiles profile
       LEFT JOIN mcp_fabric_profile_drift_state drift ON drift.profile_id=profile.id
      ORDER BY profile.updated_at DESC, profile.id DESC LIMIT 200`,
  );
  return rows.map(mapProfile);
}

export async function getFabricProfile(db: Queryable, id: number): Promise<FabricProfileRecord | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null;
  const { rows } = await db.query<FabricProfileDbRow>(
    `SELECT profile.*,
            drift.profile_revision AS drift_profile_revision,
            drift.manifest_digest AS drift_manifest_digest,
            drift.status AS drift_status,
            drift.finding_count AS drift_finding_count,
            drift.critical_count AS drift_critical_count,
            drift.warning_count AS drift_warning_count,
            drift.findings AS drift_findings,
            drift.finding_digest AS drift_finding_digest,
            drift.check_source AS drift_check_source,
            drift.transition_sequence AS drift_transition_sequence,
            drift.consecutive_failures AS drift_consecutive_failures,
            drift.last_error_code AS drift_last_error_code,
            drift.last_error_at AS drift_last_error_at,
            drift.checked_at AS drift_checked_at,
            drift.changed_at AS drift_changed_at,
            drift.notified_at AS drift_notified_at
       FROM mcp_fabric_profiles profile
       LEFT JOIN mcp_fabric_profile_drift_state drift ON drift.profile_id=profile.id
      WHERE profile.id=$1`,
    [id],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function listFabricProfileVersions(
  db: Queryable,
  profileId: number,
): Promise<FabricProfileVersionRecord[]> {
  if (!Number.isSafeInteger(profileId) || profileId < 1) return [];
  const { rows } = await db.query<FabricProfileVersionDbRow>(
    `SELECT * FROM mcp_fabric_profile_versions
      WHERE profile_id=$1 ORDER BY revision DESC LIMIT 200`,
    [profileId],
  );
  return rows.map(mapProfileVersion);
}

async function getFabricProfileVersion(
  db: Queryable,
  profileId: number,
  revision: number,
): Promise<FabricProfileVersionRecord | null> {
  if (!Number.isSafeInteger(profileId) || profileId < 1 || !Number.isSafeInteger(revision) || revision < 1) return null;
  const { rows } = await db.query<FabricProfileVersionDbRow>(
    `SELECT * FROM mcp_fabric_profile_versions WHERE profile_id=$1 AND revision=$2`,
    [profileId, revision],
  );
  return rows[0] ? mapProfileVersion(rows[0]) : null;
}

function pushVersionChange(
  changes: FabricProfileVersionDiffChange[],
  change: FabricProfileVersionDiffChange,
): void {
  if (normalizedJson(change.before) === normalizedJson(change.after)) return;
  changes.push(change);
}

export function diffFabricProfileManifests(
  before: FabricProfileManifest,
  after: FabricProfileManifest,
): FabricProfileVersionDiffChange[] {
  const changes: FabricProfileVersionDiffChange[] = [];
  for (const field of ['label', 'description', 'version'] as const) {
    pushVersionChange(changes, {
      kind: 'changed', scope: 'metadata', resource: before.metadata.name, field,
      before: before.metadata[field], after: after.metadata[field],
    });
  }

  const beforeConnectors = new Map(before.spec.connectors.map(connector => [connector.slot, connector]));
  const afterConnectors = new Map(after.spec.connectors.map(connector => [connector.slot, connector]));
  for (const slot of [...new Set([...beforeConnectors.keys(), ...afterConnectors.keys()])].sort()) {
    const left = beforeConnectors.get(slot);
    const right = afterConnectors.get(slot);
    pushVersionChange(changes, {
      kind: left == null ? 'added' : right == null ? 'removed' : 'changed',
      scope: 'connector', resource: slot, field: 'definition', before: left ?? null, after: right ?? null,
    });
  }

  const beforeBundles = new Map(before.spec.bundles.map(bundle => [bundle.name, bundle]));
  const afterBundles = new Map(after.spec.bundles.map(bundle => [bundle.name, bundle]));
  for (const bundleName of [...new Set([...beforeBundles.keys(), ...afterBundles.keys()])].sort()) {
    const left = beforeBundles.get(bundleName);
    const right = afterBundles.get(bundleName);
    pushVersionChange(changes, {
      kind: left == null ? 'added' : right == null ? 'removed' : 'changed',
      scope: 'bundle', resource: bundleName, field: 'definition', before: left ?? null, after: right ?? null,
    });
  }
  pushVersionChange(changes, {
    kind: before.spec.access == null ? 'added' : after.spec.access == null ? 'removed' : 'changed',
    scope: 'access', resource: after.spec.access?.compositeName ?? before.spec.access?.compositeName ?? 'team-access',
    field: 'definition', before: before.spec.access, after: after.spec.access,
  });
  return changes;
}

export async function diffFabricProfileVersions(
  db: Queryable,
  profileId: number,
  fromRevision: number,
  toRevision: number,
): Promise<FabricProfileVersionDiff | null> {
  const [from, to] = await Promise.all([
    getFabricProfileVersion(db, profileId, fromRevision),
    getFabricProfileVersion(db, profileId, toRevision),
  ]);
  if (!from || !to) return null;
  const allChanges = diffFabricProfileManifests(from.manifest, to.manifest);
  const changes = allChanges.slice(0, 200);
  return {
    profileId,
    from: { revision: from.revision, manifestVersion: from.manifestVersion, manifestDigest: from.manifestDigest, createdAt: from.createdAt },
    to: { revision: to.revision, manifestVersion: to.manifestVersion, manifestDigest: to.manifestDigest, createdAt: to.createdAt },
    counts: {
      total: allChanges.length,
      added: allChanges.filter(change => change.kind === 'added').length,
      removed: allChanges.filter(change => change.kind === 'removed').length,
      changed: allChanges.filter(change => change.kind === 'changed').length,
    },
    changes,
    truncated: allChanges.length > changes.length,
  };
}

async function loadFabricProfileRestoreRequest(
  db: Queryable,
  requestId: string,
  lock = false,
): Promise<FabricProfileRestoreRequest | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return null;
  const { rows } = await db.query<FabricProfileRestoreDbRow>(`
    SELECT request.*, profile.label AS profile_label
      FROM mcp_fabric_profile_restore_requests request
      JOIN mcp_fabric_profiles profile ON profile.id=request.profile_id
     WHERE request.id=$1
     ${lock ? 'FOR UPDATE OF request' : ''}
  `, [requestId]);
  return rows[0] ? mapRestoreRequest(rows[0]) : null;
}

export async function listFabricProfileRestoreRequests(
  db: Queryable,
  profileId?: number,
): Promise<FabricProfileRestoreRequest[]> {
  if (profileId !== undefined && (!Number.isSafeInteger(profileId) || profileId < 1)) return [];
  const { rows } = await db.query<FabricProfileRestoreDbRow>(`
    SELECT request.*, profile.label AS profile_label
      FROM mcp_fabric_profile_restore_requests request
      JOIN mcp_fabric_profiles profile ON profile.id=request.profile_id
     WHERE ($1::integer IS NULL OR request.profile_id=$1)
     ORDER BY request.requested_at DESC
     LIMIT 200
  `, [profileId ?? null]);
  return rows.map(mapRestoreRequest);
}

export async function requestFabricProfileRestore(
  pool: pg.Pool,
  input: {
    profileId: number;
    targetRevision: number;
    mappings?: FabricProfileMappings;
    planToken: string;
    requestedBy: number;
    requestedByUsername: string;
    comment?: string;
  },
): Promise<FabricProfileRestoreRequest> {
  if (![input.profileId, input.targetRevision, input.requestedBy].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('Restore request has invalid identifiers');
  }
  if (!/^[0-9a-f]{64}$/.test(input.planToken)) throw new Error('Restore request requires the exact preview plan token');
  const [profile, target] = await Promise.all([
    getFabricProfile(pool, input.profileId),
    getFabricProfileVersion(pool, input.profileId, input.targetRevision),
  ]);
  if (!profile || !target) throw new Error('Bundle Set or target revision was not found');
  if (profile.revision === target.revision) throw new Error('The current Bundle Set revision cannot be restored');
  const mappings = input.mappings ?? target.appliedMappings ?? {};
  const plan = await planFabricProfileImport(pool, target.manifest, mappings);
  if (plan.blockers.length > 0) throw new Error('Restore preview contains unresolved blockers');
  if (plan.planToken !== input.planToken) throw new Error('Restore preview is stale; run it again before requesting approval');
  const comment = (input.comment ?? '').trim().slice(0, 2_000);
  try {
    const { rows } = await pool.query<FabricProfileRestoreDbRow>(`
      WITH inserted AS (
        INSERT INTO mcp_fabric_profile_restore_requests (
          profile_id, target_revision, target_manifest_digest,
          requested_from_revision, requested_from_manifest_digest,
          mappings, plan_token, plan_snapshot, requested_by,
          requested_by_username, request_comment
        ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11)
        RETURNING *
      )
      SELECT inserted.*, profile.label AS profile_label
        FROM inserted JOIN mcp_fabric_profiles profile ON profile.id=inserted.profile_id
    `, [
      profile.id, target.revision, target.manifestDigest, profile.revision, profile.manifestDigest,
      JSON.stringify(mappings), plan.planToken, JSON.stringify({ actions: plan.actions, blockers: plan.blockers }),
      input.requestedBy, input.requestedByUsername, comment,
    ]);
    return mapRestoreRequest(rows[0]!);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new Error('This Bundle Set already has an open restore request');
    throw error;
  }
}

export async function decideFabricProfileRestore(
  pool: pg.Pool,
  input: {
    requestId: string;
    decision: 'approved' | 'rejected';
    actorId: number;
    actorUsername: string;
    comment: string;
  },
): Promise<FabricProfileRestoreRequest> {
  const comment = input.comment.trim();
  if (comment.length < 4 || comment.length > 2_000) throw new Error('An approval comment between 4 and 2000 characters is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const request = await loadFabricProfileRestoreRequest(client, input.requestId, true);
    if (!request) throw new Error('Restore request was not found');
    if (request.status !== 'pending') throw new Error('Restore request is no longer pending');
    if (request.requestedBy === input.actorId && process.env['ALLOW_SELF_APPROVE_FABRIC_RESTORE'] !== 'true') {
      throw new Error('Separation of duties requires a different policy admin to approve this restore');
    }
    await client.query(`
      UPDATE mcp_fabric_profile_restore_requests
         SET status=$2, decided_by=$3, decided_by_username=$4,
             decision_comment=$5, decided_at=now(), updated_at=now()
       WHERE id=$1
    `, [input.requestId, input.decision, input.actorId, input.actorUsername, comment]);
    const decided = await loadFabricProfileRestoreRequest(client, input.requestId);
    await client.query('COMMIT');
    return decided!;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function getFabricProfileByName(db: Queryable, profileName: string): Promise<FabricProfileRecord | null> {
  const { rows } = await db.query<FabricProfileDbRow>(
    `SELECT profile.*,
            drift.profile_revision AS drift_profile_revision,
            drift.manifest_digest AS drift_manifest_digest,
            drift.status AS drift_status,
            drift.finding_count AS drift_finding_count,
            drift.critical_count AS drift_critical_count,
            drift.warning_count AS drift_warning_count,
            drift.findings AS drift_findings,
            drift.finding_digest AS drift_finding_digest,
            drift.check_source AS drift_check_source,
            drift.transition_sequence AS drift_transition_sequence,
            drift.consecutive_failures AS drift_consecutive_failures,
            drift.last_error_code AS drift_last_error_code,
            drift.last_error_at AS drift_last_error_at,
            drift.checked_at AS drift_checked_at,
            drift.changed_at AS drift_changed_at,
            drift.notified_at AS drift_notified_at
       FROM mcp_fabric_profiles profile
       LEFT JOIN mcp_fabric_profile_drift_state drift ON drift.profile_id=profile.id
      WHERE profile.name=$1`,
    [profileName],
  );
  return rows[0] ? mapProfile(rows[0]) : null;
}

export async function listFabricProfileSsoGroups(db: Queryable): Promise<FabricProfileSsoGroup[]> {
  const { rows } = await db.query<{ name: string; member_count: number }>(
    `WITH known_groups AS (
       SELECT btrim(group_name) AS name FROM mcp_group_composites
       UNION
       SELECT btrim(group_name) AS name FROM mcp_fabric_profile_group_bindings
       UNION
       SELECT btrim(group_name) AS name
         FROM mcp_users user_record
         CROSS JOIN LATERAL unnest(COALESCE(user_record.entra_groups, '{}'::text[])) group_name
     )
     SELECT known.name,
            (SELECT count(*)::int FROM mcp_users member WHERE known.name = ANY(COALESCE(member.entra_groups, '{}'::text[]))) AS member_count
       FROM known_groups known
      WHERE known.name <> '' AND length(known.name) <= 128
      ORDER BY lower(known.name), known.name
      LIMIT 500`,
  );
  return rows.map(row => ({ name: row.name, memberCount: Number(row.member_count) }));
}

export async function saveFabricProfile(
  db: Queryable,
  manifestValue: unknown,
  actor: string,
  source: 'local' | 'imported',
  installedBundleIds: number[] = [],
  applied = false,
  appliedMappings: FabricProfileMappings = {},
): Promise<FabricProfileRecord> {
  const manifest = validateFabricProfileManifest(manifestValue);
  const digest = fabricProfileDigest(manifest);
  const { rows } = await db.query<FabricProfileDbRow>(
    `WITH saved AS (
       INSERT INTO mcp_fabric_profiles (
       name, label, description, manifest_version, manifest, manifest_digest,
       source, installed_bundle_ids, created_by, updated_by, last_applied_at, applied_mappings
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9, CASE WHEN $10 THEN now() ELSE NULL END, $11::jsonb)
       ON CONFLICT (name) DO UPDATE SET
       label = EXCLUDED.label,
       description = EXCLUDED.description,
       manifest_version = EXCLUDED.manifest_version,
       revision = mcp_fabric_profiles.revision + 1,
       manifest = EXCLUDED.manifest,
       manifest_digest = EXCLUDED.manifest_digest,
       source = EXCLUDED.source,
       installed_bundle_ids = EXCLUDED.installed_bundle_ids,
       applied_mappings = EXCLUDED.applied_mappings,
       updated_by = EXCLUDED.updated_by,
       last_applied_at = CASE WHEN $10 THEN now() ELSE mcp_fabric_profiles.last_applied_at END,
       updated_at = now()
       RETURNING *
     ), versioned AS (
       INSERT INTO mcp_fabric_profile_versions (
         profile_id, revision, manifest_version, manifest, manifest_digest, source,
         installed_bundle_ids, applied_mappings, change_kind, applied, created_by
       )
       SELECT saved.id, saved.revision, saved.manifest_version, saved.manifest,
              saved.manifest_digest, saved.source, saved.installed_bundle_ids,
              saved.applied_mappings,
              CASE WHEN saved.revision = 1 THEN 'created' WHEN $10 THEN 'applied' ELSE 'exported' END,
              $10, $9
         FROM saved
       ON CONFLICT (profile_id, revision) DO NOTHING
     )
     SELECT * FROM saved`,
    [
      manifest.metadata.name,
      manifest.metadata.label,
      manifest.metadata.description,
      manifest.metadata.version,
      JSON.stringify(manifest),
      digest,
      source,
      installedBundleIds,
      actor,
      applied,
      JSON.stringify(appliedMappings),
    ],
  );
  return mapProfile(rows[0]!);
}

function normalizedJson(value: unknown): string {
  return JSON.stringify(value);
}

function sameStringList(left: string[] | null | undefined, right: string[] | null | undefined): boolean {
  return normalizedJson([...(left ?? [])].sort()) === normalizedJson([...(right ?? [])].sort());
}

function addDriftFinding(
  findings: FabricProfileDriftFinding[],
  finding: FabricProfileDriftFinding,
): void {
  findings.push(finding);
}

export async function detectFabricProfileDrift(
  db: Queryable,
  profile: FabricProfileRecord,
): Promise<FabricProfileDrift> {
  const checkedAt = new Date().toISOString();
  if (profile.source === 'local' || !profile.lastAppliedAt) {
    return {
      status: 'not_applied', checkedAt, profileId: profile.id, profileRevision: profile.revision,
      manifestDigest: profile.manifestDigest, counts: { total: 0, critical: 0, warning: 0 }, findings: [],
    };
  }

  const findings: FabricProfileDriftFinding[] = [];
  const expectedBundles = profile.manifest.spec.bundles;
  const currentBundles = (await db.query<{
    id: number; name: string; label: string; description: string; icon: string;
    system_prompt: string | null; agent_role: string | null;
  }>(
    `SELECT id, name, label, description, icon, system_prompt, agent_role
       FROM mcp_service_bundles WHERE name = ANY($1::text[]) ORDER BY name`,
    [expectedBundles.map(bundle => bundle.name)],
  )).rows;
  const currentByName = new Map(currentBundles.map(bundle => [bundle.name, bundle]));
  for (const expected of expectedBundles) {
    if (currentByName.has(expected.name)) continue;
    addDriftFinding(findings, {
      code: 'bundle_missing', severity: 'critical', resourceType: 'bundle', resource: expected.name,
      message: `Bundle ${expected.name} is missing from the live Fabric`, expected: { present: true }, actual: { present: false },
    });
  }

  if (currentBundles.length > 0) {
    const actualManifest = await exportFabricProfile(db, {
      name: profile.name,
      label: profile.label,
      description: profile.description,
      version: profile.manifestVersion,
      bundleIds: currentBundles.map(bundle => Number(bundle.id)),
      createComposite: false,
    });
    const actualByName = new Map(actualManifest.spec.bundles.map(bundle => [bundle.name, bundle]));
    for (const expected of expectedBundles) {
      const actual = actualByName.get(expected.name);
      if (!actual) continue;
      const expectedMetadata = {
        label: expected.label, description: expected.description, icon: expected.icon,
        systemPrompt: expected.systemPrompt, agentRole: expected.agentRole,
      };
      const actualMetadata = {
        label: actual.label, description: actual.description, icon: actual.icon,
        systemPrompt: actual.systemPrompt, agentRole: actual.agentRole,
      };
      if (normalizedJson(expectedMetadata) !== normalizedJson(actualMetadata)) addDriftFinding(findings, {
        code: 'bundle_metadata_changed', severity: 'warning', resourceType: 'bundle', resource: expected.name,
        message: `Bundle ${expected.name} metadata differs from its applied baseline`, expected: expectedMetadata, actual: actualMetadata,
      });

      const expectedConnectors = expected.connectors.map(connector => ({
        backend: mappedName(profile.appliedMappings.backends, connector.slot,
          profile.manifest.spec.connectors.find(candidate => candidate.slot === connector.slot)?.backendName ?? connector.slot),
        policy: connector.toolPolicy,
      })).sort((left, right) => left.backend.localeCompare(right.backend));
      const actualConnectors = actual.connectors.map(connector => ({ backend: connector.slot, policy: connector.toolPolicy }))
        .sort((left, right) => left.backend.localeCompare(right.backend));
      const expectedBackendNames = expectedConnectors.map(connector => connector.backend);
      const actualBackendNames = actualConnectors.map(connector => connector.backend);
      if (!sameStringList(expectedBackendNames, actualBackendNames)) addDriftFinding(findings, {
        code: 'backend_assignment_changed', severity: 'critical', resourceType: 'connector', resource: expected.name,
        message: `Bundle ${expected.name} backend assignments changed`, expected: expectedBackendNames, actual: actualBackendNames,
      });
      for (const expectedConnector of expectedConnectors) {
        const actualConnector = actualConnectors.find(connector => connector.backend === expectedConnector.backend);
        if (!actualConnector) continue;
        if (normalizedJson(expectedConnector.policy) !== normalizedJson(actualConnector.policy)) addDriftFinding(findings, {
          code: 'tool_policy_changed', severity: 'critical', resourceType: 'connector',
          resource: `${expected.name}:${expectedConnector.backend}`,
          message: `Tool policy for ${expectedConnector.backend} in ${expected.name} changed`,
          expected: expectedConnector.policy, actual: actualConnector.policy,
        });
      }
      const expectedSkills = expected.skills.map(skill => mappedName(profile.appliedMappings.skills, skill, skill));
      if (!sameStringList(expectedSkills, actual.skills)) addDriftFinding(findings, {
        code: 'skill_assignment_changed', severity: 'warning', resourceType: 'skill', resource: expected.name,
        message: `Skills assigned to ${expected.name} changed`, expected: expectedSkills, actual: actual.skills,
      });
      if (!sameStringList(expected.directTools, actual.directTools)) addDriftFinding(findings, {
        code: 'direct_tool_assignment_changed', severity: 'critical', resourceType: 'tool', resource: expected.name,
        message: `Direct tools assigned to ${expected.name} changed`, expected: expected.directTools, actual: actual.directTools,
      });
    }
  }

  const expectedAccess = profile.manifest.spec.access;
  let compositeId: number | null = null;
  if (expectedAccess) {
    const composite = (await db.query<{
      id: number; description: string; included_bundle_ids: number[]; tool_allow_patterns: string[];
      tool_deny_patterns: string[]; enabled: boolean;
    }>(
      `SELECT id, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, enabled
         FROM mcp_composites WHERE name=$1`,
      [expectedAccess.compositeName],
    )).rows[0];
    if (!composite) addDriftFinding(findings, {
      code: 'composite_missing', severity: 'critical', resourceType: 'composite', resource: expectedAccess.compositeName,
      message: `Access composite ${expectedAccess.compositeName} is missing`, expected: { present: true }, actual: { present: false },
    });
    else {
      compositeId = Number(composite.id);
      const expectedComposite = {
        description: expectedAccess.description,
        includedBundleIds: currentBundles.map(bundle => Number(bundle.id)).sort((left, right) => left - right),
        toolAllowPatterns: expectedAccess.toolAllowPatterns,
        toolDenyPatterns: expectedAccess.toolDenyPatterns,
        enabled: true,
      };
      const actualComposite = {
        description: composite.description,
        includedBundleIds: [...(composite.included_bundle_ids ?? [])].map(Number).sort((left, right) => left - right),
        toolAllowPatterns: [...(composite.tool_allow_patterns ?? [])].sort(),
        toolDenyPatterns: [...(composite.tool_deny_patterns ?? [])].sort(),
        enabled: composite.enabled,
      };
      if (normalizedJson(expectedComposite) !== normalizedJson(actualComposite)) addDriftFinding(findings, {
        code: 'composite_changed', severity: 'critical', resourceType: 'composite', resource: expectedAccess.compositeName,
        message: `Access composite ${expectedAccess.compositeName} differs from the applied baseline`,
        expected: expectedComposite, actual: actualComposite,
      });
    }

    const bindings = (await db.query<{
      logical_name: string; group_name: string; composite_id: number; assigned: boolean;
    }>(
      `SELECT binding.logical_name, binding.group_name, binding.composite_id,
              EXISTS (SELECT 1 FROM mcp_group_composites assignment
                       WHERE assignment.group_name=binding.group_name AND assignment.composite_id=binding.composite_id) AS assigned
         FROM mcp_fabric_profile_group_bindings binding
        WHERE binding.profile_id=$1 ORDER BY binding.logical_name`,
      [profile.id],
    )).rows;
    const byAlias = new Map(bindings.map(binding => [binding.logical_name, binding]));
    for (const expected of expectedAccess.groupBindings) {
      const actual = byAlias.get(expected.logicalName);
      if (!actual) {
        if (expected.required) addDriftFinding(findings, {
          code: 'group_binding_missing', severity: 'critical', resourceType: 'sso_group', resource: expected.logicalName,
          message: `Required SSO group alias ${expected.logicalName} is no longer bound`,
          expected: { required: true, mappedGroup: profile.appliedMappings.groups?.[expected.logicalName] ?? expected.logicalName },
          actual: null,
        });
        continue;
      }
      const explicitlyMappedGroup = profile.appliedMappings.groups?.[expected.logicalName];
      if (!actual.assigned || (compositeId != null && Number(actual.composite_id) !== compositeId)
        || (explicitlyMappedGroup && actual.group_name !== explicitlyMappedGroup)) addDriftFinding(findings, {
        code: 'group_binding_changed', severity: 'critical', resourceType: 'sso_group', resource: expected.logicalName,
        message: `SSO group binding ${expected.logicalName} differs from the applied baseline`,
        expected: { groupName: explicitlyMappedGroup ?? actual.group_name, compositeId, assigned: true },
        actual: { groupName: actual.group_name, compositeId: Number(actual.composite_id), assigned: actual.assigned },
      });
    }
  }

  const critical = findings.filter(finding => finding.severity === 'critical').length;
  const warning = findings.length - critical;
  return {
    status: findings.length > 0 ? 'drifted' : 'in_sync', checkedAt, profileId: profile.id,
    profileRevision: profile.revision, manifestDigest: profile.manifestDigest,
    counts: { total: findings.length, critical, warning }, findings,
  };
}

function persistedDriftFindings(drift: FabricProfileDrift): FabricProfileDriftFindingSummary[] {
  return drift.findings.map(finding => ({
    code: finding.code,
    severity: finding.severity,
    resourceType: finding.resourceType,
    resource: finding.resource.slice(0, 256),
    message: finding.message.slice(0, 512),
  }));
}

/** Persist the latest bounded observation. The caller must own a transaction. */
export async function persistFabricProfileDriftSnapshot(
  client: pg.PoolClient,
  drift: FabricProfileDrift,
  source: FabricProfileDriftSnapshot['source'],
): Promise<FabricProfileDriftPersistenceResult> {
  const findings = persistedDriftFindings(drift);
  const findingDigest = createHash('sha256').update(JSON.stringify({ status: drift.status, findings })).digest('hex');
  const previousResult = await client.query<FabricProfileDriftDbRow>(
    'SELECT * FROM mcp_fabric_profile_drift_state WHERE profile_id=$1 FOR UPDATE',
    [drift.profileId],
  );
  const previous = previousResult.rows[0] ?? null;
  const transitioned = previous == null
    || previous.status !== drift.status
    || previous.finding_digest !== findingDigest
    || Number(previous.profile_revision) !== drift.profileRevision
    || previous.manifest_digest !== drift.manifestDigest;
  const transitionSequence = previous == null
    ? 1
    : Number(previous.transition_sequence) + (transitioned ? 1 : 0);
  const { rows } = await client.query<FabricProfileDriftDbRow>(
    `INSERT INTO mcp_fabric_profile_drift_state (
       profile_id, profile_revision, manifest_digest, status,
       finding_count, critical_count, warning_count, findings, finding_digest,
       check_source, transition_sequence, checked_at, changed_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12::timestamptz,$12::timestamptz)
     ON CONFLICT (profile_id) DO UPDATE SET
       profile_revision=EXCLUDED.profile_revision,
       manifest_digest=EXCLUDED.manifest_digest,
       status=EXCLUDED.status,
       finding_count=EXCLUDED.finding_count,
       critical_count=EXCLUDED.critical_count,
       warning_count=EXCLUDED.warning_count,
       findings=EXCLUDED.findings,
       finding_digest=EXCLUDED.finding_digest,
       check_source=EXCLUDED.check_source,
       transition_sequence=EXCLUDED.transition_sequence,
       consecutive_failures=0,
       last_error_code=NULL,
       last_error_at=NULL,
       last_error_notified_at=NULL,
       checked_at=EXCLUDED.checked_at,
       changed_at=CASE WHEN $13 THEN EXCLUDED.changed_at ELSE mcp_fabric_profile_drift_state.changed_at END,
       notified_at=CASE WHEN $13 THEN NULL ELSE mcp_fabric_profile_drift_state.notified_at END,
       updated_at=now()
     RETURNING *`,
    [
      drift.profileId,
      drift.profileRevision,
      drift.manifestDigest,
      drift.status,
      drift.counts.total,
      drift.counts.critical,
      drift.counts.warning,
      JSON.stringify(findings),
      findingDigest,
      source,
      transitionSequence,
      drift.checkedAt,
      transitioned,
    ],
  );
  return {
    snapshot: mapDriftSnapshot(rows[0]!),
    transitioned,
    previousStatus: previous?.status ?? null,
    previousFindingDigest: previous?.finding_digest ?? null,
  };
}

function mappedName(mapping: Record<string, string> | undefined, key: string, fallback: string): string {
  const mapped = mapping?.[key];
  return typeof mapped === 'string' && mapped.trim() ? mapped.trim() : fallback;
}

export async function planFabricProfileImport(
  db: Queryable,
  manifestValue: unknown,
  mappings: FabricProfileMappings = {},
): Promise<FabricProfilePlan> {
  const manifest = validateFabricProfileManifest(manifestValue);
  const backendNames = manifest.spec.connectors.map(connector => mappedName(mappings.backends, connector.slot, connector.backendName));
  const skillNames = [...new Set(manifest.spec.bundles.flatMap(bundle => bundle.skills)
    .map(skill => mappedName(mappings.skills, skill, skill)))];
  const directToolNames = [...new Set(manifest.spec.bundles.flatMap(bundle => bundle.directTools))];
  const existingBundles = (await db.query<{ id: number; name: string; updated_at: string | Date }>(
    `SELECT id, name, updated_at FROM mcp_service_bundles WHERE name = ANY($1::text[]) ORDER BY name`,
    [manifest.spec.bundles.map(bundle => bundle.name)],
  )).rows;
  const localBackends = backendNames.length === 0 ? [] : (await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM mcp_backends WHERE name = ANY($1::text[]) ORDER BY name`, [backendNames],
  )).rows;
  const localSkills = skillNames.length === 0 ? [] : (await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM mcp_skills WHERE name = ANY($1::text[]) ORDER BY name`, [skillNames],
  )).rows;
  const localTools = directToolNames.length === 0 ? [] : (await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM mcp_tools WHERE enabled = true AND name = ANY($1::text[]) ORDER BY name`, [directToolNames],
  )).rows;
  const knownGroups = manifest.spec.access?.groupBindings.length
    ? await listFabricProfileSsoGroups(db)
    : [];

  const backendByName = new Map(localBackends.map(backend => [backend.name, backend]));
  const skillByName = new Map(localSkills.map(skill => [skill.name, skill]));
  const toolByName = new Map(localTools.map(tool => [tool.name, tool]));
  const blockers: FabricProfilePlan['blockers'] = [];
  const resolvedBackends: FabricProfilePlan['resolved']['backends'] = {};
  for (const connector of manifest.spec.connectors) {
    const localName = mappedName(mappings.backends, connector.slot, connector.backendName);
    const backend = backendByName.get(localName);
    if (!backend) blockers.push({
      code: 'missing_backend', resource: connector.slot,
      message: `Connector slot ${connector.slot} requires a local backend mapping for ${connector.backendName}`,
    });
    else resolvedBackends[connector.slot] = backend;
  }
  const resolvedSkills: FabricProfilePlan['resolved']['skills'] = {};
  for (const skill of [...new Set(manifest.spec.bundles.flatMap(bundle => bundle.skills))]) {
    const localName = mappedName(mappings.skills, skill, skill);
    const local = skillByName.get(localName);
    if (!local) blockers.push({ code: 'missing_skill', resource: skill, message: `Skill ${skill} is not installed locally` });
    else resolvedSkills[skill] = local;
  }
  const resolvedTools: FabricProfilePlan['resolved']['directTools'] = {};
  for (const tool of directToolNames) {
    const local = toolByName.get(tool);
    if (!local) blockers.push({ code: 'missing_tool', resource: tool, message: `Direct tool ${tool} is unavailable locally` });
    else resolvedTools[tool] = local;
  }
  const knownGroupByName = new Map(knownGroups.map(group => [group.name, group]));
  const resolvedGroups: FabricProfilePlan['resolved']['groups'] = {};
  for (const binding of manifest.spec.access?.groupBindings ?? []) {
    const requested = mappings.groups?.[binding.logicalName]?.trim();
    const localName = requested || (knownGroupByName.has(binding.logicalName) ? binding.logicalName : '');
    const local = localName ? knownGroupByName.get(localName) : undefined;
    if (local) {
      resolvedGroups[binding.logicalName] = local;
    } else if (binding.required) {
      blockers.push({
        code: 'missing_group',
        resource: binding.logicalName,
        message: `SSO group alias ${binding.logicalName} requires an explicit local group mapping`,
      });
    }
  }

  const existingByName = new Map(existingBundles.map(bundle => [bundle.name, bundle]));
  const actions: FabricProfilePlan['actions'] = manifest.spec.bundles.map(bundle => ({
    kind: 'bundle',
    target: bundle.name,
    operation: existingByName.has(bundle.name) ? 'update' : 'create',
    detail: `${bundle.connectors.length} connector${bundle.connectors.length === 1 ? '' : 's'} · ${bundle.skills.length} skill${bundle.skills.length === 1 ? '' : 's'}`,
  }));
  if (manifest.spec.access) actions.push({
    kind: 'composite',
    target: manifest.spec.access.compositeName,
    operation: (await db.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM mcp_composites WHERE name = $1) AS exists',
      [manifest.spec.access.compositeName],
    )).rows[0]?.exists ? 'update' : 'create',
    detail: `Team access across ${manifest.spec.bundles.length} bundles`,
  });
  for (const binding of manifest.spec.access?.groupBindings ?? []) {
    const local = resolvedGroups[binding.logicalName];
    if (!local) continue;
    actions.push({
      kind: 'group',
      target: local.name,
      operation: 'bind',
      detail: `${binding.logicalName} · additive SSO access · ${local.memberCount} known member${local.memberCount === 1 ? '' : 's'}`,
    });
  }

  const manifestDigest = fabricProfileDigest(manifest);
  const liveState = {
    bundles: existingBundles.map(bundle => ({ id: bundle.id, name: bundle.name, updatedAt: iso(bundle.updated_at) })),
    backends: resolvedBackends,
    skills: resolvedSkills,
    directTools: resolvedTools,
    groups: resolvedGroups,
  };
  const planToken = createHash('sha256').update(JSON.stringify({ manifestDigest, mappings, liveState })).digest('hex');
  return {
    manifest,
    manifestDigest,
    planToken,
    actions,
    blockers,
    resolved: { backends: resolvedBackends, skills: resolvedSkills, directTools: resolvedTools, groups: resolvedGroups },
  };
}

interface StoredFabricProfileGroupBinding {
  logical_name: string;
  group_name: string;
  composite_id: number;
  assignment_owned: boolean;
}

async function removeOwnedProfileGroupBinding(
  client: pg.PoolClient,
  profileId: number,
  binding: StoredFabricProfileGroupBinding,
): Promise<void> {
  const current = (await client.query<StoredFabricProfileGroupBinding>(
    `SELECT logical_name, group_name, composite_id, assignment_owned
       FROM mcp_fabric_profile_group_bindings
      WHERE profile_id=$1 AND logical_name=$2
      FOR UPDATE`,
    [profileId, binding.logical_name],
  )).rows[0];
  if (!current) return;
  await client.query(
    'DELETE FROM mcp_fabric_profile_group_bindings WHERE profile_id=$1 AND logical_name=$2',
    [profileId, binding.logical_name],
  );
  if (!current.assignment_owned) return;
  const successor = (await client.query<{ profile_id: number; logical_name: string }>(
    `SELECT profile_id, logical_name
       FROM mcp_fabric_profile_group_bindings
      WHERE group_name=$1 AND composite_id=$2
      ORDER BY profile_id, logical_name
      LIMIT 1
      FOR UPDATE`,
    [current.group_name, current.composite_id],
  )).rows[0];
  if (successor) {
    await client.query(
      `UPDATE mcp_fabric_profile_group_bindings
          SET assignment_owned=true, updated_at=now()
        WHERE profile_id=$1 AND logical_name=$2`,
      [successor.profile_id, successor.logical_name],
    );
    return;
  }
  await client.query(
    'DELETE FROM mcp_group_composites WHERE group_name=$1 AND composite_id=$2',
    [current.group_name, current.composite_id],
  );
}

async function reconcileFabricProfileGroupBindings(
  client: pg.PoolClient,
  profileId: number,
  compositeId: number | null,
  resolvedGroups: FabricProfilePlan['resolved']['groups'],
): Promise<Array<{ logicalName: string; groupName: string; compositeId: number }>> {
  const existing = (await client.query<StoredFabricProfileGroupBinding>(
    `SELECT logical_name, group_name, composite_id, assignment_owned
       FROM mcp_fabric_profile_group_bindings
      WHERE profile_id=$1
      ORDER BY logical_name
      FOR UPDATE`,
    [profileId],
  )).rows;
  const desired = compositeId == null
    ? []
    : Object.entries(resolvedGroups).map(([logicalName, group]) => ({
      logicalName,
      groupName: group.name,
      compositeId,
    }));
  const desiredByLogicalName = new Map(desired.map(binding => [binding.logicalName, binding]));

  for (const stored of existing) {
    const next = desiredByLogicalName.get(stored.logical_name);
    if (next && next.groupName === stored.group_name && next.compositeId === stored.composite_id) continue;
    await removeOwnedProfileGroupBinding(client, profileId, stored);
  }

  for (const binding of desired) {
    const unchanged = existing.some(stored => stored.logical_name === binding.logicalName
      && stored.group_name === binding.groupName && stored.composite_id === binding.compositeId);
    if (unchanged) {
      await client.query(
        `UPDATE mcp_fabric_profile_group_bindings SET updated_at=now()
          WHERE profile_id=$1 AND logical_name=$2`,
        [profileId, binding.logicalName],
      );
      continue;
    }
    const assignment = await client.query(
      `INSERT INTO mcp_group_composites (group_name, composite_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING group_name`,
      [binding.groupName, binding.compositeId],
    );
    await client.query(
      `INSERT INTO mcp_fabric_profile_group_bindings (
         profile_id, logical_name, group_name, composite_id, assignment_owned
       ) VALUES ($1,$2,$3,$4,$5)`,
      [profileId, binding.logicalName, binding.groupName, binding.compositeId, assignment.rowCount === 1],
    );
  }
  return desired;
}

export interface ApplyFabricProfileInput {
  manifest: unknown;
  mappings?: FabricProfileMappings;
  planToken: string;
  actor: string;
}

export interface AppliedFabricProfile {
  profile: FabricProfileRecord;
  bundleIds: number[];
  compositeId: number | null;
  groupBindings: Array<{ logicalName: string; groupName: string; compositeId: number }>;
}

async function applyFabricProfileInTransaction(
  client: pg.PoolClient,
  input: ApplyFabricProfileInput,
): Promise<AppliedFabricProfile> {
  const manifest = validateFabricProfileManifest(input.manifest);
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`fabric-profile:${manifest.metadata.name}`]);
  const plan = await planFabricProfileImport(client, manifest, input.mappings);
    if (plan.blockers.length > 0) throw new Error(plan.blockers.map(blocker => blocker.message).join('; '));
    if (!/^[a-f0-9]{64}$/.test(input.planToken) || input.planToken !== plan.planToken) {
      throw new Error('Fabric profile plan is stale; preview the import again');
    }

    const bundleIds: number[] = [];
    for (const bundle of manifest.spec.bundles) {
      const saved = (await client.query<{ id: number }>(
        `INSERT INTO mcp_service_bundles (name, label, description, icon, system_prompt, agent_role)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE SET
           label = EXCLUDED.label,
           description = EXCLUDED.description,
           icon = EXCLUDED.icon,
           system_prompt = EXCLUDED.system_prompt,
           agent_role = EXCLUDED.agent_role
         RETURNING id`,
        [bundle.name, bundle.label, bundle.description, bundle.icon, bundle.systemPrompt, bundle.agentRole],
      )).rows[0]!;
      bundleIds.push(saved.id);

      await client.query('DELETE FROM mcp_tool_bundles WHERE bundle_id = $1', [saved.id]);
      await client.query('DELETE FROM mcp_backend_bundles WHERE bundle_id = $1', [saved.id]);
      for (const connector of bundle.connectors) {
        const backend = plan.resolved.backends[connector.slot]!;
        await client.query(
          'INSERT INTO mcp_backend_bundles (backend_id, bundle_id) VALUES ($1, $2)',
          [backend.id, saved.id],
        );
        await client.query(
          `INSERT INTO mcp_bundle_backend_tool_policies (backend_id, bundle_id, mode, allowed_tool_names)
           VALUES ($1, $2, $3, $4)`,
          [backend.id, saved.id, connector.toolPolicy.mode, connector.toolPolicy.allowedToolNames],
        );
        await client.query(
          `INSERT INTO mcp_tool_bundles (tool_id, bundle_id)
           SELECT tool.id, $2
             FROM mcp_tools tool
            WHERE (tool.backend = $1 OR tool.backend = 'custom:' || $1)
              AND ($3 = 'all' OR tool.name = ANY($4::text[]))
           ON CONFLICT DO NOTHING`,
          [backend.name, saved.id, connector.toolPolicy.mode, connector.toolPolicy.allowedToolNames],
        );
      }
      for (const toolName of bundle.directTools) {
        await client.query(
          'INSERT INTO mcp_tool_bundles (tool_id, bundle_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [plan.resolved.directTools[toolName]!.id, saved.id],
        );
      }
      await client.query('DELETE FROM mcp_bundle_skills WHERE bundle_id = $1', [saved.id]);
      for (let position = 0; position < bundle.skills.length; position += 1) {
        await client.query(
          'INSERT INTO mcp_bundle_skills (bundle_id, skill_id, position) VALUES ($1, $2, $3)',
          [saved.id, plan.resolved.skills[bundle.skills[position]!]!.id, position],
        );
      }
    }

    let compositeId: number | null = null;
    if (manifest.spec.access) {
      compositeId = (await client.query<{ id: number }>(
        `INSERT INTO mcp_composites (
           name, description, included_bundle_ids, tool_allow_patterns, tool_deny_patterns, enabled
         ) VALUES ($1, $2, $3, $4, $5, true)
         ON CONFLICT (name) DO UPDATE SET
           description = EXCLUDED.description,
           included_bundle_ids = EXCLUDED.included_bundle_ids,
           tool_allow_patterns = EXCLUDED.tool_allow_patterns,
           tool_deny_patterns = EXCLUDED.tool_deny_patterns,
           enabled = true,
           updated_at = now()
         RETURNING id`,
        [
          manifest.spec.access.compositeName,
          manifest.spec.access.description,
          bundleIds,
          manifest.spec.access.toolAllowPatterns,
          manifest.spec.access.toolDenyPatterns,
        ],
      )).rows[0]!.id;
    }
    const profile = await saveFabricProfile(client, manifest, input.actor, 'imported', bundleIds, true, input.mappings ?? {});
    const groupBindings = await reconcileFabricProfileGroupBindings(
      client,
      profile.id,
      compositeId,
      plan.resolved.groups,
    );
  return { profile, bundleIds, compositeId, groupBindings };
}

export async function applyFabricProfile(
  pool: pg.Pool,
  input: ApplyFabricProfileInput,
): Promise<AppliedFabricProfile> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await applyFabricProfileInTransaction(client, input);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function applyApprovedFabricProfileRestore(
  pool: pg.Pool,
  input: { requestId: string; actor: string },
): Promise<AppliedFabricProfile & { restoreRequest: FabricProfileRestoreRequest }> {
  const client = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    const request = await loadFabricProfileRestoreRequest(client, input.requestId, true);
    if (!request) throw new Error('Restore request was not found');
    if (request.status !== 'approved') throw new Error('Restore request must be approved before it can be applied');
    const head = (await client.query<{ revision: number; manifest_digest: string }>(
      'SELECT revision, manifest_digest FROM mcp_fabric_profiles WHERE id=$1 FOR UPDATE',
      [request.profileId],
    )).rows[0];
    if (!head || Number(head.revision) !== request.requestedFromRevision
      || head.manifest_digest !== request.requestedFromManifestDigest) {
      await client.query(
        `UPDATE mcp_fabric_profile_restore_requests SET status='stale', updated_at=now() WHERE id=$1`,
        [request.id],
      );
      await client.query('COMMIT');
      committed = true;
      throw new Error('Restore request is stale because the Bundle Set changed after approval was requested');
    }
    const target = await getFabricProfileVersion(client, request.profileId, request.targetRevision);
    if (!target || target.manifestDigest !== request.targetManifestDigest) {
      throw new Error('Immutable restore target failed digest verification');
    }
    const plan = await planFabricProfileImport(client, target.manifest, request.mappings);
    if (plan.blockers.length > 0 || plan.planToken !== request.planToken) {
      await client.query(
        `UPDATE mcp_fabric_profile_restore_requests SET status='stale', updated_at=now() WHERE id=$1`,
        [request.id],
      );
      await client.query('COMMIT');
      committed = true;
      throw new Error('Restore request is stale because the live Fabric no longer matches its approved preview');
    }
    const applied = await applyFabricProfileInTransaction(client, {
      manifest: target.manifest,
      mappings: request.mappings,
      planToken: request.planToken,
      actor: input.actor,
    });
    await client.query(
      `UPDATE mcp_fabric_profile_restore_requests
          SET status='applied', applied_at=now(), updated_at=now()
        WHERE id=$1`,
      [request.id],
    );
    const restored = await loadFabricProfileRestoreRequest(client, request.id);
    await client.query('COMMIT');
    committed = true;
    return { ...applied, restoreRequest: restored! };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function auditScope(context: FabricProfileAuditContext): CanonicalAuditScope {
  return { environment: context.environment, workspaceKey: 'default', tenantKey: 'default' };
}

function profileSummary(profile: FabricProfileRecord) {
  return {
    id: profile.id,
    name: profile.name,
    version: profile.manifestVersion,
    revision: profile.revision,
    manifestDigest: profile.manifestDigest,
    source: profile.source,
    installedBundleIds: profile.installedBundleIds,
    lastAppliedAt: profile.lastAppliedAt,
  };
}

function profileAuditEvent(
  context: FabricProfileAuditContext,
  action: string,
  risk: 'low' | 'medium' | 'high' | 'critical',
  resource: { id: string; revision?: string | null },
  payload: CanonicalAuditEventInput['payload'],
  policyDecision: string,
): Omit<CanonicalAuditEventInput, 'producer'> {
  return {
    ...auditScope(context),
    solution: 'argus.core',
    actor: context.actor,
    action,
    outcome: 'success',
    risk,
    resource: { type: 'mcp_fabric_profile', ...resource },
    policy: { id: 'argus.mcp-fabric.portable-profile', version: '1', decision: policyDecision },
    correlation: {
      requestId: context.requestId ?? context.producerEventId,
      traceId: context.traceId ?? null,
      spanId: context.spanId ?? null,
    },
    payload,
    retentionClass: 'business-audit-governance',
  };
}

export async function exportFabricProfileAudited(
  pool: pg.Pool,
  input: Parameters<typeof exportFabricProfile>[1] & { actor: string; audit: FabricProfileAuditContext },
): Promise<{ profile: FabricProfileRecord; auditEvent: CanonicalAuditEventSummary; replayed: boolean }> {
  const scope = auditScope(input.audit);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'mcp.fabric.profile.export', eventId: input.audit.producerEventId },
    scope,
    async client => {
      const before = await getFabricProfileByName(client, input.name);
      const manifest = await exportFabricProfile(client, input);
      const profile = await saveFabricProfile(client, manifest, input.actor, 'local', input.bundleIds, false);
      return { before, profile };
    },
    result => profileAuditEvent(
      input.audit,
      'mcp.fabric_profile.exported',
      'medium',
      { id: String(result.profile.id), revision: result.profile.manifestDigest },
      { before: result.before ? profileSummary(result.before) : null, after: profileSummary(result.profile) },
      'portable_secret_free_export',
    ),
  );
  const profile = outcome.result?.profile ?? await getFabricProfileByName(pool, input.name);
  if (!profile) throw new Error('Fabric profile export replay could not resolve its stored profile');
  return { profile, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function planFabricProfileImportAudited(
  pool: pg.Pool,
  manifestValue: unknown,
  mappings: FabricProfileMappings,
  audit: FabricProfileAuditContext,
): Promise<{ plan: FabricProfilePlan; auditEvent: CanonicalAuditEventSummary; replayed: boolean }> {
  const manifest = validateFabricProfileManifest(manifestValue);
  const scope = auditScope(audit);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'mcp.fabric.profile.import-preview', eventId: audit.producerEventId },
    scope,
    client => planFabricProfileImport(client, manifest, mappings),
    plan => profileAuditEvent(
      audit,
      'mcp.fabric_profile.import_previewed',
      'low',
      { id: manifest.metadata.name, revision: plan.manifestDigest },
      { after: {
        manifestDigest: plan.manifestDigest,
        actionCount: plan.actions.length,
        blockerCount: plan.blockers.length,
        blockerCodes: [...new Set(plan.blockers.map(blocker => blocker.code))],
      } },
      plan.blockers.length > 0 ? 'blocked' : 'dry_run_validated',
    ),
  );
  const plan = outcome.result ?? await planFabricProfileImport(pool, manifest, mappings);
  return { plan, auditEvent: outcome.event, replayed: outcome.replayed };
}

async function readAppliedFabricProfile(pool: pg.Pool, profileName: string): Promise<AppliedFabricProfile | null> {
  const profile = await getFabricProfileByName(pool, profileName);
  if (!profile) return null;
  const access = profile.manifest.spec.access;
  const compositeId = access == null ? null : Number((await pool.query<{ id: number }>(
    'SELECT id FROM mcp_composites WHERE name=$1', [access.compositeName],
  )).rows[0]?.id ?? 0) || null;
  const groupBindings = (await pool.query<{
    logical_name: string; group_name: string; composite_id: number;
  }>(
    `SELECT logical_name, group_name, composite_id FROM mcp_fabric_profile_group_bindings
      WHERE profile_id=$1 ORDER BY logical_name`, [profile.id],
  )).rows.map(binding => ({
    logicalName: binding.logical_name, groupName: binding.group_name, compositeId: Number(binding.composite_id),
  }));
  return { profile, bundleIds: profile.installedBundleIds, compositeId, groupBindings };
}

export async function applyFabricProfileAudited(
  pool: pg.Pool,
  input: ApplyFabricProfileInput & { audit: FabricProfileAuditContext },
): Promise<AppliedFabricProfile & { auditEvent: CanonicalAuditEventSummary; replayed: boolean }> {
  const manifest = validateFabricProfileManifest(input.manifest);
  const scope = auditScope(input.audit);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'mcp.fabric.profile.apply', eventId: input.audit.producerEventId },
    scope,
    async client => {
      const before = await getFabricProfileByName(client, manifest.metadata.name);
      const applied = await applyFabricProfileInTransaction(client, input);
      return { before, applied };
    },
    result => profileAuditEvent(
      input.audit,
      'mcp.fabric_profile.applied',
      'high',
      { id: String(result.applied.profile.id), revision: result.applied.profile.manifestDigest },
      {
        before: result.before ? profileSummary(result.before) : null,
        after: {
          ...profileSummary(result.applied.profile),
          compositeId: result.applied.compositeId,
          groupBindings: result.applied.groupBindings,
        },
        context: { planBindingDigest: createHash('sha256').update(input.planToken).digest('hex') },
      },
      'admin_authorized_and_plan_bound',
    ),
  );
  const applied = outcome.result?.applied ?? await readAppliedFabricProfile(pool, manifest.metadata.name);
  if (!applied) throw new Error('Fabric profile apply replay could not resolve its applied state');
  return { ...applied, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function checkFabricProfileDriftAudited(
  pool: pg.Pool,
  profileId: number,
  audit: FabricProfileAuditContext,
): Promise<{ drift: FabricProfileDrift; auditEvent: CanonicalAuditEventSummary; replayed: boolean }> {
  const scope = auditScope(audit);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'mcp.fabric.profile.drift-check', eventId: audit.producerEventId },
    scope,
    async client => {
      const profile = await getFabricProfile(client, profileId);
      if (!profile) throw new Error('Fabric profile was not found');
      const drift = await detectFabricProfileDrift(client, profile);
      await persistFabricProfileDriftSnapshot(client, drift, 'manual');
      return drift;
    },
    drift => profileAuditEvent(
      audit,
      'mcp.fabric_profile.drift_checked',
      drift.status === 'drifted' ? 'high' : 'medium',
      { id: String(drift.profileId), revision: drift.manifestDigest },
      { after: {
        status: drift.status,
        counts: drift.counts,
        findingCodes: [...new Set(drift.findings.map(finding => finding.code))],
      } },
      drift.status,
    ),
  );
  let drift = outcome.result;
  if (!drift) {
    const profile = await getFabricProfile(pool, profileId);
    if (!profile) throw new Error('Fabric profile drift replay could not resolve its profile');
    drift = await detectFabricProfileDrift(pool, profile);
  }
  return { drift, auditEvent: outcome.event, replayed: outcome.replayed };
}
