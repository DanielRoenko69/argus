/** Coding graphs whose human Git approvals require a fresh Core-bound grant. */
const GIT_BROKER_CODING_GRAPHS = new Set([
  'coding_workflow',
  'coding_image_workflow',
  'coding_follow_up_image_workflow',
]);

export function isGitBrokerCodingGraph(graphId: unknown): boolean {
  return typeof graphId === 'string' && GIT_BROKER_CODING_GRAPHS.has(graphId);
}
