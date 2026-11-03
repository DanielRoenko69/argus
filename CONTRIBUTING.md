# Contributing to Argus

Thanks for your interest in Argus. The project is early (pre-1.0), so please
open an issue to discuss larger changes before investing in a pull request.

> **Contributor terms:** Argus is licensed under the
> [GNU AGPL v3.0](LICENSE). Contributions are accepted under the same license
> (inbound = outbound). Sign off every commit (`git commit -s`) to certify the
> [Developer Certificate of Origin](https://developercertificate.org/) — that
> you wrote the change or otherwise have the right to submit it under this
> license.

## Workflow

- Fork, then branch from `main` (`feat/<scope>`, `fix/<scope>`).
- Keep pull requests focused; explain **why** in the description.
- Include or update tests for behavioural changes.
- Add an entry under *Unreleased* in [CHANGELOG.md](CHANGELOG.md) for
  user-visible changes.

## Architecture rules

- Core is the authority for identity, SSO/RBAC, agents, bundles, execution
  grants, approvals, credential references and audit. Solution Packs own domain
  workflows only.
- Preserve explicit identity, bundle, tenant/workspace, approval and evidence
  boundaries. Never fall back silently to another model, runtime, identity,
  permission scope or provider.
- Treat model output, tool results, repository content and external documents
  as untrusted input.
- Database migrations are **append-only**: add a new numbered file under
  `db/migrations/`; never edit a migration that may already be applied.
- Changes to authentication, authorization, audit or egress need a focused
  regression test that exercises the reachable path.

## Testing

```bash
npm ci && npm run build
npm test                    # Jest
npm run test:scripts        # scripts/*.test.mjs
(cd packs/argus-dev && npm ci && npm test)
(cd packs/argus-aiops && npm ci && npm test)
(cd packs/argus-hermes && npm ci && npm test)
(cd argus-console && npm ci && npm test)
```

Integration suites need the PostgreSQL service from the Docker Compose stack;
prefer the real database over mocks for migration and store behaviour.

## Commit messages

Conventional-commit style prefixes: `feat`, `fix`, `refactor`, `docs`, `test`,
`chore` with an optional scope, e.g. `fix(auth): bind OIDC callback to browser`.

## Secrets

Never commit `.env`, `secrets/`, tokens, certificates or real customer data.
Keep [`.env.example`](.env.example) in sync with new variables, using
placeholder values only.

## Security issues

Do not file security problems as public issues — follow
[SECURITY.md](SECURITY.md).
