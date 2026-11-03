/**
 * userPolicyResolver — pure function: given a user's effective policy data
 * (assembled by userPolicyStore), decide whether a tool call is permitted.
 *
 * Inputs use pattern arrays (matching Argus's existing composite schema:
 * mcp_composites.tool_allow_patterns / tool_deny_patterns).
 *
 * Semantics (designed 2026-05-22, schema-correct revision):
 *
 *   inPolicyMode = hasUserComposites
 *               || hasGroupComposites
 *               || userAllowRules.length + userDenyRules.length > 0
 *               || groupAllowRules.length + groupDenyRules.length > 0
 *
 *   Group/composite deny patterns are EVALUATED FIRST (deny wins).
 *   Then composite allow patterns are checked (wildcard if composite
 *   was assigned but allow-list empty — Argus convention).
 *   Then explicit user/group allow rules (glob).
 *   Then (if NOT inPolicyMode) legacy allowed_bundles fallback.
 *   Otherwise: default-deny (return 'no_rule').
 */

export interface PolicyRule {
  id: number;
  pattern: string;
  source: string;   // 'user' or 'group:<name>'
}

export interface PolicyInput {
  toolName: string;
  /** Whether user has at least one composite assigned (triggers policy-mode + wildcard semantics if patterns empty) */
  hasUserComposites: boolean;
  hasGroupComposites: boolean;
  /** Aggregated glob patterns from all user's composites. Empty + hasUserComposites=true => wildcard */
  userCompositeAllowPatterns: string[];
  userCompositeDenyPatterns: string[];
  groupCompositeAllowPatterns: string[];
  groupCompositeDenyPatterns: string[];
  userAllowRules: PolicyRule[];
  userDenyRules: PolicyRule[];
  groupAllowRules: PolicyRule[];
  groupDenyRules: PolicyRule[];
  /** Flat tool list from legacy mcp_users.allowed_bundles. Null when no legacy. */
  legacyAllowedBundleTools: string[] | null;
}

export type PolicyDecision = 'allow' | 'deny' | 'no_rule';

export interface PolicyResult {
  decision: PolicyDecision;
  reason: string;
  matchedRule?: PolicyRule;
}

export interface PolicyExplanationStep {
  key: string;
  label: string;
  outcome: 'matched' | 'passed';
  detail: string;
  evidence: string[];
}

