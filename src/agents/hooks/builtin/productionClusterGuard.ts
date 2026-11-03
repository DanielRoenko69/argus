/**
 * production-cluster-guard — tool-level hook at priority 95.
 *
 * Blocks K8s/Helm/Terraform tool calls that target a Production cluster when
 * the calling agent has `production_cluster_access=false`, OR when
 * ARGUS_PROD_APPROVAL_ENFORCE=true and the agent has not been explicitly
 * approved for this tool call.
 *
 * Detection:
 * - toolArgs.target_cluster ∈ prod_cluster_names → prod
 * - toolArgs.namespace matches /^prod/i → prod
 * - toolArgs.kubeconfig_context contains 'prod' → prod
 *
 * Tools considered destructive against prod:
 *   k8s_apply, k8s_delete, k8s_patch, k8s_scale, helmrelease_deploy,
 *   helm_upgrade, helm_uninstall, terraform_apply, terraform_destroy,
 *   workspace_exec when cmd contains 'kubectl apply' / 'helm upgrade' / 'terraform apply'
 *
 * Returns:
 *   null     → allow
 *   { block: reason } → blocked, agent must request human approval via UI
 */

import type pg from 'pg';
import type { ToolHook, HookContext } from '../types.js';
import { logger } from '../../../lib/logger.js';

const DESTRUCTIVE_TOOLS = new Set([
  'k8s_apply', 'k8s_delete', 'k8s_patch', 'k8s_scale',
  'helmrelease_deploy', 'helm_upgrade', 'helm_uninstall',
  'terraform_apply', 'terraform_destroy',
]);

const EXEC_PROD_HEURISTIC = /\b(?:kubectl\s+(?:apply|delete|patch|scale)|helm\s+(?:upgrade|uninstall|delete)|terraform\s+(?:apply|destroy))\b/i;

interface AgentRow { production_cluster_access: boolean }

async function getProdClusterNames(pool: pg.Pool): Promise<string[]> {
  try {
    const { rows } = await pool.query<{ value: unknown }>(
      `SELECT value FROM mcp_platform_settings WHERE category='security' AND key='prod_cluster_names'`,
    );
    if (!rows[0]) return ['prod', 'production'];
    // pg returns JSONB pre-parsed. Tolerate stringified payloads defensively.
    const raw = rows[0].value;
    if (Array.isArray(raw)) return raw.map((v) => String(v));
    if (typeof raw === 'string') {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((v) => String(v));
      } catch { /* fall through */ }
    }
    return ['prod', 'production'];
  } catch {
    return ['prod', 'production'];
  }
}

function looksLikeProd(args: Record<string, unknown>, prodNames: string[]): boolean {
  const target = String(args['target_cluster'] ?? '').toLowerCase();
  const ns     = String(args['namespace'] ?? '').toLowerCase();
  const ctx    = String(args['kubeconfig_context'] ?? '').toLowerCase();

  if (prodNames.some((p) => p.toLowerCase() === target)) return true;
  if (ns.startsWith('prod')) return true;
  if (ctx.includes('prod')) return true;
  return false;
}

export function makeProductionClusterGuard(pool: pg.Pool, opts: { enforce: () => boolean }): ToolHook {
  return {
    name: 'production-cluster-guard',
    priority: 95,
    description: 'Blocks destructive K8s/Helm/Terraform ops on production clusters unless agent has production_cluster_access OR was explicitly approved.',
    preToolUse: async (ctx: HookContext) => {
      if (!opts.enforce()) return null;

      const args = (ctx.toolArgs ?? {}) as Record<string, unknown>;
      let isDestructive = DESTRUCTIVE_TOOLS.has(ctx.toolName);
      if (ctx.toolName === 'workspace_exec') {
        const cmd = String(args['cmd'] ?? '');
        isDestructive = isDestructive || EXEC_PROD_HEURISTIC.test(cmd);
      }
      if (!isDestructive) return null;

      const prodNames = await getProdClusterNames(pool);
      if (!looksLikeProd(args, prodNames)) return null;

      let row: AgentRow | undefined;
      try {
        const r = await pool.query<AgentRow>(
          `SELECT production_cluster_access FROM mcp_agents WHERE id=$1`,
          [ctx.agentId],
        );
        row = r.rows[0];
      } catch (err) {
        logger.warn({ err }, 'productionClusterGuard: failed to load agent — fail-closed');
        return { block: 'production-cluster-guard: agent record unavailable, blocking by default' };
      }

      if (row?.production_cluster_access) return null;

      return {
        block:
          `production-cluster-guard: tool "${ctx.toolName}" targets a production cluster ` +
          `but agent ${ctx.agentId} does not have production_cluster_access. ` +
          `Request human approval in the Argus UI to proceed.`,
      };
    },
  };
}
