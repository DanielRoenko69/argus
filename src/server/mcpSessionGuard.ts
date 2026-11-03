/**
 * Binds MCP Streamable-HTTP sessions to the credential and policy that
 * created them.
 *
 * An MCP session bakes its Bundle/tool filter into the McpServer instance at
 * initialization. Every later POST/GET/DELETE on that session must therefore
 * prove (a) it comes from the same credential and (b) that credential's
 * current policy still equals the policy the session was built with. A
 * narrowed key or user scope invalidates the session instead of silently
 * keeping the old, broader filter. Missing identity fails closed.
 */

import { createHash } from 'node:crypto';
import type { SessionContext } from './mcpServer.js';

export type McpSessionDecision = 'ok' | 'unknown_session' | 'not_owner' | 'policy_changed';

/** Stable caller identity: API key prefix (incl. bound OAuth2 users), else SSO user id. */
export function mcpCallerId(req: unknown): string | undefined {
  const r = req as { apiKeyPrefix?: string; user?: { id?: number } };
  if (r.apiKeyPrefix) return `key:${r.apiKeyPrefix}`;
  if (r.user?.id != null) return `user:${r.user.id}`;
  return undefined;
}

function sortedOrNull<T>(values: readonly T[] | null | undefined): T[] | null {
  return values == null ? null : [...values].sort();
}

/** Hash of every request-derived field that shapes the MCP tool surface. */
export function mcpPolicyFingerprint(ctx: SessionContext, req: unknown): string {
  const keyScope = (req as { apiKeyScope?: unknown }).apiKeyScope ?? null;
  const userRole = (req as { user?: { role?: unknown } }).user?.role ?? null;
  const callingRole = (req as { callingUser?: { role?: unknown } }).callingUser?.role ?? null;
  const material = JSON.stringify({
    apiKeyPrefix: ctx.apiKeyPrefix ?? null,
    tenantKey: ctx.tenantKey ?? 'default',
    workspaceKey: ctx.workspaceKey ?? 'default',
    allowedBundles: sortedOrNull(ctx.allowedBundles),
    allowedTools: sortedOrNull(ctx.allowedTools),
    deniedTools: sortedOrNull(ctx.deniedTools),
    compositeId: ctx.compositeId ?? null,
    callingUser: ctx.callingUser
      ? { id: ctx.callingUser.id, groups: sortedOrNull(ctx.callingUser.entra_groups) }
      : null,
    keyScope,
    role: userRole ?? callingRole,
  });
  return createHash('sha256').update(material).digest('hex');
}

interface McpSessionBinding {
  owner: string;
  fingerprint: string;
}

export class McpSessionRegistry {
  private readonly bindings = new Map<string, McpSessionBinding>();

  /** Returns false when the request carries no identity to bind to. */
  bind(sessionId: string, req: unknown, ctx: SessionContext): boolean {
    const owner = mcpCallerId(req);
    if (!owner) return false;
    this.bindings.set(sessionId, { owner, fingerprint: mcpPolicyFingerprint(ctx, req) });
    return true;
  }

  check(sessionId: string, req: unknown, ctx: SessionContext): McpSessionDecision {
    const binding = this.bindings.get(sessionId);
    if (!binding) return 'unknown_session';
    const caller = mcpCallerId(req);
    if (!caller || caller !== binding.owner) return 'not_owner';
    if (mcpPolicyFingerprint(ctx, req) !== binding.fingerprint) return 'policy_changed';
    return 'ok';
  }

  delete(sessionId: string): void {
    this.bindings.delete(sessionId);
  }
}

/** HTTP mapping for a non-ok decision. */
export function mcpSessionDenial(decision: Exclude<McpSessionDecision, 'ok'>): { status: number; body: { error: string; code: string } } {
  switch (decision) {
    case 'not_owner':
      return { status: 403, body: { error: 'Session does not belong to this credential', code: 'mcp_session_not_owner' } };
    case 'policy_changed':
      return {
        status: 409,
        body: { error: 'Credential policy changed since this MCP session started; re-initialize the session', code: 'mcp_session_policy_changed' },
      };
    case 'unknown_session':
    default:
      return { status: 403, body: { error: 'MCP session has no verified owner', code: 'mcp_session_unbound' } };
  }
}
