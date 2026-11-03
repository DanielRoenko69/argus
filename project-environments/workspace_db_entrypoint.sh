#!/bin/sh
# Admin is local-peer only. This random bootstrap password is never distributed;
# disposable run passwords are issued separately by the trusted controller.
set -eu
unset POSTGRES_HOST_AUTH_METHOD POSTGRES_PASSWORD_FILE
POSTGRES_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
export POSTGRES_PASSWORD
exec /usr/local/bin/docker-entrypoint.sh postgres -c hba_file=/etc/argus/workspace-db.pg_hba.conf -c password_encryption=scram-sha-256
