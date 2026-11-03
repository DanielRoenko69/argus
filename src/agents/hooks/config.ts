/**
 * Per-agent tool-hook configuration (P1.3).
 *
 * Posture: ADDITIVE / TIGHTEN-ONLY. The built-in guards (destructive-cmd,
 * production-cluster) are a non-removable security floor. Per-agent config can
 * only ADD destructive patterns and LOWER the cost-budget cap — it can never
 * disable a guard or raise a cap. If the config lookup fails, we fall back to
 * EMPTY so the built-in floor still fully applies (fail-safe, never weaken).
 *
 * Hooks consult a module-level provider rather than taking a pg.Pool in every
 * preToolUse, mirroring the factory pattern of the DB-aware hooks. Default
 * provider returns EMPTY, so hooks behave exactly as before until bootstrap
 * wires the DB-backed provider.
 */
import type pg from 'pg';

export interface AgentHookConfig {
  /** Additional destructive-command regex sources, unioned with the built-in floor. */
  extraDestructivePatterns: string[];
  /** Tighten-only cap for cost-budget-guard. null = use the built-in default. */
  maxToolCalls: number | null;
}

const EMPTY: AgentHookConfig = { extraDestructivePatterns: [], maxToolCalls: null };

type Provider = (agentId: number) => Promise<AgentHookConfig>;
let provider: Provider = async () => EMPTY;

export function setAgentHookConfigProvider(p: Provider): void { provider = p; }
export function resetAgentHookConfigProvider(): void { provider = async () => EMPTY; }

/** Fail-safe lookup: any error → EMPTY (built-in guards stay fully in force). */
export async function getAgentHookConfig(agentId: number): Promise<AgentHookConfig> {
  try {
    return await provider(agentId);
  } catch {
    return EMPTY;
  }
}

/** Tighten-only: config may only LOWER the cap, never raise it above the built-in. */
export function effectiveMaxToolCalls(builtin: number, configured: number | null): number {
  if (configured == null || !Number.isFinite(configured) || configured <= 0) return builtin;
  return Math.min(builtin, Math.floor(configured));
}

/** Compile extra regex sources (case-insensitive); skip invalid ones, never throw. */
export function compileExtraPatterns(sources: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const s of sources) {
    try { out.push(new RegExp(s, 'i')); } catch { /* skip invalid pattern */ }
  }
  return out;
}

/**
 * DB-backed provider with a short TTL cache. Reads mcp_agent_hook_config.
 * agentId <= 0 (workflow/non-agent paths) → EMPTY. Changes apply within ttlMs.
 */
export function makeDbHookConfigProvider(pool: pg.Pool, ttlMs = 30_000): Provider {
  const cache = new Map<number, { at: number; cfg: AgentHookConfig }>();
  return async (agentId: number) => {
    if (!agentId || agentId <= 0) return EMPTY;
    const now = Date.now();
    const hit = cache.get(agentId);
    if (hit && now - hit.at < ttlMs) return hit.cfg;
    const { rows } = await pool.query<{ extra_destructive_patterns: string[] | null; max_tool_calls: number | null }>(
      'SELECT extra_destructive_patterns, max_tool_calls FROM mcp_agent_hook_config WHERE agent_id = $1',
      [agentId],
    );
    const cfg: AgentHookConfig = rows[0]
      ? {
          extraDestructivePatterns: rows[0].extra_destructive_patterns ?? [],
          maxToolCalls: rows[0].max_tool_calls ?? null,
        }
      : EMPTY;
    cache.set(agentId, { at: now, cfg });
    return cfg;
  };
}
