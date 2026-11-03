import { codingWorkflow } from './workflows/coding.js';
import { pullRequestReviewWorkflow } from './workflows/prReview.js';
import { ciFailureRecoveryWorkflow } from './workflows/ciRecovery.js';
import { securityRemediationWorkflow } from './workflows/securityRemediation.js';
import { releaseNotesWorkflow } from './workflows/releaseNotes.js';
import { backlogGroomingWorkflow } from './workflows/backlogGrooming.js';
import {
  getWorkflowDefinition,
  getWorkflowDefinitionByGraphId,
  workflowCatalog,
  registerDynamicWorkflowDefinition,
  type WorkflowCatalogEntry,
} from './workflowCatalog.js';

type WorkflowGraph = Pick<typeof codingWorkflow, 'getState' | 'getStateHistory' | 'invoke' | 'updateState'>;
export interface RegisteredWorkflow extends WorkflowCatalogEntry {
  graph: WorkflowGraph;
}

const graphs: Record<string, WorkflowGraph> = {
  coding_workflow: codingWorkflow,
  coding_image_workflow: codingWorkflow,
  coding_follow_up_image_workflow: codingWorkflow,
  pull_request_review: pullRequestReviewWorkflow as WorkflowGraph,
  ci_failure_recovery: ciFailureRecoveryWorkflow as WorkflowGraph,
  security_remediation: securityRemediationWorkflow as WorkflowGraph,
  release_notes: releaseNotesWorkflow as WorkflowGraph,
  backlog_grooming: backlogGroomingWorkflow as WorkflowGraph,
};

export function registerVisualWorkflow(definition: WorkflowCatalogEntry, graph: WorkflowGraph): void {
  registerDynamicWorkflowDefinition(definition);
  graphs[definition.graphId] = graph;
}

function registered(definition: WorkflowCatalogEntry | undefined): RegisteredWorkflow | undefined {
  if (!definition) return undefined;
  const graph = graphs[definition.graphId];
  return graph ? { ...definition, graph } : undefined;
}

export function listRegisteredWorkflows(): RegisteredWorkflow[] {
  return workflowCatalog().map(definition => registered(definition)).filter((value): value is RegisteredWorkflow => Boolean(value));
}

export function getWorkflow(workflowId: string): RegisteredWorkflow | undefined {
  return registered(getWorkflowDefinition(workflowId));
}

export function getWorkflowByGraphId(graphId: string): RegisteredWorkflow | undefined {
  return registered(getWorkflowDefinitionByGraphId(graphId));
}

export { DEFAULT_GRAPH_ID, DEFAULT_WORKFLOW_ID, workflowRunTitle } from './workflowCatalog.js';
