# Resource Tags API v1

This contract is the Core-owned handoff for tag pickers, chips, filters and
search indexing. UI visibility never grants access; every endpoint enforces a
named permission again on the server.

## Persistence

- `mcp_workspace_tags` is the canonical bounded registry.
- `mcp_resource_tag_assignments` stores current many-to-many assignments.
- The first compatibility scope is `workspace_key = 'default'` because Argus
  Core does not yet expose a canonical workspace table. The column and unique
  constraints are already workspace-aware for that later migration.
- Assignment accepts only the closed `TaggableResourceType` union from
  `src/tags/types.ts` and verifies the referenced resource in its authoritative
  table before writing.
- A resource can have at most 20 tags and the compatibility workspace at most
  500 tags.
- Slugs are immutable after creation. Labels, colors and descriptions may be
  changed without rewriting historical run evidence.

## Permissions

| Operation | Permission | Same-origin required |
| --- | --- | --- |
| list registry or resource tags | `tags.read` | no |
| create, update or delete a tag | `tags.manage` | yes |
| replace a resource's assignments | `tags.manage` | yes |

This first route integration resolves the user's SSO-mapped Argus role through
the shared permission evaluator. Direct/group assignment persistence and
resource-scoped denies remain part of the broader ACCESS-007 endpoint migration;
the evaluator itself is already deny-first.

## Endpoints

All responses use `schemaVersion: 1`.

```text
GET    /api/ui/tags?q=<bounded-text>
POST   /api/ui/tags
PATCH  /api/ui/tags/:tagId
DELETE /api/ui/tags/:tagId

GET /api/ui/resources/:resourceType/:resourceId/tags
PUT /api/ui/resources/:resourceType/:resourceId/tags
```

Create body:

```json
{
  "slug": "payments",
  "label": "Payments",
  "color": "#7C3AED",
  "description": "Payments platform resources"
}
```

Replace-assignment body:

```json
{
  "tagIds": [12, 19]
}
```

The replacement is transactional: Core validates the resource, every tag and
all limits before removing the previous assignment set.

## Supported resource types

```text
agent
blueprint
public_widget
knowledge_source
repository_snapshot
skill
workflow
workflow_template
mcp_connection
mcp_bundle
mcp_tool
mcp_capability
aiops_service_profile
ai_system
```

## Historical evidence boundary

These endpoints expose current catalog state. Migration 219 freezes the
primary run resources and their current `TagRef` values atomically at insert:

- every visual Workflow execution stores the Workflow and all concretely
  resolved Agent assignments in `execution_snapshot.resourceRefs`;
- every native Agent trace with an `agent_id` stores the Agent in
  `metadata.resourceRefs`;
- later execution/telemetry updates preserve an existing `resourceRefs` array,
  even if an update attempts to replace it;
- existing historical rows are not backfilled from current labels or tags,
  because that would create false evidence.

This database boundary covers builder, scheduler, webhook, retry,
sub-workflow, Agent UI and externally reported Agent-telemetry paths without
requiring every caller to remember an application helper. Transitive Workflow
dependencies such as Knowledge, Skills and MCP integrations can be added as
explicit frozen refs by future creation paths; a non-empty supplied ref array
is preserved by the trigger.

Tag create, update, delete and assignment replacement are the first migrated
canonical audit producers. Their business mutation, canonical event and
PostgreSQL outbox row commit atomically; an `Idempotency-Key` request header
provides retry deduplication. The existing admin-audit write remains in
parallel for legacy readers and is skipped on canonical replays. Do not treat
the remaining unmigrated privileged producers as business-audit certified.

## Certification

Migration 218 was applied after `db/init.sql` together with the complete
migration chain in a disposable PostgreSQL database. The first run applied all
216 migration files and the second applied zero, confirming ordering and
idempotency. The disposable database was removed after the check.

Migration 219 was then applied twice to an isolated schema copy. The behavioral
gate `npm run certify:run-resource-snapshots` verified frozen Workflow/Agent
refs, mutation resistance, and that a later run sees the new catalog state.
The command only executes against an explicitly supplied
`RUN_RESOURCE_SNAPSHOT_CERTIFICATION_DATABASE_URL`; strict CI can set
`RUN_RESOURCE_SNAPSHOT_CERTIFICATION_REQUIRED=1`.

Migrations 220–221 and the real tag producer were certified through
`npm run certify:canonical-audit` on a separate disposable PostgreSQL database.
The gate verifies atomic rollback, idempotency, redaction, append-only events,
partitioned chain linkage, equal producer keys across isolated tenant scopes,
the real Tag producer and outbox retry without permanent drop.
