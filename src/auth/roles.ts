/**
 * Argus RBAC — 6-Rollen-Modell mit Vererbungshierarchie.
 *
 * platform_admin ⊇ operations_admin ⊇ developer ⊇ agent_operator ⊇ viewer ⊇ chat_user
 *
 * Jede Rolle enthält alle Rechte der darunter liegenden Rollen.
 */

export type ArgusRole =
  | 'platform_admin'   // IT Ops Team — Vollzugriff
  | 'operations_admin' // Team-Leads — Agents, MCP Fabric und Keys verwalten
  | 'developer'        // Entwickler — Playground + Coding + eigene Keys
  | 'agent_operator'   // NOC / Ops — Agents ausführen + approven
  | 'viewer'           // Management — nur Dashboards
  | 'chat_user';       // external/staff — chat only, lowest privilege

export const ARGUS_ROLES: readonly ArgusRole[] = [
  'platform_admin',
  'operations_admin',
  'developer',
  'agent_operator',
  'viewer',
  'chat_user',
];

// Legacy aliases — accepted in checks for backwards-compat until migration runs
const LEGACY_ALIASES: Record<string, ArgusRole> = {
  admin:  'platform_admin',
  editor: 'developer',
};

/** Numeric weight per role — höher = mehr Rechte */
export const ROLE_WEIGHTS: Record<ArgusRole, number> = {
  platform_admin: 50,
  operations_admin: 40,
  developer:      30,
  agent_operator: 20,
  viewer:         10,
  chat_user:       5,
};

/** Normalize a raw role string (handles legacy aliases). */
export function normalizeRole(raw: string): ArgusRole {
  if (raw in LEGACY_ALIASES) return LEGACY_ALIASES[raw];
  if (raw in ROLE_WEIGHTS)   return raw as ArgusRole;
  return 'viewer';
}

/** Parse roles received at an administration boundary without silently widening or changing intent. */
export function parseArgusRole(raw: unknown): ArgusRole | null {
  if (typeof raw !== 'string') return null;
  if (raw in LEGACY_ALIASES) return LEGACY_ALIASES[raw];
  return ARGUS_ROLES.includes(raw as ArgusRole) ? raw as ArgusRole : null;
}

/**
 * Returns true when userRole has at least the rights of requiredRole.
 * Handles legacy role strings transparently.
 */
export function hasRole(userRole: string | undefined | null, requiredRole: ArgusRole): boolean {
  const normalized = normalizeRole(userRole ?? 'viewer');
  return ROLE_WEIGHTS[normalized] >= ROLE_WEIGHTS[requiredRole];
}

/** Badge color for UI display. */
export const ROLE_COLORS: Record<ArgusRole, string> = {
  platform_admin: '#7c3aed',   // purple
  operations_admin: '#2563eb', // blue
  developer:      '#16a34a',   // green
  agent_operator: '#d97706',   // amber
  viewer:         '#6b7280',   // gray
  chat_user:      '#7c3aed',   // violet
};
