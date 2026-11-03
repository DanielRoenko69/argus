import { describe, expect, it } from '@jest/globals';
import { applyWorkflowAgentAssignments } from '../agentContracts.js';
import { validateWorkflowSteps } from '../builderRoutes.js';
import { executeWorkflow, type StepRunners } from '../executor.js';
import type {
  ToolRunner,
  WorkflowAgentAssignment,
  WorkflowAgentPreflight,
  WorkflowAgentRequirement,
  WorkflowRow,
} from '../types.js';

const requirements: WorkflowAgentRequirement[] = [
  {
    role: 'planner', label: 'Delivery planner', stepIds: ['plan'],
    allowedModes: ['chat', 'worker'], requiredSkillNames: [],
    requiredToolPatterns: [], minimumBundleCount: 0,
  },
  {
    role: 'coder', label: 'Workspace implementation', stepIds: ['implement'],
    allowedModes: ['worker'], requiredSkillNames: [],
    requiredToolPatterns: ['workspace_read', 'workspace_write'], minimumBundleCount: 0,
  },
  {
    role: 'reviewer', label: 'Read-only implementation review', stepIds: ['review'],
    allowedModes: ['reviewer', 'worker'], requiredSkillNames: [],
    requiredToolPatterns: [], minimumBundleCount: 0,
  },
];

function portableWorkflow(): WorkflowRow {
  return {
    id: 197,
    name: 'governed_agent_delivery',
    description: 'Portable Planner -> Coder -> Reviewer reference flow',
    input_params: [{ name: 'task', type: 'string', description: 'Task', required: true }],
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
    agent_requirements: requirements,
    steps: [
      { id: 'start', label: 'Manual task', type: 'trigger.manual', args: {} },
      {
        id: 'plan', label: 'Plan delivery', type: 'argus.agent', agent_role: 'planner',
        output_contract: 'planner_plan', output_contract_retries: 1,
        args: { prompt: 'Plan this task:\n{{ input.task }}' }, depends_on: ['start'],
      },
      {
        id: 'implement', label: 'Implement task', type: 'argus.agent', agent_role: 'coder',
        output_contract: 'implementation_evidence', output_contract_retries: 1,
        args: { prompt: 'Task: {{ input.task }}\nPlan: {{ steps.plan.result }}' }, depends_on: ['plan'],
      },
      {
        id: 'review', label: 'Review evidence', type: 'argus.agent', agent_role: 'reviewer',
        output_contract: 'review_verdict', output_contract_retries: 1,
        args: {
          prompt: 'Task: {{ input.task }}\nPlan: {{ steps.plan.result }}\nImplementation: {{ steps.implement.result }}',
        },
        depends_on: ['implement'],
      },
      {
        id: 'response', label: 'Delivery result', type: 'logic.response',
        args: { value: '{{ steps.review.result }}' }, depends_on: ['review'],
      },
    ],
  };
}

function assignment(
  role: string,
  stepId: string,
  agentId: number,
  mode: WorkflowAgentAssignment['agentMode'],
): WorkflowAgentAssignment {
  return {
    role,
    label: role,
    stepIds: [stepId],
    status: 'ready',
    agentId,
    agentName: role,
    agentLabel: role,
    agentMode: mode,
    model: 'test-model',
    presetName: null,
    installedPresetVersion: null,
    requiredPresetVersion: null,
    skillNames: [],
    bundleIds: [],
    toolNames: role === 'coder' ? ['workspace_read', 'workspace_write'] : ['workspace_read'],
    runtime: null,
    catalogFingerprint: `${role}-catalog`,
    blockers: [],
    warnings: [],
  };
}

