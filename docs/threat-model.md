# Argus Threat Model — OWASP Agentic Top-10 Mapping

How Argus's built-in defenses map onto the OWASP Agentic Security Initiative's
"Top 10 for Agentic Applications" (ASI01–ASI10). Honest status per item:
**mitigated** / **partial** / **not covered**. The taxonomy labels follow the
OWASP Agentic AI threat categories; exact wording varies by version.

> Scope: this is the *agent/tool* threat surface of Argus (`argus-core`),
> a self-hosted tool that can run `kubectl` / `workspace_exec`. It is the highest-
> value attack surface, so "partial" is stated plainly rather than glossed.

| ID | Threat | Status | Argus defenses (component · file) |
|----|--------|--------|-----------------------------------|
| **ASI01** | Agent control / action hijacking | **partial** | `destructiveCmd` blocks `rm -rf` / `kubectl delete ns` / `dd` / `mkfs` / force-push; `productionClusterGuard` blocks kubectl/helm/terraform on prod namespaces — both act on the **side-effecting tool call**, not just text (`src/agents/hooks/builtin/`). Human-approval gate for sensitive tools. No ML intent-classifier. |
| **ASI02** | Tool misuse / tool poisoning | **partial** | A2AS tool-output tagging wraps untrusted tool output + instructs the model to treat it as data (`src/agents/toolOutputTagging.ts`); SSRF resolve-and-check + egress allowlist (`src/backends/customBackends.ts`); curated MCP catalog (most public MCP servers are dead/unvetted). No automated tool-poisoning scanner. |
| **ASI03** | Excessive agency / privilege compromise | **partial** | Table-driven per-user MCP-tool RBAC via `userPolicyGate`; K8s impersonation forwards the real user identity so K8s RBAC decides (least privilege) (`src/lib/platformConfig.ts`, `docs/k8s-impersonation.md`); human-approval gate. Per-user RBAC fully enforced only after Phase-2 SSO. |
| **ASI04** | Resource overload / denial-of-wallet | **mitigated** | `costBudget` hook caps tool calls/session; API-key request limiting and direct-provider usage/cost telemetry detect abnormal consumption. |
| **ASI05** | Cascading hallucination / misinformation | **not covered** | RAG grounding + reranker reduce ungrounded output, but there is no dedicated fact-verification / cross-checking layer. Treat agent output as advisory for high-stakes ops. |
| **ASI06** | Intent breaking / goal manipulation (prompt injection) | **partial** | A2AS untrusted-data tagging + regex PII/secret guards on writes (`piiPreWrite`). **No learned injection classifier** (e.g. Llama Prompt Guard / Lakera) — obfuscated / multilingual / intent-based injection is not reliably caught. |
| **ASI07** | Memory poisoning | **partial** | pgvector agent memory with PII guards on the write path; memory is agent-scoped. No dedicated memory-integrity / provenance check on retrieval. |
| **ASI08** | Identity spoofing / impersonation | **mitigated** (human) / **partial** (agent) | Entra ID SSO (OIDC Authorization-Code + PKCE, `src/auth/entraAuth.ts`); API-key auth with SHA-256 hashing + TTL; K8s impersonation ties actions to the real user. Per-**agent** identity (Entra Agent ID) is planned, not built. |
| **ASI09** | Human-in-the-loop / oversight bypass | **mitigated** | `humanApprovalGate` blocks sensitive tools when `human_oversight_required`; workflow two-stage approval (code + functional, migration 105). Enforced in the runner, not bolted on. |
| **ASI10** | Untraceability / repudiation & insecure supply chain | **partial** | Immutable append-only audit log + **SHA-256 hash-chain** (tamper-evident: any insert/edit/delete breaks the chain, verifiable via `GET /api/admin/audit-log/verify`); every tool-hook decision logged. **Supply chain NOT covered**: Argus depends on external provider SDKs and its own Jenkins/Flux CI (dependency pinning / SBOM / image signing are a separate backlog item). |

## Cross-cutting notes

- **Defense layer order on a tool call:** pre-tool hooks (`runPreToolHooks`) → block/modify decision → tool exec → post-tool hooks → immutable audit (hash-chained). See `src/agents/hooks/registry.ts` and `src/workflows/hookedToolRunner.ts`.
- **Honesty:** the deterministic action-guards (ASI01/ASI04) and audit/repudiation (ASI10) are Argus's genuinely strong areas. Injection (ASI06) and hallucination (ASI05) are the weakest — they need ML/verification layers Argus does not yet have. Do not market these as "solved".
- **Not yet covered:** ML-based PII/injection classifier, per-agent identity, CI/supply-chain hardening and full DNS-rebinding connection pinning.


