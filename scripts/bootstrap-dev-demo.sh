#!/bin/sh
# Cross-platform local Gitea + Actions fixture for Argus.Dev.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
SKIP_CORE_BUILD=false
SKIP_SAMPLE_IMAGE_BUILD=false
ARGUS_USER=
SEED_DIR=
REPO_RESPONSE=

while [ "$#" -gt 0 ]; do
  case "$1" in
    --argus-user) [ "$#" -ge 2 ] || exit 2; ARGUS_USER=$2; shift 2 ;;
    --skip-core-build) SKIP_CORE_BUILD=true; shift ;;
    --skip-sample-image-build) SKIP_SAMPLE_IMAGE_BUILD=true; shift ;;
    *) printf '%s\n' "Unknown option: $1" >&2; exit 2 ;;
  esac
done

info() { printf '%s\n' "[dev-demo] $*"; }
fail() { printf '%s\n' "[dev-demo] ERROR: $*" >&2; exit 1; }

read_env() {
  sed -n "s/^${1}=//p" "$ROOT_DIR/.env" | tail -n 1
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
  ' "$ROOT_DIR/.env" > "$temporary"
  mv "$temporary" "$ROOT_DIR/.env"
}

append_allowlist_host() {
  host=$1
  current=$(read_env SSRF_ALLOWLIST_HOSTS)
  case ",$current," in
    *",$host,"*) return 0 ;;
  esac
  if [ -n "$current" ]; then set_env SSRF_ALLOWLIST_HOSTS "$current,$host"
  else set_env SSRF_ALLOWLIST_HOSTS "$host"
  fi
}

wait_for_http() {
  url=$1
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    attempt=$((attempt + 1))
    sleep 2
  done
  fail "Service did not become ready: $url"
}

compose() {
  # A targeted Core recreate must retain an already installed local MFA lab.
  # Fresh installations without that opt-in container keep their normal IdP.
  if [ -n "$(docker ps -aq --filter label=com.docker.compose.project=argus-core --filter label=com.docker.compose.service=keycloak-mfa)" ]; then
    set -- -f "$ROOT_DIR/deploy/compose/demo/compose.mfa-demo.yml" "$@"
  fi
  if [ "$(read_env ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE)" = /run/secrets/audit/argus-audit-signing-key.pem ]; then
    docker compose \
      --project-name argus-core \
      --project-directory "$ROOT_DIR" \
      --env-file "$ROOT_DIR/.env" \
      -f "$ROOT_DIR/docker-compose.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.external-pack.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.hermes-attached.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.hermes-local.yml" \
      -f "$ROOT_DIR/deploy/compose/installer/compose.installer-audit.yml" \
      --profile dev-demo "$@"
  else
    docker compose \
      --project-name argus-core \
      --project-directory "$ROOT_DIR" \
      --env-file "$ROOT_DIR/.env" \
      -f "$ROOT_DIR/docker-compose.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.external-pack.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.hermes-attached.yml" \
      -f "$ROOT_DIR/deploy/compose/packs/compose.hermes-local.yml" \
      --profile dev-demo "$@"
  fi
}

cleanup() {
  if [ -n "$SEED_DIR" ]; then
    case "$SEED_DIR" in
      "${TMPDIR:-/tmp}"/argus-dev-seed.*) rm -rf -- "$SEED_DIR" ;;
      *) warn "Refusing to remove unexpected temporary path: $SEED_DIR" ;;
    esac
  fi
  if [ -n "$REPO_RESPONSE" ]; then
    case "$REPO_RESPONSE" in
      "${TMPDIR:-/tmp}"/argus-gitea-repository.*) rm -f -- "$REPO_RESPONSE" ;;
      *) warn "Refusing to remove unexpected temporary file: $REPO_RESPONSE" ;;
    esac
  fi
}
warn() { printf '%s\n' "[dev-demo] WARN: $*" >&2; }
trap cleanup EXIT HUP INT TERM

[ -f "$ROOT_DIR/.env" ] || fail 'Missing .env; run the normal Argus installer first'
for command_name in docker curl git openssl base64; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
docker info >/dev/null 2>&1 || fail 'Docker is not ready'
sh "$SCRIPT_DIR/ensure-local-audit-signing-volume.sh"

gitea_port=$(read_env GITEA_PORT); gitea_port=${gitea_port:-3005}; set_env GITEA_PORT "$gitea_port"
gitea_username=$(read_env GITEA_USERNAME); gitea_username=${gitea_username:-argus}; set_env GITEA_USERNAME "$gitea_username"
gitea_password=$(read_env GITEA_PASSWORD)
[ "${#gitea_password}" -ge 16 ] || gitea_password=$(openssl rand -hex 20)
set_env GITEA_PASSWORD "$gitea_password"
runner_token=$(read_env GITEA_RUNNER_REGISTRATION_TOKEN)
[ "${#runner_token}" -ge 32 ] || runner_token=$(openssl rand -hex 24)
set_env GITEA_RUNNER_REGISTRATION_TOKEN "$runner_token"
set_env GITEA_BASE_URL http://gitea:3000
set_env GITEA_PUBLIC_URL "http://localhost:$gitea_port"
set_env GITEA_OWNER "$gitea_username"
set_env GITEA_REPO argus-dev-sample
[ -z "$ARGUS_USER" ] || set_env ARGUS_DEV_DEMO_USER "$ARGUS_USER"
append_allowlist_host gitea
append_allowlist_host langgraph