describe('governed visual Agent-chain reference workflow', () => {
  it('passes task, plan and implementation evidence through a cost-free mock execution', async () => {
    const portable = portableWorkflow();
    expect(validateWorkflowSteps(portable.steps)).toMatchObject({ valid: true, errors: [] });
    expect(portable.steps.filter(step => step.type === 'argus.agent').every(step => step.agent_id == null)).toBe(true);

    const preflight: WorkflowAgentPreflight = {
      workflowId: portable.id,
      workflowName: portable.name,
      checkedAt: '2026-08-20T12:00:00.000Z',
      ready: true,
      inferredLegacyContract: false,
      contractFingerprint: 'contract-197',
      blockers: [],
      warnings: [],
      assignments: [
        assignment('planner', 'plan', 11, 'chat'),
        assignment('coder', 'implement', 12, 'worker'),
        assignment('reviewer', 'review', 13, 'reviewer'),
      ],
    };
    const resolved = applyWorkflowAgentAssignments(portable, preflight);
    expect(resolved.steps.find(step => step.id === 'plan')).toMatchObject({ agent_id: 11, agent_role: 'planner' });
    expect(resolved.steps.find(step => step.id === 'implement')).toMatchObject({ agent_id: 12, agent_role: 'coder' });
    expect(resolved.steps.find(step => step.id === 'review')).toMatchObject({ agent_id: 13, agent_role: 'reviewer' });

    const calls: Array<{ agentId: number; prompt: string; contract?: unknown }> = [];
    const replies = new Map<number, string>([
      [11, JSON.stringify({
        summary: 'Update the service and test it',
        steps: ['Add the endpoint', 'Add a regression test'],
        validation: ['npm test'], risks: [], assumptions: [],
      })],
      [12, JSON.stringify({
        summary: 'Implemented the endpoint and regression test',
        changed_files: [{ path: 'src/service.ts' }, { path: 'test/service.test.ts' }],
        validation: [{ command: 'npm test', status: 'passed', evidence: '12 tests passed' }],
        notes: [],
      })],
    ]);
    let reviewAttempts = 0;
    const runners: StepRunners = {
      agentRunner: async (agentId, prompt, args) => {
        calls.push({ agentId, prompt, contract: args.__argus_output_contract });
        if (agentId === 13) {
          reviewAttempts += 1;
          return reviewAttempts === 1
            ? 'APPROVE without structured evidence'
            : JSON.stringify({
                verdict: 'APPROVE',
                summary: 'Task, plan and implementation evidence are consistent.',
                findings: [], required_changes: [],
              });
        }
        return replies.get(agentId) ?? 'unexpected Agent';
      },
    };
    const noopToolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: '' }] });
    const result = await executeWorkflow({
      workflow: resolved,
      inputs: { task: 'Add a health endpoint' },
      toolRunner: noopToolRunner,
      runners,
      executionId: 197,
      triggeredBy: 'mock-e2e',
    });

    expect(result.status).toBe('completed');
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ agentId: 11, contract: 'planner_plan' });
    expect(calls[0]?.prompt).toContain('Plan this task:\nAdd a health endpoint');
    expect(calls[0]?.prompt).toContain('ARGUS STRUCTURED OUTPUT CONTRACT (planner_plan)');
    expect(calls[1]).toMatchObject({ agentId: 12, contract: 'implementation_evidence' });
    expect(calls[1]?.prompt).toContain('"summary":"Update the service and test it"');
    expect(calls[2]).toMatchObject({ agentId: 13, contract: 'review_verdict' });
    expect(calls[2]?.prompt).toContain('"changed_files"');
    expect(calls[3]?.prompt).toContain("previous response was rejected by Argus");
    expect(calls[3]?.prompt).toContain('response does not contain a valid JSON object');
    expect(result.stepResults.review?.result).toMatchObject({ verdict: 'APPROVE' });
    expect(result.stepResults.response?.result).toEqual(result.stepResults.review?.result);
  });

  it('fails closed after the configured contract retry budget is exhausted', async () => {
    const workflow = portableWorkflow();
    workflow.steps = [{
      id: 'review', label: 'Review', type: 'argus.agent', agent_id: 13,
      output_contract: 'review_verdict', output_contract_retries: 1,
      args: { prompt: 'Review this evidence' },
    }];
    let calls = 0;
    const result = await executeWorkflow({
      workflow,
      inputs: {},
      toolRunner: async () => ({ content: [] }),
      runners: { agentRunner: async () => { calls += 1; return 'not json'; } },
      executionId: 198,
      triggeredBy: 'contract-failure-test',
    });

    expect(calls).toBe(2);
    expect(result.status).toBe('failed');
    expect(result.stepResults.review?.error).toContain("failed after 2 attempts");
  });
});
