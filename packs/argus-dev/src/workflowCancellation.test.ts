import assert from 'node:assert/strict';
import test from 'node:test';
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from '@langchain/langgraph';
import { CancellationUnconfirmedError, WorkflowCancellation, WorkflowCanceledError, assertWorkflowNotCanceled, confirmRuntimeStopped, hasPendingResult, registerWorkflowStop, runCooperatively, withWorkflowCancellation } from './workflowCancellation.js';

const schema = Annotation.Root({ count: Annotation<number>({ reducer: (_a, b) => b, default: () => 0 }) });

test('cooperative supersteps preserve state, loops and real human approval/resume', async () => {
  let writes = 0;
  const graph = new StateGraph(schema)
    .addNode('plan', s => ({ count: s.count + 1 }))
    .addNode('approve', () => { const ok = interrupt('human approval'); return { count: ok ? 10 : 0 }; })
    .addNode('deliver', () => { writes++; return {}; })
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', s => s.count < 2 ? 'plan' : 'approve')
    .addEdge('approve', 'deliver').addEdge('deliver', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'human' }, interruptAfter: '*' as const };
  const control = new WorkflowCancellation();
  const run = (input: any) => runCooperatively({ control, isCancellationRequested: async () => false,
    invoke: async first => { await graph.invoke(first ? input : null, config); }, snapshot: () => graph.getState(config) });
  const paused = await run({});
  assert.equal(writes, 0);
  assert.equal(paused.tasks[0]?.interrupts?.length, 1);
  assert.equal(paused.values.count, 2);
  const finished = await run(new Command({ resume: true }));
  assert.equal(writes, 1);
  assert.equal(finished.values.count, 10);
  assert.deepEqual(finished.next, []);
});

test('cancel stops only the scoped worker, waits for its receipt and forbids the next node', async () => {
  const control = new WorkflowCancellation();
  const other = new WorkflowCancellation();
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let stopped = 0, unrelatedStops = 0, following = 0, done = false;
  await withWorkflowCancellation(other, async () => { registerWorkflowStop(async () => { unrelatedStops++; }); });
  const graph = new StateGraph(schema)
    .addNode('worker', async () => {
      const unregister = registerWorkflowStop(async () => { stopped++; });
      entered();
      try { await pending; assertWorkflowNotCanceled(); return {}; } finally { unregister(); }
    })
    .addNode('never', () => { following++; return {}; })
    .addEdge(START, 'worker').addEdge('worker', 'never').addEdge('never', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'cancel' }, interruptAfter: '*' as const };
  const run = runCooperatively({ control, isCancellationRequested: async () => control.requested,
    invoke: async first => { await graph.invoke(first ? {} : null, config); }, snapshot: () => graph.getState(config) });
  const result = run.then(() => { done = true; }, error => { done = true; return error; });
  await started;
  control.request();
  await Promise.resolve();
  assert.equal(stopped, 1);
  assert.equal(unrelatedStops, 0);
  assert.equal(done, false, 'request acceptance is not terminal cancellation');
  finish();
  assert.ok(await result instanceof WorkflowCanceledError);
  assert.equal(following, 0);
});

test('cancel before dispatch, including durable restart intent, never invokes a node', async () => {
  let calls = 0;
  await assert.rejects(runCooperatively({ control: new WorkflowCancellation(), isCancellationRequested: async () => true,
    invoke: async () => { calls++; }, snapshot: async () => ({ next: [] }) }), WorkflowCanceledError);
  assert.equal(calls, 0);
});

test('failed stop acknowledgement is retried without stopping unrelated workers', async () => {
  const control = new WorkflowCancellation();
  let attempts = 0;
  let unregister!: () => void;
  await withWorkflowCancellation(control, async () => {
    unregister = registerWorkflowStop(async () => { attempts++; if (attempts === 1) throw new Error('registration race 404'); });
  });
  control.request();
  await new Promise(resolve => setImmediate(resolve));
  control.retryStops();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2);
  unregister();
  control.retryStops();
  assert.equal(attempts, 2);
});