info 'Starting local Gitea...'
compose up -d gitea
gitea_host_url="http://127.0.0.1:$gitea_port"
wait_for_http "$gitea_host_url/api/healthz"

if ! compose exec -T --user git gitea gitea admin user list 2>/dev/null | \
  awk -v user="$gitea_username" '$2 == user { found = 1 } END { exit !found }'; then
  info 'Creating the local Gitea administrator...'
  compose exec -T --user git gitea gitea admin user create \
    --username "$gitea_username" \
    --password "$gitea_password" \
    --email argus-dev@example.test \
    --admin \
    --must-change-password=false
fi

gitea_token=$(read_env GITEA_TOKEN)
if [ -z "$gitea_token" ] || ! curl -fsS -H "Authorization: token $gitea_token" \
  "$gitea_host_url/api/v1/user" >/dev/null 2>&1; then
  info 'Generating a workstation-local Gitea API token...'
  token_name="argus-core-local-$(date +%Y%m%d%H%M%S)"
  gitea_token=$(compose exec -T --user git gitea gitea admin user generate-access-token \
    --username "$gitea_username" --token-name "$token_name" --scopes all --raw | tr -d '\r\n')
  [ -n "$gitea_token" ] || fail 'Gitea did not return an API token'
  set_env GITEA_TOKEN "$gitea_token"
fi

repo_url="$gitea_host_url/api/v1/repos/$gitea_username/argus-dev-sample"
REPO_RESPONSE=$(mktemp "${TMPDIR:-/tmp}/argus-gitea-repository.XXXXXX")
status=$(curl -sS -o "$REPO_RESPONSE" -w '%{http_code}' \
  -H "Authorization: token $gitea_token" -H 'Accept: application/json' "$repo_url")
if [ "$status" = 404 ]; then
  info 'Creating the local sample repository...'
  curl -fsS -X POST \
    -H "Authorization: token $gitea_token" \
    -H 'Content-Type: application/json' \
    --data '{"name":"argus-dev-sample","description":"Real local target for the Argus.Dev E2E workflow","private":true,"auto_init":false,"default_branch":"main"}' \
    "$gitea_host_url/api/v1/user/repos" > "$REPO_RESPONSE"
elif [ "$status" != 200 ]; then
  fail "Gitea repository lookup returned HTTP $status"
fi

if grep -Eq '"empty"[[:space:]]*:[[:space:]]*true' "$REPO_RESPONSE"; then
  info 'Seeding the baseline service and Actions workflow...'
  SEED_DIR=$(mktemp -d "${TMPDIR:-/tmp}/argus-dev-seed.XXXXXX")
  cp -R "$ROOT_DIR/demo/argus-dev-sample/." "$SEED_DIR/"
  git -C "$SEED_DIR" init --initial-branch=main
  git -C "$SEED_DIR" config user.name 'Argus Demo Seeder'
  git -C "$SEED_DIR" config user.email argus-dev@example.test
  git -C "$SEED_DIR" add --all
  git -C "$SEED_DIR" commit -m 'Seed Argus.Dev sample service'
  git -C "$SEED_DIR" remote add origin "$gitea_host_url/$gitea_username/argus-dev-sample.git"
  basic_auth=$(printf '%s' "$gitea_username:$gitea_token" | base64 | tr -d '\r\n')
  git -C "$SEED_DIR" -c "http.extraHeader=Authorization: Basic $basic_auth" push -u origin main
else
  info 'Existing sample repository preserved; no branch was overwritten.'
fi

info 'Starting the isolated Gitea Actions runner...'
compose up -d gitea-runner
if [ "$SKIP_CORE_BUILD" != true ]; then compose build mcp-server langgraph; fi
compose up -d --no-build
wait_for_http http://127.0.0.1:3000/health

info 'Installing the Gitea connection and governed demo Bundle...'
if ! compose exec -T mcp-server node dist/scripts/seedLocalDevDemo.js; then
  # A provider-neutral local installation may deliberately have no embedding
  # credential. The Gitea MCP Fabric bundle itself remains useful, so retry
  # without attempting remote/source embeddings instead of failing the entire
  # Dev lab after its transactional bundle setup has succeeded.
  info 'Repository embedding is unavailable; retrying the governed bundle without repository RAG...'
  compose exec -T -e ARGUS_DEV_INSTALL_REPOSITORY_RAG=false \
    mcp-server node dist/scripts/seedLocalDevDemo.js
fi
compose restart mcp-server
wait_for_http http://127.0.0.1:3000/health

if [ "$SKIP_SAMPLE_IMAGE_BUILD" != true ]; then
  docker build -t argus-dev-sample:local "$ROOT_DIR/demo/argus-dev-sample"
fi

info "Ready: $gitea_host_url/$gitea_username/argus-dev-sample"
info 'MCP Fabric Bundle: Argus.Dev Demo'
