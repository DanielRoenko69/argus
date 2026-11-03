import test from 'node:test';
import assert from 'node:assert/strict';
import { StateGraph, MemorySaver, START, END, Command } from '@langchain/langgraph';
import { WorkflowState } from './state.js';
import { requirementsInputNode } from './requirementsCheckpoint.js';

test('real LangGraph checkpoint pauses without retry or approval and preserves authority on resume', async () => {
  const graph = new StateGraph(WorkflowState).addNode('requirements_input', requirementsInputNode)
    .addEdge(START, 'requirements_input').addEdge('requirements_input', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'requirements-fixture' } };
  await graph.invoke({ description: '<Hier den Planning-Auftrag einfügen>', workflow_blockers: ['Missing scope'],
    allowed_files: 'src/new.py\ntests/test_new.py', argus_bundle_ids: [7], retry_count: 0 }, config);
  const paused = await graph.getState(config);
  assert.deepEqual(paused.next, ['requirements_input']);
  assert.equal(paused.values.retry_count, 0);
  assert.equal(paused.values.human_approved, false);
  await graph.invoke(new Command({ resume: { requirements: 'Use the documented numeric contract.' } }), config);
  const resumed = await graph.getState(config);
  assert.match(resumed.values.description, /documented numeric/);
  assert.deepEqual(resumed.values.workflow_blockers, []);
  assert.equal(resumed.values.allowed_files, 'src/new.py\ntests/test_new.py');
  assert.deepEqual(resumed.values.argus_bundle_ids, [7]);
  assert.equal(resumed.values.human_approved, false);
  assert.equal(resumed.values.pr_approved, false);
  assert.equal(resumed.values.retry_count, 0);
});
