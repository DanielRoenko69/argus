# Repository Graph v1

Status: API database-certified and read-only viewer mounted in Knowledge.
The Core configuration remains fail-closed; local Compose enables the certified
read-only journey with `ARGUS_REPOSITORY_GRAPH_ENABLED=true`.

Endpoint:

    GET /api/ui/knowledge/repository-snapshots/:id/graph
    GET /api/ui/knowledge/repository-snapshots/:id/overview
    GET /api/ui/knowledge/repository-snapshots/:id/full-graph

Required permission: `repository_graph.read`

## Architecture overview contract

`GET .../:id/overview` is the default Graphify-dialog entry. It aggregates the
already normalized immutable snapshot into a repository root, top-level path
modules, per-module file/symbol/document/test counts, language mix and directed
cross-module dependencies. It does not return source text, embeddings or search
document content.

The overview is bounded independently of neighborhood traversal:

- at most 40 modules, ordered by file count;
- at most 120 directed cross-module dependency pairs;
- at most eight languages per returned module;
- the same 2-second query budget and 256 KiB response limit; and
- explicit `truncated` plus total/returned counters.

Module IDs are stable, snapshot-local opaque path identities. Selecting a
module in the Console starts a normal bounded `q=<module>/` neighborhood query;
the overview itself never grants a broader graph capability.

## Complete graph contract

`GET .../:id/full-graph` is the explicit one-click Graphify view. It returns all
indexed files, functions/symbols, provider relationships and implicit
file-to-symbol declarations for a snapshot when they fit the hard safety
limits. The wire format uses tuple arrays, file/symbol indexes and a relation
type dictionary so the complete snapshot does not repeat large object keys or
paths for every relationship. Source text, embeddings and retrieval documents
are never included.

The endpoint permits at most 50,000 combined file/symbol nodes, 150,000 total
relationships, 24 MiB and 15 seconds. `truncated` and `truncationReasons`
explicitly disclose a node or edge safety-cap hit. The Console renders this
payload on a dedicated Canvas; it does not create one React or SVG element per
node. The normal architecture and neighborhood endpoints retain their smaller
interactive bounds.

## Query contract

Exactly one entry point is required:

- `seed=file:<id>|symbol:<id>` selects an opaque node from this snapshot.
- `q=<text>` resolves at most ten matching paths or symbols before traversal.
- `q=*` is a reserved bounded whole-repository neighborhood entry. It still
  selects at most ten seeds and never bypasses traversal or response caps.

Optional controls:

- `node_types=file,symbol`; both are selected by default.
- `edge_types=declares,calls,...`; empty selects all types in the snapshot.
- `direction=inbound|outbound|both`; default `both`.
- `depth=0..3`; default `1`.
- `limit=1..100`; default `50`.
- `cursor=<opaque value>` continues the same immutable query. It is rejected
  when reused with another snapshot, filter, direction, depth, or limit.

Node IDs are snapshot-local opaque values. Clients must not derive database
queries from them. `declares` is a synthetic directed file-to-symbol edge;
provider relations are normalized to lowercase on output.

## Authorization and non-disclosure

All three endpoints require a browser session and the named permission. The snapshot
is selected in the same SQL statement that intersects its ingestion-time MCP
Bundle bindings with the user's current `allowed_bundles` scope. An absent and
an unauthorized snapshot both return the same `404` response. A numeric
snapshot ID is never treated as a capability.

`ready` and immutable historical `superseded` snapshots are readable. A
`building` or `failed` snapshot returns `409` and does not fall back to another
commit. Commit SHA, normalized graph digest, provider, parser version, and graph
schema version are returned with every successful page.

## Bounded execution

- Maximum traversal depth: 3.
- Maximum nodes considered by one request: 400.
- Maximum edges considered by one request: 800.
- Maximum returned nodes per page: 100.
- Maximum response size: 256 KiB.
- Maximum query budget: 2 seconds, with a matching PostgreSQL query timeout.
- File paths and qualified names are trimmed before serialization; source code
  and search-document content are never part of this response.
- Every neighborhood request needs `seed` or `q`; the complete graph is only
  available through the separate, explicitly invoked and independently capped
  endpoint.

`truncated=true` is accompanied by one or more explicit reasons:
`page_limit`, `graph_limit`, or `response_bytes`. Pagination only covers the
already bounded neighborhood. Edges on a page are returned only when both
endpoints are present on that page.

## Certification

Unit and route contracts:

    npm test -- --runInBand src/codeIntelligence/__tests__/repositoryGraphService.test.ts src/codeIntelligence/__tests__/repositoryGraphRoutes.test.ts src/codeIntelligence/__tests__/repositoryGraphStore.test.ts

