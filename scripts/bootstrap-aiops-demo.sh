#!/bin/sh
# Cross-platform AIOps metrics/logs/traces/Kind acceptance lab.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
PACK_DIR=$(CDPATH= cd -- "$ROOT_DIR/packs/argus-aiops" 2>/dev/null && pwd || true)
SKIP_CORE_BUILD=false
SKIP_PACK_BUILD=false
SKIP_KUBERNETES=false
SKIP_KNOWLEDGE_SEED=false

while [ "$#" -gt 0 ]; do
  case "$1" in
    --skip-core-build) SKIP_CORE_BUILD=true; shift ;;
    --skip-pack-build) SKIP_PACK_BUILD=true; shift ;;
    --skip-kubernetes) SKIP_KUBERNETES=true; shift ;;
    --skip-knowledge-seed) SKIP_KNOWLEDGE_SEED=true; shift ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

info() { printf '%s\n' "[aiops-demo] $*"; }
fail() { printf '%s\n' "[aiops-demo] ERROR: $*" >&2; exit 1; }

wait_for_http() {
  url=$1
  label=$2
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    attempt=$((attempt + 1))
    sleep 2
  done
  fail "$label did not become ready: $url"
}

compose() {
  # Preserve the existing opt-in MFA lab when this command recreates Core.
  if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=argus-core --filter label=com.docker.compose.service=keycloak-mfa)" ]; then
    set -- -f "$ROOT_DIR/compose.mfa-demo.yml" "$@"
  fi
  if [ "$(sed -n 's/^ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE=//p' "$ROOT_DIR/.env" | tail -n 1)" = /run/secrets/audit/argus-audit-signing-key.pem ]; then
    docker compose \
      --project-name argus-core \
      --project-directory "$ROOT_DIR" \
      --env-file "$ROOT_DIR/.env" \
      -f "$ROOT_DIR/docker-compose.yml" \
      -f "$ROOT_DIR/compose.external-pack.yml" \
      -f "$ROOT_DIR/compose.hermes-attached.yml" \
      -f "$ROOT_DIR/compose.hermes-local.yml" \
      -f "$ROOT_DIR/compose.aiops-demo.yml" \
      -f "$ROOT_DIR/compose.installer-audit.yml" \
      --profile aiops-demo "$@"
  else
    docker compose \
      --project-name argus-core \
      --project-directory "$ROOT_DIR" \
      --env-file "$ROOT_DIR/.env" \
      -f "$ROOT_DIR/docker-compose.yml" \
      -f "$ROOT_DIR/compose.external-pack.yml" \
      -f "$ROOT_DIR/compose.hermes-attached.yml" \
      -f "$ROOT_DIR/compose.hermes-local.yml" \
      -f "$ROOT_DIR/compose.aiops-demo.yml" \
      --profile aiops-demo "$@"
  fi
}

[ -f "$ROOT_DIR/.env" ] || fail 'Missing .env; run the normal Argus installer first'
command -v docker >/dev/null 2>&1 || fail 'Docker is required'
command -v curl >/dev/null 2>&1 || fail 'curl is required'
docker info >/dev/null 2>&1 || fail 'Docker is not ready'
sh "$SCRIPT_DIR/ensure-local-audit-signing-volume.sh"

if [ "$SKIP_KUBERNETES" != true ]; then
  info 'Reconciling the read-only Kubernetes evidence provider...'
  sh "$SCRIPT_DIR/bootstrap-aiops-kubernetes.sh"
  info 'Reconciling the isolated Kubernetes remediation provider...'
  sh "$SCRIPT_DIR/bootstrap-aiops-kubernetes-remediation.sh"
fi

if [ "$SKIP_PACK_BUILD" != true ]; then
  [ -n "$PACK_DIR" ] && [ -f "$PACK_DIR/Dockerfile" ] || fail 'packs/argus-aiops is missing'
  info 'Building the current Argus.AIOps pack...'
  docker build -t argus-aiops:local "$PACK_DIR"
fi
if [ "$SKIP_CORE_BUILD" != true ]; then
  info 'Building Argus Core and Console...'
  compose build mcp-server
fi

info 'Starting metrics, logs, traces and deterministic signal seeds...'
compose up -d mcp-server argus-aiops prometheus loki jaeger
# Loki and Jaeger are ephemeral in the local lab. Always recreate the one-shot
# seeds so a host reboot cannot leave healthy but empty evidence stores.
compose up -d --force-recreate aiops-signal-seed aiops-demo-seed

core_container=$(compose ps -q mcp-server | tr -d '\r\n')
[ -n "$core_container" ] || fail 'Core container could not be resolved'
if ! docker inspect "$core_container" --format '{{json .NetworkSettings.Networks}}' | grep -q '"kind"'; then
  info 'Attaching Core to the private Kind network...'
  docker network connect kind "$core_container"
fi

wait_for_http http://127.0.0.1:3000/health Argus
wait_for_http http://127.0.0.1:9090/-/ready Prometheus
wait_for_http http://127.0.0.1:3101/ready Loki
wait_for_http http://127.0.0.1:16686/api/services Jaeger

assert_seed_completed() {
  service=$1
  container=$(compose ps -a -q "$service" | tr -d '\r\n')
  [ -n "$container" ] || fail "$service container was not created"
  exit_code=$(docker inspect "$container" --format '{{.State.ExitCode}}' | tr -d '\r\n')
  if [ "$exit_code" != 0 ]; then
    compose logs --no-color --tail=100 "$service"
    fail "$service exited with code $exit_code"
  fi
}
assert_seed_completed aiops-demo-seed
assert_seed_completed aiops-signal-seed

if [ "$SKIP_KNOWLEDGE_SEED" != true ]; then
  info 'Seeding the pgvector runbook corpus...'
  compose exec -T mcp-server node dist/scripts/seedAiopsKnowledge.js
else
  info 'Skipping optional embedding-backed runbook seed.'
fi
info 'Reloading the backend registry...'
compose restart mcp-server
wait_for_http http://127.0.0.1:3000/health Argus

info 'Verifying the governed multi-signal MCP Bundle...'
compose exec -T mcp-server node dist/scripts/verifyAiopsDemo.js
info 'AIOps lab ready: Argus, Prometheus :9090, Loki :3101, Jaeger :16686.'
