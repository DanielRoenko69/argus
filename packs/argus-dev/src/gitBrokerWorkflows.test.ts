import test from 'node:test';
import assert from 'node:assert/strict';
import { isGitBrokerCodingGraph } from './gitBrokerWorkflows.js';

test('the original and follow-up coding graphs require brokered human Git approvals', () => {
  for (const graphId of ['coding_workflow', 'coding_image_workflow', 'coding_follow_up_image_workflow']) {
    assert.equal(isGitBrokerCodingGraph(graphId), true);
  }
  for (const graphId of ['pull_request_review', 'visual_workflow', '', null]) {
    assert.equal(isGitBrokerCodingGraph(graphId), false);
  }
});
