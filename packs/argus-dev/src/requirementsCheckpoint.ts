import { interrupt } from '@langchain/langgraph';
import type { WorkflowState } from './state.js';
import { validateRequirementsReply } from './developmentContract.js';
import { decisionRequest, validateDecisionReply } from './developmentDecisions.js';

export async function requirementsInputNode(state: typeof WorkflowState.State) {
  if (state.development_contract_version === 2) {
    const decision = decisionRequest(state);
    const text = validateDecisionReply(interrupt({ stage: 'requirements_input', decision,
      message: decision.title, blockers: state.workflow_blockers }), decision);
    return { operator_clarifications: [{ decisionId: decision.id, text }], workflow_blockers: [], development_findings: [],
      ...(state.technical_design_policy_version === 1 ? {
        // Even unchanged implementation choices need rechecking against a changed requirement basis.
        technical_decisions: state.technical_decisions.map(d => ({ ...d, status: 'proposed' as const, reviewEvidence: [] })),
        technical_resolution_evidence: [],
        technical_design_history: [{ phase: 'clarification', decisionId: decision.id, invalidatedDecisionIds: state.technical_decisions.map(d => d.id) }],
      } : {}),
      design_feedback: '', design_refinement_pending: false, qa_test_plan: '',
      log: [{ step: 'requirements_input', summary: 'Version-bound clarification recorded; no permission or delivery approval granted.' }] };
  }
  const requirements = validateRequirementsReply(interrupt({ stage: 'requirements_input',
    message: 'Resolve the missing requirements or environment prerequisites. This is not a code approval.',
    blockers: state.workflow_blockers }));
  return { description: state.description.replace(/<[^>]*(?:hier|insert|paste)[^>]*(?:plan|handoff|übergabe|auftrag)[^>]*>/gi, '')
      + '\n\nOperator clarification (does not widen allowed paths or approve delivery):\n' + requirements,
    workflow_blockers: [], log: [{ step: 'requirements_input', summary: 'Operator supplied clarification; requirements will be re-evaluated.' }] };
}
