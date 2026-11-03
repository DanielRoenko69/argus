# Argus.Dev Sample Service

This repository is the real local development target for the Argus.Dev E2E lab.
It is intentionally small, but it behaves like a deployable service: HTTP API,
tests, a production container and a Gitea Actions pipeline.

## Local commands

```sh
npm ci
npm test
npm run build
docker build -t argus-dev-sample:local .
docker run --rm -p 8080:8080 argus-dev-sample:local
```

The first Argus.Dev exercise is to add a Kubernetes-style `GET /ready`
readiness endpoint with tests while preserving the existing `/health` contract.
