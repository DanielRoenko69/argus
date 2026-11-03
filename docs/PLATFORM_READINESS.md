# Platform readiness

The admin-only **Settings → Platform readiness** page provides one read-only,
fail-closed view of the dependencies needed for an Argus pilot or live demo.
It does not start workflows, approvals, remediations or governed evidence
exports.

## Readiness profile

The first profile, **Pilot & live demo**, evaluates seven control paths:

1. Argus Core and PostgreSQL health.
2. At least one healthy source-control backend and one healthy CI backend.
3. The installed Argus Dev solution pack.
4. The Argus AIOps evidence lanes.
5. Linked workforce identity and recent MFA step-up.
6. Audit-event availability and the configured report signer.
7. A recent combined Dev and AIOps Golden Path execution proof.

Required data that cannot be loaded is reported as **Not verified** and blocks
the overall result. A stale MFA step-up or a degraded-but-usable subsystem is
reported as **Action recommended** instead of being hidden behind a green
status.

## Operator flow

1. Sign in as a platform administrator.
2. Open **Settings → Platform readiness**.
3. Select **Run checks** immediately before a demonstration.
4. Resolve every **Blocked** or **Not verified** item from its **Inspect** link.
5. Repeat the check and download the JSON or Markdown snapshot when needed.

The backend matrix exposes the same enabled internal and MCP backend health
used by Argus Core. The check is deliberately read-only: it does not prove that
a workflow can complete, mutate a repository or publish an image.

## Snapshot boundary

The JSON and Markdown downloads are point-in-time operational snapshots. Each
contains a SHA-256 digest over the snapshot payload, but the artifact is created
in the browser and is not a signed Audit/Evidence report, a WORM receipt or a
compliance certification. Use the governed Audit and Evidence exports when a
formally attributable report is required.

## Executed Golden Paths

`npm run certify:solution-showcase` reuses the persisted showcase runs, verifies
their product evidence and imports one combined proof into Argus without model
calls:

- **Argus Dev:** ticket → governed agents → branch/PR → Jenkins image → review
  and approval evidence.
- **Argus AIOps:** service signal → correlated telemetry → causal analysis →
  governed recommendation/approval → audit evidence.

The import requires a platform-admin session with fresh provider-verified MFA.
The runner reuses the Dev task ID from its latest successful combined report;
operators can pin a different completed task with
`ARGUS_SHOWCASE_DEV_TASK_ID=<uuid>`.
Argus verifies the runner SHA-256 and every nested check, then writes the proof
append-only in the authorized tenant/workspace/environment together with a
canonical audit event. Re-importing the same digest is idempotent.

The Dev certificate also preserves the workflow's verification policy. A
normal Ticket-to-PR run must prove automated tests and review. The deliberately
simplified reviewer-gated image workflow records tests as **intentionally
skipped** and must instead prove the exact file scope, agent review, both human
approvals, a successful Jenkins image build, the local Docker image and the
pull request. The UI states this boundary explicitly; skipped tests are never
presented as passed tests.

The Readiness page exposes the latest proof and marks it stale after seven
days. These records are tenant-bound operational execution evidence, not a
legal, regulatory or external product certification.
