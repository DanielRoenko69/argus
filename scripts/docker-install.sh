#!/bin/sh
# Cross-platform Docker-only bootstrap for a local Argus workstation.
# This script is executed inside the disposable service from compose.install.yml.
set -eu

MODE=${1:-optimal}
NO_BUILD=false
DRY_RUN=false
shift || true

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-build) NO_BUILD=true ;;
    --dry-run) DRY_RUN=true ;;
    *) printf '%s\n' "Unknown installer option: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$MODE" in
  minimal|optimal|everything) ;;
  *)
    printf '%s\n' 'Usage: install {minimal|optimal|everything} [--no-build] [--dry-run]' >&2
    exit 2
    ;;
esac

# Compose project name. Override to run an isolated second stack next to an
# existing one (its containers, volumes and installer secrets stay separate).
PROJECT_NAME=${ARGUS_COMPOSE_PROJECT:-argus-core}
case "$PROJECT_NAME" in
  ''|*[!a-z0-9_-]*|[!a-z0-9]*)
    printf '%s\n' 'ARGUS_COMPOSE_PROJECT must start with a-z/0-9 and contain only a-z, 0-9, _ and -' >&2
    exit 2
    ;;
esac
export ARGUS_COMPOSE_PROJECT="$PROJECT_NAME"

CORE_DIR=${ARGUS_INSTALLER_CORE_DIR:-/workspace/argus-core}
PARENT_DIR=${ARGUS_INSTALLER_PARENT_DIR:-/workspace}
ENV_FILE="$CORE_DIR/.env"
OWNER_UID=$(stat -c '%u' "$CORE_DIR")
OWNER_GID=$(stat -c '%g' "$CORE_DIR")

