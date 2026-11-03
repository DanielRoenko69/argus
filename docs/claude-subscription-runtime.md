# Claude Code subscription runtime

Argus can run selected Agents through the official Claude Code CLI using a local Claude.ai Pro/Max login. This is separate from LiteLLM and does not create an Anthropic API credential in Argus.

## Connect and select

The local stack exposes the Claude Code endpoint by default. Exposure alone
does not select or run Claude Code: a platform administrator must authenticate
the protected runtime volume and explicitly assign the profile to an Agent.

Open **Settings -> Providers & Models -> Agent runtime profiles**, choose the
Claude Code profile and click **Connect runtime**. Complete the provider or
organization-SSO flow in the new tab, then paste the returned one-time code
into the Argus dialog. The code is forwarded directly to the waiting CLI and
is not retained in Argus logs, audit data or browser state.

The relevant local `.env` values are:

```dotenv
ARGUS_CLAUDE_ENABLED=true
ARGUS_CLAUDE_MAX_CONCURRENT_RUNS=1
ARGUS_CLAUDE_MAX_TURNS=25
```

```bash
docker compose up -d --build agent-workspace
```

## Operator fallback

The OAuth state is stored in the named `claude-auth` Docker volume:

```bash
docker compose exec agent-workspace claude
```

Complete the Claude.ai login flow and choose the Pro/Max subscription. The OAuth material remains in the volume and is never sent to Argus or LiteLLM. Setting `ARGUS_CLAUDE_ENABLED=false` closes both the runtime endpoint and the guided UI flow.

## Assign Agents

After the migration runs, open **Settings → Models → Agent runtime profiles** and assign **Claude Code · Claude Subscription** to the desired Agent. The assignment is the single source of truth; workflow files do not hard-code a model.

The optional deployment fallback is:

```dotenv
ARGUS_DEV_CODER_RUNTIME=claude-code
```

Use the profile assignment for normal operation so different Agents can use Codex, Claude Code, or Argus independently.

## Operational notes

- Argus records runtime lifecycle and trace evidence, but does not persist the Claude OAuth token.
- `ARGUS_CLAUDE_MODEL` may be left empty so Claude Code selects the model available to the subscription.
- `ARGUS_CLAUDE_ALLOWED_TOOLS` defaults to `Read,Write,Edit,Bash`; keep the permission mode restrictive for shared environments.
- The runtime is intentionally concurrency-limited and supports cancellation from the Argus Dev session panel.

Official references: [Claude Code getting started](https://docs.anthropic.com/en/docs/claude-code/getting-started), [CLI usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage), and [using Claude Code with Pro/Max](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan).
