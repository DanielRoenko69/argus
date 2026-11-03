# argus-skills — Curated Skill Sync CLI

A zero-dependency Node.js (≥20) script that imports Markdown skills with
YAML frontmatter into Argus via the `/api/admin/skills/upsert` endpoint.

This is Phase 4 of the SDK-Parity-ohne-SDK plan: rather than re-baking the
Anthropic Agent SDK's skill marketplace as a runtime, Argus treats skills
as versioned content owned by the admin. The CLI is the import path.

## Why a CLI and not a runtime sync

- **Reproducibility** — every imported skill carries `source_url`,
  `source_ref`, `imported_at` (migration 079). DORA Art. 14 auditors can
  trace any skill back to its origin commit.
- **RBAC** — imports require an admin-scoped Argus API key, so the same
  permission model as the admin UI applies.
- **Curation** — manual triggering means humans review what enters the
  library. No supply-chain attack via a poisoned community skill.

## Install

The CLI is checked in to the repo. To make it globally available:

```bash
cd tools/argus-skills && npm link
# now `argus-skills --help` works anywhere
```

Or invoke directly: `node tools/argus-skills/argus-skills.mjs <command>`.

## Configure

```bash
export ARGUS_URL=http://localhost:3000          # default
export ARGUS_API_KEY=ak_xxx_your_admin_key       # required
```

Generate an admin-scoped key in the Argus admin UI (`/admin` → Keys → New)
or with the env-based seed (`MCP_API_KEYS=test-api-key-12345678` for dev).

## Commands

### `argus-skills list`

Print all skills currently in Argus with their provenance.

```
NAME                       CATEGORY        SOURCE
tdd-discipline             engineering     local:/Users/.../seed/tdd-discipline.md
root-cause-debugging       engineering     local:/Users/.../seed/root-cause-debugging.md
custom-internal-skill      ops             (hand-authored)
```

### `argus-skills sync <dir> [--dry-run]`

Walk `<dir>` recursively, parse each `*.md`, and upsert into Argus.
`--dry-run` reports what would change without touching the DB.

```bash
argus-skills sync tools/argus-skills/seed --dry-run
argus-skills sync tools/argus-skills/seed
argus-skills sync ../claude-code-skills/skills
```

Output legend:
- `+ name` — created
- `~ name` — updated (overwrote an existing skill of the same name)
- `SKIP …` — invalid frontmatter, empty body, or 4xx from the server

## Markdown Format

```markdown
---
name: tdd-discipline           # ^[a-z0-9_-]+$ — required if filename does not match
label: TDD Discipline          # human label, falls back to name
description: One-line trigger  # shown to the model when it picks skills
category: engineering          # free-form, used for grouping in the UI
icon: "🧪"                      # any short Unicode token
---

# TDD Discipline

Markdown body becomes the skill content — injected verbatim into the
agent's system prompt when the skill is bound.
```

Only `name` and the body are strictly required; everything else has a
default.

## Importing from a Remote Repo

The MVP does not fetch from GitHub directly (many networks restrict egress
to `raw.githubusercontent.com`). Workflow:

```bash
git clone <skills-repository-url> /tmp/cs
argus-skills sync /tmp/cs/skills --dry-run
argus-skills sync /tmp/cs/skills
```

The skill's `source_url` will record the absolute local path. If you want
it to record the upstream URL, edit the import or PR a `--source-prefix`
flag.

## Seed Skills

Five curated, license-clean skills ship under `seed/`:

| Skill | When to bind |
|---|---|
| `tdd-discipline` | Any worker-mode agent that writes code |
| `root-cause-debugging` | Reviewers, dev agents, on-call assistants |
| `code-review-rigor` | Reviewer-mode agents |
| `security-mindset` | Any agent touching auth, user input, or external APIs |
| `verification-before-completion` | Every worker-mode agent (cuts "looks done" claims) |

Import them with:

```bash
argus-skills sync tools/argus-skills/seed
```

Then bind to agents via the admin UI (`/admin/agents` → edit → Skills).
