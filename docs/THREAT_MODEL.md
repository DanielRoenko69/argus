# Threat Model — Argus

STRIDE-per-component analysis of the Argus platform. This document can
support mappings to NIS2, ISO 27001, SOC 2 and the EU AI Act, but it does
not by itself satisfy or certify those frameworks.

Review cadence: quarterly + after any new component, Trust-Boundary
change, or Sev1/Sev2 incident.



---

## Scope

In scope:
- MCP Server (`src/`)
- Direct LLM clients (`src/llm/`)
- Agent Runtime (`src/agents/`, langgraph/)
- Console UI (`argus-console/`)
- Workspace Container (`agent-workspace/`)
- Persistence: Postgres (incl. pgvector), Redis, optional Qdrant

Out of scope for this repository-level model and therefore requiring a
deployment-owner assessment:
- Azure AKS infrastructure itself
- Office 365 / Entra ID tenant
- Bitbucket / Jenkins as platforms

---

## Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│  Untrusted: Internet, end users, external API consumers         │
└───────────────────────────────┬─────────────────────────────────┘
                                │  TLS, session cookies, API keys
┌───────────────────────────────▼─────────────────────────────────┐
│  Edge: Ingress / Reverse Proxy                                   │
└───────────────────────────────┬─────────────────────────────────┘
                                │  internal network
┌───────────────────────────────▼─────────────────────────────────┐
│  Application Tier: MCP Server (Node.js)                          │
│   ├─ Session Middleware (Auth/Z)                                 │
│   ├─ Direct LLM clients + agent hooks                           │
│   ├─ Agent Runner (LangGraph + Claude SDK)                       │
│   └─ Admin Surface (RBAC-gated)                                  │
└───────┬──────────────────────────────────────┬──────────────────┘
        │                                       │
