/** An impossible bundle id used to keep an empty scope fail-closed. */
export const NO_BUNDLE_ACCESS_SENTINEL = -1;

/**
 * Agents without an explicit bundle list are still usable by scoped users;
 * their runtime scope is reduced to the user's bundles before tools are built.
 * Explicit bundle assignments require at least one shared bundle.
 */
export function agentVisibleToBundleScope(
  agentBundleIds: number[] | null | undefined,
  userBundleIds: number[] | null | undefined,
): boolean {
  if (userBundleIds == null || !agentBundleIds?.length) return true;
  const allowed = new Set(userBundleIds);
  return agentBundleIds.some(id => allowed.has(id));
}

/**
 * Intersect an Agent's persistent bundle assignment with the authenticated
 * user's scope. `null` means unrestricted, while an empty user scope is
 * represented by the fail-closed sentinel because legacy empty arrays mean
 * "unrestricted" in the Agent tool builder.
 */
export function intersectAgentBundleScope(
  agentBundleIds: number[] | null | undefined,
  userBundleIds: number[] | null | undefined,
): number[] | null | undefined {
  if (userBundleIds == null) return agentBundleIds;
  if (userBundleIds.length === 0) return [NO_BUNDLE_ACCESS_SENTINEL];
  if (!agentBundleIds?.length) return [...userBundleIds];
  const allowed = new Set(userBundleIds);
  const intersection = agentBundleIds.filter(id => allowed.has(id));
  return intersection.length > 0 ? intersection : [NO_BUNDLE_ACCESS_SENTINEL];
}

