import type pg from 'pg';
import type { AgentCapabilityReadiness } from '../../agents/agentReadiness.js';
import type { AgentWithRag } from '../../agents/types.js';
import {
  applyWorkflowAgentAssignments,
  applyWorkflowAgentSnapshot,
  normalizeWorkflowAgentRequirements,
  preflightWorkflowAgents,
  workflowExecutionSnapshot,
  WorkflowAgentContractError,
} from '../agentContracts.js';
import type { WorkflowRow } from '../types.js';

const workflow = (requirements: WorkflowRow['agent_requirements'] = []): WorkflowRow => ({
  id: 7,
  name: 'portable_delivery',
  description: 'Portable delivery workflow',
  steps: [{ id: 'implement', label: 'Implement', type: 'argus.agent', agent_role: 'coder', args: {} }],
  input_params: [],
  enabled: true,
  created_by: null,
  created_at: '2026-08-19T10:00:00.000Z',
  updated_at: '2026-08-19T10:00:00.000Z',
  bundle_ids: [],
  agent_requirements: requirements,
});

const coder = {
  id: 42,
  name: 'argus_dev_coder',
  label: 'Argus Dev Coder',
  model: 'gpt-5.6-terra',
  agent_mode: 'worker',
  enabled: true,
  bundle_ids: [3],
  skills: [{ id: 2, name: 'typescript', label: 'TypeScript', icon: 'code', category: 'development', position: 1 }],
  rag_indexes: [],
  composite_name: null,
} as unknown as AgentWithRag;

const readiness = (toolNames = ['github_get_file', 'workspace_write']): AgentCapabilityReadiness => ({
  agentId: coder.id,
  agentName: coder.name,
  status: 'ready',
  ready: true,
  checkedAt: '2026-08-19T10:00:00.000Z',
  blockers: [],
  warnings: [],
  runtime: {
    type: 'codex', profileId: 4, profileName: 'codex-terra', profileLabel: 'Codex Terra',
    model: 'gpt-5.6-terra', state: 'ready', authenticated: true, activeRuns: 0,
    maxConcurrentRuns: 2, availableSlots: 2, detail: 'Ready',
  },
  bundles: [{ id: 3, name: 'github', label: 'GitHub', toolNames, backends: [], state: 'ready' }],
  tools: toolNames.map(name => ({ name, source: 'bundle' as const })),
  capabilities: {
    workspace: { available: true, toolCount: 1 },
    knowledge: { available: false, toolCount: 0 },
    subagents: { available: false, toolCount: 0 },
    codegraph: { available: false, toolCount: 0 },
  },
});

describe('Workflow Agent contracts', () => {
  it('rejects duplicate portable roles', () => {
    expect(() => normalizeWorkflowAgentRequirements([
      { role: 'coder', stepIds: [], allowedModes: ['worker'] },
      { role: 'coder', stepIds: [], allowedModes: ['worker'] },
    ])).toThrow(WorkflowAgentContractError);
  });

  it('resolves a preset role, binds the concrete Agent and restores it from the run snapshot', async () => {
    const requirement = normalizeWorkflowAgentRequirements([{
      role: 'coder', label: 'Coder', stepIds: ['implement'], presetName: 'argus-dev-coder',
      minimumPresetVersion: 2, allowedModes: ['worker'], requiredSkillNames: ['typescript'],
      requiredToolPatterns: ['github_*'], minimumBundleCount: 1,
    }]);
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 42, template_name: 'argus-dev-coder', installed_version: 3 }] }),
    } as unknown as pg.Pool;
    const result = await preflightWorkflowAgents(pool, workflow(requirement), {
      probeRuntime: false,
      agentLoader: async () => coder,
      readinessAssessor: async () => readiness(),
    });

    expect(result.ready).toBe(true);
    expect(result.assignments[0]).toMatchObject({ agentId: 42, status: 'ready', installedPresetVersion: 3 });
    expect(applyWorkflowAgentAssignments(workflow(requirement), result).steps[0]).toMatchObject({
      agent_id: 42,
      agent_role: 'coder',
    });
    const snapshot = workflowExecutionSnapshot(result);
    expect(applyWorkflowAgentSnapshot(workflow(requirement), snapshot).steps[0]).toMatchObject({
      agent_id: 42,
      agent_role: 'coder',
    });
    expect(snapshot).toMatchObject({ schemaVersion: 1, contractFingerprint: expect.any(String) });
  });

  it('blocks execution when a resolved Agent misses a required tool capability', async () => {
    const requirement = normalizeWorkflowAgentRequirements([{
      role: 'coder', stepIds: ['implement'], presetName: 'argus-dev-coder', allowedModes: ['worker'],
      requiredToolPatterns: ['github_create_pull_request'], minimumBundleCount: 1,
    }]);
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 42, template_name: 'argus-dev-coder', installed_version: 1 }] }),
    } as unknown as pg.Pool;
    const result = await preflightWorkflowAgents(pool, workflow(requirement), {
      agentLoader: async () => coder,
      readinessAssessor: async () => readiness(['github_get_file']),
    });

    expect(result.ready).toBe(false);
    expect(result.blockers).toContain("Agent 'argus_dev_coder' is missing required tool capability 'github_create_pull_request'");
  });

  it('infers existing agent_id steps as a legacy contract', async () => {
    const legacy = workflow([]);
    legacy.steps[0] = { ...legacy.steps[0]!, agent_role: undefined, agent_id: 42 };
    const pool = {
      query: jest.fn().mockResolvedValue({ rows: [{ id: 42, template_name: null, installed_version: null }] }),
    } as unknown as pg.Pool;
    const result = await preflightWorkflowAgents(pool, legacy, {
      agentLoader: async () => coder,
      readinessAssessor: async () => readiness(),
    });

    expect(result.ready).toBe(true);
    expect(result.inferredLegacyContract).toBe(true);
    expect(result.warnings[0]).toMatch(/Legacy agent_id bindings were inferred/);
  });
});
