import type { AccessPolicyComposite, AccessPolicyResponse } from './types';

type RemediationCatalog = Pick<AccessPolicyResponse, 'bundles' | 'composites' | 'tools'>;

export interface CompositeImpactPreview {
  composite: AccessPolicyComposite;
  scopedTools: string[];
  allowedTools: string[];
  removedTools: string[];
  deniedTools: string[];
  lockoutRisk: boolean;
  futureBundleExposure: boolean;
  unmatchedAllowPatterns: string[];
  unmatchedDenyPatterns: string[];
}

export interface ToolPatternSuggestion {
  pattern: string;
  kind: 'read' | 'write';
  matchCount: number;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function previewCompositeImpact(
  data: RemediationCatalog,
  composite: AccessPolicyComposite,
): CompositeImpactPreview {
  const scopedTools = composite.bundleMode === 'all'
    ? [...data.tools]
    : [...new Set(
      data.bundles
        .filter(bundle => composite.includedBundleIds.includes(bundle.id))
        .flatMap(bundle => bundle.toolNames),
    )];
  const allowMatched = composite.toolAllowPatterns.length === 0
    ? scopedTools
    : scopedTools.filter(tool => composite.toolAllowPatterns.some(pattern => globMatch(pattern, tool)));
  const deniedTools = allowMatched.filter(tool =>
    composite.toolDenyPatterns.some(pattern => globMatch(pattern, tool)),
  );
  const deniedSet = new Set(deniedTools);
  const allowedTools = allowMatched.filter(tool => !deniedSet.has(tool));
  const allowedSet = new Set(allowedTools);

  return {
    composite,
    scopedTools,
    allowedTools,
    removedTools: data.tools.filter(tool => !allowedSet.has(tool)),
    deniedTools,
    lockoutRisk: allowedTools.length === 0,
    futureBundleExposure: composite.bundleMode === 'all',
    unmatchedAllowPatterns: composite.toolAllowPatterns.filter(pattern =>
      !scopedTools.some(tool => globMatch(pattern, tool)),
    ),
    unmatchedDenyPatterns: composite.toolDenyPatterns.filter(pattern =>
      !scopedTools.some(tool => globMatch(pattern, tool)),
    ),
  };
}

export function buildRemediationCandidates(data: RemediationCatalog): CompositeImpactPreview[] {
  return data.composites
    .filter(composite => composite.enabled)
    .map(composite => previewCompositeImpact(data, composite))
    .sort((left, right) =>
      Number(left.lockoutRisk) - Number(right.lockoutRisk)
      || Number(left.futureBundleExposure) - Number(right.futureBundleExposure)
      || left.allowedTools.length - right.allowedTools.length
      || right.composite.toolDenyPatterns.length - left.composite.toolDenyPatterns.length
      || left.composite.name.localeCompare(right.composite.name),
    );
}

export function suggestToolPatterns(tools: string[]): ToolPatternSuggestion[] {
  const readVerbs = new Set(['get', 'list', 'search', 'read', 'view', 'describe', 'fetch', 'query']);
  const patterns = new Map<string, ToolPatternSuggestion>();
  for (const tool of tools) {
    const parts = tool.split('_').filter(Boolean);
    const pattern = parts.length >= 3 ? `${parts[0]}_${parts[1]}_*` : tool;
    const kind = readVerbs.has(parts[1]?.toLowerCase() ?? '') ? 'read' : 'write';
    const existing = patterns.get(pattern);
    if (existing) {
      existing.matchCount += 1;
    } else {
      patterns.set(pattern, { pattern, kind, matchCount: 1 });
    }
  }
  return [...patterns.values()].sort((left, right) =>
    Number(left.kind === 'write') - Number(right.kind === 'write')
    || right.matchCount - left.matchCount
    || left.pattern.localeCompare(right.pattern),
  );
}
