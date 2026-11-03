import assert from 'node:assert/strict';
import test from 'node:test';
import { StateGraph, START, END } from '@langchain/langgraph';
import { WorkflowState } from './state.js';

test('LangGraph retains the Core-signed retry workspace channel', async () => {
  const root = '/workspace/GEM-182-retry-a41d3d4c-e496-4e51-bb5b-40cd08cfb33f';
  const graph = new StateGraph(WorkflowState)
    .addNode('probe', state => ({ workspace_dir: state.argus_workspace_root }))
    .addEdge(START, 'probe').addEdge('probe', END).compile();
  const result = await graph.invoke({ argus_workspace_root: root });
  assert.equal(result.workspace_dir, root);
  assert.equal(result.argus_workspace_root, root);
});
