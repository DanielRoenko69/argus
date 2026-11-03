# Business Continuity Plan (BCP) — Argus

This document defines target recovery procedures for Argus outages and
data loss. It can provide evidence for later NIS2, DORA, ISO 27001 and
SOC 2 mappings, but it does not by itself satisfy or certify them.

**Current status:** design targets for a future supported production
distribution. A target is not an SLA and a procedure is not considered
verified until a dated restore drill with evidence has completed.

Review cadence: quarterly during active pre-release development.

---

## Recovery Objectives

| Service                      | Tier     | RPO       | RTO     |
|------------------------------|----------|-----------|---------|
| MCP Server / Gateway API     | Critical | 15 min    | 30 min  |
| Postgres (operational data)  | Critical | 15 min    | 1 h     |
| External LLM provider access | High     | n/a             | 30 min |
| Audit Log (`mcp_audit_log`)  | Critical | 0 (synchronous write) | 1 h |
| Agent Memory (pgvector)      | Standard | 1 h       | 4 h     |
| RAG indexes (pgvector or configured provider)| Standard | 24 h (re-ingestible) | 4 h |
| Langfuse / Observability     | Standard | 24 h      | 24 h    |
| Admin UI assets              | Low      | 0 (built from source) | 30 min |

**RPO** (Recovery Point Objective) = maximum acceptable data loss.
**RTO** (Recovery Time Objective) = maximum acceptable downtime.

These targets are reviewed and updated as the user base and SLA
commitments grow.

---

## Backup Mechanisms

### Postgres — operational database

- **Target production option:** WAL streaming to a hot standby:
  - Replica in a separate availability zone
  - Lag monitored; alert if > 60 s
- **Target production option:** daily `pg_dump` to encrypted object storage:
  - Retention: 30 days rolling + monthly snapshot for 12 months
  - Encryption: server-side AES-256 (Azure Storage)
- **Target production option:** weekly logical export of governance-relevant tables
  (`mcp_audit_log`, `mcp_compliance_findings`, `mcp_compliance_runs`) for
  with a customer- and purpose-specific retention period

The audit log is **append-only with hash-chain** (`src/audit/immutableAudit.ts`)
so even an attacker with write access cannot modify history undetectably.

### Container images & infrastructure

- Supported release images are to be published to a controlled registry, tagged with
  immutable commit-SHA references (no `:latest` in production)
- `docker-compose.yml` + Helm charts are versioned in this repo —
  reproducible infrastructure-as-code
- Kubernetes cluster state should be managed as versioned infrastructure-as-code

### Application code

- Primary source host and an independent backup/mirror must be recorded in
  each supported release's operational dossier
- Tagged releases are preserved for the declared support period

### Secrets

- Production secrets in Azure Key Vault (rotated quarterly)
- Local dev secrets in `.env` files (gitignored, never committed)
- Decryption key for field-encrypted DB columns is mounted as a
  Kubernetes Secret, separate from the application image

---

## Disaster Recovery Procedures

### Scenario 1 — Postgres data corruption

1. Switch MCP server to read-only mode (env flag)
2. Failover to hot standby (typically < 60 s)
3. Verify integrity of audit log hash-chain
4. Re-promote primary after root-cause analysis
5. **RTO target: 1 h | RPO: 15 min**

### Scenario 2 — Container crash / pod loss

1. Kubernetes restarts the pod automatically (liveness probe)
2. If repeated crashes, rollback to previous image tag
3. **RTO target: < 5 min** (handled by orchestrator)

### Scenario 3 — Region outage (AKS)

1. Cut over DNS to secondary region
2. Promote standby Postgres in secondary region
3. Re-bootstrap stateless services from container registry
4. **RTO target: 4 h | RPO: 15 min**

### Scenario 4 — Full data loss

1. Restore latest `pg_dump` to a fresh Postgres
2. Replay WAL up to last available archive
3. Re-ingest RAG indexes from source corpora (Confluence, Jira,
   Bitbucket)
4. Agent memories that fall outside the restore window are lost —
   acknowledged trade-off (low criticality vs. agent quality)
5. **RTO target: 8 h | RPO: 24 h for memory, 15 min for operational data**

### Scenario 5 — Compromised credentials / ransomware

1. Trigger emergency-rotation script (rotates all API keys, JWT
   secrets, encryption keys)
2. Force-logout all sessions (`DELETE FROM mcp_sessions`)
3. Restore from the most recent **pre-incident** backup
4. Audit log hash-chain verification identifies any tampered rows
5. Incident owner evaluates GDPR, CRA, contractual and customer-specific
   NIS2/DORA notification duties against the applicable role and facts

---

## Restore Testing

**Target cadence:** quarterly for a supported production edition. Financial
customers may require additional DORA-aligned evidence contractually.

Each drill exercises one DR scenario end-to-end against the staging
environment:

| Scenario | Last evidenced run | Result |
|---|---|---|
| Postgres corruption | Not yet recorded | Planned |
| Region/cluster outage | Not yet recorded | Planned |
| Full data loss | Not yet recorded | Planned |
| Compromised credentials | Not yet recorded | Planned |

Drill results are documented as post-mortems even when successful,
with timing measurements against the RPO/RTO targets above.

---

## Communication During Disaster

The Comms Lead (see `docs/runbooks/incident-response.md`) is
responsible for:

- Status page updates every 30 minutes during an active disaster
- Stakeholder email at recovery start and resolution
- Regulator notification (NIS2 / DORA) where applicable

---

## Vendor / Third-Party Dependencies

This inventory template supports provider-neutral exit planning and can
contribute to a financial customer's DORA third-party assessment:

| Vendor              | Service        | Criticality | Exit strategy summary       |
|---------------------|----------------|-------------|-----------------------------|
| Microsoft Azure     | AKS, OpenAI    | Critical    | Multi-region, can fall back to on-prem K8s + AWS Bedrock for LLM |
| Anthropic           | Claude models  | High        | Switch agent configuration to another direct provider |
| Bitbucket           | Git hosting    | Medium      | Mirror to another Git provider |
| Langfuse Self-Host  | Observability  | Low         | Local data; no vendor lock-in |
| Configured RAG provider | Knowledge indexes | Medium | Re-ingestible into pgvector or another supported provider |

Detailed vendor risk assessments must be stored as versioned governance
artifacts. The repository does not currently contain a completed vendor
risk register.

---

## Insurance

No cyber-insurance coverage is asserted by this repository. A future legal
entity must document its insurance decision and actual policy scope before
making any coverage statement.