info() { printf '%s\n' "[argus-install] $*"; }
fail() { printf '%s\n' "[argus-install] ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || fail 'Docker CLI is unavailable in the installer image.'
docker info >/dev/null 2>&1 || fail 'Docker Desktop is not running or its socket is unavailable.'

HOST_PARENT_DIR=$(docker inspect "$HOSTNAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}')
[ -n "$HOST_PARENT_DIR" ] || fail 'Could not resolve the host workspace path from the installer mount.'
ARGUS_HOST_CORE_DIR=$(docker inspect "$HOSTNAME" --format '{{range .Mounts}}{{if eq .Destination "/workspace/argus-core"}}{{.Source}}{{end}}{{end}}')
[ -n "$ARGUS_HOST_CORE_DIR" ] || fail 'Could not resolve the actual Core checkout bind mount.'
export ARGUS_HOST_CORE_DIR

if [ "$DRY_RUN" = true ]; then
  info "Mode: $MODE"
  info "Container workspace: $PARENT_DIR"
  info "Docker host workspace: $HOST_PARENT_DIR"
  info 'Dry run complete; no files, images or services were changed.'
  exit 0
fi

cd "$CORE_DIR"

if [ ! -f "$ENV_FILE" ]; then
  cp "$CORE_DIR/.env.example" "$ENV_FILE"
  info 'Created .env from .env.example.'
fi

read_env() {
  key=$1
  sed -n "s/^${key}=//p" "$ENV_FILE" | tail -n 1
}

set_env() {
  key=$1
  value=$2
  temporary=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' "$ENV_FILE" > "$temporary"
  mv "$temporary" "$ENV_FILE"
}

ensure_secret() {
  key=$1
  prefix=${2:-}
  bytes=${3:-32}
  current=$(read_env "$key")
  case "$current" in
    ''|CHANGE_ME*|your-secret*) set_env "$key" "${prefix}$(openssl rand -hex "$bytes")" ;;
  esac
}

ensure_secret MCP_API_KEYS ak_ 32
ensure_secret SESSION_SECRET '' 32
ensure_secret DB_ENCRYPTION_KEY '' 32
ensure_secret POSTGRES_PASSWORD '' 16
ensure_secret REDIS_PASSWORD '' 24
ensure_secret WORKSPACE_SECRET '' 32
ensure_secret ARGUS_EXECUTION_GRANT_SECRET '' 32
ensure_secret ARGUS_WEBHOOK_SECRET '' 32
ensure_secret WIDGET_TOKEN_SECRET '' 32

mkdir -p "$CORE_DIR/secrets"
if [ ! -s "$CORE_DIR/secrets/argus-audit-signing-key.pem" ]; then
  openssl genpkey -algorithm ED25519 -out "$CORE_DIR/secrets/argus-audit-signing-key.pem"
fi
chmod 600 "$CORE_DIR/secrets/argus-audit-signing-key.pem"
set_env ARGUS_AUDIT_EVIDENCE_V1_ENABLED true
set_env ARGUS_AUDIT_SIGNING_KEY_ID local-audit-ed25519-v1
set_env ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE /run/secrets/audit/argus-audit-signing-key.pem
set_env ARGUS_AUDIT_REPORT_WORKER_INTERVAL_SEC 60
docker volume create "$PROJECT_NAME-installer-audit-signing" >/dev/null
tar -C "$CORE_DIR/secrets" -cf - argus-audit-signing-key.pem |
  docker run --rm -i -v "$PROJECT_NAME-installer-audit-signing":/run/secrets alpine:3.23 \
    sh -ec 'umask 077; tar -C /run/secrets -xf -; chmod 0555 /run/secrets; chmod 0444 /run/secrets/*'

POSTGRES_USER_VALUE=$(read_env POSTGRES_USER)
POSTGRES_DB_VALUE=$(read_env POSTGRES_DB)
POSTGRES_PASSWORD_VALUE=$(read_env POSTGRES_PASSWORD)
[ -n "$POSTGRES_USER_VALUE" ] || POSTGRES_USER_VALUE=aiops
[ -n "$POSTGRES_DB_VALUE" ] || POSTGRES_DB_VALUE=aiops
set_env POSTGRES_CONNECTION_URL "postgresql://${POSTGRES_USER_VALUE}:${POSTGRES_PASSWORD_VALUE}@localhost:5432/${POSTGRES_DB_VALUE}"
set_env ARGUS_INSTALL_STARTER_AGENTS true
set_env LLM_REQUEST_TIMEOUT_MS 300000
# Minimal and Optimal are provider-neutral. Everything enables automatic
# cross-session memory after its local embedding endpoint is ready.
set_env ARGUS_AGENT_MEMORY_AUTO_ENABLED false

BASE_FILES="-f $CORE_DIR/docker-compose.yml -f $CORE_DIR/deploy/compose/installer/compose.installer-hostpaths.yml -f $CORE_DIR/deploy/compose/installer/compose.installer-audit.yml"
STACK_FILES="$BASE_FILES"

if [ "$MODE" != minimal ]; then
  for repository in argus-dev argus-aiops argus-hermes; do
    [ -f "$CORE_DIR/packs/$repository/Dockerfile" ] || fail "Missing Solution Pack: packs/$repository"
  done

  mkdir -p "$CORE_DIR/secrets"
  if [ ! -s "$CORE_DIR/secrets/argus-hermes-discovery-token" ]; then
    openssl rand -hex 32 > "$CORE_DIR/secrets/argus-hermes-discovery-token"
  fi
  if [ ! -s "$CORE_DIR/secrets/hermes-api-key" ]; then
    openssl rand -hex 32 > "$CORE_DIR/secrets/hermes-api-key"
  fi
  chmod 600 "$CORE_DIR/secrets/argus-hermes-discovery-token" "$CORE_DIR/secrets/hermes-api-key"
  set_env ARGUS_HERMES_DISCOVERY_TOKEN_FILE './secrets/argus-hermes-discovery-token'
  set_env ARGUS_HERMES_API_KEY_SOURCE_FILE './secrets/hermes-api-key'
  set_env ARGUS_HERMES_IMAGE 'argus-hermes:local'

  # Compose file-secret mounts are resolved by the Docker engine and cannot
  # refer to the installer's /workspace path on Docker Desktop. Stream them
  # into two dedicated named volumes instead; values never enter container env
  # or image layers, and each service sees only the secret it needs.
  docker volume create "$PROJECT_NAME-installer-hermes-discovery" >/dev/null
  tar -C "$CORE_DIR/secrets" -cf - argus-hermes-discovery-token |
    docker run --rm -i -v "$PROJECT_NAME-installer-hermes-discovery":/run/secrets alpine:3.23 \
      sh -ec 'umask 077; tar -C /run/secrets -xf -; chmod 0555 /run/secrets; chmod 0444 /run/secrets/*'
  docker volume create "$PROJECT_NAME-installer-hermes-api" >/dev/null
  tar -C "$CORE_DIR/secrets" -cf - hermes-api-key |
    docker run --rm -i -v "$PROJECT_NAME-installer-hermes-api":/run/secrets alpine:3.23 \
      sh -ec 'umask 077; tar -C /run/secrets -xf -; mv -f /run/secrets/hermes-api-key /run/secrets/argus-hermes-api-key; chmod 0555 /run/secrets; chmod 0444 /run/secrets/*'
  export ARGUS_HERMES_DISCOVERY_TOKEN_FILE="$CORE_DIR/secrets/argus-hermes-discovery-token"
  export ARGUS_HERMES_API_KEY_SOURCE_FILE="$CORE_DIR/secrets/hermes-api-key"

  if [ "$NO_BUILD" != true ]; then
    info 'Building external Argus Solution Packs...'
    docker build -t argus-dev:local "$CORE_DIR/packs/argus-dev"
    docker build -t argus-aiops:local "$CORE_DIR/packs/argus-aiops"
    docker build -t argus-hermes:local "$CORE_DIR/packs/argus-hermes"
  fi

  STACK_FILES="$BASE_FILES -f $CORE_DIR/deploy/compose/packs/compose.external-pack.yml -f $CORE_DIR/deploy/compose/packs/compose.hermes-attached.yml -f $CORE_DIR/deploy/compose/packs/compose.hermes-local.yml -f $CORE_DIR/deploy/compose/installer/compose.installer-secrets.yml"
fi

# Intentional word splitting: STACK_FILES is a controlled list of repository
# paths without user-provided fragments.
# shellcheck disable=SC2086
compose_stack() {
  docker compose --project-name "$PROJECT_NAME" --project-directory "$CORE_DIR" --env-file "$ENV_FILE" $STACK_FILES "$@"
}

if [ "$MODE" = minimal ]; then
  info 'Starting Minimal: Core, PostgreSQL and Redis...'
  if [ "$NO_BUILD" = true ]; then
    compose_stack up -d --wait mcp-server
  else
    compose_stack up -d --build --wait mcp-server
  fi
  node "$CORE_DIR/scripts/local-platform-doctor.mjs"
else
  if [ "$MODE" = everything ]; then
    ensure_secret LITELLM_MASTER_KEY sk-local- 24
    ensure_secret LITELLM_UI_PASSWORD '' 24
    ensure_secret LITELLM_DATABASE_PASSWORD '' 24
    set_env OLLAMA_MODEL granite3.3:2b
    set_env LITELLM_OLLAMA_MODEL ollama_chat/granite3.3:2b
    set_env LITELLM_OLLAMA_CODER_MODEL ollama_chat/qwen2.5-coder:3b
    set_env LITELLM_OLLAMA_EMBEDDING_MODEL ollama/qwen3-embedding:0.6b

    compose_everything() {
      compose_stack --profile local-llm --profile llm-gateway --profile pii --profile public-widget-demo "$@"
    }

    info 'Starting local Ollama and LiteLLM...'
    compose_everything up -d --wait ollama litellm
    info 'Pulling local chat, coder and embedding models (cached on later runs)...'
    compose_everything exec -T ollama ollama pull granite3.3:2b
    compose_everything exec -T ollama ollama pull qwen2.5-coder:3b
    compose_everything exec -T ollama ollama pull qwen3-embedding:0.6b

    ARGUS_LITELLM_API_KEY_VALUE=$(read_env ARGUS_LITELLM_API_KEY)
    if [ -z "$ARGUS_LITELLM_API_KEY_VALUE" ]; then
      info 'Creating a scoped LiteLLM key for Argus Core...'
      ARGUS_LITELLM_API_KEY_VALUE=$(compose_everything exec -T litellm python3 -c '
import json, os, urllib.request
payload = json.dumps({
  "key_alias": "argus-core-local",
  "models": ["argus-local", "argus-local-coder", "argus-local-embedding", "argus-openai"],
  "max_parallel_requests": 4,
  "rpm_limit": 120,
  "metadata": {"application": "argus-core", "environment": "local", "managed_by": "docker-installer"},
}).encode()
request = urllib.request.Request(
  "http://127.0.0.1:4000/key/generate",
  data=payload,
  headers={"Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"], "Content-Type": "application/json"},
  method="POST",
)
print(json.load(urllib.request.urlopen(request, timeout=30))["key"])
' | tr -d '\r')
      [ -n "$ARGUS_LITELLM_API_KEY_VALUE" ] || fail 'LiteLLM did not return a runtime key.'
      set_env ARGUS_LITELLM_API_KEY "$ARGUS_LITELLM_API_KEY_VALUE"
    fi
    set_env OPENAI_BASE_URL 'http://litellm:4000/v1'
    set_env OPENAI_API_KEY "$ARGUS_LITELLM_API_KEY_VALUE"
    set_env EMBEDDING_MODEL 'argus-local-embedding'
    set_env ARGUS_AGENT_MEMORY_AUTO_ENABLED true
    set_env ARGUS_CODE_EMBEDDING_PROFILE 'qwen3-code-retrieval'
    set_env ARGUS_CODE_EMBEDDINGS_ENABLED true
    set_env ARGUS_CODE_EMBEDDING_MODEL 'argus-local-embedding'

    info 'Starting Everything: all product modules and safe local runtime profiles...'
    if [ "$NO_BUILD" = true ]; then
      compose_everything up -d --wait
    else
      compose_everything up -d --build --wait
    fi
  else
    info 'Starting Optimal: Core, Agent Workspace, Dev, AIOps and Attached Hermes...'
    if [ "$NO_BUILD" = true ]; then
      compose_stack up -d --wait
    else
      compose_stack up -d --build --wait
    fi
  fi

  info 'Applying the safe Attached Hermes tool profile...'
  compose_stack exec -T hermes-upstream hermes config set platform_toolsets.api_server '[]'
  compose_stack restart hermes-upstream argus-hermes
  compose_stack up -d --wait hermes-upstream argus-hermes
  node "$CORE_DIR/scripts/local-platform-doctor.mjs" --full
fi

chown "$OWNER_UID:$OWNER_GID" "$ENV_FILE" 2>/dev/null || true
if [ -d "$CORE_DIR/secrets" ]; then chown -R "$OWNER_UID:$OWNER_GID" "$CORE_DIR/secrets" 2>/dev/null || true; fi

info "Argus $MODE is ready: http://localhost:3000/home"
