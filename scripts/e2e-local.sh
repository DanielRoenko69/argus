#!/bin/sh
set -eu

project_name="argus-e2e"
compose_file="compose.e2e.yml"

cleanup() {
  docker compose -p "$project_name" -f "$compose_file" down --volumes --remove-orphans
}

trap cleanup EXIT INT TERM
cleanup
docker compose -p "$project_name" -f "$compose_file" up --build --detach postgres redis keycloak fake-openai fake-mcp fake-workspace argus langgraph
docker compose -p "$project_name" -f "$compose_file" run --rm playwright
docker compose -p "$project_name" -f "$compose_file" restart argus
docker compose -p "$project_name" -f "$compose_file" up --detach --wait argus
docker compose -p "$project_name" -f "$compose_file" run --rm -e ARGUS_E2E_RECOVERY_PHASE=resume playwright
docker compose -p "$project_name" -f "$compose_file" restart langgraph
docker compose -p "$project_name" -f "$compose_file" up --detach --wait langgraph
docker compose -p "$project_name" -f "$compose_file" run --rm -e ARGUS_E2E_RECOVERY_PHASE=langgraph-resume playwright
