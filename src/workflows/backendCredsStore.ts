/**
 * Resolves backend credentials for a workflow.
 *
 * Topology:
 *   mcp_workflow_bundles (workflow_id, bundle_id)
 *      ↓
 *   mcp_backend_bundles (backend_id, bundle_id)
 *      ↓
 *   mcp_backends (auth_value encrypted, config JSONB)
 *
 * Returns the FIRST matching backend (by name prefix or config.kind) joined
 * via any of the workflow's bundles. If multiple backends match (e.g. user
 * assigned 2 bitbucket bundles), the lowest-ID one wins.
 *
 * Token is decrypted via DB_ENCRYPTION_KEY (src/lib/encryption.ts).
 */

import type pg from 'pg';
import { decrypt } from '../lib/encryption.js';
import { logger } from '../lib/logger.js';
import { assertServiceCredentialAdapter, type BackendAuthMode } from '../backends/backendAuthentication.js';

/** A workflow selects an authorized backend, not a portable decrypted secret.
 * The transport resolves the current user's credential just before each call.
 */
export async function resolveBundleBackendReference(pool: pg.Pool, bundleId: number, backendId?: number): Promise<number> {
  if (!Number.isSafeInteger(bundleId) || bundleId < 1
    || (backendId !== undefined && (!Number.isSafeInteger(backendId) || backendId < 1))) {
    throw new Error('Invalid workflow backend reference');
  }
  const { rows } = await pool.query<{ id: number }>(
    `SELECT b.id FROM mcp_backends b JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
     WHERE bb.bundle_id = $1 AND b.enabled = true AND ($2::int IS NULL OR b.id = $2)
     ORDER BY b.id LIMIT 2`, [bundleId, backendId ?? null],
  );
  if (rows.length !== 1) throw new Error('Select exactly one enabled backend in the authorized credential Bundle');
  return rows[0]!.id;
}

export interface BackendCreds {
  backend_id: number;
  backend_name: string;
  base_url: string;
  token: string | null;          // decrypted; null when no token set yet
  config: Record<string, unknown>;
}

/**
 * Get credentials for a workflow + backend kind.
 *
 * @param pool      pg connection pool
 * @param workflowId Argus workflow ID
 * @param kind       backend kind, matched against (a) backend name prefix "<kind>-",
 *                   (b) config->>'kind' = kind. E.g. 'bitbucket'.
 * @returns BackendCreds when found, null when workflow has no matching backend bundle.
 */
