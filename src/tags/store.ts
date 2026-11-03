import type pg from 'pg';
import { executeCanonicalAuditedMutation } from '../audit/canonicalAuditStore.js';
import type {
  CanonicalAuditActor,
  CanonicalAuditEventSummary,
} from '../audit/canonicalAuditTypes.js';
import type { TaggableResourceType, TagRef, WorkspaceTag } from './types.js';
import { MAX_TAGS_PER_WORKSPACE, TagValidationError } from './validation.js';

export const DEFAULT_WORKSPACE_KEY = 'default';

type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export interface TagAuditContext {
  producerEventId: string;
  environment: string;
  actor: CanonicalAuditActor;
  requestId?: string | null;
}

export interface AuditedTagMutationResult<T> {
  value: T;
  before: unknown;
  auditEvent: CanonicalAuditEventSummary;
  replayed: boolean;
}

type TagRow = {
  id: string | number;
  slug: string;
  label: string;
  color: string | null;
  description: string;
  usage_count?: string | number;
  created_at: string | Date;
  updated_at: string | Date;
};

const RESOURCE_EXISTS_SQL: Readonly<Record<TaggableResourceType, string>> = Object.freeze({
  agent: `SELECT label FROM mcp_agents WHERE id=$1`,
  blueprint: `SELECT label FROM mcp_agent_templates WHERE id=$1`,
  public_widget: `SELECT COALESCE(greeting, slug) AS label FROM mcp_public_widgets WHERE id=$1`,
  knowledge_source: `SELECT label FROM mcp_rag_indexes WHERE id=$1`,
  repository_snapshot: `SELECT repository_key AS label FROM mcp_code_index_snapshots WHERE id=$1`,
  skill: `SELECT label FROM mcp_skills WHERE id=$1`,
  workflow: `SELECT name AS label FROM mcp_workflows WHERE id=$1 AND source <> 'template'`,
  workflow_template: `SELECT name AS label FROM mcp_workflows WHERE id=$1 AND source = 'template'`,
  mcp_connection: `SELECT name AS label FROM mcp_backends WHERE id=$1`,
  mcp_bundle: `SELECT label FROM mcp_service_bundles WHERE id=$1`,
  mcp_tool: `SELECT prefixed_name AS label FROM mcp_remote_tools WHERE id=$1`,
  mcp_capability: `SELECT name AS label FROM mcp_tools WHERE id=$1`,
  aiops_service_profile: `SELECT display_name AS label FROM mcp_observability_aiops_service_profiles WHERE id=$1`,
  ai_system: `SELECT display_name AS label FROM mcp_ai_systems WHERE id=$1`,
});

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function mapTag(row: TagRow): WorkspaceTag {
  return {
    id: String(row.id),
    slug: row.slug,
    label: row.label,
    color: row.color,
    description: row.description,
    usageCount: Number(row.usage_count ?? 0),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

export async function assertResourceExists(
  pool: Queryable,
  resourceType: TaggableResourceType,
  resourceId: string,
): Promise<string> {
  const result = await pool.query<{ label: string }>(RESOURCE_EXISTS_SQL[resourceType], [resourceId]);
  const row = result.rows[0];
  if (!row) throw new TagValidationError('resource not found', 404);
  return row.label;
}

export async function listWorkspaceTags(
  pool: pg.Pool,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
  query = '',
): Promise<WorkspaceTag[]> {
  const result = await pool.query<TagRow>(
    `SELECT tag.id, tag.slug, tag.label, tag.color, tag.description,
            tag.created_at, tag.updated_at, count(assignment.tag_id)::int AS usage_count
       FROM mcp_workspace_tags tag
       LEFT JOIN mcp_resource_tag_assignments assignment
         ON assignment.workspace_key=tag.workspace_key AND assignment.tag_id=tag.id
      WHERE tag.workspace_key=$1
        AND ($2='' OR lower(tag.label) LIKE '%' || lower($2) || '%'
                   OR lower(tag.slug) LIKE '%' || lower($2) || '%')
      GROUP BY tag.id
      ORDER BY lower(tag.label), tag.id
      LIMIT 200`,
    [workspaceKey, query],
  );
  return result.rows.map(mapTag);
}

export async function getWorkspaceTag(
  pool: Queryable,
  tagId: string,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<WorkspaceTag> {
  const result = await pool.query<TagRow>(
    `SELECT tag.id, tag.slug, tag.label, tag.color, tag.description,
            tag.created_at, tag.updated_at, count(assignment.tag_id)::int AS usage_count
       FROM mcp_workspace_tags tag
       LEFT JOIN mcp_resource_tag_assignments assignment
         ON assignment.workspace_key=tag.workspace_key AND assignment.tag_id=tag.id
      WHERE tag.workspace_key=$1 AND tag.id=$2
      GROUP BY tag.id`,
    [workspaceKey, tagId],
  );
  if (!result.rows[0]) throw new TagValidationError('tag not found', 404);
  return mapTag(result.rows[0]);
}

export async function createWorkspaceTag(
  pool: pg.Pool,
  input: { slug: string; label: string; color: string | null; description: string },
  actorUserId: number,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<WorkspaceTag> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tag = await createWorkspaceTagRecord(client, input, actorUserId, workspaceKey);
    await client.query('COMMIT');
    return tag;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') throw new TagValidationError('tag slug already exists', 409);
    throw error;
  } finally {
    client.release();
  }
}

async function createWorkspaceTagRecord(
  client: pg.PoolClient,
  input: { slug: string; label: string; color: string | null; description: string },
  actorUserId: number,
  workspaceKey: string,
): Promise<WorkspaceTag> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('argus-tags:' || $1))`, [workspaceKey]);
  const count = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM mcp_workspace_tags WHERE workspace_key=$1`,
    [workspaceKey],
  );
  if (Number(count.rows[0]?.count ?? 0) >= MAX_TAGS_PER_WORKSPACE) {
    throw new TagValidationError(`workspace tag limit of ${MAX_TAGS_PER_WORKSPACE} reached`, 409);
  }
  const result = await client.query<TagRow>(
    `INSERT INTO mcp_workspace_tags
       (workspace_key, slug, label, color, description, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, slug, label, color, description, 0::int AS usage_count, created_at, updated_at`,
    [workspaceKey, input.slug, input.label, input.color, input.description, actorUserId],
  );
  return mapTag(result.rows[0]!);
}

