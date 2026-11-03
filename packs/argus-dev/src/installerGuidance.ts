import { ENVIRONMENT_PREFLIGHT_GUIDANCE } from './environmentPreflight.js';

/** A reviewed example, not a shell rewriter or permission to skip verification. */
export const VERIFIED_ARCHIVE_EXAMPLE = [
  'archive_name="${asset_url##*/}"',
  'curl --fail --show-error --silent --location --proto "=https" --proto-redir "=https" "$asset_url" -o "$download_dir/$archive_name"',
  'curl --fail --show-error --silent --location --proto "=https" --proto-redir "=https" "$checksum_url" -o "$download_dir/archive.sha256"',
  '( cd "$download_dir" && sha256sum --check --strict archive.sha256 )',
].join('\n');

export const INSTALLER_GUIDANCE = `
Service startup: setup runs as root, but services may run under a different OS user. Before switching user, create only the service-owned data, log and socket directories with that user's ownership and restrictive permissions. A root-owned parent or a pre-created root-owned log file can prevent a non-root daemon from starting. Check directory traversal and write access as the actual service user before launch. For a fresh PostgreSQL log directory, for example: install -d -m 0750 -o postgres -g postgres /tmp/argus-postgres-logs; then runuser -u postgres -- test -w /tmp/argus-postgres-logs. Use this only after the package has created that user/group. Choose explicit per-service paths inside the disposable container, not shared root-owned directories. Do not chmod 777, recursively chown /tmp or /repo, run PostgreSQL as root, swallow startup failures or change application/tests to bypass them. Wait for service readiness and preserve startup failure propagation. Startup and tests share one shell; exports/functions and cleanup traps survive, but setup runs separately.
Download integrity: preserve the release archive's original basename when its published checksum file names that basename. Run sha256sum --check in the same download directory. A download saved as uv.tar.gz cannot be verified by an unchanged manifest naming uv-x86_64-unknown-linux-gnu.tar.gz. This is a local filename error, not a missing package, checksum mismatch or reason to disable verification. Extract/install only after verification succeeds; retain failure propagation.
For a verified official release URL and its documented single-asset GNU SHA-256 manifest, use this tested pattern (asset_url, checksum_url and download_dir are explicit recipe variables):
${VERIFIED_ARCHIVE_EXAMPLE}
Adapt to the actual published checksum format; do not guess manifest URLs, compute a replacement expected digest from downloaded bytes, ignore checksum failures, or skip TLS/integrity checks. Check every download, local filename, verification working directory and extraction path before returning a recipe. This guidance applies to initial setup and repairs, not product/test changes.
${ENVIRONMENT_PREFLIGHT_GUIDANCE}`;
