# Argus.Dev real-repository benchmarks

These benchmarks exercise Argus.Dev against pinned, historical defects from
real open-source repositories. The repository snapshot given to an agent is
always the parent of the accepted upstream fix. Oracle files stay in Argus
Core and must not be copied into the agent workspace until evaluation.

| Benchmark | Language | Main difficulty | Historical scope |
| --- | --- | --- | --- |
| `click-2971` | Python | focused error-hint regression | 2 files, 16 changed lines |
| `nestjs-4873` | TypeScript | asynchronous dependency-injection race | 8 files, 533 changed lines |
| `rclone-8675` | Go | concurrent run-state isolation under the race detector | 15 files, 594 changed lines |

## Import a pinned snapshot into local Gitea

The existing importer accepts arbitrary Git repositories when its FastAPI CI
fixture is disabled:

```powershell
./scripts/import-dev-e2e-repository.ps1 `
  -SourceUrl https://github.com/nestjs/nest.git `
  -SourceRef dffc1d07769b46e7b1dab850126da5d988deaf0d `
  -RepositoryName argus-dev-nestjs-4873 `
  -WithoutCiWorkflow

./scripts/import-dev-e2e-repository.ps1 `
  -SourceUrl https://github.com/rclone/rclone.git `
  -SourceRef fc5bd21e28fe8beee3e0f544a30f9d9552250901 `
  -RepositoryName argus-dev-rclone-8675 `
  -WithoutCiWorkflow
```

Each `benchmark.json` contains the ticket text, pinned commits, expected change
surface, normal project tests and hidden-oracle command. Use the verifier only
on a disposable checkout:

After importing a snapshot, provision its isolated Gitea backend and MCP
bundle in the running local Argus Core stack:

```powershell
./scripts/provision-argus-dev-benchmark.ps1 -Benchmark nestjs-4873
./scripts/provision-argus-dev-benchmark.ps1 -Benchmark rclone-8675
```

The script clones the credentials and transport settings of the existing
`gitea_local` backend without printing its secret, constrains the clone to the
benchmark repository, and creates an idempotent `argus-dev-<benchmark>`
bundle. Argus Core is restarted so its backend registry immediately discovers
the new connection.

Start a governed run with the repository bundle plus the native Code
Intelligence read/index bundles. The runner signs the requested retrieval
variant, starts the regular A2A `ticket-to-pull-request` workflow, and prints
only non-secret task, trace and UI references:

```powershell
node ./scripts/start-argus-dev-benchmark.mjs --benchmark nestjs-4873 --variant candidate
node ./scripts/start-argus-dev-benchmark.mjs --benchmark nestjs-4873 --variant baseline
```

The first run for a repository commit is an untimed warm-up. Core builds the
exact-commit Graphify index and local embeddings before a subscription runtime
receives code context. On large repositories and local embedding hardware this
can take several minutes. Do not compare that cold index build with a warm
retrieval run. Once the snapshot is persisted, both variants reuse the same
immutable index; `baseline` disables semantic query embedding while
`candidate` uses the full hybrid graph retrieval path.

Benchmark grants use Core's bounded one-hour maximum because these hard cases
span several independent subscription-runtime calls. This is a test-runner
choice, not a general relaxation of Core's normal interactive grant lifetime.

```powershell
./scripts/verify-argus-dev-benchmark.ps1 `
  -Benchmark nestjs-4873 `
  -RepositoryPath C:\path\to\nestjs-checkout
```

A correct benchmark has three pieces of evidence:

1. The hidden oracle fails against `sourceRef`.
2. The same oracle passes against `fixCommit`.
3. The Argus-produced patch passes the oracle without copying the accepted
   upstream implementation.

## NestJS evidence

The first warm `candidate` run established the complete execution path rather
than a successful solution claim:

- the pinned 1,910-file snapshot was indexed with 13,988 symbols and 15,898
  retrievable documents;
- Planner, Knowledge and Coder completed through the governed Codex runtime;
- the Coder changed three relevant files with 144 insertions and one deletion,
  including unit and integration coverage;
- the hidden race oracle still failed deterministically in all four attempts
  because the request-scoped dependency remained `null`.

That is a useful negative result: the patch looked plausible and broad project
tests exercised substantial code, but it did not satisfy the ticket's actual
behaviour. It must not be counted as a solved benchmark.

The run also exposed two harness failures that are now fixed in the Core-owned
workspace runtime:

1. Historical npm repositories try strict `npm ci` first and use a bounded
   `--package-lock=false --legacy-peer-deps` fallback only inside the isolated
   test profile.
2. Oversized retry prompts retain both their command/setup head and diagnostic
   tail inside the 160,000-character Codex boundary, with an explicit
   `ARGUS_RUNTIME_PROMPT_COMPACTED` audit marker.

A fresh governed run is still required before deciding whether the candidate
retrieval method improves end-to-end ticket completion. Retrieval quality,
runtime completion and hidden-oracle correctness remain separate metrics.