export async function updateWorkspaceTag(
  pool: Queryable,
  tagId: string,
  input: { label: string; color: string | null; description: string },
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<WorkspaceTag> {
  const result = await pool.query<TagRow>(
    `UPDATE mcp_workspace_tags
        SET label=$3, color=$4, description=$5
      WHERE workspace_key=$1 AND id=$2
      RETURNING id, slug, label, color, description,
        (SELECT count(*)::int FROM mcp_resource_tag_assignments assignment
          WHERE assignment.workspace_key=mcp_workspace_tags.workspace_key
            AND assignment.tag_id=mcp_workspace_tags.id) AS usage_count,
        created_at, updated_at`,
    [workspaceKey, tagId, input.label, input.color, input.description],
  );
  if (!result.rows[0]) throw new TagValidationError('tag not found', 404);
  return mapTag(result.rows[0]);
}

export async function deleteWorkspaceTag(
  pool: Queryable,
  tagId: string,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<boolean> {
  const result = await pool.query(
    `DELETE FROM mcp_workspace_tags WHERE workspace_key=$1 AND id=$2`,
    [workspaceKey, tagId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listResourceTags(
  pool: Queryable,
  resourceType: TaggableResourceType,
  resourceId: string,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<TagRef[]> {
  await assertResourceExists(pool, resourceType, resourceId);
  const result = await pool.query<{ id: string | number; label: string; color: string | null }>(
    `SELECT tag.id, tag.label, tag.color
       FROM mcp_resource_tag_assignments assignment
       JOIN mcp_workspace_tags tag
         ON tag.workspace_key=assignment.workspace_key AND tag.id=assignment.tag_id
      WHERE assignment.workspace_key=$1 AND assignment.resource_type=$2 AND assignment.resource_id=$3
      ORDER BY lower(tag.label), tag.id`,
    [workspaceKey, resourceType, resourceId],
  );
  return result.rows.map(row => ({ id: String(row.id), label: row.label, color: row.color }));
}

export async function replaceResourceTags(
  pool: pg.Pool,
  resourceType: TaggableResourceType,
  resourceId: string,
  tagIds: string[],
  actorUserId: number,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<TagRef[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tags = await replaceResourceTagsRecord(
      client, resourceType, resourceId, tagIds, actorUserId, workspaceKey,
    );
    await client.query('COMMIT');
    return tags;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function replaceResourceTagsRecord(
  client: pg.PoolClient,
  resourceType: TaggableResourceType,
  resourceId: string,
  tagIds: string[],
  actorUserId: number,
  workspaceKey: string,
): Promise<TagRef[]> {
  await assertResourceExists(client, resourceType, resourceId);
  if (tagIds.length > 0) {
    const found = await client.query<{ id: string | number }>(
      `SELECT id FROM mcp_workspace_tags WHERE workspace_key=$1 AND id=ANY($2::bigint[]) FOR SHARE`,
      [workspaceKey, tagIds],
    );
    if (found.rows.length !== tagIds.length) throw new TagValidationError('one or more tags were not found', 404);
  }
  await client.query(
    `DELETE FROM mcp_resource_tag_assignments
      WHERE workspace_key=$1 AND resource_type=$2 AND resource_id=$3`,
    [workspaceKey, resourceType, resourceId],
  );
  if (tagIds.length > 0) {
    await client.query(
      `INSERT INTO mcp_resource_tag_assignments
         (workspace_key, tag_id, resource_type, resource_id, assigned_by_user_id)
       SELECT $1, tag_id, $3, $4, $5
         FROM unnest($2::bigint[]) AS tag_id`,
      [workspaceKey, tagIds, resourceType, resourceId, actorUserId],
    );
  }
  return listResourceTags(client, resourceType, resourceId, workspaceKey);
}

function tagAuditBase(
  context: TagAuditContext,
  workspaceKey: string,
  action: string,
  resource: { type: string; id: string; revision?: string | null },
  payload: { before?: unknown; after?: unknown; context?: unknown },
) {
  return {
    environment: context.environment,
    workspaceKey,
    tenantKey: workspaceKey,
    solution: 'argus.core',
    actor: context.actor,
    action,
    outcome: 'success' as const,
    risk: 'medium' as const,
    resource,
    correlation: { requestId: context.requestId ?? context.producerEventId },
    payload,
  };
}

export async function createWorkspaceTagAudited(
  pool: pg.Pool,
  input: { slug: string; label: string; color: string | null; description: string },
  actorUserId: number,
  context: TagAuditContext,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<AuditedTagMutationResult<WorkspaceTag>> {
  try {
    const outcome = await executeCanonicalAuditedMutation(
      pool,
      { name: 'tags.create', eventId: context.producerEventId },
      { environment: context.environment, workspaceKey, tenantKey: workspaceKey },
      client => createWorkspaceTagRecord(client, input, actorUserId, workspaceKey),
      tag => tagAuditBase(context, workspaceKey, 'tag.created', { type: 'workspace_tag', id: tag.id, revision: tag.updatedAt }, {
        before: null, after: tag,
      }),
    );
    const value = outcome.result ?? await getWorkspaceTag(pool, outcome.event.resource.id, workspaceKey);
    return { value, before: null, auditEvent: outcome.event, replayed: outcome.replayed };
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new TagValidationError('tag slug already exists', 409);
    throw error;
  }
}

export async function updateWorkspaceTagAudited(
  pool: pg.Pool,
  tagId: string,
  input: { label: string; color: string | null; description: string },
  context: TagAuditContext,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<AuditedTagMutationResult<WorkspaceTag>> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'tags.update', eventId: context.producerEventId },
    { environment: context.environment, workspaceKey, tenantKey: workspaceKey },
    async client => {
      const before = await getWorkspaceTag(client, tagId, workspaceKey);
      const value = await updateWorkspaceTag(client, tagId, input, workspaceKey);
      return { before, value };
    },
    result => tagAuditBase(context, workspaceKey, 'tag.updated', {
      type: 'workspace_tag', id: result.value.id, revision: result.value.updatedAt,
    }, { before: result.before, after: result.value }),
  );
  const value = outcome.result?.value ?? await getWorkspaceTag(pool, outcome.event.resource.id, workspaceKey);
  return {
    value,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function deleteWorkspaceTagAudited(
  pool: pg.Pool,
  tagId: string,
  context: TagAuditContext,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<AuditedTagMutationResult<boolean>> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'tags.delete', eventId: context.producerEventId },
    { environment: context.environment, workspaceKey, tenantKey: workspaceKey },
    async client => {
      const before = await getWorkspaceTag(client, tagId, workspaceKey);
      if (!await deleteWorkspaceTag(client, tagId, workspaceKey)) throw new TagValidationError('tag not found', 404);
      return { before, value: true };
    },
    result => tagAuditBase(context, workspaceKey, 'tag.deleted', {
      type: 'workspace_tag', id: tagId, revision: result.before.updatedAt,
    }, { before: result.before, after: null }),
  );
  return {
    value: outcome.result?.value ?? true,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}

export async function replaceResourceTagsAudited(
  pool: pg.Pool,
  resourceType: TaggableResourceType,
  resourceId: string,
  tagIds: string[],
  actorUserId: number,
  context: TagAuditContext,
  workspaceKey = DEFAULT_WORKSPACE_KEY,
): Promise<AuditedTagMutationResult<TagRef[]>> {
  const outcome = await executeCanonicalAuditedMutation(
    pool,
    { name: 'tags.assignments.replace', eventId: context.producerEventId },
    { environment: context.environment, workspaceKey, tenantKey: workspaceKey },
    async client => {
      const before = await listResourceTags(client, resourceType, resourceId, workspaceKey);
      const value = await replaceResourceTagsRecord(
        client, resourceType, resourceId, tagIds, actorUserId, workspaceKey,
      );
      return { before, value };
    },
    result => tagAuditBase(context, workspaceKey, 'tag.assignments_replaced', {
      type: resourceType, id: resourceId,
    }, { before: { tags: result.before }, after: { tags: result.value } }),
  );
  const value = outcome.result?.value ?? await listResourceTags(pool, resourceType, resourceId, workspaceKey);
  return {
    value,
    before: outcome.result?.before ?? null,
    auditEvent: outcome.event,
    replayed: outcome.replayed,
  };
}
