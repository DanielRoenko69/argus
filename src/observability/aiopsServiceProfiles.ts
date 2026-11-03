import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventSummary,
} from '../audit/canonicalAuditTypes.js';
import {
  AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
  aiOpsServiceProfileReadinessSchema,
  hashAiOpsServiceProfileConfig,
  parseAiOpsServiceProfileConfig,
  type AiOpsServiceProfileConfig,
  type AiOpsServiceProfileReadiness,
  type AiOpsServiceProfileResource,
} from './aiopsServiceProfileContracts.js';

export const DEFAULT_AIOPS_WORKSPACE_KEY = 'default';
export const DEFAULT_AIOPS_TENANT_KEY = 'default';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;
type ProfileStatus = AiOpsServiceProfileResource['status'];
type ProfileAction = AiOpsServiceProfileResource['allowedActions'][number];

export interface AiOpsProfileActorSnapshot {
  id: number;
  username: string;
}

export interface AiOpsProfileScope {
  workspaceKey?: string;
  tenantKey?: string;
}

export interface AiOpsProfileAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
}

export interface AiOpsServiceProfileRecord {
  id: number;
  status: ProfileStatus;
  activeRevision: { revision: number; sha256: string } | null;
  latestRevision: AiOpsServiceProfileResource['latestRevision'];
  createdAt: string;
  updatedAt: string;
}

export interface AiOpsProfileValidationRecord {
  id: number;
  profileId: number;
  revision: number;
  profileSha256: string;
  status: 'passed' | 'warning' | 'failed';
  readiness: AiOpsServiceProfileReadiness;
  validatedBy: AiOpsProfileActorSnapshot;
  validatedAt: string;
}

export type AiOpsServiceProfileRevision = AiOpsServiceProfileResource['latestRevision'];

export interface AuditedAiOpsMutationResult<T> {
  value: T;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

export class AiOpsServiceProfileError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly code: 'forbidden' | 'not_found' | 'revision_conflict' | 'validation_required' | 'identity_conflict' | 'invalid_profile',
    message: string,
  ) {
    super(message);
    this.name = 'AiOpsServiceProfileError';
  }
}

