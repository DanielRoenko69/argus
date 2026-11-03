/**
 * Tool-Level Hooks — central enforcement point for every tool call an agent
 * makes. Runs INSIDE the agent loop (after the LLM has decided to call a tool,
 * before the tool executes, and after the tool returns).
 *
 * Compare to gateway/guardrails/* which operate on the LLM input/output level
 * — these hooks operate at one layer below, per tool invocation.
 */

export interface HookContext {
  /** Agent that initiated the tool call (mcp_agents.id) */
  agentId: number;
  /** Agent name for human-readable logs (e.g. 'coder') */
  agentName: string;
  /** Session for context isolation (mcp_agent_sessions.id) */
  sessionId: string;
  /** Tool being called */
  toolName: string;
  /** Tool arguments — may be mutated by hooks via HookResult.modify */
  toolArgs: Record<string, unknown>;
  /** Set on postToolUse — undefined on preToolUse */
  toolResult?: string;
  /** True if the tool execution threw — set on postToolUse only */
  toolIsError?: boolean;
  /** Iteration index in the agent loop, starts at 1 */
  iteration: number;
  /** Sub-agent depth — 0 for top-level, 1+ for nested */
  agentDepth: number;
  /** Argus user ID (set when SSO-authenticated; undefined for API-key callers) */
  userId?: number;
  /** API-key prefix for external policy context; never contains the full secret. */
  apiKeyPrefix?: string | null;
  /** Entra group ObjectIDs from last SSO login (empty when no SSO context) */
  userGroups?: string[];
  /**
   * Workflow whose step issued this tool call (mcp_workflows.id). Set on the
   * workflow/trigger/builder/admin-run paths via the hooked tool runner so the
   * human-approval-gate can enforce WORKFLOW-level oversight even though those
   * paths have no agent (agentId = 0). Undefined for agent + raw MCP calls.
   */
  workflowId?: number;
  /** Persisted workflow execution that owns this tool call, when applicable. */
  workflowExecutionId?: number;
  /** Workflow step currently invoking the tool. */
  workflowStepId?: string;
}

export interface HookResult {
  /**
   * If set, the tool call is BLOCKED. The block reason is returned as the
   * tool result to the LLM, which can then re-strategize.
   * `null`/`undefined` = allow.
   * The sentinel value `'no'` is treated as "not blocked" by the registry
   * (used by user-policy-gate to signal an explicit allow decision).
   */
  block?: string;
  /**
   * Human-readable explanation of the block decision. Used by hooks that
   * return `block: 'yes'` (user-policy-gate) to carry the policy reason
   * alongside the block sentinel. Forwarded to the LLM as context.
   */
  reason?: string;
  /**
   * If set, the tool args are REPLACED with these before execution.
   * Use for transformations (e.g. PII masking in content). The LLM is NOT
   * told the args were modified — this is silent.
   */
  modify?: Record<string, unknown>;
  /** Structured governance data for the caller (never used as an enforcement decision). */
  metadata?: {
    approval?: {
      approvalId: number;
      toolName: string;
      parameters: Record<string, unknown>;
      riskLevel: 'low' | 'medium' | 'high' | 'critical';
      riskScore: number;
      riskFactors: Array<{ id: string; label: string; category: string; weight: number; evidence: string }>;
      reason: string;
      sessionId: string;
    };
  };
}

export interface ToolHook {
  /** Stable identifier for audit logs (e.g. 'destructive-cmd-guard') */
  name: string;
  /** Lower runs first. Use 100 = security checks, 500 = transformations, 900 = approvals */
  priority: number;
  /** One-liner shown in admin UI */
  description: string;
  /**
   * Called BEFORE the tool executes. Return `{block}` to deny, `{modify}` to
   * transform args, or empty object/undefined to allow as-is.
   * `null` return means "this hook doesn't apply, skip me" — same as `{}`.
   */
  preToolUse?: (ctx: HookContext) => Promise<HookResult | null | void>;
  /**
   * Called AFTER the tool executes. Used for side effects only — cannot block
   * (the tool already ran). Side-effects: audit, metric, alert.
   */
  postToolUse?: (ctx: HookContext) => Promise<void>;
}

/** What gets written to the audit log when a hook fires. */
export interface HookDecision {
  hookName: string;
  toolName: string;
  decision: 'allow' | 'block' | 'modify';
  reason?: string;
  /** True if this was a postToolUse fire (no block possible) */
  postOnly?: boolean;
}
