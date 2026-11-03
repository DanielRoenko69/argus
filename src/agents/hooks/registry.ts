import type pg from 'pg';
import { logger } from '../../lib/logger.js';
import type { HookContext, ToolHook, HookDecision, HookResult } from './types.js';
import { logHookDecision } from './audit.js';

const HOOKS: ToolHook[] = [];

export function registerHook(h: ToolHook): void {
  HOOKS.push(h);
  HOOKS.sort((a, b) => a.priority - b.priority);
}

/** Exported for tests only — resets the registry between test cases. */
export function clearHooks(): void {
  HOOKS.length = 0;
}

export function listHooks(): ReadonlyArray<Pick<ToolHook, 'name' | 'priority' | 'description'>> {
  return HOOKS.map((h) => ({ name: h.name, priority: h.priority, description: h.description }));
}

export interface PreHookOutcome {
  decision: 'allow' | 'block' | 'modify';
  hookName?: string;
  reason?: string;
  modifiedArgs?: Record<string, unknown>;
  metadata?: HookResult['metadata'];
}

/**
 * Run all preToolUse hooks in priority order. First block short-circuits.
 * Modifications are applied in order — later hooks see already-modified args.
 */
export async function runPreToolHooks(pool: pg.Pool, ctx: HookContext): Promise<PreHookOutcome> {
  let workingArgs = ctx.toolArgs;
  let anyModified = false;
  let modifyHookName: string | undefined;

  for (const h of HOOKS) {
    if (!h.preToolUse) continue;
    try {
      const r = await h.preToolUse({ ...ctx, toolArgs: workingArgs });
      if (!r) continue;
      // `block: 'no'` is the explicit "not blocked" sentinel from user-policy-gate.
      // `block: 'yes'` is the explicit "blocked" sentinel; the human-readable
      // reason is in `r.reason`. Any other truthy string is used directly as reason.
      if (r.block && r.block !== 'no') {
        const blockReason = r.block === 'yes' ? (r.reason ?? 'blocked by policy') : r.block;
        const decision: HookDecision = {
          hookName: h.name, toolName: ctx.toolName, decision: 'block', reason: blockReason,
        };
        logHookDecision(pool, ctx, decision);
        return { decision: 'block', hookName: h.name, reason: blockReason, metadata: r.metadata };
      }
      if (r.modify) {
        workingArgs = { ...workingArgs, ...r.modify };
        anyModified = true;
        modifyHookName = h.name;
        logHookDecision(pool, ctx, {
          hookName: h.name, toolName: ctx.toolName, decision: 'modify',
          reason: `args modified: keys=${Object.keys(r.modify).join(',')}`,
        });
      }
    } catch (err) {
      // A throwing hook must NOT block agent progress — it fails open with a
      // warning. Compliance-critical hooks should not throw.
      logger.warn({ err, hook: h.name, tool: ctx.toolName }, 'preToolUse hook threw — failing open');
    }
  }

  if (anyModified) {
    return { decision: 'modify', hookName: modifyHookName, modifiedArgs: workingArgs };
  }
  return { decision: 'allow' };
}

/**
 * Run all postToolUse hooks. Order = priority ascending. Errors logged, never
 * thrown — post-hooks are observability-only.
 */
export async function runPostToolHooks(pool: pg.Pool, ctx: HookContext): Promise<void> {
  for (const h of HOOKS) {
    if (!h.postToolUse) continue;
    try {
      await h.postToolUse(ctx);
      logHookDecision(pool, ctx, {
        hookName: h.name, toolName: ctx.toolName, decision: 'allow', postOnly: true,
      });
    } catch (err) {
      logger.warn({ err, hook: h.name, tool: ctx.toolName }, 'postToolUse hook threw');
    }
  }
}
