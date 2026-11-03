import type pg from 'pg';
import { loadAllowedToolNames } from '../bundles/toolPolicies.js';
import { assessAgentReadiness, type AgentCapabilityReadiness, type AgentReadinessOptions } from './agentReadiness.js';
import { createAgent, getAgent } from './agentStore.js';
import type { AgentRuntimeAssignment } from './runtimeProfiles.js';
import { setAgentSkills, replaceAgentSkills } from './skillStore.js';
import type { AgentWithRag, CreateAgentInput } from './types.js';

export interface AgentTemplateConfig {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  agentRole?: string;
  giteaProject?: string;
  enabled?: boolean;
  maxIterations?: number;
  taskType?: string;
  allowedPaths?: string[];
  bitbucketRepo?: string;
  thinkingBudget?: number;
  untrustedToolOutputEnforcement?: boolean;
  codegraphEnabled?: boolean;
  visibility?: 'internal' | 'public';
  minRole?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  humanOversightRequired?: boolean;
}

export interface AgentTemplate {
  id: number;
  name: string;
  label: string;
  description: string;
  category: string;
  agentMode: 'chat' | 'worker' | 'reviewer';
  config: AgentTemplateConfig;
  compositeName: string | null;
  skillNames: string[];
  recommendedCapabilities: string[];
  requiredBy: string[];
  requiredToolPatterns: string[];
  minimumBundleCount: number;
  compatibleBundleIds: number[];
  version: number;
  installed: boolean;
  installedAgentId: number | null;
  installedVersion: number | null;
  installedAgents: AgentTemplateInstallation[];
  upgradeAvailable: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TemplateRow extends pg.QueryResultRow {
  id: number;
  name: string;
  label: string;
  description: string;
  category: string;
  agent_mode: AgentTemplate['agentMode'];
  config: AgentTemplateConfig | null;
  composite_name: string | null;
  skill_names: string[] | null;
  recommended_capabilities: string[] | null;
  required_by: string[] | null;
  required_tool_patterns: string[] | null;
  minimum_bundle_count: number | string | null;
  version: number | string | null;
  installed: boolean;
  installed_agent_id: number | string | null;
  installed_version: number | string | null;
  created_at: string;
  updated_at: string;
}

function mapTemplate(row: TemplateRow, compatibleBundleIds: number[] = []): AgentTemplate {
  return {
    id: Number(row.id),
    name: row.name,
    label: row.label,
    description: row.description,
    category: row.category,
    agentMode: row.agent_mode,
    config: row.config ?? {},
    compositeName: row.composite_name,
    skillNames: row.skill_names ?? [],
    recommendedCapabilities: row.recommended_capabilities ?? [],
    requiredBy: row.required_by ?? [],
    requiredToolPatterns: row.required_tool_patterns ?? [],
    minimumBundleCount: Number(row.minimum_bundle_count ?? 0),
    compatibleBundleIds,
    version: Number(row.version ?? 1),
    installed: row.installed,
    installedAgentId: row.installed_agent_id == null ? null : Number(row.installed_agent_id),
    installedVersion: row.installed_version == null ? null : Number(row.installed_version),
    installedAgents: [],
    upgradeAvailable: row.installed
      && Number(row.version ?? 1) > Number(row.installed_version ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TEMPLATE_SELECT = `
  SELECT template.*,
         (agent.id IS NOT NULL) AS installed,
         agent.id AS installed_agent_id,
         installation.installed_version
    FROM mcp_agent_templates template
    LEFT JOIN LATERAL (
      SELECT id FROM mcp_agents WHERE name=template.name ORDER BY id LIMIT 1
    ) agent ON true
    LEFT JOIN mcp_agent_template_installations installation
      ON installation.agent_id=agent.id AND installation.template_name=template.name`;

export async function listAgentTemplates(pool: pg.Pool): Promise<AgentTemplate[]> {
  const { rows } = await pool.query<TemplateRow>(
    `${TEMPLATE_SELECT} ORDER BY template.category, template.label, template.id`,
  );
  const templates = rows.map(row => mapTemplate(row));
  let templatesWithInstallations = templates;
  if (templates.some(template => template.installed)) {
    const names = templates.map(template => template.name);
    const installationResult = await pool.query<{
      template_name: string;
      id: number;
      name: string;
      label: string;
      model: string;
      installed_version: number | string;
    }>(
      `SELECT installation.template_name, agent.id, agent.name, agent.label, agent.model,
              installation.installed_version
         FROM mcp_agent_template_installations installation
         JOIN mcp_agents agent ON agent.id=installation.agent_id
        WHERE installation.template_name=ANY($1::text[])
        ORDER BY installation.template_name, agent.id`,
      [names],
    );
    const installedByTemplate = new Map<string, AgentTemplateInstallation[]>();
    for (const row of installationResult.rows) {
      const current = installedByTemplate.get(row.template_name) ?? [];
      current.push({
        id: Number(row.id), name: row.name, label: row.label, model: row.model,
        installedVersion: Number(row.installed_version ?? 0),
      });
      installedByTemplate.set(row.template_name, current);
    }
    templatesWithInstallations = templates.map(template => {
      const installedAgents = installedByTemplate.get(template.name) ?? [];
      const installedVersion = installedAgents[0]?.installedVersion ?? template.installedVersion;
      return {
        ...template,
        installed: template.installed || installedAgents.length > 0,
        installedAgentId: installedAgents[0]?.id ?? template.installedAgentId,
        installedVersion,
        installedAgents,
        upgradeAvailable: template.version > (installedVersion ?? 0),
      };
    });
  }
  if (!templatesWithInstallations.some(template => template.requiredToolPatterns.length > 0)) return templatesWithInstallations;

  const bundleResult = await pool.query<{ id: number }>('SELECT id FROM mcp_service_bundles ORDER BY id');
  const toolCatalogs = new Map<number, Set<string>>();
  await Promise.all(bundleResult.rows.map(async bundle => {
    toolCatalogs.set(Number(bundle.id), await loadAllowedToolNames(pool, [Number(bundle.id)], { includeUnscoped: false }));
  }));
  return templatesWithInstallations.map(template => ({
    ...template,
    compatibleBundleIds: template.requiredToolPatterns.length === 0
      ? []
      : [...toolCatalogs.entries()]
          .filter(([, tools]) => template.requiredToolPatterns.every(
            pattern => [...tools].some(toolName => globMatch(pattern, toolName)),
          ))
          .map(([bundleId]) => bundleId),
  }));
}

export class AgentTemplateInstallError extends Error {
  constructor(message: string, public readonly status: 400 | 403 | 404 | 409) {
    super(message);
    this.name = 'AgentTemplateInstallError';
  }
}

export interface AgentTemplateInstallInput {
  model: string;
  runtimeProfileId?: number | null;
  bundleIds?: number[];
  agentName?: string;
}

export interface AgentTemplateInstallation {
  id: number;
  name: string;
  label: string;
  model: string;
  installedVersion: number;
}

export interface AgentTemplateInstallOptions {
  allowMultiple?: boolean;
  allowedAgentModes?: AgentTemplate['agentMode'][];
  visibleAgentIds?: number[];
  /** Optional server-side bundle scope for user-facing onboarding installs. */
  allowedBundleIds?: number[] | null;
}

export interface AgentTemplatePreflight {
  templateName: string;
  selectionValid: boolean;
  errors: string[];
  readiness: AgentCapabilityReadiness | null;
}

interface ResolvedTemplateSelection {
  template: AgentTemplate;
  agentName?: string;
  model: string;
  runtimeProfileId: number | null;
  runtimeAssignment: AgentRuntimeAssignment | null;
  bundleIds: number[];
  compositeId: number | null;
}

export interface AgentTemplatePreflightOptions {
  readinessAssessor?: (
    pool: pg.Pool,
    agent: AgentWithRag,
    options: AgentReadinessOptions,
  ) => Promise<AgentCapabilityReadiness>;
}

export interface AgentTemplateManagedSnapshot {
  label: string;
  description: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string | null;
  agentRole: string | null;
  compositeName: string | null;
  skillNames: string[];
  giteaProject: string | null;
  maxIterations: number;
  agentMode: AgentTemplate['agentMode'];
  taskType: string | null;
  allowedPaths: string[] | null;
  bitbucketRepo: string | null;
  thinkingBudget: number;
  untrustedToolOutputEnforcement: boolean;
  codegraphEnabled: boolean;
  visibility: 'internal' | 'public';
  minRole: string | null;
  riskLevel: 'low' | 'medium' | 'high';
  humanOversightRequired: boolean;
}

export interface AgentTemplateFieldDiff {
  field: keyof AgentTemplateManagedSnapshot;
  baseline: unknown;
  current: unknown;
  target: unknown;
  templateChanged: boolean;
  locallyChanged: boolean;
  conflict: boolean;
}

export interface AgentTemplateUpgradePreview {
  templateName: string;
  templateLabel: string;
  agentId: number;
  installedVersion: number;
  targetVersion: number;
  upgradeAvailable: boolean;
  safeToApply: boolean;
  proposedChanges: AgentTemplateFieldDiff[];
  localChanges: AgentTemplateFieldDiff[];
  conflicts: AgentTemplateFieldDiff[];
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

function positiveIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))].slice(0, 16);
}

async function resolveTemplateSelection(
  pool: pg.Pool,
  templateName: string,
  value: string | AgentTemplateInstallInput,
  requireUninstalled: boolean,
): Promise<ResolvedTemplateSelection> {
  const templateResult = await pool.query<TemplateRow>(
    `${TEMPLATE_SELECT} WHERE template.name=$1`,
    [templateName],
  );
  const row = templateResult.rows[0];
  if (!row) throw new AgentTemplateInstallError('Agent template not found', 404);
  const template = mapTemplate(row);
  if (requireUninstalled && template.installed) {
    throw new AgentTemplateInstallError(`Agent “${template.label}” is already installed`, 409);
  }

  return validateTemplateSelection(pool, template, value);
}

async function validateTemplateSelection(
  pool: pg.Pool,
  template: AgentTemplate,
  value: string | AgentTemplateInstallInput,
): Promise<ResolvedTemplateSelection> {
  const inputValue: AgentTemplateInstallInput = typeof value === 'string' ? { model: value } : value;
  const agentName = typeof inputValue.agentName === 'string' && inputValue.agentName.trim()
    ? inputValue.agentName.trim().toLowerCase()
    : undefined;
  if (agentName && (!/^[a-z0-9][a-z0-9_-]*$/.test(agentName) || agentName.length > 128)) {
    throw new AgentTemplateInstallError('Agent name may only contain lowercase letters, numbers, _ and -', 400);
  }
  const selectedBundleIds = positiveIds(inputValue.bundleIds);
  if (selectedBundleIds.length < template.minimumBundleCount) {
    throw new AgentTemplateInstallError(
      `Select at least ${template.minimumBundleCount} MCP bundle${template.minimumBundleCount === 1 ? '' : 's'} for this preset`,
      400,
    );
  }

  const normalizedModel = inputValue.model.trim();
  if (!normalizedModel) throw new AgentTemplateInstallError('Select a catalog model', 400);
  const modelResult = await pool.query<{ model_name: string }>(
    `SELECT model.model_name
       FROM mcp_models model
       LEFT JOIN mcp_llm_providers provider ON provider.id=model.provider_id
      WHERE model.model_name=$1
        AND model.enabled=true
        AND COALESCE(provider.enabled, true)=true
      LIMIT 1`,
    [normalizedModel],
  );
  if (!modelResult.rows[0]) throw new AgentTemplateInstallError('Selected model is missing or disabled', 400);

  const runtimeProfileId = inputValue.runtimeProfileId == null ? null : Number(inputValue.runtimeProfileId);
  let runtimeAssignment: AgentRuntimeAssignment | null = null;
  if (runtimeProfileId != null) {
    if (!Number.isSafeInteger(runtimeProfileId) || runtimeProfileId <= 0) {
      throw new AgentTemplateInstallError('Select a valid runtime profile', 400);
    }
    const runtimeResult = await pool.query<Omit<AgentRuntimeAssignment, 'agent_id' | 'agent_name'>>(
      `SELECT runtime_type,
              id AS profile_id,
              name AS profile_name,
              label AS profile_label,
              auth_mode,
              auth_ref,
              model,
              reasoning_effort,
              code_context_mode,
              code_context_max_results,
              code_context_max_bytes,
              enabled AS profile_enabled
         FROM mcp_agent_runtime_profiles
        WHERE id=$1 AND enabled=true`,
      [runtimeProfileId],
    );
    const profile = runtimeResult.rows[0];
    if (!profile) throw new AgentTemplateInstallError('Selected runtime profile is missing or disabled', 400);
    runtimeAssignment = { agent_id: -template.id, agent_name: template.name, ...profile };
  }

  if (selectedBundleIds.length > 0) {
    const bundleResult = await pool.query<{ id: number; label: string }>(
      'SELECT id, label FROM mcp_service_bundles WHERE id=ANY($1::int[])',
      [selectedBundleIds],
    );
    const foundIds = new Set(bundleResult.rows.map(bundle => Number(bundle.id)));
    const missingIds = selectedBundleIds.filter(id => !foundIds.has(id));
    if (missingIds.length > 0) {
      throw new AgentTemplateInstallError(`Selected MCP bundle${missingIds.length === 1 ? '' : 's'} not found: ${missingIds.join(', ')}`, 400);
    }
    if (template.requiredToolPatterns.length > 0) {
      const allowedTools = await loadAllowedToolNames(pool, selectedBundleIds, { includeUnscoped: false });
      const missingPatterns = template.requiredToolPatterns.filter(
        pattern => ![...allowedTools].some(toolName => globMatch(pattern, toolName)),
      );
      if (missingPatterns.length > 0) {
        throw new AgentTemplateInstallError(
          `Selected MCP bundle scope is missing required capabilities: ${missingPatterns.join(', ')}`,
          400,
        );
      }
    }
  }

  const compositeResult = template.compositeName
    ? await pool.query<{ id: number }>('SELECT id FROM mcp_composites WHERE name=$1 AND enabled=true', [template.compositeName])
    : { rows: [] as Array<{ id: number }> };
  if (template.compositeName && !compositeResult.rows[0]) {
    throw new AgentTemplateInstallError(`Required policy composite is unavailable: ${template.compositeName}`, 409);
  }
  return {
    template,
    agentName,
    model: normalizedModel,
    runtimeProfileId,
    runtimeAssignment,
    bundleIds: selectedBundleIds,
    compositeId: compositeResult.rows[0]?.id ?? null,
  };
}

function buildTemplateAgentInput(selection: ResolvedTemplateSelection): CreateAgentInput {
  const { template, agentName, model, runtimeProfileId, bundleIds, compositeId } = selection;
  const config = template.config;
  return {
    name: agentName ?? template.name,
    label: template.label,
    description: template.description,
    model,
    temperature: config.temperature ?? 0.3,
    max_tokens: config.maxTokens ?? 4096,
    system_prompt: config.systemPrompt,
    agent_role: config.agentRole,
    composite_id: compositeId,
    gitea_project: config.giteaProject ?? null,
    enabled: config.enabled ?? true,
    max_iterations: config.maxIterations ?? 10,
    agent_mode: template.agentMode,
    task_type: config.taskType ?? null,
    allowed_paths: config.allowedPaths ?? null,
    bitbucket_repo: config.bitbucketRepo ?? null,
    bundle_ids: bundleIds,
    runtime_profile_id: runtimeProfileId,
    thinking_budget: config.thinkingBudget ?? 0,
    untrusted_tool_output_enforcement: config.untrustedToolOutputEnforcement ?? true,
    codegraph_enabled: config.codegraphEnabled ?? false,
    visibility: config.visibility ?? 'internal',
    min_role: config.minRole ?? null,
    risk_level: config.riskLevel ?? 'low',
    human_oversight_required: config.humanOversightRequired ?? false,
  };
}

async function nextStarterVariantName(pool: pg.Pool, templateName: string, model: string): Promise<string> {
  const modelSlug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
  const baseName = `${templateName}-${modelSlug}`.slice(0, 110).replace(/-+$/g, '') || `${templateName}-model`;
  const result = await pool.query<{ name: string }>(
    'SELECT name FROM mcp_agents WHERE name=$1 OR name LIKE $2',
    [baseName, `${baseName}-%`],
  );
  const usedNames = new Set(result.rows.map(row => row.name));
  let candidate = baseName;
  let suffix = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName.slice(0, Math.max(1, 127 - String(suffix).length))}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function templateManagedSnapshot(
  template: AgentTemplate,
  compositeName: string | null = template.compositeName,
): AgentTemplateManagedSnapshot {
  const config = template.config;
  return {
    label: template.label,
    description: template.description,
    temperature: config.temperature ?? 0.3,
    maxTokens: config.maxTokens ?? 4096,
    systemPrompt: config.systemPrompt ?? null,
    agentRole: config.agentRole ?? null,
    compositeName,
    skillNames: [...template.skillNames],
    giteaProject: config.giteaProject ?? null,
    maxIterations: config.maxIterations ?? 10,
    agentMode: template.agentMode,
    taskType: config.taskType ?? null,
    allowedPaths: config.allowedPaths ?? null,
    bitbucketRepo: config.bitbucketRepo ?? null,
    thinkingBudget: config.thinkingBudget ?? 0,
    untrustedToolOutputEnforcement: config.untrustedToolOutputEnforcement ?? true,
    codegraphEnabled: config.codegraphEnabled ?? false,
    visibility: config.visibility ?? 'internal',
    minRole: config.minRole ?? null,
    riskLevel: config.riskLevel ?? 'low',
    humanOversightRequired: config.humanOversightRequired ?? false,
  };
}

function agentManagedSnapshot(agent: AgentWithRag): AgentTemplateManagedSnapshot {
  return {
    label: agent.label,
    description: agent.description,
    temperature: Number(agent.temperature),
    maxTokens: Number(agent.max_tokens),
    systemPrompt: agent.system_prompt,
    agentRole: agent.agent_role,
    compositeName: agent.composite_name,
    skillNames: agent.skills.map(skill => skill.name),
    giteaProject: agent.gitea_project,
    maxIterations: Number(agent.max_iterations),
    agentMode: agent.agent_mode,
    taskType: agent.task_type,
    allowedPaths: agent.allowed_paths,
    bitbucketRepo: agent.bitbucket_repo,
    thinkingBudget: Number(agent.thinking_budget),
    untrustedToolOutputEnforcement: agent.untrusted_tool_output_enforcement,
    codegraphEnabled: agent.codegraph_enabled,
    visibility: agent.visibility,
    minRole: agent.min_role,
    riskLevel: agent.risk_level,
    humanOversightRequired: agent.human_oversight_required,
  };
}

const MANAGED_FIELDS = [
  'label', 'description', 'temperature', 'maxTokens', 'systemPrompt', 'agentRole',
  'compositeName', 'skillNames', 'giteaProject', 'maxIterations', 'agentMode',
  'taskType', 'allowedPaths', 'bitbucketRepo', 'thinkingBudget',
  'untrustedToolOutputEnforcement', 'codegraphEnabled', 'visibility', 'minRole',
  'riskLevel', 'humanOversightRequired',
] as const satisfies ReadonlyArray<keyof AgentTemplateManagedSnapshot>;

function sameSnapshotValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function diffAgentTemplateSnapshots(
  baseline: AgentTemplateManagedSnapshot,
  current: AgentTemplateManagedSnapshot,
  target: AgentTemplateManagedSnapshot,
): AgentTemplateFieldDiff[] {
  return MANAGED_FIELDS.map(field => {
    const templateChanged = !sameSnapshotValue(baseline[field], target[field]);
    const locallyChanged = !sameSnapshotValue(baseline[field], current[field]);
    return {
      field,
      baseline: baseline[field],
      current: current[field],
      target: target[field],
      templateChanged,
      locallyChanged,
      conflict: templateChanged && locallyChanged && !sameSnapshotValue(current[field], target[field]),
    };
  });
}

function virtualAgent(selection: ResolvedTemplateSelection): AgentWithRag {
  const input = buildTemplateAgentInput(selection);
  const now = new Date().toISOString();
  return {
    id: -selection.template.id,
    name: input.name,
    label: input.label,
    description: input.description ?? '',
    model: input.model ?? '',
    temperature: input.temperature ?? 0.3,
    max_tokens: input.max_tokens ?? 4096,
    system_prompt: input.system_prompt ?? null,
    agent_role: input.agent_role ?? null,
    composite_id: input.composite_id ?? null,
    composite_name: selection.template.compositeName,
    gitea_project: input.gitea_project ?? null,
    enabled: input.enabled ?? true,
    max_iterations: input.max_iterations ?? 10,
    created_by: null,
    created_at: now,
    updated_at: now,
    agent_mode: input.agent_mode ?? 'chat',
    task_type: input.task_type ?? null,
    pr_branch: null,
    pr_number: null,
    ticket_id: null,
    allowed_paths: input.allowed_paths ?? null,
    bitbucket_repo: input.bitbucket_repo ?? null,
    bundle_ids: input.bundle_ids ?? [],
    llm_api_key: null,
    llm_credential_profile_id: null,
    runtime_profile_id: input.runtime_profile_id ?? null,
    thinking_budget: input.thinking_budget ?? 0,
    untrusted_tool_output_enforcement: input.untrusted_tool_output_enforcement ?? true,
    entra_object_id: null,
    entra_app_id: null,
    entra_blueprint_id: null,
    entra_synced_at: null,
    entra_sync_error: null,
    codegraph_enabled: input.codegraph_enabled ?? false,
    visibility: input.visibility ?? 'internal',
    min_role: input.min_role ?? null,
    risk_level: input.risk_level ?? 'low',
    human_oversight_required: input.human_oversight_required ?? false,
    rag_indexes: [],
    skills: [],
  };
}

export async function previewAgentTemplateDefinition(
  pool: pg.Pool,
  template: AgentTemplate,
  value: string | AgentTemplateInstallInput,
  options: AgentTemplatePreflightOptions = {},
): Promise<AgentTemplatePreflight> {
  try {
    const selection = await validateTemplateSelection(pool, template, value);
    const readiness = await (options.readinessAssessor ?? assessAgentReadiness)(
      pool,
      virtualAgent(selection),
      { bundleIds: selection.bundleIds, runtimeAssignment: selection.runtimeAssignment },
    );
    return { templateName: template.name, selectionValid: true, errors: [], readiness };
  } catch (error) {
    if (error instanceof AgentTemplateInstallError) {
      return { templateName: template.name, selectionValid: false, errors: [error.message], readiness: null };
    }
    throw error;
  }
}

export async function previewAgentTemplate(
  pool: pg.Pool,
  templateName: string,
  value: string | AgentTemplateInstallInput,
  options: AgentTemplatePreflightOptions = {},
): Promise<AgentTemplatePreflight> {
  try {
    const selection = await resolveTemplateSelection(pool, templateName, value, false);
    const readiness = await (options.readinessAssessor ?? assessAgentReadiness)(
      pool,
      virtualAgent(selection),
      { bundleIds: selection.bundleIds, runtimeAssignment: selection.runtimeAssignment },
    );
    return { templateName, selectionValid: true, errors: [], readiness };
  } catch (error) {
    if (error instanceof AgentTemplateInstallError) {
      return { templateName, selectionValid: false, errors: [error.message], readiness: null };
    }
    throw error;
  }
}

interface TemplateInstallationRow extends pg.QueryResultRow {
  agent_id: number;
  installed_version: number | string;
  applied_snapshot: AgentTemplateManagedSnapshot;
}

interface AgentTemplateUpgradeContext {
  template: AgentTemplate;
  agent: AgentWithRag;
  installedVersion: number;
  baseline: AgentTemplateManagedSnapshot;
  current: AgentTemplateManagedSnapshot;
  target: AgentTemplateManagedSnapshot;
  compositeId: number | null;
  diffs: AgentTemplateFieldDiff[];
}

async function loadAgentTemplateUpgradeContext(
  pool: pg.Pool,
  templateName: string,
  requestedAgentId?: number,
): Promise<AgentTemplateUpgradeContext> {
  const templateResult = await pool.query<TemplateRow>(`${TEMPLATE_SELECT} WHERE template.name=$1`, [templateName]);
  const row = templateResult.rows[0];
  if (!row) throw new AgentTemplateInstallError('Agent template not found', 404);
  const template = mapTemplate(row);
  if (!template.installed || template.installedAgentId == null) {
    throw new AgentTemplateInstallError(`Agent preset “${template.label}” is not installed`, 409);
  }
  const installationResult = await pool.query<TemplateInstallationRow>(
    `SELECT agent_id, installed_version, applied_snapshot
       FROM mcp_agent_template_installations
      WHERE template_name=$1
        AND ($2::int IS NULL OR agent_id=$2)
      ORDER BY agent_id
      LIMIT 1`,
    [template.name, requestedAgentId ?? null],
  );
  const installation = installationResult.rows[0];
  if (!installation) {
    throw new AgentTemplateInstallError(`Agent preset “${template.label}” has no lifecycle baseline`, 409);
  }
  const agent = await getAgent(pool, Number(installation.agent_id));
  if (!agent) throw new AgentTemplateInstallError('Installed Agent could not be loaded', 409);
  const compositeResult = template.compositeName
    ? await pool.query<{ id: number }>('SELECT id FROM mcp_composites WHERE name=$1 AND enabled=true', [template.compositeName])
    : { rows: [] as Array<{ id: number }> };
  if (template.compositeName && !compositeResult.rows[0]) {
    throw new AgentTemplateInstallError(`Required policy composite is unavailable: ${template.compositeName}`, 409);
  }
  const baseline = installation.applied_snapshot;
  const current = agentManagedSnapshot(agent);
  const target = templateManagedSnapshot(template);
  return {
    template,
    agent,
    installedVersion: Number(installation.installed_version),
    baseline,
    current,
    target,
    compositeId: compositeResult.rows[0]?.id ?? null,
    diffs: diffAgentTemplateSnapshots(baseline, current, target),
  };
}

function upgradePreviewFromContext(context: AgentTemplateUpgradeContext): AgentTemplateUpgradePreview {
  const proposedChanges = context.diffs.filter(diff => !sameSnapshotValue(diff.current, diff.target));
  const localChanges = context.diffs.filter(diff => diff.locallyChanged);
  const conflicts = context.diffs.filter(diff => diff.conflict);
  const upgradeAvailable = context.template.version > context.installedVersion;
  return {
    templateName: context.template.name,
    templateLabel: context.template.label,
    agentId: context.agent.id,
    installedVersion: context.installedVersion,
    targetVersion: context.template.version,
    upgradeAvailable,
    safeToApply: upgradeAvailable && conflicts.length === 0,
    proposedChanges,
    localChanges,
    conflicts,
  };
}

export async function previewAgentTemplateUpgrade(
  pool: pg.Pool,
  templateName: string,
  agentId?: number,
): Promise<AgentTemplateUpgradePreview> {
  return upgradePreviewFromContext(await loadAgentTemplateUpgradeContext(pool, templateName, agentId));
}

export async function applyAgentTemplateUpgrade(
  pool: pg.Pool,
  templateName: string,
  agentId?: number,
): Promise<{ agent: AgentWithRag; preview: AgentTemplateUpgradePreview }> {
  const context = await loadAgentTemplateUpgradeContext(pool, templateName, agentId);
  const preview = upgradePreviewFromContext(context);
  if (!preview.upgradeAvailable) {
    throw new AgentTemplateInstallError(`Agent preset “${context.template.label}” is already up to date`, 409);
  }
  if (preview.conflicts.length > 0) {
    throw new AgentTemplateInstallError(
      `Preset upgrade conflicts with local changes: ${preview.conflicts.map(diff => diff.field).join(', ')}`,
      409,
    );
  }

  const skillResult = context.target.skillNames.length
    ? await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM mcp_skills WHERE name=ANY($1::text[])
         ORDER BY array_position($1::text[], name)`,
        [context.target.skillNames],
      )
    : { rows: [] as Array<{ id: number; name: string }> };
  const foundSkills = new Set(skillResult.rows.map(skill => skill.name));
  const missingSkills = context.target.skillNames.filter(name => !foundSkills.has(name));
  if (missingSkills.length > 0) {
    throw new AgentTemplateInstallError(`Required preset skills are unavailable: ${missingSkills.join(', ')}`, 409);
  }

  const target = context.target;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE mcp_agents SET
         label=$1, description=$2, temperature=$3, max_tokens=$4,
         system_prompt=$5, agent_role=$6, composite_id=$7, gitea_project=$8,
         max_iterations=$9, agent_mode=$10, task_type=$11, allowed_paths=$12,
         bitbucket_repo=$13, thinking_budget=$14,
         untrusted_tool_output_enforcement=$15, codegraph_enabled=$16,
         visibility=$17, min_role=$18, risk_level=$19,
         human_oversight_required=$20
       WHERE id=$21`,
      [
        target.label, target.description, target.temperature, target.maxTokens,
        target.systemPrompt, target.agentRole, context.compositeId, target.giteaProject,
        target.maxIterations, target.agentMode, target.taskType, target.allowedPaths,
        target.bitbucketRepo, target.thinkingBudget,
        target.untrustedToolOutputEnforcement, target.codegraphEnabled,
        target.visibility, target.minRole, target.riskLevel,
        target.humanOversightRequired, context.agent.id,
      ],
    );
    await replaceAgentSkills(client,context.agent.id,skillResult.rows.map(skill=>skill.id));
    await client.query(
      `UPDATE mcp_agent_template_installations
          SET installed_version=$2, applied_snapshot=$3::jsonb, upgraded_at=now()
        WHERE agent_id=$1 AND template_name=$4`,
      [context.agent.id, context.template.version, JSON.stringify(target), context.template.name],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const agent = await getAgent(pool, context.agent.id);
  if (!agent) throw new Error('Upgraded Agent could not be reloaded');
  return { agent, preview };
}

export async function installAgentTemplate(
  pool: pg.Pool,
  templateName: string,
  value: string | AgentTemplateInstallInput,
  createdBy?: number,
  options: AgentTemplateInstallOptions = {},
): Promise<AgentWithRag> {
  const allowMultiple = options.allowMultiple === true;
  const selection = await resolveTemplateSelection(pool, templateName, value, !allowMultiple);
  const { template } = selection;
  if (options.allowedBundleIds != null) {
    const allowed = [...new Set(options.allowedBundleIds.filter(id => Number.isSafeInteger(id) && id > 0))];
    if (allowed.length === 0) {
      throw new AgentTemplateInstallError('No MCP bundles are assigned to your account', 403);
    }
    const unauthorized = selection.bundleIds.filter(id => !allowed.includes(id));
    if (unauthorized.length > 0) {
      throw new AgentTemplateInstallError('One or more selected MCP bundles are outside your access scope', 403);
    }
    if (selection.bundleIds.length === 0) selection.bundleIds = allowed;
  }
  if (options.allowedAgentModes && !options.allowedAgentModes.includes(template.agentMode)) {
    throw new AgentTemplateInstallError('This starter is not available in the onboarding flow', 400);
  }

  if (allowMultiple) {
    const visibleAgentClause = options.visibleAgentIds ? ' AND agent.id=ANY($3::int[])' : '';
    const existingResult = await pool.query<{ id: number }>(
      `SELECT agent.id
         FROM mcp_agents agent
         LEFT JOIN mcp_agent_template_installations installation
           ON installation.agent_id=agent.id AND installation.template_name=$1
        WHERE agent.model=$2
          AND agent.enabled=true
          AND (installation.template_name IS NOT NULL OR agent.name=$1)${visibleAgentClause}
        ORDER BY agent.id
        LIMIT 1`,
      options.visibleAgentIds
        ? [template.name, selection.model, options.visibleAgentIds]
        : [template.name, selection.model],
    );
    if (existingResult.rows[0]) {
      const existing = await getAgent(pool, Number(existingResult.rows[0].id));
      if (existing) return existing;
    }
    if (!selection.agentName && template.installed) {
      selection.agentName = await nextStarterVariantName(pool, template.name, selection.model);
    }
  }

  const config = template.config;
  const input = buildTemplateAgentInput(selection);

  let createdId: number | null = null;
  try {
    const created = await createAgent(pool, input, createdBy);
    createdId = created.id;
    if (template.skillNames.length > 0) {
      const skillResult = await pool.query<{ id: number; name: string }>(
        `SELECT id, name FROM mcp_skills WHERE name=ANY($1::text[])
         ORDER BY array_position($1::text[], name)`,
        [template.skillNames],
      );
      await setAgentSkills(pool, created.id, skillResult.rows.map(skill => skill.id));
    }
    await pool.query(
      `UPDATE mcp_agents
          SET risk_level=$2, human_oversight_required=$3
        WHERE id=$1`,
      [created.id, config.riskLevel ?? 'low', config.humanOversightRequired ?? false],
    );
    const installed = await getAgent(pool, created.id);
    if (!installed) throw new Error('Installed agent could not be reloaded');
    await pool.query(
      `INSERT INTO mcp_agent_template_installations
         (agent_id, template_name, installed_version, applied_snapshot)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (agent_id) DO UPDATE SET
         template_name=EXCLUDED.template_name,
         installed_version=EXCLUDED.installed_version,
         applied_snapshot=EXCLUDED.applied_snapshot,
         installed_at=now(),
         upgraded_at=NULL`,
      [created.id, template.name, template.version, JSON.stringify(templateManagedSnapshot(template))],
    );
    return installed;
  } catch (error) {
    if (createdId != null) await pool.query('DELETE FROM mcp_agents WHERE id=$1', [createdId]).catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      throw new AgentTemplateInstallError(`Agent “${template.label}” is already installed`, 409);
    }
    throw error;
  }
}