export async function getWorkflowBackendCreds(
  pool: pg.Pool,
  workflowId: number,
  kind: string,
): Promise<BackendCreds | null> {
  if (!Number.isInteger(workflowId) || workflowId <= 0) {
    throw new Error(`getWorkflowBackendCreds: invalid workflowId ${workflowId}`);
  }
  if (!kind || typeof kind !== 'string' || !/^[a-z0-9_-]+$/i.test(kind)) {
    throw new Error(`getWorkflowBackendCreds: invalid kind "${kind}"`);
  }

  const sql = `
    SELECT
      b.id AS backend_id,
      b.name AS backend_name,
      b.base_url,
      b.auth_mode,
      b.auth_value,
      b.config
    FROM mcp_backends b
    JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
    JOIN mcp_workflow_bundles wb ON wb.bundle_id = bb.bundle_id
    WHERE wb.workflow_id = $1
      AND b.enabled = true
      AND (
        b.name LIKE $2
        OR (b.config ->> 'kind') = $3
      )
    ORDER BY b.id ASC
    LIMIT 1
  `;

  let row;
  try {
    const res = await pool.query<{
      backend_id: number;
      backend_name: string;
      base_url: string;
      auth_value: string | null;
      auth_mode: BackendAuthMode;
      config: Record<string, unknown> | null;
    }>(sql, [workflowId, `${kind}-%`, kind]);
    row = res.rows[0];
  } catch (err) {
    logger.error({ err, workflowId, kind }, 'getWorkflowBackendCreds: DB query failed');
    throw err;
  }

  if (!row) {
    return null;
  }

  assertServiceCredentialAdapter(row.backend_id, row.auth_mode);
  // Decrypt token only for an explicitly configured service identity.
  let token: string | null = null;
  try {
    token = decrypt(row.auth_value);
  } catch (err) {
    logger.error({ err, backend_id: row.backend_id }, 'getWorkflowBackendCreds: decrypt failed');
    // Fail-closed: rather return null than leak partial creds
    return null;
  }

  return {
    backend_id: row.backend_id,
    backend_name: row.backend_name,
    base_url: row.base_url,
    token,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

// ── Bundle-based git creds (used by Coding-Workflow) ─────────────────

/** Supported git providers — used to dispatch URL construction + PR API. */
export type GitKind = 'bitbucket' | 'gitea' | 'github';

export interface GitBackendCreds extends BackendCreds {
  /** Detected git provider — from config.kind if set, else inferred from name. */
  kind: GitKind;
}

/**
 * Detect git provider kind from backend name + config.
 * Precedence: config.kind explicit → name substring.
 * Returns null when not a recognized git provider.
 */
function detectGitKind(name: string, config: Record<string, unknown>): GitKind | null {
  const explicit = String(config['kind'] ?? '').toLowerCase();
  if (explicit === 'bitbucket' || explicit === 'gitea' || explicit === 'github') return explicit;
  const n = name.toLowerCase();
  if (n.includes('gitea'))    return 'gitea';
  if (n.includes('bitbucket'))return 'bitbucket';
  if (n.includes('github'))   return 'github';
  return null;
}

/**
 * Resolve the git-provider backend assigned to a bundle.
 *
 * Topology:
 *   mcp_backend_bundles (backend_id, bundle_id) → mcp_backends
 *
 * Returns the FIRST enabled backend in the bundle whose name OR config.kind
 * matches a known git provider (bitbucket/gitea/github). If multiple match,
 * the lowest-ID one wins (deterministic). Token is decrypted.
 *
 * Use when the Coding-Workflow needs Bitbucket/Gitea/GitHub creds:
 *   getBundleGitBackend(pool, 21) → { kind: 'gitea', token: '...', base_url: '...', ... }
 */
export async function getBundleGitBackend(
  pool: pg.Pool,
  bundleId: number,
): Promise<GitBackendCreds | null> {
  if (!Number.isInteger(bundleId) || bundleId <= 0) {
    throw new Error(`getBundleGitBackend: invalid bundleId ${bundleId}`);
  }

  const sql = `
    SELECT b.id AS backend_id, b.name AS backend_name, b.base_url, b.auth_value, b.auth_mode, b.config
    FROM mcp_backends b
    JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
    WHERE bb.bundle_id = $1
      AND b.enabled = true
      AND (
        (b.config ->> 'kind') IN ('bitbucket', 'gitea', 'github')
        OR b.name ILIKE '%bitbucket%'
        OR b.name ILIKE '%gitea%'
        OR b.name ILIKE '%github%'
      )
    ORDER BY
      CASE WHEN b.config ->> 'kind' IN ('bitbucket','gitea','github') THEN 0 ELSE 1 END,
      b.id ASC
    LIMIT 1
  `;

  let row;
  try {
    const res = await pool.query<{
      backend_id: number;
      backend_name: string;
      base_url: string;
      auth_value: string | null;
      auth_mode: BackendAuthMode;
      config: Record<string, unknown> | null;
    }>(sql, [bundleId]);
    row = res.rows[0];
  } catch (err) {
    logger.error({ err, bundleId }, 'getBundleGitBackend: DB query failed');
    throw err;
  }
  if (!row) return null;

  assertServiceCredentialAdapter(row.backend_id, row.auth_mode);
  const config = (row.config ?? {}) as Record<string, unknown>;
  const kind = detectGitKind(row.backend_name, config);
  if (!kind) {
    logger.warn({ bundleId, backend: row.backend_name }, 'getBundleGitBackend: kind detection failed');
    return null;
  }

  let token: string | null = null;
  try {
    token = decrypt(row.auth_value);
  } catch (err) {
    logger.error({ err, backend_id: row.backend_id }, 'getBundleGitBackend: decrypt failed');
    return null;
  }

  return {
    backend_id: row.backend_id,
    backend_name: row.backend_name,
    base_url: row.base_url,
    token,
    config,
    kind,
  };
}

// ── Bundle-scoped creds for per-step cred_ref override ───────────────

/**
 * Resolve the service creds of a backend reachable via a single bundle.
 *
 * Used by the workflow executor when a step carries a `cred_ref`. Topology
 * is the bundle-level slice of getWorkflowBackendCreds:
 *   mcp_backend_bundles (backend_id, bundle_id) → mcp_backends
 *
 * @param pool          pg pool
 * @param bundleId      mcp_service_bundles.id the step references
 * @param backendCredId optional pin to a specific backend id; when set, the
 *                      backend MUST be linked to `bundleId` or null is returned
 *                      (prevents pinning a backend outside the authorized bundle).
 * @returns BackendCreds (token decrypted) or null when nothing matches.
 *          Fail-closed on decrypt error (returns null, never partial creds).
 */
export async function resolveBundleBackendCreds(
  pool: pg.Pool,
  bundleId: number,
  backendCredId?: number,
): Promise<BackendCreds | null> {
  if (!Number.isInteger(bundleId) || bundleId <= 0) {
    throw new Error(`resolveBundleBackendCreds: invalid bundleId ${bundleId}`);
  }
  if (backendCredId !== undefined && (!Number.isInteger(backendCredId) || backendCredId <= 0)) {
    throw new Error(`resolveBundleBackendCreds: invalid backendCredId ${backendCredId}`);
  }

  const sql = `
    SELECT b.id AS backend_id, b.name AS backend_name, b.base_url, b.auth_value, b.auth_mode, b.config
    FROM mcp_backends b
    JOIN mcp_backend_bundles bb ON bb.backend_id = b.id
    WHERE bb.bundle_id = $1
      AND b.enabled = true
      AND ($2::int IS NULL OR b.id = $2::int)
    ORDER BY b.id ASC
    LIMIT 1
  `;

  let row;
  try {
    const res = await pool.query<{
      backend_id: number;
      backend_name: string;
      base_url: string;
      auth_value: string | null;
      auth_mode: BackendAuthMode;
      config: Record<string, unknown> | null;
    }>(sql, [bundleId, backendCredId ?? null]);
    row = res.rows[0];
  } catch (err) {
    logger.error({ err, bundleId, backendCredId }, 'resolveBundleBackendCreds: DB query failed');
    throw err;
  }
  if (!row) return null;

  assertServiceCredentialAdapter(row.backend_id, row.auth_mode);
  let token: string | null = null;
  try {
    token = decrypt(row.auth_value);
  } catch (err) {
    logger.error({ err, backend_id: row.backend_id }, 'resolveBundleBackendCreds: decrypt failed');
    return null; // fail-closed
  }

  return {
    backend_id: row.backend_id,
    backend_name: row.backend_name,
    base_url: row.base_url,
    token,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}
