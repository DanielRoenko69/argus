# Official Codex subscription runtime for Argus.Dev

Argus.Dev can use the official OpenAI Codex SDK for repository implementation
and its agentic test fallback. This lets a developer run coding jobs with the
Codex entitlement of their own ChatGPT account without turning that login into
an OpenAI-compatible proxy.

LiteLLM remains independent: generic Argus agents, local Ollama models and API
providers continue to use the normal Argus model registry and credential
profiles. The execution engine can be selected per Agent through an Argus
Runtime Profile; the Coder and its ticket-specific test stage honor that
assignment.

## Architecture and trust boundary

1. LangGraph keeps control of planning, RAG context, workflow state and Argus
   approval gates.
2. LangGraph calls the authenticated `agent-workspace` boundary with the shared
   internal workspace secret.
3. The workspace service starts the official `@openai/codex-sdk` in the checked
   out repository with `workspace-write`, no Codex approval prompts and network
   access disabled. Argus remains the approval authority.
4. Codex authentication lives only in the private Docker volume `codex-auth` at
   `/home/node/.codex`. It is not copied to `.env`, Argus PostgreSQL, LiteLLM or
   workflow output.
5. Commands, file changes, response, usage and failures are written as child
   evidence beneath the existing Argus workflow trace.

The Codex child process receives an allowlisted environment. In particular, it
does not inherit `WORKSPACE_SECRET`, LiteLLM credentials or Git-provider tokens.

## Connect and select

The local stack exposes the Codex endpoint by default. Exposure alone does not
select or run Codex: a platform administrator must authenticate the protected
runtime volume and explicitly assign the profile to an Agent.

Open **Settings -> Providers & Models -> Agent runtime profiles**, choose the
Codex profile and click **Connect runtime**. Argus opens the official device
authorization page and shows the one-time code in the dialog. The OAuth result
is written directly by the CLI to the private `codex-auth` volume; it never
passes through the browser application or Argus Core.

The relevant local `.env` values are:

```dotenv
ARGUS_CODEX_ENABLED=true
ARGUS_DEV_CODER_RUNTIME=codex
ARGUS_CODEX_MODEL=gpt-5.6-terra
ARGUS_CODEX_REASONING_EFFORT=xhigh
ARGUS_CODEX_TIMEOUT_SEC=900
ARGUS_CODEX_MAX_CONCURRENT_RUNS=1
CODEX_CONTEXT_TARGET_CHARS=145000
```

Before each SDK call, Argus Core applies a deterministic context budget. Large
MCP schemas are reduced to their executable parameter structure first, then old
machine-generated tool/assistant output is bounded or omitted. The latest human
instruction remains verbatim. Compaction counts and strategies are written to
the correlated trace logs without retaining discarded content.

The terminal flow remains available as an operator fallback:

```powershell
docker compose up -d --build agent-workspace langgraph mcp-server
docker compose exec agent-workspace codex login --device-auth
docker compose exec agent-workspace codex login status
```

Complete the browser/device flow with the ChatGPT account that has Codex access.
The login survives container rebuilds because it is stored in `codex-auth`.
Never commit or export the volume's `auth.json`.

The control plane seeds two profiles that share the protected `codex-auth`
volume without copying its credentials:

- `codex-subscription-local` uses `gpt-5.6-terra` with `xhigh` reasoning.
  Existing Codex Agent assignments stay on this profile. Migration 257 replaces
  the retired Spark preview identifier without touching the protected login.
- `codex-subscription-deep` uses `gpt-5.6-terra` with `xhigh` reasoning and a
  concurrency limit of one. Assign it manually to an Agent for difficult
  debugging, reviews or long-horizon changes.

Neither profile is routed through LiteLLM or an OpenAI API key. Selection is
deliberately explicit in the prototype, so the chosen runtime and model remain
visible in Agent configuration, traces and usage evidence. Before a release,
the selected model is probed through the official CLI because preview model
availability can change independently of the Argus deployment.

Automatic cross-session Agent Memory is a separate capability. Codex and
Claude Code subscription runtimes do not expose embeddings, so Minimal and
Optimal keep `ARGUS_AGENT_MEMORY_AUTO_ENABLED=false`. This prevents a completed
subscription turn from spending another model call on facts that cannot be
embedded or stored. Set the switch to `true` only after configuring an
independent embedding provider; the Everything installer does this after its
local embedding endpoint is ready. Explicit Knowledge indexing and Workflow
memory nodes retain their own provider readiness checks.

To return Argus.Dev to its regular registered Coder Agent:

```dotenv
ARGUS_DEV_CODER_RUNTIME=argus
```

Then recreate `langgraph`. Setting `ARGUS_CODEX_ENABLED=false` closes the
workspace endpoint and disables the UI sign-in flow. A missing Codex login causes an explicit workflow error;
Argus does not silently fall back to a billable API provider.

## Per-Agent assignment

The migrations create three control-plane profiles:

- `argus-default` — the regular API/local-model path.
- `codex-subscription-local` — the default Terra Codex SDK path using the
  `codex-auth` Docker volume.
- `codex-subscription-deep` — the manually selected deep Codex SDK path using
  the same protected volume.

Open **Build -> Agents**, edit an Agent and choose one **Execution** option.
Codex Fast, Codex Deep, Claude Code and Hermes are complete runtime choices:
their effective model, reasoning policy and protected authentication boundary
are shown together and no second model override is requested. Choosing a
direct API model instead reveals its compatible managed credential profiles.
The profile table stores only a non-secret runtime reference (`codex-auth`),
never the ChatGPT auth file or token.

The current selection is explicit per Agent. A future `Balanced` strategy may
promote a task only from deterministic failure or low-confidence evidence; the
UI must not label a static deployment default as automatic routing before that
policy exists.

## Current scope

- Supported: Argus.Dev ticket implementation, retry continuity through a Codex
  thread ID, ticket-specific agentic test fallback and correlated evidence.
- Still owned by Argus: MCP bundles, repository bootstrap, deterministic tests,
  reviews, human approvals, delivery and audit history.
- Not provided: a general-purpose OpenAI API endpoint, subscription credential
  sharing, unattended multi-user auth or an Ungate-compatible proxy.

Official references: [Codex SDK](https://developers.openai.com/codex/sdk/),
[Codex authentication](https://developers.openai.com/codex/auth/) and
[Codex CLI](https://developers.openai.com/codex/cli/).
