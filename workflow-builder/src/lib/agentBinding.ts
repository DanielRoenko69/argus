import type { PaletteAgent } from '@/api/palette';

export interface AgentBindingData {
  agent_id?: number | null;
  agent_role?: string | null;
}

export type AgentBindingMode = 'role' | 'agent';

export function normalizedAgentRole(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const role = value.trim().toLowerCase();
  return role || null;
}

export function agentBindingMode(data: AgentBindingData): AgentBindingMode {
  return normalizedAgentRole(data.agent_role) ? 'role' : data.agent_id != null ? 'agent' : 'role';
}

export function resolvePaletteAgentForRole(
  agents: PaletteAgent[],
  value: unknown,
): PaletteAgent | undefined {
  const role = normalizedAgentRole(value);
  if (!role) return undefined;
  return agents.find((agent) => agent.name.toLowerCase() === role)
    ?? agents.find((agent) => normalizedAgentRole(agent.agent_role) === role);
}

export function resolvePaletteAgent(
  agents: PaletteAgent[],
  data: AgentBindingData,
): PaletteAgent | undefined {
  const role = normalizedAgentRole(data.agent_role);
  if (role) return resolvePaletteAgentForRole(agents, role);
  return agents.find((agent) => agent.id === data.agent_id);
}

export function availableAgentRoles(agents: PaletteAgent[]): string[] {
  return [...new Set(agents.flatMap((agent) => {
    const role = normalizedAgentRole(agent.agent_role);
    return role ? [role, agent.name.toLowerCase()] : [agent.name.toLowerCase()];
  }))].sort((left, right) => left.localeCompare(right));
}

export function effectiveAgentModel(agent: PaletteAgent): string {
  return agent.runtime_model?.trim() || agent.model;
}

export function formatAgentTarget(agent: PaletteAgent | undefined, data: AgentBindingData): string {
  const role = normalizedAgentRole(data.agent_role);
  if (role) return `Role: ${role}`;
  return agent?.label ?? '(no agent)';
}