type ProfileRow = {
  id: number | string;
  status: ProfileStatus;
  active_revision: number | string | null;
  active_sha256: string | null;
  latest_revision: number | string;
  latest_sha256: string;
  latest_profile_json: unknown;
  latest_created_at: string | Date;
  latest_created_by_actor_id: number | string;
  latest_created_by_username: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type ValidationRow = {
  id: number | string;
  profile_id: number | string;
  revision: number | string;
  profile_sha256: string;
  status: 'passed' | 'warning' | 'failed';
  readiness_json: unknown;
  validated_by_actor_id: number | string;
  validated_by_username: string;
  validated_at: string | Date;
};

const PROFILE_SELECT = `
  SELECT profile.id, profile.status, profile.active_revision,
         active_revision.profile_sha256 AS active_sha256,
         latest.revision AS latest_revision,
         latest.profile_sha256 AS latest_sha256,
         latest.profile_json AS latest_profile_json,
         latest.created_at AS latest_created_at,
         latest.created_by_actor_id AS latest_created_by_actor_id,
         latest.created_by_username AS latest_created_by_username,
         profile.created_at, profile.updated_at
    FROM mcp_observability_aiops_service_profiles profile
    JOIN LATERAL (
      SELECT revision, profile_sha256, profile_json, created_at,
             created_by_actor_id, created_by_username
        FROM mcp_observability_aiops_service_profile_revisions
       WHERE profile_id=profile.id
       ORDER BY revision DESC
       LIMIT 1
    ) latest ON true
    LEFT JOIN mcp_observability_aiops_service_profile_revisions active_revision
      ON active_revision.profile_id=profile.id
     AND active_revision.revision=profile.active_revision`;

function scopeValues(scope: AiOpsProfileScope): { workspaceKey: string; tenantKey: string } {
  return {
    workspaceKey: scope.workspaceKey?.trim() || DEFAULT_AIOPS_WORKSPACE_KEY,
    tenantKey: scope.tenantKey?.trim() || DEFAULT_AIOPS_TENANT_KEY,
  };
}

function positiveSafeInteger(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} is outside the safe integer range`);
  return parsed;
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function mapProfile(row: ProfileRow): AiOpsServiceProfileRecord {
  const latestRevision = positiveSafeInteger(row.latest_revision, 'latest revision');
  const activeRevision = row.active_revision == null
    ? null
    : {
      revision: positiveSafeInteger(row.active_revision, 'active revision'),
      sha256: row.active_sha256 ?? '',
    };
  if (activeRevision && !/^[a-f0-9]{64}$/.test(activeRevision.sha256)) {
    throw new Error('active AIOps profile revision has an invalid content hash');
  }
  return {
    id: positiveSafeInteger(row.id, 'profile id'),
    status: row.status,
    activeRevision,
    latestRevision: {
      revision: latestRevision,
      sha256: row.latest_sha256,
      config: parseAiOpsServiceProfileConfig(row.latest_profile_json),
      createdAt: iso(row.latest_created_at),
      createdBy: {
        id: positiveSafeInteger(row.latest_created_by_actor_id, 'profile revision actor id'),
        username: row.latest_created_by_username,
      },
    },
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapValidation(row: ValidationRow): AiOpsProfileValidationRecord {
  return {
    id: positiveSafeInteger(row.id, 'validation id'),
    profileId: positiveSafeInteger(row.profile_id, 'profile id'),
    revision: positiveSafeInteger(row.revision, 'revision'),
    profileSha256: row.profile_sha256,
    status: row.status,
    readiness: aiOpsServiceProfileReadinessSchema.parse(row.readiness_json),
    validatedBy: {
      id: positiveSafeInteger(row.validated_by_actor_id, 'validation actor id'),
      username: row.validated_by_username,
    },
    validatedAt: iso(row.validated_at),
  };
}

export function toAiOpsServiceProfileResource(
  record: AiOpsServiceProfileRecord,
  options: {
    tags?: AiOpsServiceProfileResource['tags'];
    allowedActions?: ProfileAction[];
  } = {},
): AiOpsServiceProfileResource {
  return {
    schemaVersion: AIOPS_SERVICE_PROFILE_SCHEMA_VERSION,
    kind: 'aiops-service-profile',
    ...record,
    tags: options.tags ?? [],
    allowedActions: options.allowedActions ?? ['read'],
  };
}

export async function listAiOpsServiceProfiles(
  pool: Queryable,
  scope: AiOpsProfileScope = {},
  options: { includeArchived?: boolean } = {},
): Promise<AiOpsServiceProfileRecord[]> {
  const { workspaceKey, tenantKey } = scopeValues(scope);
  const result = await pool.query<ProfileRow>(
    `${PROFILE_SELECT}
      WHERE profile.workspace_key=$1 AND profile.tenant_key=$2
        AND ($3::boolean OR profile.status <> 'archived')
      ORDER BY lower((latest.profile_json->'service'->>'displayName')),
               lower(profile.environment), profile.id
      LIMIT 200`,
    [workspaceKey, tenantKey, options.includeArchived ?? false],
  );
  return result.rows.map(mapProfile);
}

export async function getAiOpsServiceProfile(
  pool: Queryable,
  profileId: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRecord> {
  const { workspaceKey, tenantKey } = scopeValues(scope);
  const result = await pool.query<ProfileRow>(
    `${PROFILE_SELECT}
      WHERE profile.id=$1 AND profile.workspace_key=$2 AND profile.tenant_key=$3`,
    [profileId, workspaceKey, tenantKey],
  );
  const row = result.rows[0];
  if (!row) throw new AiOpsServiceProfileError(404, 'not_found', 'AIOps service profile not found');
  return mapProfile(row);
}

export async function listAiOpsServiceProfileRevisions(
  pool: Queryable,
  profileId: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRevision[]> {
  await getAiOpsServiceProfile(pool, profileId, scope);
  const result = await pool.query<{
    revision: number | string;
    profile_sha256: string;
    profile_json: unknown;
    created_at: string | Date;
    created_by_actor_id: number | string;
    created_by_username: string;
  }>(
    `SELECT revision, profile_sha256, profile_json, created_at,
            created_by_actor_id, created_by_username
       FROM mcp_observability_aiops_service_profile_revisions
      WHERE profile_id=$1
      ORDER BY revision DESC
      LIMIT 100`,
    [profileId],
  );
  return result.rows.map(row => ({
    revision: positiveSafeInteger(row.revision, 'profile revision'),
    sha256: row.profile_sha256,
    config: parseAiOpsServiceProfileConfig(row.profile_json),
    createdAt: iso(row.created_at),
    createdBy: {
      id: positiveSafeInteger(row.created_by_actor_id, 'profile revision actor id'),
      username: row.created_by_username,
    },
  }));
}

export async function getAiOpsServiceProfileRevision(
  pool: Queryable,
  profileId: number,
  revision: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRevision> {
  await getAiOpsServiceProfile(pool, profileId, scope);
  const result = await pool.query<{
    revision: number | string;
    profile_sha256: string;
    profile_json: unknown;
    created_at: string | Date;
    created_by_actor_id: number | string;
    created_by_username: string;
  }>(
    `SELECT revision, profile_sha256, profile_json, created_at,
            created_by_actor_id, created_by_username
       FROM mcp_observability_aiops_service_profile_revisions
      WHERE profile_id=$1 AND revision=$2`,
    [profileId, revision],
  );
  const row = result.rows[0];
  if (!row) throw new AiOpsServiceProfileError(404, 'not_found', 'AIOps service profile revision not found');
  return {
    revision: positiveSafeInteger(row.revision, 'profile revision'),
    sha256: row.profile_sha256,
    config: parseAiOpsServiceProfileConfig(row.profile_json),
    createdAt: iso(row.created_at),
    createdBy: {
      id: positiveSafeInteger(row.created_by_actor_id, 'profile revision actor id'),
      username: row.created_by_username,
    },
  };
}

async function lockedProfileIdentity(
  client: Queryable,
  profileId: number,
  scope: AiOpsProfileScope,
): Promise<{ serviceName: string; environment: string; latestRevision: number; latestSha256: string }> {
  const { workspaceKey, tenantKey } = scopeValues(scope);
  const result = await client.query<{
    service_name: string;
    environment: string;
    latest_revision: number | string;
    latest_sha256: string;
  }>(
    `SELECT profile.service_name, profile.environment,
            latest.revision AS latest_revision, latest.profile_sha256 AS latest_sha256
       FROM mcp_observability_aiops_service_profiles profile
       JOIN LATERAL (
         SELECT revision, profile_sha256
           FROM mcp_observability_aiops_service_profile_revisions
          WHERE profile_id=profile.id
          ORDER BY revision DESC LIMIT 1
       ) latest ON true
      WHERE profile.id=$1 AND profile.workspace_key=$2 AND profile.tenant_key=$3
      FOR UPDATE OF profile`,
    [profileId, workspaceKey, tenantKey],
  );
  const row = result.rows[0];
  if (!row) throw new AiOpsServiceProfileError(404, 'not_found', 'AIOps service profile not found');
  return {
    serviceName: row.service_name,
    environment: row.environment,
    latestRevision: positiveSafeInteger(row.latest_revision, 'latest revision'),
    latestSha256: row.latest_sha256,
  };
}

export async function createAiOpsServiceProfileRecord(
  client: Queryable,
  configValue: unknown,
  actor: AiOpsProfileActorSnapshot,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRecord> {
  const config = parseAiOpsServiceProfileConfig(configValue);
  const profileSha256 = hashAiOpsServiceProfileConfig(config);
  const { workspaceKey, tenantKey } = scopeValues(scope);
  try {
    const profile = await client.query<{ id: number | string }>(
      `INSERT INTO mcp_observability_aiops_service_profiles
         (workspace_key, tenant_key, service_name, environment, display_name,
          description, status, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,'draft',$7)
       RETURNING id`,
      [
        workspaceKey,
        tenantKey,
        config.service.serviceName,
        config.service.environment,
        config.service.displayName,
        config.service.description ?? '',
        actor.id,
      ],
    );
    const profileId = positiveSafeInteger(profile.rows[0]!.id, 'profile id');
    await client.query(
      `INSERT INTO mcp_observability_aiops_service_profile_revisions
         (profile_id, revision, schema_version, profile_sha256, profile_json,
          created_by_user_id, created_by_actor_id, created_by_username)
       VALUES ($1,1,$2,$3,$4::jsonb,$5,$5,$6)`,
      [profileId, AIOPS_SERVICE_PROFILE_SCHEMA_VERSION, profileSha256, JSON.stringify(config), actor.id, actor.username],
    );
    return getAiOpsServiceProfile(client, profileId, scope);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw new AiOpsServiceProfileError(
        409,
        'identity_conflict',
        'An AIOps service profile already exists for this service and environment',
      );
    }
    throw error;
  }
}

export async function appendAiOpsServiceProfileRevisionRecord(
  client: Queryable,
  profileId: number,
  expectedLatestRevision: number,
  configValue: unknown,
  actor: AiOpsProfileActorSnapshot,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRecord> {
  const config = parseAiOpsServiceProfileConfig(configValue);
  const identity = await lockedProfileIdentity(client, profileId, scope);
  if (identity.latestRevision !== expectedLatestRevision) {
    throw new AiOpsServiceProfileError(409, 'revision_conflict', 'The AIOps service profile has a newer revision');
  }
  if (config.service.serviceName !== identity.serviceName || config.service.environment !== identity.environment) {
    throw new AiOpsServiceProfileError(
      409,
      'identity_conflict',
      'Service name and environment are immutable; clone the profile to change its identity',
    );
  }
  const profileSha256 = hashAiOpsServiceProfileConfig(config);
  if (profileSha256 === identity.latestSha256) {
    throw new AiOpsServiceProfileError(409, 'revision_conflict', 'The submitted profile is identical to the latest revision');
  }
  const revision = identity.latestRevision + 1;
  await client.query(
    `INSERT INTO mcp_observability_aiops_service_profile_revisions
       (profile_id, revision, schema_version, profile_sha256, profile_json,
        created_by_user_id, created_by_actor_id, created_by_username)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6,$7)`,
    [profileId, revision, AIOPS_SERVICE_PROFILE_SCHEMA_VERSION, profileSha256, JSON.stringify(config), actor.id, actor.username],
  );
  await client.query(
    `UPDATE mcp_observability_aiops_service_profiles
        SET display_name=$2, description=$3
      WHERE id=$1`,
    [profileId, config.service.displayName, config.service.description ?? ''],
  );
  return getAiOpsServiceProfile(client, profileId, scope);
}

export async function recordAiOpsServiceProfileValidationRecord(
  client: Queryable,
  readinessValue: unknown,
  actor: AiOpsProfileActorSnapshot,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsProfileValidationRecord> {
  const readiness = aiOpsServiceProfileReadinessSchema.parse(readinessValue);
  const profile = await getAiOpsServiceProfile(client, readiness.profileId, scope);
  const revisionResult = await client.query<{ profile_sha256: string }>(
    `SELECT profile_sha256
       FROM mcp_observability_aiops_service_profile_revisions
      WHERE profile_id=$1 AND revision=$2`,
    [readiness.profileId, readiness.revision],
  );
  const revision = revisionResult.rows[0];
  if (!revision || revision.profile_sha256 !== readiness.profileSha256) {
    throw new AiOpsServiceProfileError(409, 'revision_conflict', 'Readiness does not match the stored profile revision');
  }
  if (profile.id !== readiness.profileId) {
    throw new AiOpsServiceProfileError(404, 'not_found', 'AIOps service profile not found');
  }
  const status = readiness.state === 'ready' ? 'passed' : readiness.state === 'degraded' ? 'warning' : 'failed';
  const result = await client.query<ValidationRow>(
    `INSERT INTO mcp_observability_aiops_profile_validations
       (profile_id, revision, profile_sha256, status, readiness_json,
        validated_by_user_id, validated_by_actor_id, validated_by_username)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6,$7)
     RETURNING *`,
    [readiness.profileId, readiness.revision, readiness.profileSha256, status, JSON.stringify(readiness), actor.id, actor.username],
  );
  return mapValidation(result.rows[0]!);
}

export async function activateAiOpsServiceProfileRecord(
  client: Queryable,
  profileId: number,
  revision: number,
  expectedLatestRevision: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRecord> {
  const identity = await lockedProfileIdentity(client, profileId, scope);
  if (identity.latestRevision !== expectedLatestRevision || revision > identity.latestRevision) {
    throw new AiOpsServiceProfileError(409, 'revision_conflict', 'The AIOps service profile revision changed');
  }
  const validation = await client.query<{ status: 'passed' | 'warning' | 'failed'; profile_sha256: string; profile_json: unknown }>(
    `SELECT validation.status, validation.profile_sha256, revision.profile_json
       FROM mcp_observability_aiops_profile_validations validation
       JOIN mcp_observability_aiops_service_profile_revisions revision
         ON revision.profile_id=validation.profile_id
        AND revision.revision=validation.revision
        AND revision.profile_sha256=validation.profile_sha256
      WHERE validation.profile_id=$1 AND validation.revision=$2
      ORDER BY validation.validated_at DESC, validation.id DESC
      LIMIT 1`,
    [profileId, revision],
  );
  if (!validation.rows[0] || validation.rows[0].status === 'failed') {
    throw new AiOpsServiceProfileError(
      422,
      'validation_required',
      'The exact AIOps service profile revision must pass validation before activation',
    );
  }
  const activatingConfig = parseAiOpsServiceProfileConfig(validation.rows[0].profile_json);
  const alertRuleIds = activatingConfig.detection.autoInvestigate
    ? activatingConfig.detection.nativeAlertRuleIds
    : [];
  if (alertRuleIds.length > 0) {
    const { workspaceKey, tenantKey } = scopeValues(scope);
    const conflicts = await client.query<{ id: number | string; service_name: string; environment: string }>(
      `SELECT other.id, other.service_name, other.environment
         FROM mcp_observability_aiops_service_profiles other
         JOIN mcp_observability_aiops_service_profile_revisions other_revision
           ON other_revision.profile_id=other.id
          AND other_revision.revision=other.active_revision
        WHERE other.id <> $1
          AND other.workspace_key=$2
          AND other.tenant_key=$3
          AND other.status='active'
          AND COALESCE((other_revision.profile_json #>> '{detection,autoInvestigate}')::boolean, false)
          AND EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(
                COALESCE(other_revision.profile_json #> '{detection,nativeAlertRuleIds}', '[]'::jsonb)
              ) alert_rule_id
             WHERE alert_rule_id::bigint = ANY($4::bigint[])
          )
        LIMIT 1`,
      [profileId, workspaceKey, tenantKey, alertRuleIds],
    );
    if (conflicts.rows[0]) {
      const conflict = conflicts.rows[0];
      throw new AiOpsServiceProfileError(
        409,
        'identity_conflict',
        `Native alert rule is already assigned to active profile ${conflict.service_name}/${conflict.environment} (#${conflict.id})`,
      );
    }
  }
  await client.query(
    `UPDATE mcp_observability_aiops_service_profiles
        SET status='active', active_revision=$2
      WHERE id=$1`,
    [profileId, revision],
  );
  return getAiOpsServiceProfile(client, profileId, scope);
}

