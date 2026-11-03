import type { ArgusRole } from './roles.js';
import { ARGUS_PERMISSIONS, type ArgusPermission } from './permissions.js';

export interface PermissionDefinition {
  id: ArgusPermission;
  area: 'build' | 'run' | 'observe' | 'governance' | 'platform';
  description: string;
  privileged: boolean;
}

const definitions: PermissionDefinition[] = [
  { id: 'agents.chat', area: 'build', description: 'Use an enabled chat agent.', privileged: false },
  { id: 'agents.read', area: 'build', description: 'Read visible agent definitions.', privileged: false },
  { id: 'agents.run', area: 'run', description: 'Run an authorized agent.', privileged: false },
  { id: 'agents.manage', area: 'build', description: 'Create and change agent definitions.', privileged: true },
  { id: 'workflows.read', area: 'build', description: 'Read visible workflows.', privileged: false },
  { id: 'workflows.run', area: 'run', description: 'Run an authorized workflow.', privileged: false },
  { id: 'workflows.manage', area: 'build', description: 'Create and change workflows.', privileged: true },
  { id: 'integrations.read', area: 'build', description: 'Read authorized MCP integrations.', privileged: false },
  { id: 'integrations.manage', area: 'build', description: 'Create and change MCP integrations.', privileged: true },
  { id: 'knowledge.read', area: 'build', description: 'Read authorized knowledge sources.', privileged: false },
  { id: 'knowledge.manage', area: 'build', description: 'Create and change knowledge sources.', privileged: true },
  { id: 'skills.read', area: 'build', description: 'Read authorized skills.', privileged: false },
  { id: 'skills.manage', area: 'build', description: 'Create and change skills.', privileged: true },
  { id: 'evaluations.run', area: 'build', description: 'Configure and run agent evaluations.', privileged: true },
  { id: 'runs.read_own', area: 'run', description: 'Read runs in the current actor scope.', privileged: false },
  { id: 'runs.read_all', area: 'run', description: 'Read all authorized workspace runs.', privileged: true },
  { id: 'approvals.review', area: 'governance', description: 'Review pending approval requests.', privileged: true },
  { id: 'approvals.override_four_eyes', area: 'governance', description: 'Override four-eyes restrictions where policy permits.', privileged: true },
  { id: 'governance.read', area: 'governance', description: 'Read governance state and policy outcomes.', privileged: false },
  { id: 'observability.read', area: 'observe', description: 'Read authorized operational telemetry.', privileged: false },
  { id: 'aiops.service_profile.read', area: 'observe', description: 'Read authorized AIOps service profiles.', privileged: false },
  { id: 'aiops.service_profile.write', area: 'observe', description: 'Create and revise AIOps service profiles.', privileged: true },
  { id: 'aiops.service_profile.activate', area: 'governance', description: 'Activate or pause a validated AIOps service profile revision.', privileged: true },
  { id: 'aiops.investigation.run', area: 'run', description: 'Start an authorized AIOps investigation.', privileged: false },
  { id: 'aiops.investigation.review', area: 'observe', description: 'Review an AIOps root-cause result and retain evidence-bound feedback.', privileged: true },
  { id: 'aiops.remediation.propose', area: 'run', description: 'Propose a bounded AIOps remediation.', privileged: true },
  { id: 'aiops.remediation.approve', area: 'governance', description: 'Approve a governed AIOps remediation.', privileged: true },
  { id: 'aiops.remediation.execute', area: 'run', description: 'Execute an approved AIOps remediation.', privileged: true },
  { id: 'audit.read', area: 'observe', description: 'Read authorized audit evidence.', privileged: true },
  { id: 'audit.export', area: 'observe', description: 'Export an authorized evidence pack.', privileged: true },
  { id: 'audit.retention_manage', area: 'governance', description: 'Create versioned audit-retention policies.', privileged: true },
  { id: 'audit.legal_hold_manage', area: 'governance', description: 'Place and release non-mutating legal holds.', privileged: true },
  { id: 'runtime_policy.manage', area: 'governance', description: 'Change runtime and execution policy.', privileged: true },
  { id: 'compliance.read', area: 'governance', description: 'Read compliance workspaces and reports.', privileged: true },
  { id: 'compliance.manage', area: 'governance', description: 'Configure and execute compliance checks.', privileged: true },
  { id: 'ai_system.read', area: 'governance', description: 'Read authorized AI-system identities and released revision state.', privileged: false },
  { id: 'ai_system.create', area: 'governance', description: 'Register a governed AI system and its initial immutable revision.', privileged: true },
  { id: 'ai_system.manage', area: 'governance', description: 'Create new AI-system revisions and manage non-release metadata.', privileged: true },
  { id: 'ai_system.classify', area: 'governance', description: 'Confirm prohibited-practice and regulatory classification assessments.', privileged: true },
  { id: 'ai_system.release', area: 'governance', description: 'Release an independently reviewed AI-system revision.', privileged: true },
  { id: 'ai_system.suspend', area: 'governance', description: 'Suspend or retire an AI-system revision.', privileged: true },
  { id: 'compliance.control_manage', area: 'governance', description: 'Assign and maintain applicable compliance controls.', privileged: true },
  { id: 'compliance.review', area: 'governance', description: 'Review control evidence without changing immutable source records.', privileged: true },
  { id: 'compliance.dossier_generate', area: 'governance', description: 'Generate a scoped immutable compliance dossier.', privileged: true },
  { id: 'compliance.dossier_export', area: 'governance', description: 'Export an authorized compliance dossier.', privileged: true },
  { id: 'compliance.exception_manage', area: 'governance', description: 'Create expiring compliance exceptions and residual-risk decisions.', privileged: true },
  { id: 'compliance.external_anchor', area: 'governance', description: 'Anchor signed compliance evidence in an external trust boundary.', privileged: true },
  { id: 'risk.manage', area: 'governance', description: 'Manage AI-system lifecycle risks and treatments.', privileged: true },
  { id: 'data_governance.manage', area: 'governance', description: 'Manage AI-system data-source, lineage, quality and retention records.', privileged: true },
  { id: 'evaluation.approve', area: 'governance', description: 'Approve an exact evaluation result for a release gate.', privileged: true },
  { id: 'oversight.manage', area: 'governance', description: 'Manage human-oversight plans, assignments and exercises.', privileged: true },
  { id: 'incident.manage', area: 'governance', description: 'Manage AI-system incidents and corrective actions.', privileged: true },
  { id: 'incident.regulatory_report', area: 'governance', description: 'Record and submit a separately reviewed regulatory incident decision.', privileged: true },
  { id: 'retention.execute', area: 'governance', description: 'Execute an authorized physical retention or purge job.', privileged: true },
  { id: 'restore_drill.execute', area: 'governance', description: 'Execute and attest a governed restore drill.', privileged: true },
  { id: 'public_channels.manage', area: 'build', description: 'Create and change public channels.', privileged: true },
  { id: 'tags.read', area: 'platform', description: 'Read workspace tags.', privileged: false },
  { id: 'tags.manage', area: 'platform', description: 'Create tags and assign them to resources.', privileged: true },
  { id: 'repository_graph.read', area: 'build', description: 'Read bounded immutable repository graphs.', privileged: false },
  { id: 'workspace.search', area: 'platform', description: 'Search authorized workspace resources.', privileged: false },
  { id: 'access.manage', area: 'governance', description: 'Manage users, SSO mappings and access policies.', privileged: true },
  { id: 'platform.admin', area: 'platform', description: 'Administer platform-wide settings.', privileged: true },
];