test('cooperative cancellation waits for non-interruptible work, then prevents continuation', async () => {
  const control = new WorkflowCancellation();
  let subsequent = 0;
  await assert.rejects(runCooperatively({ control, isCancellationRequested: async () => control.requested,
    invoke: async () => { control.request(); }, snapshot: async () => { subsequent++; return { next: ['write'] }; } }), WorkflowCanceledError);
  assert.equal(subsequent, 0);
});

test('runtime termination requires an exact terminal receipt, not a lost or malformed response', async t => {
  const receipt = { id: 'target', finishedAt: '2026-09-27T10:00:00Z' };
  const fake = t.mock.method(globalThis, 'fetch', async () => Response.json({ runs: [receipt] }));
  await confirmRuntimeStopped('http://fixture.invalid', 'fixture-secret', 'codex', 'target');
  const [url, init] = fake.mock.calls[0]!.arguments;
  assert.equal(url, 'http://fixture.invalid/codex/status');
  assert.deepEqual(init?.headers, { 'x-workspace-secret': 'fixture-secret' });
  for (const body of [null, {}, { runs: {} }, { runs: [null] }, { runs: [{ id: 'target' }] },
    { runs: [{ ...receipt, id: 'other' }] }, { runs: [{ ...receipt, finishedAt: 'invalid' }] }]) {
    fake.mock.mockImplementation(async () => Response.json(body));
    await assert.rejects(confirmRuntimeStopped('http://fixture.invalid', '', 'claude', 'target'), CancellationUnconfirmedError);
  }
  fake.mock.mockImplementation(async () => { throw new Error('lost response'); });
  await assert.rejects(confirmRuntimeStopped('http://fixture.invalid', '', 'codex', 'target'), CancellationUnconfirmedError);
});

test('a finished step with writes not yet checkpointed is applied instead of ending the run', async () => {
  // LangGraph lists the completed task (with its result) but omits it from
  // `next` until a checkpoint folds in its writes. That is not graph end.
  const snapshots = [
    { next: [], tasks: [{ result: { tests_passed: true }, interrupts: [] }], config: { configurable: { checkpoint_id: 'c4' } } },
    { next: ['approval'], tasks: [{ interrupts: [] }], config: { configurable: { checkpoint_id: 'c5' } } },
    { next: ['approval'], tasks: [{ interrupts: ['human approval'] }], config: { configurable: { checkpoint_id: 'c5' } } },
  ];
  let invokes = 0;
  const result = await runCooperatively({ control: new WorkflowCancellation(), isCancellationRequested: async () => false,
    invoke: async () => { invokes++; }, snapshot: async () => snapshots[invokes - 1]! });
  assert.equal(invokes, 3);
  assert.equal(result.tasks[0]?.interrupts?.length, 1);
});

test('pending writes that make no progress are returned instead of looping', async () => {
  let invokes = 0;
  const result = await runCooperatively({ control: new WorkflowCancellation(), isCancellationRequested: async () => false,
    invoke: async () => { invokes++; },
    snapshot: async () => ({ next: [] as string[], tasks: [{ result: { ok: true }, interrupts: [] }], config: { configurable: { checkpoint_id: 'c4' } } }) });
  assert.equal(invokes, 2);
  assert.deepEqual(result.next, []);
});

test('only completed, non-interrupted tasks count as uncommitted step results', () => {
  assert.equal(hasPendingResult({ next: [], tasks: [] }), false);
  assert.equal(hasPendingResult({ next: [], tasks: [{ interrupts: [] }] }), false);
  assert.equal(hasPendingResult({ next: [], tasks: [{ result: { ok: true }, interrupts: ['approval'] }] }), false);
  assert.equal(hasPendingResult({ next: [], tasks: [{ result: { ok: true }, interrupts: [] }] }), true);
});