export async function setAiOpsServiceProfileStatusRecord(
  client: Queryable,
  profileId: number,
  status: 'paused' | 'archived',
  expectedLatestRevision: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsServiceProfileRecord> {
  const identity = await lockedProfileIdentity(client, profileId, scope);
  if (identity.latestRevision !== expectedLatestRevision) {
    throw new AiOpsServiceProfileError(409, 'revision_conflict', 'The AIOps service profile has a newer revision');
  }
  await client.query(
    `UPDATE mcp_observability_aiops_service_profiles SET status=$2 WHERE id=$1`,
    [profileId, status],
  );
  return getAiOpsServiceProfile(client, profileId, scope);
}

function auditSnapshot(record: AiOpsServiceProfileRecord): Record<string, unknown> {
  return {
    profileId: record.id,
    status: record.status,
    serviceName: record.latestRevision.config.service.serviceName,
    environment: record.latestRevision.config.service.environment,
    latestRevision: record.latestRevision.revision,
    latestSha256: record.latestRevision.sha256,
    activeRevision: record.activeRevision,
  };
}

function isAiOpsServiceProfileRecord(
  value: AiOpsServiceProfileRecord | AiOpsProfileValidationRecord,
): value is AiOpsServiceProfileRecord {
  return 'latestRevision' in value && 'activeRevision' in value;
}

function auditBase(
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope,
  action: string,
  record: AiOpsServiceProfileRecord,
  before: unknown,
) {
  const { workspaceKey, tenantKey } = scopeValues(scope);
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey,
    solution: 'argus.aiops',
    actor: context.actor,
    action,
    outcome: 'success' as const,
    risk: action.endsWith('.activated') || action.endsWith('.archived') ? 'medium' as const : 'low' as const,
    resource: {
      type: 'aiops_service_profile',
      id: String(record.id),
      revision: `${record.latestRevision.revision}:${record.latestRevision.sha256}`,
    },
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload: { before, after: auditSnapshot(record) },
  };
}

