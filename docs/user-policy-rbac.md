# User-Policy RBAC — Operator Guide

Per-user and per-group MCP-tool authorization on top of Argus SSO.

## Concept

Argus SSO authenticates users via Entra ID. Each tool call from an
authenticated user passes through `user-policy-gate` (priority 50 in
the tool-hook chain) which evaluates:

```
allow_set = (∪ tool_allow_patterns of user's composites — empty patterns = wildcard)
          ∪ (∪ tool_allow_patterns of user's groups' composites)
          ∪ (∪ user's allow rules)
          ∪ (∪ user's groups' allow rules)

deny_set  = (∪ tool_deny_patterns of user's composites)
          ∪ (∪ tool_deny_patterns of user's groups' composites)
          ∪ (∪ user's deny rules)
          ∪ (∪ user's groups' deny rules)

tool allowed ⇔ tool ∈ (allow_set − deny_set)
```

**Deny ALWAYS wins.** **Default-deny** when no rule matches. **Empty composite allow-patterns = wildcard** (composite grants all tools, only deny-patterns restrict).

## Three ways to grant a user a tool

1. **User → Composite binding** (broad): user gets every tool the composite covers.
2. **Group → Composite binding** (broader): all members of an Entra group get the composite.
3. **Explicit rule** (narrow): glob pattern allow on a specific tool name.

## Backwards-compatibility — legacy mode

Existing users have `mcp_users.allowed_bundles` (legacy RBAC). The
resolver honours this AS LONG AS the user has no new-style policy data.
Once you assign ONE composite or rule (user-level or group-level), the
user enters policy-mode and `allowed_bundles` is ignored.

This lets you migrate one user at a time without breaking production.

## Recipes

### "Alice gets all Jira read tools, but no delete"

In the Console (**Governance → Policies**):
1. Assign Alice the `jira-base` composite.
2. Add user-rule: pattern `jira_delete_*`, effect `deny`.

Result: Alice gets `jira_search`, `jira_get_issue`, etc. — `jira_delete_issue` blocked.

### "Everyone in the Entra group 'platform-engineers' gets Kubernetes tools"

Group-Policies tab:
1. Group name: paste the Entra group ObjectID (UUID format).
2. Assign the `k8s-tools` composite.

Every user with that group claim gets these tools automatically.

### "Temporarily allow k8s_apply for Bob for 24 hours"

User-rule on Bob:
- Pattern: `k8s_apply`
- Effect: `allow`
- Expires: tomorrow ISO timestamp

After expiry the rule is auto-ignored.

## Auditing

Every block writes to `mcp_immutable_audit_log` with
`event_type = user_policy_block`. The reason field includes the matched
rule, e.g. `user-deny via rule 17`.

```sql
SELECT created_at, api_key_prefix, tool, error_type
FROM mcp_immutable_audit_log
WHERE event_type = 'user_policy_block' AND tool = 'k8s_apply'
ORDER BY created_at DESC LIMIT 50;
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| All authenticated users blocked for all tools | No composites/rules + no legacy `allowed_bundles` | Assign a default composite, or grant via group |
| Group-rules don't fire | Entra `groups` claim not configured | Entra portal → App Registration → Token configuration → Add `groups` claim |
| Rule with `expires_at` not respected | Server clock drift | Resolver uses `now()` in SQL — verify DB server time |
| API-key clients work without policy check | By design | API keys bypass user-policy-gate (have their own RBAC) |
| Resolver returns 500 | DB connection issue | Fail-CLOSED: tool blocked with `policy-load-error` reason |

## Disabling

Per user: drop all `mcp_user_composites` + `mcp_user_tool_rules` rows for that user. Legacy `allowed_bundles` kicks back in.

Cluster-wide: remove `registerHook(makeUserPolicyGate(pool))` from
`src/agents/hooks/index.ts` and restart. Tool calls revert to legacy
RBAC unconditionally.
