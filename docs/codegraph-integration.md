# Codegraph Integration — Operator Guide

Argus worker agents can query a persistent code knowledge graph instead of
running cascades of grep/read calls. Built on `graphify`
(github.com/safishamsi/graphify), exposed as three MCP tools.

## When to enable per agent

- ✅ Worker agents that operate on a specific Gitea/Bitbucket repo (Dev Agent, Reviewer, Compliance Auditor when scoped)
- ❌ Chat agents — no workspace, no graph to query
- ❌ Agents that switch between many unrelated repos per session — graph is single-repo

Toggle in admin UI: Agent edit → "Codegraph (knowledge-graph MCP tools)".

## The three MCP tools

| Tool | When to use | Replaces |
|---|---|---|
| `codegraph_query "topic terms"` | Exploring an unfamiliar area | 5-15 `grep` + `workspace_read` |
| `codegraph_path "A" "B"` | Tracing how two symbols connect | manual import-following |
| `codegraph_explain "ClassName"` | Understanding one symbol fully | read-file + grep-usages + list-methods |

## Best practices for the agent's system prompt

When an agent has codegraph enabled, recommend a Skill (via `mcp_skills`):

> Before exploring code with grep/read, try `codegraph_query` with code-symbol terms.
> Query phrasing: use terms that match symbol names or doc headings — not natural-language questions.
>   - Good: `codegraph_query "oauth jwt middleware verify"`
>   - Bad:  `codegraph_query "how does authentication work"`
> For known symbols use `codegraph_path` or `codegraph_explain` — they are more precise.

## Cost / performance

- **First-time build per repo**: ~30s AST-only via `graphify update .` (no LLM)
- **Per agent task** (pre-job hook): ~30s if graph fresh, no-op otherwise
- **Per tool call**: <1s (BFS over local graph.json)
- **Token reduction**: avg 16×, peak 100×+ (graphify benchmark on Argus itself)

## Semantic extraction (optional, one-time per repo)

AST-only graph works great for path/explain but weaker for natural-language queries.
For NL-friendly queries, run semantic extraction once per repo:

```bash
docker compose exec agent-workspace sh -c "cd /workspace && \
  ANTHROPIC_API_KEY=$ARGUS_ADMIN_ANTHROPIC_KEY graphify extract . --backend claude"
```

Cost: ~$0.50-2 per 50k-LOC repo, ~5-10 min wall-clock. Result persists in
graphify-out/graph.json; subsequent `graphify update` keeps semantic edges
for unchanged files (incremental).

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `codegraph_query` returns "graph.json not found" | Pre-job hook failed or repo not cloned | Check `agent-workspace` logs; verify `gitea_project` is set on agent |
| Returns wildly wrong start-nodes | Query keywords don't match graph nodes | Rephrase with code-symbol terms; consider semantic extraction |
| Timeouts on large repos | `graphify update` >120s | Tune the pre-job timeout in `codegraphPrejob.ts`; consider scheduled background re-builds |
| `graphify: command not found` in agent-workspace | Container image lacks graphify | Rebuild: `docker compose up -d --force-recreate agent-workspace` |

## Disabling

- Per agent: uncheck the box. Pre-job hook becomes a no-op; existing graphify-out/ stays but unused.
- Cluster-wide: disable the integration for every agent; there is no global kill switch yet.