async function auditedMutation<T extends AiOpsServiceProfileRecord | AiOpsProfileValidationRecord>(
  pool: pg.Pool,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope,
  producerName: string,
  action: string,
  mutate: (client: pg.PoolClient) => Promise<{ value: T; before: unknown }>,
  replay: (resourceId: number) => Promise<T>,
): Promise<AuditedAiOpsMutationResult<T>> {
  const normalizedScope = scopeValues(scope);
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: producerName, eventId: context.producerEventId },
    { environment: context.environment, ...normalizedScope },
    mutate,
    result => {
      const profile = isAiOpsServiceProfileRecord(result.value) ? result.value : null;
      if (profile) return auditBase(context, scope, action, profile, result.before);
      const validation = result.value as AiOpsProfileValidationRecord;
      return {
        environment: context.environment,
        ...normalizedScope,
        solution: 'argus.aiops',
        actor: context.actor,
        action,
        outcome: 'success' as const,
        risk: 'low' as const,
        resource: {
          type: 'aiops_service_profile',
          id: String(validation.profileId),
          revision: `${validation.revision}:${validation.profileSha256}`,
        },
        correlation: { requestId: context.requestId ?? context.producerEventId },
        payload: {
          before: result.before,
          after: {
            validationId: validation.id,
            status: validation.status,
            profileId: validation.profileId,
            revision: validation.revision,
            profileSha256: validation.profileSha256,
          },
        },
      };
    },
  );
  const resourceId = Number(outcome.event.resource.id);
  const value = outcome.result?.value ?? await replay(resourceId);
  return { value, auditEvent: outcome.event, replayed: outcome.replayed };
}

