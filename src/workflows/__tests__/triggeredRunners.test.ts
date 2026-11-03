import { describe, it, expect, jest } from '@jest/globals';
import type pg from 'pg';
import { executeWorkflow, type StepRunners } from '../executor.js';

jest.mock('../../agents/agentRunner.js', () => ({ runAgentChatSync: jest.fn() }));
jest.mock('../../agents/skillStore.js', () => ({ getSkill: jest.fn() }));
jest.mock('../../agents/memory.js', () => ({ retrieveMemories: jest.fn(), storeMemory: jest.fn() }));
jest.mock('../../agents/ragSearch.js', () => ({ searchRagIndex: jest.fn() }));
jest.mock('../../agents/ragClient.js', () => ({ formatRagContext: jest.fn() }));

import { buildRealRunners } from '../executeRoutes.js';
import { runAgentChatSync } from '../../agents/agentRunner.js';
import type { WorkflowRow, ToolRunner } from '../types.js';
import type { Config } from '../../config/env.js';
import { getNativeTelemetryContext } from '../../observability/telemetryStore.js';

/** Minimal single-step argus.agent workflow (no deps → runs in first group). */
function agentWorkflow(): WorkflowRow {
  return {
    id: 4242,
    name: 'triggered-agent-wf',
    description: 'regression: argus.agent under cron/webhook trigger',
    steps: [
      {
        id: 'a1',
        label: 'call agent',
        type: 'argus.agent',
        agent_id: 7,
        agent_role: 'coder',
        args: { prompt: 'hello' },
      },
    ],
    input_params: [],
    enabled: true,
    bundle_ids: [],
    created_by: null,
    created_at: '',
    updated_at: '',
  };
}

// toolRunner is never invoked for an argus.agent step, but executeWorkflow requires one.
const noopToolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: '' }] });

describe('triggered-runner wiring (P1-1)', () => {
  it('reproduces the bug: runners without agentRunner fail with the executor.ts:261 message', async () => {
    const result = await executeWorkflow({
      workflow: agentWorkflow(),
      inputs: {},
      toolRunner: noopToolRunner,
      runners: { agentRunner: undefined } as StepRunners, // the OLD index.ts wiring
      executionId: 1,
      triggeredBy: 'cron-scheduler',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('no agentRunner provided — cannot execute argus.agent step');
  });

  it('runs an argus.agent step when a defined agentRunner is supplied', async () => {
    let seenAgentId = -1;
    let seenPrompt = '';
    let seenTelemetry = getNativeTelemetryContext();
    const runners: StepRunners = {
      agentRunner: async (agentId, prompt) => {
        seenAgentId = agentId;
        seenPrompt = prompt;
        seenTelemetry = getNativeTelemetryContext();
        return 'agent-reply';
      },
    };
    const result = await executeWorkflow({
      workflow: agentWorkflow(),
      inputs: {},
      toolRunner: noopToolRunner,
      runners,
      executionId: 2,
      triggeredBy: 'webhook:test',
    });
    expect(result.status).toBe('completed');
    expect(seenAgentId).toBe(7);
    expect(seenPrompt).toBe('hello');
    expect(seenTelemetry?.rootTraceId).toBe(seenTelemetry?.traceId);
    expect(seenTelemetry?.spanId).toBeTruthy();
    expect(seenTelemetry?.agentRole).toBe('coder');
    expect(seenTelemetry?.workflowStepId).toBe('a1');
    expect(seenTelemetry?.workflowId).toBe(4242);
    expect((result.stepResults['a1']?.result as string)).toBe('agent-reply');
  });

  it('buildRealRunners is exported and yields a defined agentRunner (index.ts uses this exact call)', () => {
    const fakePool = {} as unknown as pg.Pool;
    const fakeConfig = {} as unknown as Config;
    const fakeToolRunner: ToolRunner = async () => ({ content: [{ type: 'text', text: '' }] });
    // Same arg shape as executeRoutes.ts:181 and the index.ts fix.
    const runners = buildRealRunners(fakePool, fakeConfig, fakeToolRunner);
    expect(typeof runners.agentRunner).toBe('function');
  });

  it('persists the synthetic session before a real workflow agent step runs', async () => {
    const pool = {
      query: jest.fn(async () => ({ rows: [{ id: 'builder-session', agent_id: 7 }] })),
    } as unknown as pg.Pool;
    jest.mocked(runAgentChatSync).mockResolvedValue({
      response: 'agent-reply',
      session_id: 'builder-session',
      tool_calls: [],
      iterations: 1,
    });

    const runners = buildRealRunners(pool, {} as Config, noopToolRunner);
    const output = await runners.agentRunner!(7, 'hello', {});

    expect(output).toBe('agent-reply');
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO mcp_agent_sessions'),
      [expect.stringMatching(/^builder-/), 7, null],
    );
    expect(runAgentChatSync).toHaveBeenCalledWith(
      7,
      expect.stringMatching(/^builder-/),
      'hello',
      pool,
      expect.anything(),
      undefined,
      undefined,
    );
    const insertedSessionId = jest.mocked(pool.query).mock.calls[0]?.[1]?.[0];
    const runnerSessionId = jest.mocked(runAgentChatSync).mock.calls[0]?.[1];
    expect(runnerSessionId).toBe(insertedSessionId);
  });
});
