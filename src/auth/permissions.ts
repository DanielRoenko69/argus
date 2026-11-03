export const ARGUS_PERMISSIONS = [
  'agents.chat',
  'agents.read',
  'agents.run',
  'agents.manage',
  'workflows.read',
  'workflows.run',
  'workflows.manage',
  'integrations.read',
  'integrations.manage',
  'knowledge.read',
  'knowledge.manage',
  'skills.read',
  'skills.manage',
  'evaluations.run',
  'runs.read_own',
  'runs.read_all',
  'approvals.review',
  'approvals.override_four_eyes',
  'governance.read',
  'observability.read',
  'aiops.service_profile.read',
  'aiops.service_profile.write',
  'aiops.service_profile.activate',
  'aiops.investigation.run',
  'aiops.investigation.review',
  'aiops.remediation.propose',
  'aiops.remediation.approve',
  'aiops.remediation.execute',
  'audit.read',
  'audit.export',
  'audit.retention_manage',
  'audit.legal_hold_manage',
  'runtime_policy.manage',
  'compliance.read',
  'compliance.manage',
  'ai_system.read',
  'ai_system.create',
  'ai_system.manage',
  'ai_system.classify',
  'ai_system.release',
  'ai_system.suspend',
  'compliance.control_manage',
  'compliance.review',
  'compliance.dossier_generate',
  'compliance.dossier_export',
  'compliance.exception_manage',
  'compliance.external_anchor',
  'risk.manage',
  'data_governance.manage',
  'evaluation.approve',
  'oversight.manage',
  'incident.manage',
  'incident.regulatory_report',
  'retention.execute',
  'restore_drill.execute',
  'public_channels.manage',
  'tags.read',
  'tags.manage',
  'repository_graph.read',
  'workspace.search',
  'access.manage',
  'platform.admin',
] as const;

export type ArgusPermission = typeof ARGUS_PERMISSIONS[number];

export const ARGUS_PERMISSION_SET: ReadonlySet<string> = new Set(ARGUS_PERMISSIONS);

export type ResourceScopeKind =
  | 'workspace'
  | 'solution'
  | 'project'
  | 'environment'
  | 'bundle'
  | 'tag';

export interface ResourceScope {
  kind: ResourceScopeKind;
  id: string;
}

export interface PermissionAssignment {
  permission: ArgusPermission;
  effect: 'allow' | 'deny';
  scope?: ResourceScope;
  source: 'direct' | 'sso_group' | 'role_preset';
  sourceId?: string;
}

export function isArgusPermission(value: unknown): value is ArgusPermission {
  return typeof value === 'string' && ARGUS_PERMISSION_SET.has(value);
}