export interface ExplainedPolicyResult {
  result: PolicyResult;
  policyMode: boolean;
  steps: PolicyExplanationStep[];
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

function globMatch(pattern: string, name: string): boolean {
  return globToRegex(pattern).test(name);
}

function anyMatch(patterns: string[], name: string): boolean {
  return patterns.some(p => globMatch(p, name));
}

function findMatchingRule(rules: PolicyRule[], name: string): PolicyRule | null {
  for (const r of rules) {
    if (globMatch(r.pattern, name)) return r;
  }
  return null;
}

function matchingPatterns(patterns: string[], name: string): string[] {
  return patterns.filter(pattern => globMatch(pattern, name));
}

/**
 * Resolve a user policy and retain the exact deny-first evaluation trail.
 * The runtime resolver below delegates to this function so the simulator
 * cannot drift from the enforcement decision.
 */
export function explainUserPolicy(input: PolicyInput): ExplainedPolicyResult {
  const { toolName } = input;
  const steps: PolicyExplanationStep[] = [];
  const inPolicyMode =
    input.hasUserComposites ||
    input.hasGroupComposites ||
    input.userAllowRules.length > 0 ||
    input.userDenyRules.length > 0 ||
    input.groupAllowRules.length > 0 ||
    input.groupDenyRules.length > 0;

  const finish = (result: PolicyResult): ExplainedPolicyResult => ({
    result,
    policyMode: inPolicyMode,
    steps,
  });

  // 1. Deny ALWAYS wins — check all four deny sources in order
  const groupCompositeDenies = matchingPatterns(input.groupCompositeDenyPatterns, toolName);
  steps.push({
    key: 'group-composite-deny',
    label: 'Group composite denies',
    outcome: groupCompositeDenies.length > 0 ? 'matched' : 'passed',
    detail: groupCompositeDenies.length > 0 ? 'A group composite blocks this tool.' : 'No group composite deny matched.',
    evidence: groupCompositeDenies,
  });
  if (groupCompositeDenies.length > 0) {
    return finish({ decision: 'deny', reason: 'composite-deny via group composite' });
  }

  const userCompositeDenies = matchingPatterns(input.userCompositeDenyPatterns, toolName);
  steps.push({
    key: 'user-composite-deny',
    label: 'Direct composite denies',
    outcome: userCompositeDenies.length > 0 ? 'matched' : 'passed',
    detail: userCompositeDenies.length > 0 ? 'A directly assigned composite blocks this tool.' : 'No direct composite deny matched.',
    evidence: userCompositeDenies,
  });
  if (userCompositeDenies.length > 0) {
    return finish({ decision: 'deny', reason: 'composite-deny via user composite' });
  }

  const groupDeny = findMatchingRule(input.groupDenyRules, toolName);
  steps.push({
    key: 'group-rule-deny',
    label: 'Group deny rules',
    outcome: groupDeny ? 'matched' : 'passed',
    detail: groupDeny ? `Rule ${groupDeny.id} from ${groupDeny.source} blocks this tool.` : 'No explicit group deny matched.',
    evidence: groupDeny ? [groupDeny.pattern] : [],
  });
  if (groupDeny) {
    return finish({ decision: 'deny', reason: `group-deny via rule ${groupDeny.id} (${groupDeny.source})`, matchedRule: groupDeny });
  }

  const userDeny = findMatchingRule(input.userDenyRules, toolName);
  steps.push({
    key: 'user-rule-deny',
    label: 'Direct deny rules',
    outcome: userDeny ? 'matched' : 'passed',
    detail: userDeny ? `Direct rule ${userDeny.id} blocks this tool.` : 'No explicit user deny matched.',
    evidence: userDeny ? [userDeny.pattern] : [],
  });
  if (userDeny) {
    return finish({ decision: 'deny', reason: `user-deny via rule ${userDeny.id}`, matchedRule: userDeny });
  }

  // 2. Composite allow-paths (with wildcard semantics: empty patterns + hasComposites = "all tools")
  const userCompositeAllows = matchingPatterns(input.userCompositeAllowPatterns, toolName);
  const userCompositeWildcard = input.hasUserComposites && input.userCompositeAllowPatterns.length === 0;
  const userCompositeAllowed = input.hasUserComposites && (userCompositeWildcard || userCompositeAllows.length > 0);
  steps.push({
    key: 'user-composite-allow',
    label: 'Direct composite allows',
    outcome: userCompositeAllowed ? 'matched' : 'passed',
    detail: userCompositeAllowed
      ? userCompositeWildcard ? 'An assigned composite has an open allow list.' : 'A directly assigned composite allows this tool.'
      : 'No direct composite allow matched.',
    evidence: userCompositeWildcard ? ['* (empty allow list)'] : userCompositeAllows,
  });
  if (userCompositeAllowed) {
    return finish({ decision: 'allow', reason: 'user-composite' });
  }

  const groupCompositeAllows = matchingPatterns(input.groupCompositeAllowPatterns, toolName);
  const groupCompositeWildcard = input.hasGroupComposites && input.groupCompositeAllowPatterns.length === 0;
  const groupCompositeAllowed = input.hasGroupComposites && (groupCompositeWildcard || groupCompositeAllows.length > 0);
  steps.push({
    key: 'group-composite-allow',
    label: 'Group composite allows',
    outcome: groupCompositeAllowed ? 'matched' : 'passed',
    detail: groupCompositeAllowed
      ? groupCompositeWildcard ? 'An inherited composite has an open allow list.' : 'An inherited composite allows this tool.'
      : 'No group composite allow matched.',
    evidence: groupCompositeWildcard ? ['* (empty allow list)'] : groupCompositeAllows,
  });
  if (groupCompositeAllowed) {
    return finish({ decision: 'allow', reason: 'group-composite' });
  }

  // 3. Explicit allow rules
  const userAllow = findMatchingRule(input.userAllowRules, toolName);
  steps.push({
    key: 'user-rule-allow',
    label: 'Direct allow rules',
    outcome: userAllow ? 'matched' : 'passed',
    detail: userAllow ? `Direct rule ${userAllow.id} allows this tool.` : 'No explicit user allow matched.',
    evidence: userAllow ? [userAllow.pattern] : [],
  });
  if (userAllow) {
    return finish({ decision: 'allow', reason: `user-rule ${userAllow.id}`, matchedRule: userAllow });
  }

  const groupAllow = findMatchingRule(input.groupAllowRules, toolName);
  steps.push({
    key: 'group-rule-allow',
    label: 'Group allow rules',
    outcome: groupAllow ? 'matched' : 'passed',
    detail: groupAllow ? `Rule ${groupAllow.id} from ${groupAllow.source} allows this tool.` : 'No explicit group allow matched.',
    evidence: groupAllow ? [groupAllow.pattern] : [],
  });
  if (groupAllow) {
    return finish({ decision: 'allow', reason: `group-rule ${groupAllow.id} (${groupAllow.source})`, matchedRule: groupAllow });
  }

  // 4. Legacy fallback — ONLY if user is NOT in policy-mode
  const legacyMatch = !inPolicyMode && input.legacyAllowedBundleTools?.includes(toolName) === true;
  steps.push({
    key: 'legacy-bundle-fallback',
    label: 'Legacy bundle fallback',
    outcome: legacyMatch ? 'matched' : 'passed',
    detail: inPolicyMode
      ? 'Skipped because at least one modern policy is active.'
      : legacyMatch ? 'The legacy bundle assignment contains this tool.' : 'The legacy bundle assignment does not contain this tool.',
    evidence: legacyMatch ? [toolName] : [],
  });
  if (legacyMatch) {
    return finish({ decision: 'allow', reason: 'legacy allowed_bundles fallback' });
  }

  steps.push({
    key: 'default-deny',
    label: 'Default deny',
    outcome: 'matched',
    detail: 'No evaluated policy path allowed this tool.',
    evidence: [],
  });
  return finish({ decision: 'no_rule', reason: 'default-deny: no matching allow rule' });
}

export function resolveUserPolicy(input: PolicyInput): PolicyResult {
  return explainUserPolicy(input).result;
}

// ── Agent-access resolver ─────────────────────────────────────────────────────

export interface AgentRuleSets {
  agentAllowIds: Set<number>;
  agentDenyIds: Set<number>;
}

/**
 * Pure function — filters `candidateAgentIds` through agent-access rules.
 *
 * Semantics (deny-first, allowlist-when-present, default unrestricted):
 *  1. Remove any candidate in `agentDenyIds` (deny always wins).
 *  2. If `agentAllowIds.size > 0` → keep ONLY candidates in `agentAllowIds` (minus denies).
 *  3. If `agentAllowIds.size === 0` → keep ALL remaining candidates (unrestricted default).
 *
 * Has no side-effects and makes no DB calls.
 */
export function resolveAgentAccess(
  rules: AgentRuleSets,
  candidateAgentIds: number[],
): number[] {
  // Step 1: remove denied candidates
  const afterDeny = candidateAgentIds.filter(id => !rules.agentDenyIds.has(id));

  // Step 2: if an allow-set is present, restrict to it; otherwise unrestricted
  if (rules.agentAllowIds.size > 0) {
    return afterDeny.filter(id => rules.agentAllowIds.has(id));
  }

  // Step 3: no allow rules → default unrestricted (return all post-deny)
  return afterDeny;
}
