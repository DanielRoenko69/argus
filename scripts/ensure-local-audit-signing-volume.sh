#!/bin/sh
# Reconcile the installer-managed audit signing volume without exposing the key.
# The normal Docker installer configures Core to read this path from a named
# volume. Lightweight demo bootstraps must preserve that contract when they
# recreate only the Core container.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
AUDIT_PATH=/run/secrets/audit/argus-audit-signing-key.pem

read_env() {
  sed -n "s/^${1}=//p" "$ROOT_DIR/.env" | tail -n 1
}

[ -f "$ROOT_DIR/.env" ] || { printf '%s\n' '[audit-signing] Missing .env.' >&2; exit 1; }
configured_path=$(read_env ARGUS_AUDIT_SIGNING_PRIVATE_KEY_FILE)
[ "$configured_path" = "$AUDIT_PATH" ] || exit 0

command -v docker >/dev/null 2>&1 || { printf '%s\n' '[audit-signing] Docker is required.' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { printf '%s\n' '[audit-signing] Node.js is required.' >&2; exit 1; }
docker info >/dev/null 2>&1 || { printf '%s\n' '[audit-signing] Docker is not ready.' >&2; exit 1; }

node "$SCRIPT_DIR/ensure-audit-signing-key.mjs" >/dev/null
docker volume create argus-core-installer-audit-signing >/dev/null
tar -C "$ROOT_DIR/secrets" -cf - argus-audit-signing-key.pem | \
  docker run --rm -i -v argus-core-installer-audit-signing:/run/secrets alpine:3.23 \
    sh -ec 'umask 077; tar -C /run/secrets -xf -; chmod 0555 /run/secrets; chmod 0444 /run/secrets/*'

printf '%s\n' '[audit-signing] Local installer audit signer is ready.'
