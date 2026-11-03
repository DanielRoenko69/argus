#!/bin/sh
# Reproduce the Argus Core + Argus.Dev local stack on macOS/Linux/WSL.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$PROJECT_DIR"

if ! command -v openssl >/dev/null 2>&1; then
  printf '%s\n' '[bootstrap] openssl is required to generate local secrets.' >&2
  exit 1
fi

if [ ! -f .env ]; then
  sh ./setup.sh
fi

set_env() {
  key=$1
  value=$2
  tmp_file=$(mktemp)
  awk -v key="$key" -v value="$value" '
    BEGIN { replaced = 0 }
    $0 ~ "^" key "=" { print key "=" value; replaced = 1; next }
    { print }
    END { if (!replaced) print key "=" value }
  ' .env > "$tmp_file"
  mv "$tmp_file" .env
}

read_env() {
  key=$1
  sed -n "s/^${key}=//p" .env | tail -n 1
}

ensure_secret() {
  key=$1
  prefix=${2:-}
  current=$(read_env "$key")
  if [ -z "$current" ]; then
    set_env "$key" "${prefix}$(openssl rand -hex 24)"
  fi
}

ensure_secret LITELLM_MASTER_KEY 'sk-local-'
ensure_secret LITELLM_UI_PASSWORD
ensure_secret LITELLM_DATABASE_PASSWORD
set_env ARGUS_INSTALL_STARTER_AGENTS true
set_env LLM_REQUEST_TIMEOUT_MS 300000
set_env OLLAMA_MODEL granite3.3:2b
set_env LITELLM_OLLAMA_MODEL ollama_chat/granite3.3:2b
set_env LITELLM_OLLAMA_CODER_MODEL ollama_chat/qwen2.5-coder:3b
set_env LITELLM_OLLAMA_EMBEDDING_MODEL ollama/nomic-embed-text

printf '%s\n' '[bootstrap] Pulling pinned runtime images...'
docker compose --profile local-llm --profile llm-gateway pull \
  postgres redis agent-workspace-db litellm-db ollama litellm

printf '%s\n' '[bootstrap] Starting Ollama and downloading local models...'
docker compose --profile local-llm up -d ollama
docker compose exec -T ollama ollama pull granite3.3:2b
docker compose exec -T ollama ollama pull qwen2.5-coder:3b
docker compose exec -T ollama ollama pull nomic-embed-text

printf '%s\n' '[bootstrap] Starting LiteLLM and provisioning the Argus Core runtime key...'
docker compose --profile llm-gateway up -d litellm
litellm_port=$(read_env LITELLM_PORT)
litellm_port=${litellm_port:-4000}
ready=0
attempt=0
while [ "$attempt" -lt 45 ]; do
  if curl -fsS "http://127.0.0.1:${litellm_port}/health/liveliness" >/dev/null 2>&1; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$ready" -ne 1 ]; then
  printf '%s\n' '[bootstrap] LiteLLM did not become ready.' >&2
  exit 1
fi

argus_litellm_key=$(read_env ARGUS_LITELLM_API_KEY)
key_has_embedding=0
if [ -n "$argus_litellm_key" ] && curl -fsS \
  -H "Authorization: Bearer $argus_litellm_key" \
  "http://127.0.0.1:${litellm_port}/v1/models" | grep -q '"argus-local-embedding"'; then
  key_has_embedding=1
fi
if [ -n "$argus_litellm_key" ] && [ "$key_has_embedding" -ne 1 ]; then
  docker compose --profile llm-gateway exec -T \
    -e ARGUS_LITELLM_API_KEY="$argus_litellm_key" \
    litellm python3 -c '
import json, os, urllib.request
payload = json.dumps({
  "key": os.environ["ARGUS_LITELLM_API_KEY"],
  "models": ["argus-local", "argus-local-coder", "argus-local-embedding", "argus-openai"],
  "max_parallel_requests": 4,
  "rpm_limit": 120,
}).encode()
request = urllib.request.Request(
  "http://127.0.0.1:4000/key/update",
  data=payload,
  headers={"Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"], "Content-Type": "application/json"},
  method="POST",
)
urllib.request.urlopen(request, timeout=30).read()
'
  key_has_embedding=1
  printf '%s\n' '[bootstrap] Existing Argus Core LiteLLM Virtual Key scope updated.'
fi
if [ -z "$argus_litellm_key" ]; then
  argus_litellm_key=$(docker compose --profile llm-gateway exec -T litellm python3 -c '
import json, os, urllib.request
payload = json.dumps({
  "key_alias": "argus-core-local",
  "models": ["argus-local", "argus-local-coder", "argus-local-embedding", "argus-openai"],
  "max_parallel_requests": 4,
  "rpm_limit": 120,
  "metadata": {"application": "argus-core", "environment": "local", "managed_by": "bootstrap-local.sh"},
}).encode()
request = urllib.request.Request(
  "http://127.0.0.1:4000/key/generate",
  data=payload,
  headers={"Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"], "Content-Type": "application/json"},
  method="POST",
)
print(json.load(urllib.request.urlopen(request, timeout=30))["key"])
')
  set_env ARGUS_LITELLM_API_KEY "$argus_litellm_key"
  printf '%s\n' '[bootstrap] Created scoped LiteLLM Virtual Key: argus-core-local.'
fi
set_env OPENAI_BASE_URL http://litellm:4000/v1
set_env OPENAI_API_KEY "$argus_litellm_key"
set_env EMBEDDING_MODEL argus-local-embedding
set_env ARGUS_AGENT_MEMORY_AUTO_ENABLED true

printf '%s\n' '[bootstrap] Building Argus images and starting the complete local stack...'
docker compose --profile local-llm --profile llm-gateway up -d --build

printf '%s\n' '[bootstrap] Current service state:'
docker compose --profile local-llm --profile llm-gateway ps

printf '%s\n' '[bootstrap] Argus Core: http://localhost:3000'
printf '%s\n' '[bootstrap] LiteLLM UI: http://localhost:4000/ui'
printf '%s\n' '[bootstrap] Local models: granite3.3:2b, qwen2.5-coder:3b, nomic-embed-text'
