export type PolicyPostureSeverity = 'critical' | 'high' | 'medium' | 'low';
export type PolicyPostureCategory = 'exposure' | 'coverage' | 'hygiene';

export interface PolicyPostureTarget {
  tab: 'composites' | 'groups' | 'users' | 'technical';
  id: string;
}

export interface PolicyPostureFinding {
  id: string;
  severity: PolicyPostureSeverity;
  category: PolicyPostureCategory;
  title: string;
  description: string;
  recommendation: string;
  entityLabel: string;
  target: PolicyPostureTarget | null;
}

export interface PolicyPostureResult {
  score: number;
  status: 'strong' | 'watch' | 'at_risk' | 'critical';
  coveragePercent: number;
  coveredPrincipals: number;
  totalPrincipals: number;
  unrestrictedPrincipals: number;
  summary: Record<PolicyPostureSeverity, number> & { total: number };
  findings: PolicyPostureFinding[];
}

export interface PolicyPostureInput {
  bundles: Array<{ id: number }>;
  composites: Array<{
    id: number;
    name: string;
    bundleMode: 'all' | 'selected';
    includedBundleIds: number[];
    toolAllowPatterns: string[];
    toolDenyPatterns: string[];
    enabled: boolean;
    userCount: number;
    groupCount: number;
    agentCount: number;
    apiKeyCount: number;
  }>;
  groups: Array<{
    name: string;
    memberCount: number;
    compositeIds: number[];
    agentIds: number[];
    rules: Array<{ toolPattern: string; effect: 'allow' | 'deny' }>;
  }>;
  users: Array<{
    id: number;
    label: string;
    role: string;
    enabled: boolean;
    allowedBundleIds: number[] | null;
    entraGroups: string[];
    compositeIds: number[];
    rules: Array<{ expiresAt: string | null }>;
  }>;
  technicalIdentities: Array<{
    id: number;
    kind: 'agent' | 'api_key';
    label: string;
    enabled: boolean;
    compositeId: number | null;
    allowedBundleIds: number[] | null;
    allowedTools: string[] | null;
  }>;
}

const severityRank: Record<PolicyPostureSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function assignmentCount(composite: PolicyPostureInput['composites'][number]): number {
  return composite.userCount + composite.groupCount + composite.agentCount + composite.apiKeyCount;
}

