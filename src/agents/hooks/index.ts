import type pg from 'pg';
import { registerHook } from './registry.js';
import { destructiveCmdGuard } from './builtin/destructiveCmd.js';
import { piiPreWriteGuard } from './builtin/piiPreWrite.js';
import { costBudgetGuard } from './builtin/costBudget.js';
import { makeHumanApprovalGate } from './builtin/humanApprovalGate.js';
import { makeUserPolicyGate } from './builtin/userPolicyGate.js';
import { makeProductionClusterGuard } from './builtin/productionClusterGuard.js';
import { externalPolicyFilter } from './builtin/externalPolicyFilter.js';
import { setAgentHookConfigProvider, makeDbHookConfigProvider } from './config.js';
import { loadConfig } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export type { HookContext, HookResult, ToolHook, HookDecision } from './types.js';
export { runPreToolHooks, runPostToolHooks, listHooks } from './registry.js';

/**
 * Register the 7 built-in hooks. Called once during server startup.
 * Passing `pool` lets DB-aware hooks (humanApprovalGate, userPolicyGate,
 * productionClusterGuard) capture it via closure without dependency-injecting
 * it into every preToolUse call.
 */
export function bootstrapBuiltinHooks(pool: pg.Pool): void {
  // Per-agent additive hook config (P1.3) — destructive/cost-budget guards read this.
  setAgentHookConfigProvider(makeDbHookConfigProvider(pool));
  registerHook(makeUserPolicyGate(pool, {
    enforce: () => loadConfig().rbacEnforce,
  }));
  registerHook(destructiveCmdGuard);
  registerHook(piiPreWriteGuard);
  registerHook(costBudgetGuard);
  registerHook(makeProductionClusterGuard(pool, {
    enforce: () => loadConfig().prodApprovalEnforce,
  }));
  registerHook(externalPolicyFilter);
  registerHook(makeHumanApprovalGate(pool));
  logger.info({ count: 7 }, 'Built-in tool hooks registered');
}
