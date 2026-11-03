/**
 * user-policy-gate — tool-level hook at priority 50.
 * Enforces per-user / per-group MCP-tool policies from migration 083.
 *
 * - API-key requests (no userId) → allow (skip — they have their own RBAC)
 * - SSO-authenticated requests → resolve via userPolicyStore + resolver
 * - DB errors → fail-CLOSED (block with policy-load-error reason)
 *
 * Return convention:
 *   { block: 'no' }            → allow (registry truthy-check: 'no' treated as non-empty,
 *                                  but downstream code in runPreToolHooks uses `if (r.block)`
 *                                  which would normally treat any string as a block reason.
 *                                  NOTE: 'no' here is an internal sentinel — hook callers
 *                                  that check block !== undefined must treat 'no' as allow.)
 *   { block: 'yes', reason }   → block with reason forwarded to LLM
 */

import type pg from 'pg';
import type { ToolHook, HookContext } from '../types.js';
import { fetchUserPolicyData } from '../../../auth/userPolicyStore.js';
import { resolveUserPolicy } from '../../../auth/userPolicyResolver.js';

// Extend HookResult locally with the 'no'/'yes' block discriminant pattern used
// by this hook. The caller (test or registry) reads .block to determine allow/deny.
interface PolicyHookResult {
  block: 'no' | 'yes';
  reason?: string;
}

export function makeUserPolicyGate(pool: pg.Pool, opts?: { enforce?: () => boolean }): ToolHook {
  const enforce = opts?.enforce ?? (() => true);

  return {
    name: 'user-policy-gate',
    priority: 50,
    description: 'Enforces per-user/per-group MCP-tool policies for SSO-authenticated requests',
    preToolUse: async (ctx: HookContext): Promise<PolicyHookResult> => {
      if (!enforce()) {
        return { block: 'no' };
      }
      if (!ctx.userId) {
        return { block: 'no' };
      }

      let data;
      try {
        data = await fetchUserPolicyData(pool, ctx.userId, ctx.userGroups ?? []);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { block: 'yes', reason: `policy-load-error: ${msg.slice(0, 200)}` };
      }

      const result = resolveUserPolicy({ toolName: ctx.toolName, ...data });
      if (result.decision === 'allow') {
        return { block: 'no' };
      }
      return { block: 'yes', reason: result.reason };
    },
  };
}
