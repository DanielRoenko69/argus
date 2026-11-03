import 'dotenv/config';
import pg from 'pg';
import { preflightWorkflowAgents } from '../workflows/agentContracts.js';
import type { WorkflowAgentRequirement, WorkflowInputParam, WorkflowRow, WorkflowStep } from '../workflows/types.js';

const TEMPLATE_NAME = 'tpl_governed_agent_delivery';
const EXPECTED_ROLES = ['planner', 'coder', 'reviewer'];
const EXPECTED_OUTPUT_CONTRACTS = new Map([
  ['plan', 'planner_plan'],
  ['implement', 'implementation_evidence'],
  ['review', 'review_verdict'],
]);

interface TemplateRow extends pg.QueryResultRow {
  id: number;
  name: string;
  description: string;
  steps: WorkflowStep[];
  input_params: WorkflowInputParam[];
  enabled: boolean;
  agent_requirements: WorkflowAgentRequirement[];
}

async function main(): Promise<void> {
  const probeRuntime = process.argv.includes('--probe-runtime');
  const connectionString = process.env['POSTGRES_CONNECTION_URL'];
  if (!connectionString) {
    throw new Error('POSTGRES_CONNECTION_URL is required. Run this command with the configured Argus environment.');
  }

  const pool = new pg.Pool({ connectionString });
  try {
    const { rows } = await pool.query<TemplateRow>(
      `SELECT id, name, description, steps, input_params, enabled, agent_requirements
         FROM mcp_workflows
        WHERE name=$1 AND source='template'`,
      [TEMPLATE_NAME],
    );
    const template = rows[0];
    if (!template) throw new Error(`Workflow template '${TEMPLATE_NAME}' is not installed`);

    const declaredRoles = template.agent_requirements.map(requirement => requirement.role).sort();
    const missingRoles = EXPECTED_ROLES.filter(role => !declaredRoles.includes(role));
    if (missingRoles.length > 0) {
      throw new Error(`Workflow template is missing required Agent roles: ${missingRoles.join(', ')}`);
    }
    for (const [stepId, outputContract] of EXPECTED_OUTPUT_CONTRACTS) {
      const step = template.steps.find(candidate => candidate.id === stepId);
      if (step?.output_contract !== outputContract) {
        throw new Error(`Workflow step '${stepId}' must use output contract '${outputContract}'`);
      }
    }

    const workflow: WorkflowRow = {
      ...template,
      bundle_ids: [],
      created_by: null,
      created_at: '',
      updated_at: '',
    };
    const preflight = await preflightWorkflowAgents(pool, workflow, { probeRuntime });
    const report = {
      template: template.name,
      steps: template.steps.length,
      inputParameters: template.input_params.map(parameter => parameter.name),
      outputContracts: Object.fromEntries(template.steps
        .filter(step => step.output_contract)
        .map(step => [step.id, step.output_contract])),
      runtimeProbe: probeRuntime,
      ready: preflight.ready,
      blockers: preflight.blockers,
      warnings: preflight.warnings,
      assignments: preflight.assignments.map(assignment => ({
        role: assignment.role,
        status: assignment.status,
        agent: assignment.agentName,
        mode: assignment.agentMode,
        model: assignment.model,
        runtime: assignment.runtime == null ? null : {
          type: assignment.runtime.type,
          state: assignment.runtime.state,
          detail: assignment.runtime.detail,
        },
        workspaceTools: assignment.toolNames.filter(name => name.startsWith('workspace_')).sort(),
        blockers: assignment.blockers,
        warnings: assignment.warnings,
      })),
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!preflight.ready) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
