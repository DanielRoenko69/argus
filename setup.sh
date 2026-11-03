#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Argus Core — One-time setup script
# Führt alle Schritte aus damit `docker compose up -d` funktioniert.
# ─────────────────────────────────────────────────────────────────────────────
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { printf "${GREEN}[setup]${NC} %s\n" "$1"; }
warn()    { printf "${YELLOW}[warn] ${NC} %s\n" "$1"; }
error()   { printf "${RED}[error]${NC} %s\n" "$1"; exit 1; }

# ── 1. .env anlegen ──────────────────────────────────────────────────────────
if [ -f ".env" ]; then
  warn ".env existiert bereits — wird nicht überschrieben."
else
  info "Erstelle .env aus .env.example ..."
  cp .env.example .env

  # Zufälligen SESSION_SECRET generieren
  if command -v openssl >/dev/null 2>&1; then
    SECRET=$(openssl rand -hex 32)
    # Portable sed für Linux und macOS
    sed -i.bak "s|CHANGE_ME_SESSION_SECRET|${SECRET}|" .env && rm -f .env.bak
    info "SESSION_SECRET automatisch generiert."
  else
    warn "openssl nicht gefunden — bitte SESSION_SECRET in .env manuell setzen (min. 32 Zeichen)."
  fi

  # Zufälliges Postgres-Passwort generieren
  if command -v openssl >/dev/null 2>&1; then
    PG_PASS=$(openssl rand -hex 16)
    sed -i.bak "s|POSTGRES_PASSWORD=CHANGE_ME|POSTGRES_PASSWORD=${PG_PASS}|g" .env && rm -f .env.bak
    # Connection URL ebenfalls aktualisieren
    sed -i.bak "s|postgresql://aiops:CHANGE_ME@|postgresql://aiops:${PG_PASS}@|g" .env && rm -f .env.bak
    info "POSTGRES_PASSWORD automatisch generiert."
  fi

  # Zufälligen MCP API Key generieren
  if command -v openssl >/dev/null 2>&1; then
    API_KEY="ak_$(openssl rand -hex 32)"
    sed -i.bak "s|MCP_API_KEYS=your-secret-api-key-here|MCP_API_KEYS=${API_KEY}|g" .env && rm -f .env.bak
    info "MCP_API_KEYS automatisch generiert: ${API_KEY}"
  fi

  # Zufälligen WORKSPACE_SECRET generieren (für agent-workspace HTTP-Sidecar)
  if command -v openssl >/dev/null 2>&1; then
    WS_SECRET=$(openssl rand -hex 32)
    sed -i.bak "s|CHANGE_ME_WORKSPACE_SECRET|${WS_SECRET}|" .env && rm -f .env.bak
    info "WORKSPACE_SECRET automatisch generiert."
  fi

  # DB Encryption Key generieren (AES-256-GCM für api_keys, tokens, secrets in DB)
  if command -v openssl >/dev/null 2>&1; then
    DB_ENC_KEY=$(openssl rand -hex 32)
    sed -i.bak "s|CHANGE_ME_DB_ENCRYPTION_KEY|${DB_ENC_KEY}|" .env && rm -f .env.bak
    info "DB_ENCRYPTION_KEY automatisch generiert."
    warn "WICHTIG: DB_ENCRYPTION_KEY sicher aufbewahren! Verlust = alle verschluesselten DB-Felder unleserlich."
  fi

  info ".env erstellt."
  printf "\n"
  warn "Optional in .env eintragen (sonst bleiben einzelne Features inaktiv):"
  printf "  - LANGFUSE_PUBLIC_KEY       (LLM Observability + RAG Eval Scores)\n"
  printf "  - LANGFUSE_SECRET_KEY       (zusammen mit PUBLIC_KEY)\n"
  printf "  - LANGFUSE_HOST             (default: http://langfuse:3100)\n"
  printf "  - BITBUCKET_TOKEN           (Coding Workflow -> Branch Push + PR)\n"
  printf "  - BITBUCKET_BASE_URL        (z.B. https://bitbucket.example.com)\n"
  printf "  - BITBUCKET_USER_SLUG       (für User-Repos, z.B. john.doe)\n"
  printf "  - BITBUCKET_REPO_SLUG       (Repository-Name, z.B. my-service)\n"
  printf "  - OTEL_EXPORTER_OTLP_ENDPOINT (Tracing → SigNoz/Jaeger, z.B. http://host:4317)\n"
  printf "  - RAG_RERANKER_PROVIDER=tei (self-hosted Reranking aktivieren)\n"
  printf "  - GRAFANA_URL/API_KEY       (Grafana-Tools)\n"
  printf "  - CONTINUOUS_EVAL_ENABLED=true (LLM-as-a-Judge für Agent-Antworten)\n"
fi

# ── 2. Docker prüfen ─────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  error "Docker nicht gefunden. Bitte Docker Desktop installieren: https://www.docker.com/products/docker-desktop/"
fi
if ! docker info >/dev/null 2>&1; then
  error "Docker Daemon läuft nicht. Bitte Docker Desktop starten."
fi
info "Docker OK."

# ── 3. Fertig ─────────────────────────────────────────────────────────────────
printf "\n"
info "Setup abgeschlossen! Starten mit:"
printf "\n"
printf "  ${GREEN}docker compose up -d${NC}\n"
printf "\n"
info "Wichtige Endpoints:"
printf "\n"
printf "  Dashboard:  http://localhost:3000/status\n"
printf "  Admin UI:   http://localhost:3000/admin\n"
printf "  Workflows:  http://localhost:3000/workflows\n"
printf "  Activity:   http://localhost:3000/audit\n"
printf "  Docs:       http://localhost:3000/docs\n"
printf "\n"
info "API Endpoints:"
printf "\n"
printf "  MCP Gateway:    http://localhost:3000/mcp\n"
printf "  Agent Chat:     http://localhost:3000/api/agents/:id/chat\n"
printf "  Health Check:   http://localhost:3000/health\n"
printf "  Prometheus:     http://localhost:3000/metrics\n"
printf "\n"
info "Features:"
printf "\n"
printf "  ✓ MCP Gateway (Direct tool access für IDEs)\n"
printf "  ✓ Agent Platform (Orchestrierte LLM Agents mit Custom Instructions)\n"
printf "  ✓ Workflow Engine (Multi-step Automationen)\n"
printf "  ✓ Service Bundles (Tool-Gruppierung + RBAC)\n"
printf "  ✓ API Key Scopes (mcp / agents / both)\n"
printf "  ✓ Message Filters (Webhook-basierte Tool-Interceptors)\n"
printf "  ✓ Audit Trail (NIS2/ISO27001-konform, ${AUDIT_LOG_RETENTION_DAYS:-90} Tage)\n"
printf "\n"
info "Initial Login:"
printf "\n"
printf "  Beim ersten Besuch von /login kannst du einen Admin-User anlegen.\n"
printf "  API Keys verwaltest du dann unter /admin → API Keys.\n"
printf "\n"


