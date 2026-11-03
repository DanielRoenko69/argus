import { runFilters } from '../../../filters/toolFilters.js';
import type { ToolHook } from '../types.js';

/**
 * Bridges administrator-managed external policy webhooks into the same hook
 * chain used by agents, workflows and direct MCP clients.
 */
export const externalPolicyFilter: ToolHook = {
  name: 'external-policy-filter',
  priority: 800,
  description: 'Runs enabled external pre-execution policies with optional HMAC signing and argument transformation.',
  async preToolUse(ctx) {
    const result = await runFilters(ctx.toolName, ctx.toolArgs, {
      apiKeyPrefix: ctx.apiKeyPrefix ?? null,
      sessionId: ctx.sessionId || null,
    });
    if (!result.allowed) return { block: result.reason };
    return result.args === ctx.toolArgs ? null : { modify: result.args };
  },
};
