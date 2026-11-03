export function bundleResolutionCandidates(bundleIds: number[], legacyBundleId: number): number[] {
  const selected = bundleIds.length > 0 ? bundleIds : [legacyBundleId];
  return [...new Set(selected.filter(bundleId => Number.isSafeInteger(bundleId) && bundleId > 0))];
}
