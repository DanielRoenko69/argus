import type { ToolHook } from '../types.js';
import { getAgentHookConfig, effectiveMaxToolCalls } from '../config.js';

// Hard cap on tool calls per session. Matches the existing subagent global
// cap (MAX_TOTAL_SUBAGENTS=20) but multiplied by max agent iterations (~10)
// plus buffer. Override via env later if needed.
const MAX_TOOL_CALLS_PER_SESSION = 60;

const counter = new Map<string, number>();

/** Test-only helper to reset between tests. NEVER call in prod code. */
export function resetBudgetForTest(): void {
  counter.clear();
}

export const costBudgetGuard: ToolHook = {
  name: 'cost-budget-guard',
  priority: 120,
  description: `Blocks further tool calls when a session has made ${MAX_TOOL_CALLS_PER_SESSION}+ tool calls. Prevents runaway agent loops.`,
  async preToolUse(ctx) {
    // Tighten-only per-agent cap (P1.3): config may LOWER the cap, never raise it.
    const cfg = await getAgentHookConfig(ctx.agentId);
    const cap = effectiveMaxToolCalls(MAX_TOOL_CALLS_PER_SESSION, cfg.maxToolCalls);
    const used = counter.get(ctx.sessionId) ?? 0;
    if (used >= cap) {
      return {
        block: `Session budget exhausted: ${used} tool calls used (limit ${cap}). ` +
               `Wrap up the task and produce a final answer. If more work is genuinely needed, ` +
               `the human reviewer must open a new session.`,
      };
    }
    return null;
  },
  async postToolUse(ctx) {
    counter.set(ctx.sessionId, (counter.get(ctx.sessionId) ?? 0) + 1);
  },
};