export async function createAiOpsServiceProfileAudited(
  pool: pg.Pool,
  config: unknown,
  actor: AiOpsProfileActorSnapshot,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsServiceProfileRecord>> {
  return auditedMutation(
    pool,
    context,
    scope,
    'aiops.service_profile.create',
    'aiops.service_profile.created',
    async client => ({ value: await createAiOpsServiceProfileRecord(client, config, actor, scope), before: null }),
    profileId => getAiOpsServiceProfile(pool, profileId, scope),
  );
}

export async function reviseAiOpsServiceProfileAudited(
  pool: pg.Pool,
  profileId: number,
  expectedLatestRevision: number,
  config: unknown,
  actor: AiOpsProfileActorSnapshot,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsServiceProfileRecord>> {
  return auditedMutation(
    pool,
    context,
    scope,
    'aiops.service_profile.revise',
    'aiops.service_profile.revised',
    async client => {
      const before = auditSnapshot(await getAiOpsServiceProfile(client, profileId, scope));
      const value = await appendAiOpsServiceProfileRevisionRecord(
        client, profileId, expectedLatestRevision, config, actor, scope,
      );
      return { value, before };
    },
    resourceId => getAiOpsServiceProfile(pool, resourceId, scope),
  );
}

export async function validateAiOpsServiceProfileAudited(
  pool: pg.Pool,
  readiness: unknown,
  actor: AiOpsProfileActorSnapshot,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsProfileValidationRecord>> {
  const parsed = aiOpsServiceProfileReadinessSchema.parse(readiness);
  return auditedMutation(
    pool,
    context,
    scope,
    'aiops.service_profile.validate',
    'aiops.service_profile.validated',
    async client => ({
      value: await recordAiOpsServiceProfileValidationRecord(client, parsed, actor, scope),
      before: null,
    }),
    async () => {
      const latest = await getLatestAiOpsServiceProfileValidation(pool, parsed.profileId, parsed.revision, scope);
      if (!latest) throw new AiOpsServiceProfileError(404, 'not_found', 'AIOps profile validation not found');
      return latest;
    },
  );
}

export async function getLatestAiOpsServiceProfileValidation(
  pool: Queryable,
  profileId: number,
  revision: number,
  scope: AiOpsProfileScope = {},
): Promise<AiOpsProfileValidationRecord | null> {
  await getAiOpsServiceProfile(pool, profileId, scope);
  const result = await pool.query<ValidationRow>(
    `SELECT * FROM mcp_observability_aiops_profile_validations
      WHERE profile_id=$1 AND revision=$2
      ORDER BY validated_at DESC, id DESC LIMIT 1`,
    [profileId, revision],
  );
  return result.rows[0] ? mapValidation(result.rows[0]) : null;
}

export async function activateAiOpsServiceProfileAudited(
  pool: pg.Pool,
  profileId: number,
  revision: number,
  expectedLatestRevision: number,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsServiceProfileRecord>> {
  return auditedMutation(
    pool,
    context,
    scope,
    'aiops.service_profile.activate',
    'aiops.service_profile.activated',
    async client => {
      const before = auditSnapshot(await getAiOpsServiceProfile(client, profileId, scope));
      const value = await activateAiOpsServiceProfileRecord(
        client, profileId, revision, expectedLatestRevision, scope,
      );
      return { value, before };
    },
    resourceId => getAiOpsServiceProfile(pool, resourceId, scope),
  );
}

export async function setAiOpsServiceProfileStatusAudited(
  pool: pg.Pool,
  profileId: number,
  status: 'paused' | 'archived',
  expectedLatestRevision: number,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsServiceProfileRecord>> {
  return auditedMutation(
    pool,
    context,
    scope,
    `aiops.service_profile.${status}`,
    `aiops.service_profile.${status}`,
    async client => {
      const before = auditSnapshot(await getAiOpsServiceProfile(client, profileId, scope));
      const value = await setAiOpsServiceProfileStatusRecord(
        client, profileId, status, expectedLatestRevision, scope,
      );
      return { value, before };
    },
    resourceId => getAiOpsServiceProfile(pool, resourceId, scope),
  );
}

export async function cloneAiOpsServiceProfileAudited(
  pool: pg.Pool,
  sourceProfileId: number,
  config: unknown,
  actor: AiOpsProfileActorSnapshot,
  context: AiOpsProfileAuditContext,
  scope: AiOpsProfileScope = {},
): Promise<AuditedAiOpsMutationResult<AiOpsServiceProfileRecord>> {
  return auditedMutation(
    pool,
    context,
    scope,
    'aiops.service_profile.clone',
    'aiops.service_profile.created',
    async client => {
      const source = await getAiOpsServiceProfile(client, sourceProfileId, scope);
      const value = await createAiOpsServiceProfileRecord(client, config, actor, scope);
      return {
        value,
        before: {
          clonedFromProfileId: source.id,
          clonedFromRevision: source.latestRevision.revision,
          clonedFromSha256: source.latestRevision.sha256,
        },
      };
    },
    resourceId => getAiOpsServiceProfile(pool, resourceId, scope),
  );
}