┌───────▼─────────────┐               ┌────────▼─────────────────┐
│  Trusted: Postgres   │               │  Egress: External LLMs  │
│  Redis, Qdrant       │               │  Azure OpenAI / Anthropic│
│  agent-workspace     │               │  Gitea / Bitbucket / Jira│
└─────────────────────┘               └──────────────────────────┘
```

Trust crosses a boundary on every arrow. Mitigations below address
each crossing.

---

## Component-by-Component STRIDE

### MCP Server (request pipeline)

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| **S**poofing of user   | High     | HttpOnly/SameSite=Lax session cookies, verified OIDC issuer/audience/signature/nonce, API-key scopes (`mcp`/`agents`/`both`) |
| **T**ampering w/ req   | Medium   | `requireSameOrigin` on mutations, CSRF-resistant cookies, HMAC on webhooks |
| **R**epudiation        | High     | `mcp_audit_log` (hash-chained append-only) records every privileged action with user-id + IP |
| **I**nfo disclosure    | Critical | AES-256-GCM at rest for credentials (`src/lib/encryption.ts`), TLS in transit, PII guardrails strip sensitive data before external calls |
| **D**enial of service  | Medium   | Per-key + per-IP rate limiting, admin-specific stricter limit, circuit breakers on outbound LLM calls |
| **E**levation of priv  | Critical | `requireAdmin` middleware on every admin route, scope-restricted API keys, no privilege inheritance across sessions |

### Direct LLM provider access

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| Provider credential leak| Critical | Provider keys never leave server; never returned in responses; encrypted in DB |
| Prompt injection       | High     | PII hooks, tool allowlists and approval gates before sensitive actions |
| Cost overrun           | High     | Usage accounting, spend-anomaly detection and per-agent cost hooks |
| Cross-user data leak   | Critical | Agent/session ownership checks and user-scoped memory retrieval |
| Audit-log bypass       | Critical | `writeImmutableAudit` called in the success/failure path, not conditionally |

### Agent Runtime

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| Tool misuse            | High     | Tool allow/deny patterns per composite, agent-mode-specific tools (worker ≠ reviewer ≠ chat) |
| Unauthorised code exec | Critical | `workspace_exec` only available to specific composites; runs in sandboxed `agent-workspace` container with resource limits |
| Memory contamination   | Medium   | Memory scoped by `agent_id`; pgvector retrieval threshold (cosine ≥ 0.72); fact-extraction prompts hardened against injection |
| Approval-gate bypass   | Critical | LangGraph `interrupt()` checkpoints can't be skipped; checkpointer persists state so an attempted skip leaves an audit trace |
| Sub-agent escalation   | High     | Sub-agents inherit caller's scope only; can't request broader permissions at runtime |

### Workspace Container

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| Container escape       | Critical | Non-root user, no privileged mode, no host volume mounts beyond `/workspace` |
| Code injection via Git | High     | Repo URL validated against an allowlist before clone |
| Resource exhaustion    | Medium   | Memory + CPU limits in `docker-compose.yml` |
| Workspace-db leakage   | High     | Separate Postgres for test runs; production credentials never reach this container |

### Admin UI

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| XSS                    | High     | All user-content rendered via `esc()` helper; CSP headers; no `innerHTML` of user-supplied strings |
| CSRF                   | High     | SameSite=Lax cookies + `requireSameOrigin` on every session-authenticated mutation; Lax is required for OIDC callback landings |
| Clickjacking           | Low      | `X-Frame-Options: DENY` (Grafana iframes are explicitly allowlisted) |
| Session fixation       | Medium   | Session ID regenerated on login |

### Persistence

| Threat                 | Risk     | Mitigation                                                           |
|------------------------|----------|----------------------------------------------------------------------|
| SQL injection          | High     | Parameterised queries throughout (`pg` parameter substitution); no string concatenation |
| Unauthorised DB access | Critical | Postgres on private network; credentials in K8s Secret only; least-privilege per role |
| Backup tampering       | High     | Hash-chained audit-log detects tampering; backups encrypted; restore drill validates integrity |
| pgvector poisoning     | Medium   | Memory writes go through `mcp_agent_memory` insert path which validates agent_id scope |

---

## AI-system foreseeable misuse

Argus runs LLM agents that interact with production systems. Foreseeable
misuse scenarios:

1. **Prompt-injection-driven Kubernetes destruction** — a malicious doc
   in the RAG corpus instructs the agent to `kubectl delete deployment`
   → mitigated by `human_oversight_required` flag + LangGraph approval
   gates on destructive K8s tools
2. **Spend exhaustion via recursive sub-agents** — an agent spawns
   unbounded sub-agents → mitigated by `max_iterations` cap and
   spend-anomaly detector
3. **Data exfiltration via embedding model** — sensitive data sent to
   external embedding API → mitigated by PII guardrails + (optional)
   self-hosted embedding model
4. **Credential exposure via workspace shell** — an agent reading
   `/etc/secrets` → mitigated by `workspace_exec` running as non-root
   in a separate container with no production-secret mounts
5. **Audit-log tampering** — adversary tries to hide their tracks →
   mitigated by append-only hash-chain; tampering becomes detectable

These scenarios can be recorded in `mcp_agents.eu_ai_act_notes`. The
internal `risk_level` controls operational danger and must not be treated
as a legal EU-AI-Act high-risk classification.

---

## Risk Register Summary

Living risks (with planned mitigation in upcoming sprints):

| #  | Risk                                  | Severity | Owner        | Status |
|----|---------------------------------------|----------|--------------|--------|
| R1 | No MFA enforced for admins yet        | High     | Platform Owner | Planned for Entra-ID-SSO rollout |
| R2 | RAG corpora not yet ingested behind ACL| Medium  | Compliance Lead | Backlog |
| R3 | No formal vendor exit-strategy doc per vendor | Medium | Platform Owner | Planned repository artifact |
| R4 | Agent-memory has no time-decay yet (TTL-based eviction only) | Low | Platform Owner | Future enhancement |

The complete versioned risk register is still a planned repository
artifact. Until it exists, this summary must not be represented as a
complete enterprise risk register.