export function buildPolicyPosture(
  input: PolicyPostureInput,
  now: Date = new Date(),
): PolicyPostureResult {
  const findings: PolicyPostureFinding[] = [];
  const bundleIds = new Set(input.bundles.map(bundle => bundle.id));
  const composites = new Map(input.composites.map(composite => [composite.id, composite]));
  const enabledCompositeIds = new Set(input.composites.filter(composite => composite.enabled).map(composite => composite.id));
  const groups = new Map(input.groups.map(group => [group.name, group]));
  let unrestrictedPrincipals = 0;

  const add = (finding: PolicyPostureFinding) => findings.push(finding);

  for (const composite of input.composites) {
    const assignments = assignmentCount(composite);
    const target = { tab: 'composites' as const, id: String(composite.id) };

    if (!composite.enabled && assignments > 0) {
      add({
        id: `disabled-composite:${composite.id}`,
        severity: 'high',
        category: 'coverage',
        title: 'Assigned composite is disabled',
        description: `${composite.name} still has ${assignments} assignment${assignments === 1 ? '' : 's'}, but no longer provides an active policy boundary.`,
        recommendation: 'Enable the composite or move every assignment to an active replacement.',
        entityLabel: composite.name,
        target,
      });
    }

    if (composite.enabled && composite.bundleMode === 'all' && composite.toolAllowPatterns.length === 0) {
      add({
        id: `unrestricted-composite:${composite.id}`,
        severity: 'critical',
        category: 'exposure',
        title: 'Composite allows the full tool catalog',
        description: `${composite.name} includes every current and future bundle and has no tool allowlist.`,
        recommendation: 'Select explicit bundles and add a narrow tool allowlist.',
        entityLabel: composite.name,
        target,
      });
    } else if (composite.enabled && composite.bundleMode === 'all') {
      add({
        id: `future-bundles:${composite.id}`,
        severity: 'medium',
        category: 'exposure',
        title: 'Future bundles are included automatically',
        description: `${composite.name} uses all-bundles mode, so newly connected capabilities enter its scope automatically.`,
        recommendation: 'Use selected-bundles mode unless automatic inheritance is intentional.',
        entityLabel: composite.name,
        target,
      });
    } else if (composite.enabled && composite.toolAllowPatterns.length === 0) {
      add({
        id: `open-tool-scope:${composite.id}`,
        severity: 'high',
        category: 'exposure',
        title: 'Bundle scope has no tool allowlist',
        description: `${composite.name} permits every tool exposed by its selected bundles.`,
        recommendation: 'Define explicit allow patterns for the capabilities this policy actually needs.',
        entityLabel: composite.name,
        target,
      });
    }

    if (composite.enabled && composite.toolDenyPatterns.length === 0) {
      add({
        id: `no-deny-guardrail:${composite.id}`,
        severity: 'low',
        category: 'hygiene',
        title: 'No explicit deny guardrail',
        description: `${composite.name} has no final deny pattern for destructive or administrative tools.`,
        recommendation: 'Add deny patterns for destructive operations that should never be inherited.',
        entityLabel: composite.name,
        target,
      });
    }

    const missingBundleIds = composite.includedBundleIds.filter(bundleId => !bundleIds.has(bundleId));
    if (missingBundleIds.length > 0) {
      add({
        id: `missing-bundles:${composite.id}`,
        severity: 'high',
        category: 'hygiene',
        title: 'Composite references unavailable bundles',
        description: `${composite.name} contains ${missingBundleIds.length} bundle reference${missingBundleIds.length === 1 ? '' : 's'} that no longer resolve.`,
        recommendation: 'Remove stale references and select an available replacement bundle.',
        entityLabel: composite.name,
        target,
      });
    }

    if (assignments === 0) {
      add({
        id: `unused-composite:${composite.id}`,
        severity: 'low',
        category: 'hygiene',
        title: 'Composite has no assignments',
        description: `${composite.name} is not bound to a user, group, Agent or API key.`,
        recommendation: 'Assign the policy or remove it if it is no longer part of the access model.',
        entityLabel: composite.name,
        target,
      });
    }
  }

  for (const group of input.groups) {
    const target = { tab: 'groups' as const, id: group.name };
    const activeCompositeCount = group.compositeIds.filter(id => enabledCompositeIds.has(id)).length;
    const configured = group.compositeIds.length > 0 || group.rules.length > 0 || group.agentIds.length > 0;

    if (group.memberCount > 0 && activeCompositeCount === 0 && group.rules.length === 0) {
      add({
        id: `group-without-boundary:${group.name}`,
        severity: 'high',
        category: 'coverage',
        title: 'Identity group has no active policy boundary',
        description: `${group.name} has ${group.memberCount} known member${group.memberCount === 1 ? '' : 's'} but no enabled composite or explicit tool rule.`,
        recommendation: 'Bind an enabled composite before relying on this group for access control.',
        entityLabel: group.name,
        target,
      });
    }

    if (group.memberCount > 0 && group.agentIds.length === 0) {
      add({
        id: `group-all-agents:${group.name}`,
        severity: 'medium',
        category: 'exposure',
        title: 'Group can discover every Agent',
        description: `${group.name} has no Agent allowlist, so all current and future internal Agents remain visible to its members.`,
        recommendation: 'Select only the Agents required by this group.',
        entityLabel: group.name,
        target,
      });
    }

    if (group.rules.some(rule => rule.effect === 'allow' && (rule.toolPattern === '*' || rule.toolPattern === '**'))) {
      add({
        id: `group-wildcard-rule:${group.name}`,
        severity: 'high',
        category: 'exposure',
        title: 'Group contains a global allow override',
        description: `${group.name} has an explicit wildcard allow rule that can broaden inherited access.`,
        recommendation: 'Replace the wildcard with the smallest required tool prefix.',
        entityLabel: group.name,
        target,
      });
    }

    if (group.memberCount === 0 && configured) {
      add({
        id: `stale-group:${group.name}`,
        severity: 'low',
        category: 'hygiene',
        title: 'Configured group has no known members',
        description: `${group.name} has stored policy bindings but is not present on any current user.`,
        recommendation: 'Confirm the identity-provider identifier or remove the stale binding.',
        entityLabel: group.name,
        target,
      });
    }
  }

  let coveredPrincipals = 0;
  let totalPrincipals = 0;

  for (const user of input.users) {
    if (!user.enabled) continue;
    totalPrincipals += 1;
    const directCoverage = user.compositeIds.some(id => enabledCompositeIds.has(id));
    const groupCoverage = user.entraGroups.some(name =>
      groups.get(name)?.compositeIds.some(id => enabledCompositeIds.has(id)),
    );
    if (directCoverage || groupCoverage) {
      coveredPrincipals += 1;
    } else if (user.allowedBundleIds === null) {
      unrestrictedPrincipals += 1;
      add({
        id: `unrestricted-user:${user.id}`,
        severity: 'critical',
        category: 'coverage',
        title: 'User falls back to unrestricted legacy access',
        description: `${user.label} has no active composite boundary and no legacy bundle restriction.`,
        recommendation: 'Assign a composite directly or through an identity group.',
        entityLabel: user.label,
        target: { tab: 'users', id: String(user.id) },
      });
    } else {
      add({
        id: `legacy-user:${user.id}`,
        severity: 'medium',
        category: 'coverage',
        title: 'User still relies on legacy bundle access',
        description: `${user.label} has no active composite and is governed only by the legacy bundle list.`,
        recommendation: 'Migrate the user to a direct or group composite policy.',
        entityLabel: user.label,
        target: { tab: 'users', id: String(user.id) },
      });
    }

    const expiredRules = user.rules.filter(rule =>
      rule.expiresAt != null && Date.parse(rule.expiresAt) <= now.getTime(),
    ).length;
    if (expiredRules > 0) {
      add({
        id: `expired-user-rules:${user.id}`,
        severity: 'low',
        category: 'hygiene',
        title: 'Expired user overrides remain stored',
        description: `${user.label} has ${expiredRules} expired tool override${expiredRules === 1 ? '' : 's'}.`,
        recommendation: 'Remove expired exceptions to keep the effective policy easy to audit.',
        entityLabel: user.label,
        target: { tab: 'users', id: String(user.id) },
      });
    }
  }

  for (const identity of input.technicalIdentities) {
    if (!identity.enabled) continue;
    totalPrincipals += 1;
    const composite = identity.compositeId == null ? null : composites.get(identity.compositeId);
    if (composite?.enabled) {
      coveredPrincipals += 1;
      continue;
    }

    const target = { tab: 'technical' as const, id: `${identity.kind}:${identity.id}` };
    if (identity.compositeId != null) {
      add({
        id: `inactive-technical-composite:${identity.kind}:${identity.id}`,
        severity: 'high',
        category: 'coverage',
        title: 'Technical identity references an inactive composite',
        description: `${identity.label} points to a composite that is missing or disabled.`,
        recommendation: 'Assign an enabled composite before the identity is used again.',
        entityLabel: identity.label,
        target,
      });
    } else if (
      identity.kind === 'api_key'
      && identity.allowedBundleIds === null
      && identity.allowedTools === null
    ) {
      unrestrictedPrincipals += 1;
      add({
        id: `unrestricted-api-key:${identity.id}`,
        severity: 'critical',
        category: 'exposure',
        title: 'API key has no explicit capability boundary',
        description: `${identity.label} has no composite, bundle allowlist or tool allowlist.`,
        recommendation: 'Assign a composite and rotate the key if it has already been distributed.',
        entityLabel: identity.label,
        target,
      });
    } else if (identity.kind === 'agent') {
      unrestrictedPrincipals += 1;
      add({
        id: `unrestricted-agent:${identity.id}`,
        severity: 'high',
        category: 'exposure',
        title: 'Agent receives the unrestricted tool catalog',
        description: `${identity.label} has no composite boundary and can inherit every available tool.`,
        recommendation: 'Assign a least-privilege composite to the Agent.',
        entityLabel: identity.label,
        target,
      });
    } else {
      add({
        id: `legacy-api-key:${identity.id}`,
        severity: 'high',
        category: 'coverage',
        title: 'API key relies on legacy filters',
        description: `${identity.label} has no composite and is governed by separate bundle or tool lists.`,
        recommendation: 'Move the key to a composite so human and machine access use one policy model.',
        entityLabel: identity.label,
        target,
      });
    }
  }

  findings.sort((left, right) =>
    severityRank[left.severity] - severityRank[right.severity]
    || left.entityLabel.localeCompare(right.entityLabel)
    || left.title.localeCompare(right.title),
  );

  const summary = findings.reduce<Record<PolicyPostureSeverity, number> & { total: number }>(
    (counts, finding) => {
      counts[finding.severity] += 1;
      counts.total += 1;
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0, total: 0 },
  );
  const score = Math.max(
    0,
    100 - Math.min(100, summary.critical * 25 + summary.high * 12 + summary.medium * 5 + summary.low * 2),
  );
  const status: PolicyPostureResult['status'] = summary.critical > 0
    ? 'critical'
    : score >= 90
      ? 'strong'
      : score >= 70
        ? 'watch'
        : 'at_risk';

  return {
    score,
    status,
    coveragePercent: totalPrincipals === 0 ? 100 : Math.round((coveredPrincipals / totalPrincipals) * 100),
    coveredPrincipals,
    totalPrincipals,
    unrestrictedPrincipals,
    summary,
    findings,
  };
}
