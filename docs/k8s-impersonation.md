# Kubernetes Impersonation — Verification & Deferred Gaps

**Status:** Impersonation is wired and enforced on the primary
calling paths; two gaps are explicitly deferred (documented below).

## What it does

When enabled, Argus forwards the *calling user's* identity to Kubernetes as
`Impersonate-User` / `Impersonate-Group` headers, so K8s RBAC decides on the
real user instead of Argus's ServiceAccount. This is **HTTP-header-based** and
applies to REST-style K8s backends only — it does **not** touch the
`@kubernetes/client-node` SDK path.

## How headers are built

`buildImpersonationHeaders(callingUser)` in `src/lib/platformConfig.ts`
(currently ~lines 84–108):

- Returns `{}` when impersonation is disabled or there is no calling user.
- Resolves the user from the configured `userSource` (`username` | `email` |
  `custom` → `userHeader`). Returns `{}` if that yields no value.
- Sets `Impersonate-User`; resolves `Impersonate-Group` as
  `groupMap[role]` (role-specific) else `defaultGroup`.

Config (`K8sImpersonationConfig`) is loaded from the DB (`mcp_platform_settings`,
category `k8s_impersonation`) at startup and is runtime-updatable via
`setK8sImpersonationConfig`. The header contract is locked by
`src/lib/__tests__/impersonation.test.ts`.

## Where headers are injected

`executeCustomBackend()` in `src/backends/customBackends.ts` (the K8s-impersonation
block, ~lines 400–420 after the SSRF/egress helpers): when impersonation is
enabled AND the backend URL is K8s-flavored (`/api/v1`, `/apis/`, or
`builtin_key === 'k8s'`), it reads `getCurrentCallingUser()` and merges the
impersonation headers into the outbound request. Wrapped in a try/catch that
fails open (impersonation is an enhancement, not a gate).

## How the calling user flows in

Via `AsyncLocalStorage` in `src/lib/requestContext.ts`
(`withRequestContext` / `getCurrentCallingUser`). It is populated on:

- **Agent-chat (SSO/session)** — `src/index.ts` wraps the agent chat execution in
  `withRequestContext({ callingUser })`.
- **API-key bound to a user** — `src/auth/apiKeyMiddleware.ts` wraps `next()` in
  `withRequestContext` when the key has `acting_as_user_id`.

Both paths therefore enforce impersonation on K8s tool calls. ✅

## Deferred gaps (known, intentional)

1. **Workflow-builder background execution** — `src/workflows/executeRoutes.ts`
   runs `executeWorkflow(...)` as a fire-and-forget task that is NOT wrapped in
   `withRequestContext`. The user identity is passed to the hooked tool runner,
   but `getCurrentCallingUser()` returns `undefined` inside the detached task, so
   K8s tool steps fall back to the **ServiceAccount** identity. *Deferred:* wrap
   the background `executeWorkflow` in `withRequestContext({ callingUser })`.
2. **Cron / webhook triggers** — `src/workflows/triggerWorker.ts` carries no
   calling user; triggered runs use the **service identity by design** (no human
   initiator). Left as-is intentionally; revisit if per-trigger identity is ever
   required.

## Not in scope

- SDK-based (`@kubernetes/client-node`) calls — impersonation is header-based for
  REST backends only.
- RFC-8693 upstream token exchange (tracked separately in the roadmap).
