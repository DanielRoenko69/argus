import type pg from 'pg';
import { writeImmutableAudit } from '../../audit/immutableAudit.js';
import type { HookContext, HookDecision } from './types.js';

/**
 * Persist a hook decision to the immutable audit log. Fire-and-forget —
 * never await this. The downstream writer uses setImmediate so this returns
 * synchronously.
 *
 * Hook audit uses event_type='tool_hook_decision' (added in migration 077).
 * We overload existing ImmutableAuditEntry fields:
 *   - apiKeyPrefix: synthetic "agent__<id>" so each agent shows up
 *   - model: tool name (no real model involved per tool call)
 *   - errorType: "<hookName>:<decision>:<reason-truncated>" — grep-friendly
 *   - riskLevel: 'high' for blocks, 'low' for allow/modify
 */
export function logHookDecision(
  pool: pg.Pool,
  ctx: HookContext,
  decision: HookDecision,
): void {
  writeImmutableAudit(pool, {
    eventType: 'tool_hook_decision',
    apiKeyPrefix: ctx.apiKeyPrefix || `agent__${ctx.agentId}`,
    sessionId: ctx.sessionId,
    model: ctx.toolName,
    isError: decision.decision === 'block',
    errorType:
      `${decision.hookName}:${decision.decision}` +
      (decision.reason ? `:${decision.reason.slice(0, 80)}` : ''),
    riskLevel: decision.decision === 'block' ? 'high' : 'low',
  });
}
