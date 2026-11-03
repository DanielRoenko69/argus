import { createHash } from 'node:crypto';
import type pg from 'pg';
import { assessAgentReadiness, type AgentCapabilityReadiness } from '../agents/agentReadiness.js';
import { getAgent } from '../agents/agentStore.js';
import type { AgentWithRag } from '../agents/types.js';
import type {
  WorkflowAgentAssignment,
  WorkflowAgentPreflight,
  WorkflowAgentRequirement,
  WorkflowRow,
  WorkflowStep,
} from './types.js';

const ROLE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{1,127}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{1,127}$/;

export class WorkflowAgentContractError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowAgentContractError';
  }
}

export interface WorkflowAgentPreflightOptions {
  probeRuntime?: boolean;
  agentLoader?: (pool: pg.Pool, agentId: number) => Promise<AgentWithRag | null>;
  readinessAssessor?: (
    pool: pg.Pool,
    agent: AgentWithRag,
    options: { probeRuntime?: boolean },
  ) => Promise<AgentCapabilityReadiness>;
}

function uniqueStrings(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(item => String(item).trim()).filter(Boolean))]
    .slice(0, maxItems)
    .map(item => item.slice(0, maxLength));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalJson(entry)]));
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalJson(value))).digest('hex');
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function normalizeWorkflowAgentRequirements(value: unknown): WorkflowAgentRequirement[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new WorkflowAgentContractError('agent_requirements must be an array');
  if (value.length > 32) throw new WorkflowAgentContractError('A workflow may declare at most 32 Agent roles');
  const roles = new Set<string>();
  return value.map((rawValue, index) => {
    const raw = (rawValue && typeof rawValue === 'object' ? rawValue : {}) as Record<string, unknown>;
    const role = String(raw['role'] ?? '').trim().toLowerCase();
    if (!ROLE_PATTERN.test(role)) throw new WorkflowAgentContractError(`Agent requirement ${index + 1} has an invalid role`);
    if (roles.has(role)) throw new WorkflowAgentContractError(`Agent role '${role}' is declared more than once`);
    roles.add(role);
    const agentName = raw['agentName'] == null ? undefined : String(raw['agentName']).trim().toLowerCase();
    const presetName = raw['presetName'] == null ? undefined : String(raw['presetName']).trim().toLowerCase();
    if (agentName && !NAME_PATTERN.test(agentName)) throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid agentName`);
    if (presetName && !NAME_PATTERN.test(presetName)) throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid presetName`);
    const agentIdValue = raw['agentId'] == null ? undefined : Number(raw['agentId']);
    if (agentIdValue != null && (!Number.isSafeInteger(agentIdValue) || agentIdValue <= 0)) {
      throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid legacy agentId`);
    }
    const minimumPresetVersion = presetName ? Number(raw['minimumPresetVersion'] ?? 1) : undefined;
    if (minimumPresetVersion != null && (!Number.isInteger(minimumPresetVersion) || minimumPresetVersion < 1)) {
      throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid minimum preset version`);
    }
    const modes = uniqueStrings(raw['allowedModes'], 3, 16);
    if (modes.some(mode => !['chat', 'worker', 'reviewer'].includes(mode))) {
      throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid allowed mode`);
    }
    const minimumBundleCount = Number(raw['minimumBundleCount'] ?? 0);
    if (!Number.isInteger(minimumBundleCount) || minimumBundleCount < 0 || minimumBundleCount > 16) {
      throw new WorkflowAgentContractError(`Agent role '${role}' has an invalid minimum bundle count`);
    }
    return {
      role,
      label: String(raw['label'] ?? role).trim().slice(0, 128) || role,
      stepIds: uniqueStrings(raw['stepIds'], 64, 128),
      agentName,
      agentId: agentIdValue,
      presetName,
      minimumPresetVersion,
      allowedModes: (modes.length ? modes : ['chat', 'worker', 'reviewer']) as WorkflowAgentRequirement['allowedModes'],
      requiredSkillNames: uniqueStrings(raw['requiredSkillNames'], 64, 128),
      requiredToolPatterns: uniqueStrings(raw['requiredToolPatterns'], 64, 256),
      minimumBundleCount,
    };
  });
}

function deriveRequirements(workflow: WorkflowRow): {
  requirements: WorkflowAgentRequirement[];
  inferredLegacyContract: boolean;
  blockers: string[];
} {
  const explicit = normalizeWorkflowAgentRequirements(workflow.agent_requirements ?? []);
  const requirements = explicit.map(requirement => ({ ...requirement, stepIds: [...requirement.stepIds] }));
  const covered = new Set(explicit.flatMap(requirement => requirement.stepIds));
  let inferredLegacyContract = false;
  const blockers: string[] = [];
  for (const step of workflow.steps.filter(step => (step.type ?? 'argus.tool') === 'argus.agent')) {
    if (covered.has(step.id)) continue;
    if (step.agent_role) {
      const role = step.agent_role.trim().toLowerCase();
      const existing = requirements.find(requirement => requirement.role === role);
      if (existing) existing.stepIds = [...new Set([...existing.stepIds, step.id])];
      else requirements.push({
        role,
        label: step.label || role,
        stepIds: [step.id],
        allowedModes: ['chat', 'worker', 'reviewer'],
        requiredSkillNames: [],
        requiredToolPatterns: [],
        minimumBundleCount: 0,
      });
      continue;
    }
    if (Number.isSafeInteger(step.agent_id) && Number(step.agent_id) > 0) {
      inferredLegacyContract = true;
      const role = `legacy-agent-${step.agent_id}`;
      const existing = requirements.find(requirement => requirement.agentId === step.agent_id);
      if (existing) existing.stepIds = [...new Set([...existing.stepIds, step.id])];
      else requirements.push({
        role,
        label: step.label || role,
        stepIds: [step.id],
        agentId: step.agent_id,
        allowedModes: ['chat', 'worker', 'reviewer'],
        requiredSkillNames: [],
        requiredToolPatterns: [],
        minimumBundleCount: 0,
      });
      continue;
    }
    blockers.push(`Agent step '${step.label || step.id}' has neither agent_role nor agent_id`);
  }
  return { requirements, inferredLegacyContract, blockers };
}

interface CandidateRow extends pg.QueryResultRow {
  id: number | string;
  template_name: string | null;
  installed_version: number | string | null;
}

async function findCandidate(pool: pg.Pool, requirement: WorkflowAgentRequirement): Promise<CandidateRow | null> {
  if (requirement.agentId != null) {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT agent.id, installation.template_name, installation.installed_version
         FROM mcp_agents agent
         LEFT JOIN mcp_agent_template_installations installation ON installation.agent_id=agent.id
        WHERE agent.id=$1
        ORDER BY installation.installed_version DESC NULLS LAST LIMIT 1`,
      [requirement.agentId],
    );
    return rows[0] ?? null;
  }
  if (requirement.presetName) {
    const params: unknown[] = [requirement.presetName];
    let nameClause = '';
    if (requirement.agentName) {
      params.push(requirement.agentName);
      nameClause = ' AND agent.name=$2';
    }
    const { rows } = await pool.query<CandidateRow>(
      `SELECT agent.id, installation.template_name, installation.installed_version
         FROM mcp_agent_template_installations installation
         JOIN mcp_agents agent ON agent.id=installation.agent_id
        WHERE installation.template_name=$1${nameClause}
        ORDER BY agent.enabled DESC, installation.installed_version DESC, agent.id LIMIT 1`,
      params,
    );
    return rows[0] ?? null;
  }
  const match = requirement.agentName ?? requirement.role;
  const { rows } = await pool.query<CandidateRow>(
    `SELECT agent.id, installation.template_name, installation.installed_version
       FROM mcp_agents agent
       LEFT JOIN mcp_agent_template_installations installation ON installation.agent_id=agent.id
      WHERE agent.name=$1 OR agent.agent_role=$1
      ORDER BY (agent.name=$1) DESC, agent.enabled DESC, installation.installed_version DESC NULLS LAST, agent.id LIMIT 1`,
    [match],
  );
  return rows[0] ?? null;
}

