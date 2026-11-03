# API and data contracts

Versioned contracts between Argus Core and its consumers (Console, Solution
Packs, external integrations). Each folder documents one contract family and
ships JSON fixtures. Inner `response` objects are wire examples; surrounding
`examples` arrays are test-vector wrappers and are not returned by an
endpoint. Several fixtures are loaded directly by the test suites.

| Contract | Folder | Purpose |
| --- | --- | --- |
| Navigation capabilities | [`core-access/`](core-access/) | Named permissions and capability flags for navigation and search |
| Resource tags | [`resource-tags/`](resource-tags/) | Tags and frozen resource references for catalogs, search and logs |
| Run read model v2 | [`run-read-model/`](run-read-model/) | Hierarchical root/child run summaries for Runs, Approvals and pack views |
| Repository graph | [`repository-graph/`](repository-graph/) | Immutable code-graph neighborhood and accessible table fallback |
| Audit evidence | [`audit-evidence/`](audit-evidence/) | Canonical audit events, durable outbox and evidence pages |
| AIOps service profiles | [`aiops-service-profiles/`](aiops-service-profiles/) | Service profiles, evidence readiness and profile-backed investigation context |
| Golden Path | [`golden-path/`](golden-path/) | Preflight, idempotent run start and run read model for the end-to-end path |
| AI Act enablement | [`ai-act-compliance/`](ai-act-compliance/) | AI-system registry, classification, control matrix, runtime binding and dossier manifests |
| Evaluation | [`evaluation/`](evaluation/) | Curated cases, rules, scenarios and controlled releases |

Cross-cutting requirements are listed in [REQUIREMENTS.md](REQUIREMENTS.md).

## Compatibility rules

- Add optional fields within one schema version; rename or remove fields only
  in a new version.
- Server authorization is authoritative. Capability booleans control only UI
  discoverability.
- Every resource URL and action in a response is already
  authorization-filtered.
- Timestamps use UTC ISO 8601 and identifiers are opaque strings unless the
  contract explicitly declares a number.
- New contracts stay behind feature flags until implementation and
  certification are complete; additive Core contracts can be adopted by
  consumers independently while legacy endpoints remain available.

## Feature flags

| Contract | Flag | Default |
| --- | --- | --- |
| Repository graph | `ARGUS_REPOSITORY_GRAPH_ENABLED` | Off in Core; enabled by the local Compose setup |
| Audit evidence | `ARGUS_AUDIT_EVIDENCE_V1_ENABLED` | Off in Core; enabled by the Docker installer with a generated machine-local signing key |
