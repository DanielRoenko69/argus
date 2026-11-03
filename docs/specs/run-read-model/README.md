# Hierarchical Run Read Model v2

This is the additive H3 handoff for the new Runs, Approvals, Argus Dev and
Observe surfaces. The existing `/api/ui/runs` response remains unchanged while
the Console migrates.

## Endpoint

```text
GET /api/ui/runs/v2
```

Supported query parameters:

| Parameter | Values | Default |
| --- | --- | --- |
| `view` | `root`, `all` | `root` |
| `include_children` | `none`, `summary`, `full` | `summary` |
| `kind` | comma-separated `workflow`, `agent` | all |
| `status` | raw or display status values | all |
| `tag` | comma-separated canonical numeric tag IDs, AND semantics | all |
| `q` | bounded title, phase or resource-label search | empty |
| `hours` | `1..2160` | `2160` |
| `limit` | `1..100` | `50` |
| `cursor` | opaque cursor returned by the previous page | empty |

The response uses the contract represented by `run-summary.v2.fixture.json`:

- raw execution `status` remains available;
- `displayStatus` is the one presentation state shared by all UI consumers;
- `parentRunId` and `rootTraceId` preserve lineage;
- `childCounts` aggregate only authorized descendants;
- `attentionReason` and `currentPhase` are bounded, explainable values;
- `orphaned` preserves historical runs whose parent has expired or is outside
  the actor's scope;
- `allowedActions` is derived from server-side permissions;
- `resourceRefs` link Runs, Agents, Workflows and canonical tags;
- `evidenceCompleteness` distinguishes frozen evidence from explicitly marked
  legacy live-state fallback.

## Presentation status matrix

| Raw/family state | `displayStatus` |
| --- | --- |
| approval required on run or authorized descendant | `action_required` |
| running run or authorized descendant | `active` |
| external/checkpoint wait | `waiting` |
| running without activity beyond the display threshold | `stale` |
| completed family | `succeeded` |
| failed run or failed descendant after execution settles | `failed` |
| cancelled run | `cancelled` |

`stale` is display-only. The read model never terminates, retries or resumes a
run based on that heuristic.

## Authorization boundary

The route requires `runs.read_own`. `runs.read_all` changes source loading from
actor scope to workspace scope, while bundle restrictions still apply.

Authorization happens in each source query before hierarchy building, filters,
child counts and pagination:

- workflow runs are scoped by owner/trigger plus visible bundles;
- native telemetry uses its existing user and bundle access query;
- process-local Agent sessions require matching `callingUserId` unless the
  actor has `runs.read_all`, and are bundle-filtered before materialization.

An inaccessible parent and its root trace identifier are never returned by ID.
Its visible child becomes an explicit orphan root and exposes only its own trace
identifier, so retained historical evidence remains discoverable without
leaking the hidden resource.

## Lineage rules

The mapper resolves, in order:

1. persisted workflow `parent_execution_id`;
2. workflow `retry_of_execution_id`;
3. native `parent_trace_id`;
4. native `root_trace_id` fallback.

Workflow telemetry linked by `workflow_execution_id` is represented by the
workflow execution rather than duplicated as another root. Agent traces can
still attach to it through the trace mapping. Duplicate process-local sessions
are removed when their persisted telemetry session already exists.

## Evidence boundary

Migration 219 freezes primary Workflow/Agent references in
`execution_snapshot.resourceRefs` and telemetry `metadata.resourceRefs` at
insert and preserves them on later updates. Older executions are returned with
`evidenceCompleteness: "legacy_live_fallback"` and current tags; v2 never
pretends that historical fallback is immutable evidence. Future callers may
provide additional frozen Knowledge, Skill or integration refs without being
overwritten by the database trigger.