function unresolvedAssignment(requirement: WorkflowAgentRequirement, blockers: string[]): WorkflowAgentAssignment {
  return {
    role: requirement.role,
    label: requirement.label ?? requirement.role,
    stepIds: requirement.stepIds,
    status: 'blocked',
    agentId: null,
    agentName: null,
    agentLabel: null,
    agentMode: null,
    model: null,
    presetName: requirement.presetName ?? null,
    installedPresetVersion: null,
    requiredPresetVersion: requirement.minimumPresetVersion ?? null,
    skillNames: [],
    bundleIds: [],
    toolNames: [],
    runtime: null,
    catalogFingerprint: null,
    blockers,
    warnings: [],
  };
}

export async function preflightWorkflowAgents(
  pool: pg.Pool,
  workflow: WorkflowRow,
  options: WorkflowAgentPreflightOptions = {},
): Promise<WorkflowAgentPreflight> {
  const checkedAt = new Date().toISOString();
  let derived: ReturnType<typeof deriveRequirements>;
  try {
    derived = deriveRequirements(workflow);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      workflowId: workflow.id,
      workflowName: workflow.name,
      checkedAt,
      ready: false,
      inferredLegacyContract: false,
      contractFingerprint: fingerprint(workflow.agent_requirements ?? []),
      blockers: [message],
      warnings: [],
      assignments: [],
    };
  }

  const assignments = await Promise.all(derived.requirements.map(async requirement => {
    const candidate = await findCandidate(pool, requirement);
    if (!candidate) return unresolvedAssignment(requirement, [
      requirement.presetName
        ? `No Agent is installed from preset '${requirement.presetName}'`
        : `No Agent matches role '${requirement.role}'`,
    ]);
    const agent = await (options.agentLoader ?? getAgent)(pool, Number(candidate.id));
    if (!agent) return unresolvedAssignment(requirement, [`Resolved Agent #${candidate.id} no longer exists`]);

    const readiness = await (options.readinessAssessor ?? assessAgentReadiness)(
      pool,
      agent,
      { probeRuntime: options.probeRuntime !== false },
    );
    const blockers = [...readiness.blockers];
    const warnings = [...readiness.warnings];
    const installedVersion = candidate.installed_version == null ? null : Number(candidate.installed_version);
    if (requirement.presetName && candidate.template_name !== requirement.presetName) {
      blockers.push(`Agent '${agent.name}' is not installed from preset '${requirement.presetName}'`);
    }
    if (requirement.minimumPresetVersion != null && (installedVersion == null || installedVersion < requirement.minimumPresetVersion)) {
      blockers.push(`Preset '${requirement.presetName}' requires v${requirement.minimumPresetVersion}; Agent has ${installedVersion == null ? 'no lifecycle version' : `v${installedVersion}`}`);
    }
    if (!requirement.allowedModes.includes(agent.agent_mode)) {
      blockers.push(`Agent '${agent.name}' mode '${agent.agent_mode}' is not allowed for role '${requirement.role}'`);
    }
    const skillNames = agent.skills.map(skill => skill.name);
    for (const missing of requirement.requiredSkillNames.filter(name => !skillNames.includes(name))) {
      blockers.push(`Agent '${agent.name}' is missing required skill '${missing}'`);
    }
    if (readiness.bundles.length < requirement.minimumBundleCount) {
      blockers.push(`Agent '${agent.name}' needs at least ${requirement.minimumBundleCount} MCP bundle${requirement.minimumBundleCount === 1 ? '' : 's'}`);
    }
    const toolNames = readiness.tools.map(tool => tool.name);
    for (const pattern of requirement.requiredToolPatterns.filter(pattern => !toolNames.some(name => globMatch(pattern, name)))) {
      blockers.push(`Agent '${agent.name}' is missing required tool capability '${pattern}'`);
    }
    const bundleIds = readiness.bundles.map(bundle => bundle.id).sort((left, right) => left - right);
    const snapshotCore = {
      agentId: agent.id,
      agentName: agent.name,
      agentMode: agent.agent_mode,
      model: agent.model,
      presetName: candidate.template_name,
      installedPresetVersion: installedVersion,
      skillNames: [...skillNames].sort(),
      bundleIds,
      toolNames: [...toolNames].sort(),
      runtime: readiness.runtime,
    };
    return {
      role: requirement.role,
      label: requirement.label ?? requirement.role,
      stepIds: requirement.stepIds,
      status: blockers.length ? 'blocked' : warnings.length ? 'degraded' : 'ready',
      agentId: agent.id,
      agentName: agent.name,
      agentLabel: agent.label,
      agentMode: agent.agent_mode,
      model: agent.model,
      presetName: candidate.template_name,
      installedPresetVersion: installedVersion,
      requiredPresetVersion: requirement.minimumPresetVersion ?? null,
      skillNames,
      bundleIds,
      toolNames,
      runtime: readiness.runtime,
      catalogFingerprint: fingerprint(snapshotCore),
      blockers: [...new Set(blockers)],
      warnings: [...new Set(warnings)],
    } satisfies WorkflowAgentAssignment;
  }));

  const blockers = [...new Set([...derived.blockers, ...assignments.flatMap(assignment => assignment.blockers)])];
  const warnings = [...new Set([
    ...(derived.inferredLegacyContract ? ['Legacy agent_id bindings were inferred; migrate the workflow to portable Agent roles'] : []),
    ...assignments.flatMap(assignment => assignment.warnings),
  ])];
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    checkedAt,
    ready: blockers.length === 0,
    inferredLegacyContract: derived.inferredLegacyContract,
    contractFingerprint: fingerprint(derived.requirements),
    blockers,
    warnings,
    assignments,
  };
}

