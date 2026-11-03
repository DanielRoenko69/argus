import { describe, expect, it } from 'vitest';
import type { Node } from 'reactflow';
import {
  buildSavePayload,
  reconcileWorkflowAgentRequirements,
  restoreFromFlow,
  serializeStepArgs,
  type FlowState,
  type WorkflowAgentRequirement,
} from '../workflows';

describe('workflow step argument serialization', () => {
  it('moves Knowledge picker fields into step.args while preserving nested query settings', () => {
    const nodes: Node[] = [{
      id: 'argus.knowledge.1',
      type: 'argus.knowledge',
      position: { x: 10, y: 20 },
      data: {
        label: 'Search runbooks',
        index_name: 'platform-runbooks',
        args: { query: '{{ input.question }}', top_k: 7 },
      },
    }];

    const payload = buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 });

    expect(payload.steps[0]).toMatchObject({
      id: 'argus.knowledge.1',
      type: 'argus.knowledge',
      args: {
        index_name: 'platform-runbooks',
        query: '{{ input.question }}',
        top_k: 7,
      },
    });
  });

  it('serializes other executor arguments that the properties panel stores flat', () => {
    expect(serializeStepArgs({
      label: 'Wait',
      seconds: 12,
      operation: 'retrieve',
      target_workflow_id: 42,
      args: { query: 'canonical', seconds: 9 },
      query: 'stale-flat-value',
    })).toEqual({
      seconds: 9,
      operation: 'retrieve',
      target_workflow_id: 42,
      query: 'canonical',
    });
  });

  it('keeps function code as step metadata instead of leaking it into args', () => {
    const nodes: Node[] = [{
      id: 'logic.function.1',
      type: 'logic.function',
      position: { x: 0, y: 0 },
      data: {
        label: 'Transform',
        function_code: 'return input;',
        args: {},
      },
    }];

    const step = buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 }).steps[0];
    expect(step?.function_code).toBe('return input;');
    expect(step?.args).toEqual({});
  });

  it('round-trips a resolved portable tool binding without sending it as tool arguments', () => {
    const toolBinding = {
      integration_id: 'github',
      action_hints: ['get_issue'],
      access: 'read' as const,
      required_parameters: ['owner', 'repo', 'issue_number'],
    };
    const nodes: Node[] = [{
      id: 'read_issue',
      type: 'argus.tool',
      position: { x: 0, y: 0 },
      data: {
        label: 'Read issue',
        tool: 'github_product_get_issue',
        tool_binding: toolBinding,
        integration_id: 'github',
        args: { owner: 'argus', repo: 'core', issue_number: 42 },
      },
    }];

    const payload = buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 });
    expect(payload.steps[0]).toMatchObject({
      tool: 'github_product_get_issue',
      integration_id: 'github',
      tool_binding: toolBinding,
      args: { owner: 'argus', repo: 'core', issue_number: 42 },
    });
    expect(payload.steps[0]?.args).not.toHaveProperty('tool_binding');

    const flow: FlowState = {
      id: 200, name: 'triage', description: '', input_params: [], enabled: true,
      steps: payload.steps, canvas_state: {}, trigger_config: {}, block_definitions: [],
      source: 'visual', updated_at: '',
    };
    expect(restoreFromFlow(flow).nodes[0]?.data).toMatchObject({ integration_id: 'github', tool_binding: toolBinding });
  });

  it('persists Router configuration as portable step arguments', () => {
    const nodes: Node[] = [{
      id: 'route', type: 'logic.router', position: { x: 0, y: 0 },
      data: {
        label: 'Route request',
        route_on: '{{ input.intent }}',
        routes: '{"implement":"coder","explain":"planner"}',
        default_route: 'planner',
        args: {},
      },
    }];

    expect(buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 }).steps[0]).toMatchObject({
      type: 'logic.router',
      args: {
        route_on: '{{ input.intent }}',
        routes: '{"implement":"coder","explain":"planner"}',
        default_route: 'planner',
      },
    });
  });

  it('reconstructs an editable canvas for executable workflows without stored blocks', () => {
    const flow: FlowState = {
      id: 145,
      name: 'agent_contract_trace_smoke',
      description: '',
      steps: [{
        id: 'plan',
        label: 'Planner trace smoke',
        type: 'argus.agent',
        agent_role: 'planner',
        args: { prompt: 'Reply with exactly: ARGUS_ROLE_TRACE_OK' },
      }],
      input_params: [],
      canvas_state: {},
      trigger_config: {},
      block_definitions: [],
      source: 'manual',
      enabled: true,
      updated_at: '2026-08-20T10:00:00.000Z',
    };

    const restored = restoreFromFlow(flow);

    expect(restored.nodes).toHaveLength(1);
    expect(restored.nodes[0]).toMatchObject({
      id: 'plan',
      type: 'argus.agent',
      position: { x: 96, y: 96 },
      data: {
        label: 'Planner trace smoke',
        agent_role: 'planner',
        args: { prompt: 'Reply with exactly: ARGUS_ROLE_TRACE_OK' },
      },
    });
  });

  it('persists a portable Agent role as step metadata', () => {
    const nodes: Node[] = [{
      id: 'argus.agent.coder',
      type: 'argus.agent',
      position: { x: 0, y: 0 },
      data: {
        label: 'Implement',
        agent_id: 42,
        agent_role: 'coder',
        output_contract: 'implementation_evidence',
        output_contract_retries: 2,
        args: { prompt: 'Implement the ticket' },
      },
    }];

    const payload = buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 });
    const step = payload.steps[0];
    expect(step).toMatchObject({
      agent_role: 'coder',
      output_contract: 'implementation_evidence',
      output_contract_retries: 2,
    });
    expect(step).not.toHaveProperty('agent_id');
    expect(step?.args).toEqual({ prompt: 'Implement the ticket' });
    expect(payload.block_definitions[0]?.data).toMatchObject({ agent_role: 'coder' });
    expect(payload.block_definitions[0]?.data).not.toHaveProperty('agent_id');
  });

  it('restores structured Agent handoff settings onto the editable canvas', () => {
    const flow: FlowState = {
      id: 197, name: 'structured-chain', description: '', input_params: [], enabled: true,
      steps: [{
        id: 'review', label: 'Review', type: 'argus.agent', agent_role: 'reviewer',
        output_contract: 'review_verdict', output_contract_retries: 1, args: { prompt: 'Review' },
      }],
      canvas_state: {}, trigger_config: {}, block_definitions: [], source: 'manual', updated_at: '',
    };

    expect(restoreFromFlow(flow).nodes[0]?.data).toMatchObject({
      output_contract: 'review_verdict',
      output_contract_retries: 1,
    });
  });

  it('reconciles role changes with the saved portable Agent contract', () => {
    const existing: WorkflowAgentRequirement[] = [{
      role: 'planner',
      label: 'Delivery planner',
      stepIds: ['old-plan'],
      agentName: 'senior_planner',
      allowedModes: ['worker'],
      requiredSkillNames: ['planning'],
      requiredToolPatterns: ['github_*'],
      minimumBundleCount: 1,
    }, {
      role: 'knowledge',
      label: 'Supporting knowledge role',
      stepIds: [],
      allowedModes: ['worker'],
      requiredSkillNames: [],
      requiredToolPatterns: [],
      minimumBundleCount: 0,
    }];
    const nodes: Node[] = [{
      id: 'new-plan', type: 'argus.agent', position: { x: 0, y: 0 },
      data: { label: 'Plan', agent_role: 'planner' },
    }, {
      id: 'review', type: 'argus.agent', position: { x: 200, y: 0 },
      data: { label: 'Review', agent_role: 'reviewer' },
    }];

    expect(reconcileWorkflowAgentRequirements(nodes, existing)).toEqual([
      expect.objectContaining({
        role: 'planner', label: 'Delivery planner', stepIds: ['new-plan'],
        agentName: 'senior_planner', requiredSkillNames: ['planning'],
      }),
      expect.objectContaining({ role: 'knowledge', stepIds: [] }),
      expect.objectContaining({
        role: 'reviewer', stepIds: ['review'],
        allowedModes: ['chat', 'worker', 'reviewer'],
      }),
    ]);
  });

  it('removes stale role bindings when a step is pinned to a concrete Agent', () => {
    const existing: WorkflowAgentRequirement[] = [{
      role: 'coder', label: 'Coder', stepIds: ['implement'],
      allowedModes: ['worker'], requiredSkillNames: [], requiredToolPatterns: [], minimumBundleCount: 0,
    }];
    const nodes: Node[] = [{
      id: 'implement', type: 'argus.agent', position: { x: 0, y: 0 },
      data: { label: 'Implement', agent_id: 42, agent_role: null },
    }];

    const payload = buildSavePayload(nodes, [], { x: 0, y: 0, zoom: 1 }, existing);

    expect(payload.agent_requirements).toEqual([]);
    expect(payload.steps[0]).toMatchObject({ agent_id: 42 });
    expect(payload.steps[0]).not.toHaveProperty('agent_role');
  });
});
