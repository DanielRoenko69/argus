/** This opt-in workflow records that automated tests were deliberately skipped. */
export const IMAGE_REVIEW_WORKFLOW_ID = 'ticket-to-image-pull-request';
export const IMAGE_REVIEW_GRAPH_ID = 'coding_image_workflow';

/** Review-only skips execution, never ticket-authorized regression-test files. */
export const REVIEW_ONLY_TEST_POLICY = 'Automated tests are not executed in this workflow. When the ticket explicitly requests regression tests within authorized paths, plan and author them alongside the implementation. The Reviewer inspects code and test files, but nobody may claim the tests passed.';

export function isImageReviewDelivery(mode: unknown): boolean {
  return mode === IMAGE_REVIEW_WORKFLOW_ID;
}
