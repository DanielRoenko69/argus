/**
 * Blueprint resolver — picks the right Identity Blueprint for an agent.
 *
 * The mapping is configured via the ENTRA_BLUEPRINTS_JSON env var (parsed
 * by env.ts into entraBlueprintMap). A special key "default" provides the
 * fallback for agents whose agent_role is unmapped or null.
 *
 * Returning null means "do not provision a SP for this agent" — the
 * lifecycle hook will skip the Entra call.
 */

export function resolveBlueprintId(
  agent: { agent_role: string | null },
  blueprintMap: Record<string, string>,
): string | null {
  if (agent.agent_role && blueprintMap[agent.agent_role]) {
    return blueprintMap[agent.agent_role]!;
  }
  if (blueprintMap['default']) return blueprintMap['default']!;
  return null;
}
