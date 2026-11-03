import type { SolutionPackWorkflowDefinition, SolutionPackWorkflowStage } from '../types';

export const developmentWorkflow: SolutionPackWorkflowDefinition = {
  id: 'ticket-to-pull-request', graphId: 'coding_workflow', label: 'Ticket to pull request',
  description: 'Governed development', tags: [], inputSchema: [], approvalGates: ['code_approval', 'functional_approval'],
  requiredAgents: ['planner', 'knowledge', 'coder', 'reviewer', 'researcher'], titleField: 'ticket_id',
  stages: ([
    ['setup_workspace', 'Workspace', 'Clone & reset', 'workspace'],
    ['planner', 'Plan', 'Planner agent', 'plan'],
    ['knowledge', 'Knowledge', 'RAG & patterns', 'knowledge'],
    ['test_design', 'QA design', 'Independent test cases', 'test'],
    ['design_refinement', 'Design clarification', 'Up to 2 internal rounds', 'plan'],
    ['technical_resolution', 'Technical investigation budget', 'Reserve one investigation', 'plan'],
    ['technical_investigation', 'Technical investigation', 'Read-only evidence, then independent QA', 'plan'],
    ['generation_plan', 'Generator plan', 'Reviewer · repository evidence', 'plan'],
    ['coder', 'Implement', 'Coder agent', 'code'],
    ['code_generation', 'Generate', 'Isolated repository generator · opt-in', 'code'],
    ['stack_environment', 'Test environment', 'Automatic isolated stack · opt-in', 'test'],
    ['tests', 'Tests', 'Fixture & suite', 'test'],
    ['qa_author', 'QA tests', 'Independent test authoring · opt-in', 'test'],
    ['qa_execute', 'QA acceptance', 'Isolated pytest evidence · opt-in', 'test'],
    ['reviewer', 'Review', 'Reviewer agent', 'review'],
    ['human_approval', 'Approval', 'Code gate', 'approval'],
    ['finalize_build', 'CI/CD handoff', 'Branch & push', 'delivery'],
    ['external_ci', 'CI/CD', 'Provider validation', 'delivery'],
    ['human_approval_pr', 'Approval', 'Functional gate', 'approval'],
    ['finalize_pr', 'Pull request', 'Final artifact', 'delivery'],
    ['requirements_input', 'Requirements', 'Resolve blockers', 'plan'],
  ] satisfies Array<[string, string, string, SolutionPackWorkflowStage['kind']]>).map(([id, label, hint, kind]) => ({ id, label, hint, kind })),
};

export const workspaceQaEvidence = { environmentPolicyVersion: 3, policyVersion: 1, codeGeneration: { policyVersion: 1 } };
