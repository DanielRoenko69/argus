/**
 * Internal credentials resolution endpoint.
 *
 * GET /api/internal/workflow-creds/:workflowId/:backendKind
 *
 * Auth: shared secret via X-Workspace-Secret header.
 * Used by LangGraph (coding workflow) + agent-workspace to fetch
 * workflow-scoped backend credentials without holding tokens themselves.
 *
 * Token bleibt im Argus-Pod entschlüsselt — wird nur über cluster-internal
 * HTTPS/HTTP an LangGraph weitergegeben. Argus-internal Service-DNS only;
 * NEVER expose this route via Ingress (Argus Ingress MUST NOT route
 * /api/internal/* paths; enforce via NetworkPolicy in Helm chart).
 */

import express, { type Request, type Response, type Router } from 'express';
import type pg from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { getWorkflowBackendCreds, getBundleGitBackend } from './backendCredsStore.js';
import { logger } from '../lib/logger.js';
import { BackendAuthenticationError } from '../backends/backendAuthentication.js';
import {
  assertExecutionGrantActive,
  verifyExecutionGrant,
} from '../solutionPacks/executionGrant.js';
import { listAgentRuntimeAssignments } from '../agents/runtimeProfiles.js';

/** Constant-time string compare to avoid timing oracle on secret check. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function createInternalCredsRouter(
  pool: pg.Pool,
  executionGrantSecret = process.env['ARGUS_EXECUTION_GRANT_SECRET'] ?? '',
): Router {
  const router = express.Router();

  router.get('/api/internal/workflow-creds/:workflowId/:backendKind', async (req: Request, res: Response) => {
    // ── Auth ────────────────────────────────────────────────
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');

    if (!expectedSecret) {
      logger.error('internal-creds: WORKSPACE_SECRET not set — rejecting all requests');
      return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    }
    if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
      logger.warn({ ip: req.ip, path: req.path }, 'internal-creds: auth failed');
      return res.status(401).json({ error: 'unauthorized' });
    }

    // ── Input validation ───────────────────────────────────
    const workflowId = Number.parseInt(String(req.params['workflowId'] ?? ''), 10);
    if (!Number.isInteger(workflowId) || workflowId <= 0) {
      return res.status(400).json({ error: 'workflowId must be a positive integer' });
    }
    const backendKind = String(req.params['backendKind'] ?? '');
    if (!/^[a-z0-9_-]+$/i.test(backendKind) || backendKind.length > 32) {
      return res.status(400).json({ error: 'backendKind must be alphanumeric, ≤32 chars' });
    }

    // ── Resolve ────────────────────────────────────────────
    try {
      const creds = await getWorkflowBackendCreds(pool, workflowId, backendKind);
      if (!creds) {
        return res.status(404).json({
          error: 'no backend creds found',
          workflowId,
          backendKind,
          hint: 'Assign a bundle containing a ' + backendKind + ' backend to this workflow via the Argus Console workflow catalog.',
        });
      }
      return res.json({
        backend_id:   creds.backend_id,
        backend_name: creds.backend_name,
        base_url:     creds.base_url,
        token:        creds.token,        // may be null when no token set in /admin
        config:       creds.config,
      });
    } catch (err) {
      if (err instanceof BackendAuthenticationError) return res.status(409).json({ error: err.message, code: err.code });
      logger.error({ err, workflowId, backendKind }, 'internal-creds: resolve failed');
      return res.status(500).json({ error: 'creds resolution failed' });
    }
  });

  // ── Bundle-based git creds resolution (Coding-Workflow) ─────
  // GET /api/internal/bundle-creds/:bundleId/git
  // Returns the first git provider backend (bitbucket/gitea/github) in the bundle.
  router.get('/api/internal/bundle-creds/:bundleId/git', async (req: Request, res: Response) => {
    const bundleId = Number.parseInt(String(req.params['bundleId'] ?? ''), 10);
    if (!Number.isInteger(bundleId) || bundleId <= 0) {
      return res.status(400).json({ error: 'bundleId must be a positive integer' });
    }
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');
    const executionToken = String(req.header('authorization') ?? '').startsWith('Bearer eg_v1.')
      ? String(req.header('authorization')).slice('Bearer '.length)
      : '';
    let authorized = Boolean(expectedSecret && providedSecret && safeEqual(providedSecret, expectedSecret));
    if (!authorized && executionToken) {
      try {
        const rootTraceId = String(req.header('x-argus-root-trace-id') ?? '');
        // A Managed Runtime MCP grant is intentionally incapable of resolving
        // a raw backend credential. It can use only the lease-bound MCP
        // transport, while normal Agent-surface grants retain this existing
        // bundle-scoped workflow compatibility path.
        const claims = verifyExecutionGrant(executionGrantSecret, executionToken, {
          bundleId,
          rootTraceId,
          executionSurface: 'agent',
        });
        await assertExecutionGrantActive(pool, claims.jti);
        authorized = true;
      } catch {
        authorized = false;
      }
    }
    if (!authorized) {
      logger.warn({ ip: req.ip, path: req.path }, 'internal-creds bundle: auth failed');
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const creds = await getBundleGitBackend(pool, bundleId);
      if (!creds) {
        return res.status(404).json({
          error: 'no git backend in bundle',
          bundleId,
          hint: 'Add a backend named "bitbucket", "gitea", or "github" (or set config.kind) to this bundle via /admin/bundles.',
        });
      }
      return res.json({
        backend_id:   creds.backend_id,
        backend_name: creds.backend_name,
        base_url:     creds.base_url,
        token:        creds.token,
        config:       creds.config,
        kind:         creds.kind,
      });
    } catch (err) {
      if (err instanceof BackendAuthenticationError) return res.status(409).json({ error: err.message, code: err.code });
      logger.error({ err, bundleId }, 'internal-creds bundle: resolve failed');
      return res.status(500).json({ error: 'creds resolution failed' });
    }
  });

  // ── Agent name → id resolution (Coding-Workflow / LangGraph) ────────
  // GET /api/internal/agent-ids  → { "<name>": <id>, ... } for enabled agents.
  // Lets LangGraph address agents by their stable NAME instead of per-instance
  // SERIAL ids (which differ between local / dev / prod DBs). Same X-Workspace-Secret
  // auth; MUST NOT be exposed via Ingress (enforce via NetworkPolicy in Helm chart).
  router.get('/api/internal/agent-ids', async (req: Request, res: Response) => {
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');

    if (!expectedSecret) {
      logger.error('internal-creds: WORKSPACE_SECRET not set');
      return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    }
    if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
      logger.warn({ ip: req.ip, path: req.path }, 'internal-creds agent-ids: auth failed');
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const { rows } = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM mcp_agents WHERE enabled = true ORDER BY id`
      );
      const map: Record<string, number> = {};
      for (const row of rows) map[row.name] = row.id;
      return res.json(map);
    } catch (err) {
      logger.error({ err }, 'internal-creds agent-ids: resolve failed');
      return res.status(500).json({ error: 'agent-id resolution failed' });
    }
  });

  // GET /api/internal/agent-runtimes
  //   {
  //     "coder": { "agentId": 12, "runtimeType": "codex" | "claude-code", "profileId": 2, ... }
  //   }
  //
  // Only runtime metadata is returned. Auth references are deliberately not
  // included here: LangGraph calls the workspace runtime, which owns the
  // protected Codex auth volume and performs the actual auth check.
  router.get('/api/internal/agent-runtimes', async (req: Request, res: Response) => {
    const expectedSecret = process.env['WORKSPACE_SECRET'] ?? '';
    const providedSecret = String(req.header('x-workspace-secret') ?? '');

    if (!expectedSecret) {
      logger.error('internal-creds: WORKSPACE_SECRET not set');
      return res.status(503).json({ error: 'service-misconfigured: WORKSPACE_SECRET missing' });
    }
    if (!providedSecret || !safeEqual(providedSecret, expectedSecret)) {
      logger.warn({ ip: req.ip, path: req.path }, 'internal-creds agent-runtimes: auth failed');
      return res.status(401).json({ error: 'unauthorized' });
    }

    try {
      const assignments = await listAgentRuntimeAssignments(pool);
      const map: Record<string, {
        agentId: number;
        runtimeType: 'argus' | 'codex' | 'claude-code' | 'hermes' | null;
        profileId: number | null;
        profileName: string | null;
        profileLabel: string | null;
        authMode: string | null;
        model: string | null;
        reasoningEffort: string | null;
        codeContextMode: 'metadata_only' | 'bounded_source' | null;
        codeContextMaxResults: number | null;
        codeContextMaxBytes: number | null;
        profileEnabled: boolean | null;
      }> = {};
      for (const row of assignments) {
        map[row.agent_name] = {
          agentId: row.agent_id,
          runtimeType: row.runtime_type,
          profileId: row.profile_id,
          profileName: row.profile_name,
          profileLabel: row.profile_label,
          authMode: row.auth_mode,
          model: row.model,
          reasoningEffort: row.reasoning_effort,
          codeContextMode: row.code_context_mode,
          codeContextMaxResults: row.code_context_max_results,
          codeContextMaxBytes: row.code_context_max_bytes,
          profileEnabled: row.profile_enabled,
        };
      }
      return res.json(map);
    } catch (err) {
      logger.error({ err }, 'internal-creds agent-runtimes: resolve failed');
      return res.status(500).json({ error: 'agent-runtime resolution failed' });
    }
  });

  return router;
}