Behavioral database gate (explicit disposable database only):

    REPOSITORY_GRAPH_CERTIFICATION_DATABASE_URL=postgres://... \
      REPOSITORY_GRAPH_CERTIFICATION_REQUIRED=1 \
      npm run certify:repository-graph

The gate inserts bundle-scoped cyclic/self-edge data inside a transaction,
proves commit/digest identity and non-disclosure, then rolls everything back.

## Graphify viewer and Knowledge integration

The feature-local viewer is exported from:

    argus-console/src/features/repository-graph/index.ts

The viewer and its focus-managed dialog are exported from the feature-local
module. Knowledge exposes Repository snapshots as a fourth source filter and
mounts the dialog from each ready or superseded snapshot card. Shared
navigation and the global stylesheet remain untouched:

```tsx
<RepositoryGraphDialog snapshot={snapshot} onClose={() => setOpenSnapshot(null)} />
```

The dialog starts with the architecture overview and can be dismissed through
its close action, backdrop, or Escape key. Users can filter modules by path or
language, inspect aggregate metadata and cross-module relationships, then use a
progressive drill-down in the same graph surface. The full architecture draws
only the twelve strongest returned dependencies by default. One prominent
`Show complete code graph` button loads the dedicated full-graph contract and
renders every returned file, function/symbol, declaration and provider relation
at once on a dense, module-colored Canvas. This complete view requires no module
or code-neighborhood drill-down. Search, pan, zoom, fit and point details remain
available without replacing the full graph. A single click in the smaller views focuses the
selected module and its direct neighbors, while a double-click or the details
action lazily loads that module's bounded file/symbol neighborhood. Clicking a loaded file or symbol
applies the same direct-neighbor focus without another request. Breadcrumb and
Back actions restore the loaded module or repository context. Graph and
Accessible list remain equivalent rendering modes. Direct viewer consumers may
omit `initialEntry`; a direct code-neighborhood viewer then shows a bounded
search gate and issues no request.
Default loaders use the endpoints above with the current browser session; tests
or another adapter can inject `loadOverview`, `loadGraph` and `loadFullGraph`.

The implementation includes:

- persistent commit SHA, graph digest and immutable status;
- repository/module architecture with totals, language mix and dependencies;
- progressive repository-to-module-to-file/symbol drill-down with breadcrumb
  navigation, direct-neighbor focus and lazy expansion;
- a twelve-edge strongest-dependency preview in the architecture and a distinct
  one-click complete file/symbol graph backed by a compact, hard-capped API;
- file/symbol, relation, direction and depth filters;
- abortable searches, pagination and progressively merged node expansion;
- deterministic cycle-safe SVG layout for bounded views plus a cached Canvas
  layer for the complete graph, with zoom, fit and drag/scroll pan;
- read-only node metadata and inbound/outbound relationship inspection;
- explicit server/client truncation notices; 200-node cap for neighborhood SVG
  views and 50,000-node/150,000-edge caps for the complete Canvas view;
- a semantic, keyboard-operable node and relation table with the same loaded
  neighborhood as the visual graph; and
- feature-local responsive/light-dark styles in `repositoryGraph.css`.

Focused verification:

    npm --prefix argus-console test -- --run \
      src/features/repository-graph/graphLayout.test.ts \
      src/features/repository-graph/fullGraphLayout.test.ts \
      src/features/repository-graph/repositoryGraphClient.test.ts \
      src/features/repository-graph/RepositoryGraphDialog.test.tsx \
      src/features/repository-graph/RepositoryGraphViewer.test.tsx
    npm --prefix argus-console run build

The bounded mounted journey has been exercised against local snapshot #24 in Edge. The
real overview returned 13 modules, 1,303 files, 20,058 symbols, 42,475 stored
relations and 39 cross-module dependency pairs. The full map rendered the 12
strongest pairs by default. Those 21,361 file/symbol nodes and 42,475 provider
relations fit within the complete-graph contract; the new Canvas journey still
requires a mounted browser acceptance pass after rebuilding the Core container. Focusing `fs`
showed 9 modules and its 13 direct dependencies.
Drilling into `fs` loaded the first bounded 100-node `fs/` neighborhood, and
selecting `Start` reduced the canvas to the symbol plus its declaring file.
Back restored first the 100 loaded nodes and then the focused `fs` architecture.
The local Compose default is enabled; non-Compose deployments must opt in after
their own authorization and theme certification.