export const PERMISSION_CATALOG: Readonly<Record<ArgusPermission, PermissionDefinition>> =
  Object.freeze(Object.fromEntries(definitions.map(definition => [definition.id, Object.freeze(definition)])) as Record<ArgusPermission, PermissionDefinition>);

const chatUser: ArgusPermission[] = ['agents.chat'];
const viewer: ArgusPermission[] = [
  ...chatUser,
  'agents.read',
  'workflows.read',
  'integrations.read',
  'knowledge.read',
  'skills.read',
  'runs.read_own',
  'governance.read',
  'observability.read',
  'aiops.service_profile.read',
  'ai_system.read',
  'tags.read',
  'repository_graph.read',
  'workspace.search',
];
const agentOperator: ArgusPermission[] = [
  ...viewer,
  'agents.run',
  'workflows.run',
  'runs.read_all',
  'approvals.review',
  'audit.read',
  'aiops.investigation.run',
  'aiops.investigation.review',
];
const developer: ArgusPermission[] = [
  ...agentOperator,
  'agents.manage',
  'workflows.manage',
  'knowledge.manage',
  'skills.manage',
  'evaluations.run',
  'tags.manage',
  'aiops.service_profile.write',
  'aiops.remediation.propose',
];
const operationsAdmin: ArgusPermission[] = [
  ...developer,
  'integrations.manage',
  'audit.export',
  'audit.retention_manage',
  'audit.legal_hold_manage',
  'runtime_policy.manage',
  'aiops.service_profile.activate',
  'aiops.remediation.approve',
  'aiops.remediation.execute',
  'compliance.read',
  'compliance.manage',
  'ai_system.create',
  'ai_system.manage',
  'compliance.control_manage',
  'compliance.review',
  'compliance.dossier_generate',
  'compliance.dossier_export',
  'risk.manage',
  'data_governance.manage',
  'oversight.manage',
  'incident.manage',
  'public_channels.manage',
];

export const ROLE_PERMISSION_PRESETS: Readonly<Record<ArgusRole, readonly ArgusPermission[]>> = Object.freeze({
  chat_user: Object.freeze(chatUser),
  viewer: Object.freeze(viewer),
  agent_operator: Object.freeze(agentOperator),
  developer: Object.freeze(developer),
  operations_admin: Object.freeze(operationsAdmin),
  platform_admin: Object.freeze([
    ...ARGUS_PERMISSIONS,
  ]),
});

export function permissionsForRole(role: ArgusRole): readonly ArgusPermission[] {
  return ROLE_PERMISSION_PRESETS[role];
}
