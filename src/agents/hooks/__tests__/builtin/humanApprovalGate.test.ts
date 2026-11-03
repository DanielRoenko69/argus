import { makeHumanApprovalGate } from '../../builtin/humanApprovalGate.js';
import type { HookContext } from '../../types.js';

type FakeRow = { human_oversight_required: boolean };
const makeFakePool = (row: FakeRow | null) => ({
  query: jest.fn().mockResolvedValue({ rows: row ? [row] : [] }),
}) as never;
const pendingApproval = async () => ({ decision: 'pending' as const, requestId: 17 });
const consumedApproval = async () => ({ decision: 'allow' as const, requestId: 17 });

const ctxFor = (toolName: string): HookContext => ({
  agentId: 42, agentName: 'coder', sessionId: 'sess1',
  toolName, toolArgs: {}, iteration: 1, agentDepth: 0,
});

// Workflow-trigger path: no agent (agentId 0), oversight comes from the workflow.
const ctxForWf = (toolName: string, workflowId?: number): HookContext => ({
  agentId: 0, agentName: 'workflow-trigger', sessionId: 'trigger:1',
  toolName, toolArgs: {}, iteration: 1, agentDepth: 0, workflowId,
});

describe('humanApprovalGate', () => {
  it('skips non-sensitive tools even for oversight agents', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }));
    const r = await gate.preToolUse!(ctxFor('workspace_read'));
    expect(r ?? null).toBeNull();
  });

  it('skips sensitive tools for agents without oversight flag', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: false }));
    const r = await gate.preToolUse!(ctxFor('gitea_create_pr'));
    expect(r ?? null).toBeNull();
  });

  it('blocks sensitive tool for oversight-required agent', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }), pendingApproval);
    const r = await gate.preToolUse!(ctxFor('gitea_create_pr'));
    expect(r).toHaveProperty('block');
    expect((r as {block:string}).block).toMatch(/approval/i);
  });

  it('blocks helmrelease_deploy for oversight agent', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }), pendingApproval);
    const r = await gate.preToolUse!(ctxFor('helmrelease_deploy'));
    expect(r).toHaveProperty('block');
  });

  it('falls open (allows) if DB lookup fails', async () => {
    const failingPool = { query: jest.fn().mockRejectedValue(new Error('db down')) } as never;
    const gate = makeHumanApprovalGate(failingPool);
    const r = await gate.preToolUse!(ctxFor('gitea_create_pr'));
    expect(r ?? null).toBeNull();
  });

  // ── audit #2: workflow-level oversight (agentId 0) ───────────────
  it('blocks sensitive tool for oversight-required WORKFLOW (no agent)', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }), pendingApproval);
    const r = await gate.preToolUse!(ctxForWf('k8s_apply', 7));
    expect(r).toHaveProperty('block');
    expect((r as { block: string }).block).toMatch(/workflow #7/);
  });

  it('allows sensitive tool when the workflow has no oversight flag', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: false }));
    const r = await gate.preToolUse!(ctxForWf('k8s_apply', 7));
    expect(r ?? null).toBeNull();
  });

  it('allows when there is neither an agent nor a workflow id', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }));
    const r = await gate.preToolUse!(ctxForWf('helmrelease_deploy', undefined));
    expect(r ?? null).toBeNull();
  });

  it('allows the exact action after its single-use approval is consumed', async () => {
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }), consumedApproval);
    expect(await gate.preToolUse!(ctxFor('gitea_create_pr'))).toBeNull();
  });

  it('fails closed when approval persistence is unavailable', async () => {
    const resolver = async () => { throw new Error('approval db unavailable'); };
    const gate = makeHumanApprovalGate(makeFakePool({ human_oversight_required: true }), resolver);
    const result = await gate.preToolUse!(ctxFor('gitea_create_pr'));
    expect(result?.block).toMatch(/blocked safely/i);
  });
});
