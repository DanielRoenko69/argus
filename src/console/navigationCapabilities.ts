import type { SessionUser } from '../auth/userAuth.js';
import { effectivePermissions, evaluatePermission, type EffectiveAccessInput } from '../auth/effectiveAccess.js';
import type { ArgusPermission, PermissionAssignment } from '../auth/permissions.js';

export const CONSOLE_MODULE_IDS = [
  'argus.core',
  'argus.dev',
  'argus.aiops',
  'argus.hermes',
  'public-channels',
  'compliance',
] as const;

export type ConsoleModuleId = typeof CONSOLE_MODULE_IDS[number];

export interface ConsoleModuleCapability {
  id: ConsoleModuleId;
  installed: boolean;
  entitled: boolean;
  available: boolean;
  reason: 'available' | 'not_installed' | 'not_entitled';
}

export interface ConsoleNavigationCapabilities {
  canUseArgusDev: boolean;
  canBuildWorkflows: boolean;
  canManageAgents: boolean;
  canManageIntegrations: boolean;
  canManageKnowledge: boolean;
  canRunEvaluations: boolean;
  canReviewApprovals: boolean;
  canObservePlatform: boolean;
  canReadAuditEvidence: boolean;
  canManageRuntimePolicy: boolean;
  canUseCompliance: boolean;
  canManagePublicChannels: boolean;
  canSearchWorkspaceResources: boolean;
  canAdminPlatform: boolean;
}

export interface NavigationCapabilityResponse {
  schemaVersion: 1;
  generatedAt: string;
  actor: { id: number; role: string };
  permissions: ArgusPermission[];
  modules: ConsoleModuleCapability[];
  navigation: ConsoleNavigationCapabilities;
}

export interface NavigationCapabilityOptions {
  installedModules?: readonly ConsoleModuleId[];
  entitledModules?: readonly ConsoleModuleId[];
  assignments?: readonly PermissionAssignment[];
  now?: () => Date;
}

function moduleCapabilities(options: NavigationCapabilityOptions): ConsoleModuleCapability[] {
  const installed = new Set(options.installedModules ?? ['argus.core']);
  const entitled = new Set(options.entitledModules ?? CONSOLE_MODULE_IDS);
  return CONSOLE_MODULE_IDS.map(id => {
    const isInstalled = installed.has(id);
    const isEntitled = entitled.has(id);
    return {
      id,
      installed: isInstalled,
      entitled: isEntitled,
      available: isInstalled && isEntitled,
      reason: !isInstalled ? 'not_installed' : !isEntitled ? 'not_entitled' : 'available',
    };
  });
}

export function buildConsoleNavigationCapabilities(
  user: SessionUser,
  options: NavigationCapabilityOptions = {},
): NavigationCapabilityResponse {
  const access: EffectiveAccessInput = { role: user.role, assignments: options.assignments };
  const modules = moduleCapabilities(options);
  const moduleAvailable = (id: ConsoleModuleId) => modules.some(module => module.id === id && module.available);
  const allowed = (permission: ArgusPermission) => evaluatePermission(access, permission).allowed;

  return {
    schemaVersion: 1,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    actor: { id: user.id, role: user.role },
    permissions: effectivePermissions(access),
    modules,
    navigation: {
      canUseArgusDev: moduleAvailable('argus.dev') && allowed('agents.run'),
      canBuildWorkflows: allowed('workflows.manage'),
      canManageAgents: allowed('agents.manage'),
      canManageIntegrations: allowed('integrations.manage'),
      canManageKnowledge: allowed('knowledge.manage'),
      canRunEvaluations: allowed('evaluations.run'),
      canReviewApprovals: allowed('approvals.review'),
      canObservePlatform: allowed('observability.read'),
      canReadAuditEvidence: allowed('audit.read'),
      canManageRuntimePolicy: allowed('runtime_policy.manage'),
      canUseCompliance: moduleAvailable('compliance') && allowed('compliance.read'),
      canManagePublicChannels: moduleAvailable('public-channels') && allowed('public_channels.manage'),
      canSearchWorkspaceResources: allowed('workspace.search'),
      canAdminPlatform: allowed('platform.admin'),
    },
  };
}
