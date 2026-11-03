import { describe, it, expect, jest, beforeEach } from '@jest/globals';
jest.mock('../../../../tools/dynamic/index.js', () => ({ isKnownWriteTool: jest.fn(() => false) }));
import { isKnownWriteTool } from '../../../../tools/dynamic/index.js';
import { makeHumanApprovalGate } from '../../builtin/humanApprovalGate.js';
import type pg from 'pg';

const pool = { query: jest.fn(async () => ({ rows: [{ human_oversight_required: true }] })) } as unknown as pg.Pool;
const pendingApproval = async () => ({ decision: 'pending' as const, requestId: 23 });
const ctx = (toolName: string) =>
  ({ toolName, agentName: 'a', agentId: 1, sessionId: 's', toolArgs: {}, iteration: 0, agentDepth: 0 }) as never;

describe('human-approval-gate write-action', () => {
  beforeEach(() => { (isKnownWriteTool as jest.Mock).mockReturnValue(false); });

  it('blocks an imported write-action when oversight is on', async () => {
    (isKnownWriteTool as jest.Mock).mockReturnValue(true);
    const gate = makeHumanApprovalGate(pool, pendingApproval);
    const out = await gate.preToolUse!(ctx('pets__createPet'));
    expect(out?.block).toMatch(/human approval/i);
  });

  it('allows a read-action (not sensitive, not write)', async () => {
    const gate = makeHumanApprovalGate(pool);
    expect(await gate.preToolUse!(ctx('pets__getPet'))).toBeNull();
  });
});