export function applyWorkflowAgentAssignments(workflow: WorkflowRow, preflight: WorkflowAgentPreflight): WorkflowRow {
  if (!preflight.ready) return workflow;
  const byStep = new Map<string, { agentId: number; role: string }>();
  for (const assignment of preflight.assignments) {
    if (assignment.agentId == null) continue;
    for (const stepId of assignment.stepIds) byStep.set(stepId, { agentId: assignment.agentId, role: assignment.role });
  }
  return {
    ...workflow,
    steps: workflow.steps.map((step: WorkflowStep) => {
      const assignment = byStep.get(step.id);
      return assignment ? { ...step, agent_id: assignment.agentId, agent_role: assignment.role } : step;
    }),
  };
}

export function workflowExecutionSnapshot(preflight: WorkflowAgentPreflight): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'workflow-agent-contract',
    capturedAt: preflight.checkedAt,
    contractFingerprint: preflight.contractFingerprint,
    inferredLegacyContract: preflight.inferredLegacyContract,
    assignments: preflight.assignments,
  };
}

export function applyWorkflowAgentSnapshot(
  workflow: WorkflowRow,
  snapshot: Record<string, unknown> | null | undefined,
): WorkflowRow {
  const rawAssignments = Array.isArray(snapshot?.['assignments']) ? snapshot['assignments'] : [];
  const byStep = new Map<string, { agentId: number; role: string }>();
  for (const raw of rawAssignments) {
    if (!raw || typeof raw !== 'object') continue;
    const assignment = raw as Record<string, unknown>;
    const agentId = Number(assignment['agentId']);
    const role = String(assignment['role'] ?? '').trim();
    if (!Number.isSafeInteger(agentId) || agentId <= 0 || !role || !Array.isArray(assignment['stepIds'])) continue;
    for (const rawStepId of assignment['stepIds']) {
      const stepId = String(rawStepId ?? '').trim();
      if (stepId) byStep.set(stepId, { agentId, role });
    }
  }
  return {
    ...workflow,
    steps: workflow.steps.map(step => {
      const assignment = byStep.get(step.id);
      return assignment ? { ...step, agent_id: assignment.agentId, agent_role: assignment.role } : step;
    }),
  };
}
