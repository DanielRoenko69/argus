# Changelog

All notable changes to Argus Core are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Argus is pre-1.0;
breaking changes can happen in any release.

## [Unreleased]

## [0.1.0] — Initial public release

First public source release of Argus, licensed under AGPL-3.0-only:

- identity, OIDC/Entra ID SSO, RBAC, API keys and tenant/workspace scope;
- agents with Core-managed model and subscription runtime profiles;
- MCP Fabric: connections, catalog trust review, bundles and per-bundle tool
  allowlists;
- signed execution grants and the Solution Pack (A2A) integration contract;
- human approvals, hash-chained canonical audit events, signed checkpoints,
  evidence packs and audit reports;
- provider-neutral RAG/knowledge layer (pgvector by default);
- native traces and logs, alerts and remediation plans;
- visual workflow builder with the Workflow Copilot;
- Solution Packs in `packs/`: Argus Dev (LangGraph governed software
  delivery), Argus AIOps (read-only incident investigation) and Argus Hermes
  (Hermes runtime bridge);
- Docker installer with `minimal`, `optimal` (Core + all packs) and
  `everything` profiles.

Security hardening included in this release: strict Git ref validation for
workspace commands, OAuth2 issuer/audience enforcement and user binding,
MCP session ownership and policy binding, OIDC browser binding and redirect
validation, encrypted and masked backend credential headers, tenant- and
Bundle-scoped run reads, IPv6-aware SSRF checks, and fail-closed audit
recording for evidence exports.
